import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import redis from '@fastify/redis'
import schedule from '@fastify/schedule'
import { fastify, FastifyBaseLogger, FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { MongoClient } from 'mongodb'

import { Context, createDefaultContext } from '#config/context'
import { CORS_METHODS, corsOrigin } from '#config/corsOptions'
import {
	BadRequestError,
	ContentTypeMismatchError,
	NotFoundError,
	ValidationError
} from '#helpers/errors/ApiErrors'
import { CircuitOpenError } from '#helpers/utils/CircuitBreaker'

// Extend FastifyInstance to include mongoClient for health check
declare module 'fastify' {
	interface FastifyInstance {
		mongoClient?: MongoClient
	}
}
import { AsyncTask, SimpleIntervalJob } from 'toad-scheduler'

import { initialize } from '#config/papr'
import { registerPerformanceHooks } from '#config/performance/hooks'
import { rateLimitAllowList } from '#config/rateLimitAllowList'
import deleteAuthor from '#config/routes/authors/delete'
import searchAuthor from '#config/routes/authors/search/show'
import showAuthor from '#config/routes/authors/show'
import deleteChapter from '#config/routes/books/chapters/delete'
import showChapter from '#config/routes/books/chapters/show'
import deleteBook from '#config/routes/books/delete'
import searchBook from '#config/routes/books/search/show'
import showBook from '#config/routes/books/show'
import health from '#config/routes/health'
import imagesSimilar from '#config/routes/images'
import { parseEnvArray, registerMetricsRoute } from '#config/routes/metrics'
import version from '#config/routes/version'
import { warnIfDeletesDisabled } from '#config/routes/writeAuth'
import { buildTrustedProxies } from '#config/trustedProxies'
import { chaptersConfigured } from '#helpers/books/audible/ChapterHelper'
import { memoryCache } from '#helpers/database/inProcessCache'
import { backupSqlite, parseMinFraction, pruneBackups } from '#helpers/database/sqlite/backup'
import { closeSqlite, sqliteDb } from '#helpers/database/sqlite/SqliteModel'
import { goodreadsTuningSummary } from '#helpers/providers/goodreadsSeries'
import { envInt } from '#helpers/utils/env'
import UpdateScheduler from '#helpers/utils/UpdateScheduler'

// Heroku or local port
const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT) || 3000
const logLevel = (process.env.LOG_LEVEL as FastifyBaseLogger['level']) || 'info'

let trustedProxies: string[] = []
let server: ReturnType<typeof fastify>
const updateInterval = Number(process.env.UPDATE_INTERVAL) || 30

// Setup DB context. Under DB_BACKEND=sqlite there is no mongo at all
// (migration Phase 2): no URI requirement, no client, no papr initialize —
// the sqlite backend opens its own file lazily and sets its pragmas there.
const useSqlite = process.env.DB_BACKEND === 'sqlite'
if (!useSqlite && !process.env.MONGODB_URI) {
	throw new Error('No MongoDB URI specified')
}
const ctx: Context | null = useSqlite
	? null
	: createDefaultContext(process.env.MONGODB_URI as string)

/**
 * Registers plugins for the server before booting it up
 * Should be called before registering routes
 */
async function registerPlugins() {
	// Register redis if it's present; otherwise decorate the in-process cache
	// (Phase 1 of the single-container migration). The decorator's TRUTHINESS
	// is load-bearing -- books/show.ts gates the alternate-cover compute on it,
	// health pings it, UpdateScheduler receives it -- so the shim registers
	// under the same name with the same five-method surface (plan #7.3).
	if (process.env.REDIS_URL) {
		server.log.info('Using Redis')
		await server.register(redis, {
			connectTimeout: 500,
			maxRetriesPerRequest: 1,
			url: process.env.REDIS_URL
		})
	} else {
		server.log.info('No REDIS_URL: using the in-process cache')
		server.decorate('redis', memoryCache as never)
	}

	// CORS — deny cross-origin unless CORS_ALLOWED_ORIGINS names an origin.
	// See config/corsOptions.ts: reflecting any origin lends the operator's
	// ambient IP authority (the DELETE and metrics allowlists) to any page they
	// have open. The Plex agent sends no Origin and is unaffected.
	await server.register(cors, {
		origin: corsOrigin(),
		methods: CORS_METHODS
	})

	// Helmet
	await server.register(helmet, {
		global: true
	})

	// Scheduler
	await server.register(schedule)

	// Rate limiting
	await server.register(rateLimit, {
		global: true,
		// Redis is OPTIONAL everywhere else in this codebase (the search cache
		// "degrades to live calls when it is not" there, and GenericShowHelper
		// swallows Redis rejections specifically so a blip cannot crash-loop the
		// API). @fastify/rate-limit v10 defaults skipOnError to FALSE, which
		// contradicted that: a Redis restart made the store's own error escape to
		// the error handler and 500 every non-allowlisted request. Skipping the
		// limit is the right failure direction for a self-hosted instance.
		skipOnError: true,
		// Key on request.ip (the @fastify/rate-limit default). Fastify derives it
		// from the X-Forwarded-For chain via `trustProxy: trustedProxies` (set
		// below) — so behind a reverse proxy it's the real client and it is NOT
		// spoofable by external clients. IMPORTANT: put your reverse proxy's
		// IP/CIDR in TRUSTED_PROXIES, or request.ip becomes the proxy IP and the
		// whole API shares one rate-limit bucket. (Reading the leftmost XFF entry
		// here instead would trust a client-spoofable value.)
		max: Number(process.env.MAX_REQUESTS) || 100,
		// Exempt trusted callers (comma-separated IPs / CIDR ranges in
		// RATE_LIMIT_ALLOWLIST) from the limit. A local Plex agent legitimately
		// bursts hundreds of GETs during a from-scratch library scan — Plex
		// re-matches an album once per track and a multi-file audiobook holds
		// 100+ tracks — which trips this shared-IP bucket and 429s its own scan
		// even though provider results are already cached. Unconfigured →
		// allowList returns false for all → every client is limited (unchanged).
		allowList: rateLimitAllowList,
		redis: process.env.REDIS_URL ? server.redis : undefined,
		timeWindow: '1 minute'
	})
	const rateLimitAllow = parseEnvArray(process.env.RATE_LIMIT_ALLOWLIST)
	if (rateLimitAllow) {
		server.log.info(
			`Rate-limit allowlist: ${rateLimitAllow.length} entr${rateLimitAllow.length === 1 ? 'y' : 'ies'}`
		)
	}
	// Send 429 if rate limit is reached
	// Check for custom error status codes (404, 400, etc.)
	server.setErrorHandler(function (
		error: FastifyError,
		request: FastifyRequest,
		reply: FastifyReply
	) {
		const errorCodeMap: Record<string, string> = {
			ContentTypeMismatchError: 'CONTENT_TYPE_MISMATCH',
			ValidationError: 'VALIDATION_ERROR',
			NotFoundError: 'NOT_FOUND',
			BadRequestError: 'BAD_REQUEST'
		}

		// An open circuit is "come back in N seconds", not "something broke".
		// Served as a bare 500 it told the Plex agent nothing actionable, and its
		// retry ladder cannot outlast a 60s breaker window by guessing -- five
		// Apple-backed books lost their metadata that way on the 2026-08-05
		// rebuild. 503 + Retry-After is the honest answer, and the agent obeys it
		// as of bundle v1.3.187.
		if (error instanceof CircuitOpenError) {
			reply.header('Retry-After', String(error.retryAfter))
			reply.status(503)
			reply.send({
				error: {
					code: 'UPSTREAM_UNAVAILABLE',
					message: error.message,
					details: { retryAfter: error.retryAfter }
				}
			})
			return
		}

		if (
			error instanceof ContentTypeMismatchError ||
			error instanceof ValidationError ||
			error instanceof NotFoundError ||
			error instanceof BadRequestError
		) {
			const statusCode = error.statusCode
			const errorCode = error.details?.code || errorCodeMap[error.name] || 'UNKNOWN_ERROR'

			reply.status(statusCode)
			reply.send({
				error: {
					code: errorCode,
					message: error.message,
					details: error.details
				}
			})
			return
		}

		// Check for 429 rate limit errors first
		if (reply.statusCode === 429) {
			if (error instanceof Error) {
				reply.status(429)
				reply.send({
					error: {
						code: 'RATE_LIMIT_EXCEEDED',
						message: 'Rate limit reached. Please try again later.',
						details: null
					}
				})
				return
			} else {
				server.log.error('Non-error object in error handler: %s', String(error))
			}
		}

		// Check if error has a custom statusCode property
		if (error instanceof Error && 'statusCode' in error) {
			const statusCode = (error as Error & { statusCode: number }).statusCode
			const errorCode = String(statusCode || 'UNKNOWN_ERROR')
			reply.status(statusCode)
			reply.send({
				error: {
					code: errorCode,
					message: error.message || 'An error occurred',
					details: null
				}
			})
			return
		}
		reply.send(error)
	})
}

/**
 * Registers routes for the server before booting it up
 * Should be called after registering plugins
 */
async function registerRoutes() {
	await server
		.register(showBook)
		.register(searchBook)
		.register(deleteBook)
		.register(showChapter)
		.register(deleteChapter)
		.register(showAuthor)
		.register(deleteAuthor)
		.register(searchAuthor)
		.register(health)
		.register(imagesSimilar)
		.register(version)

	warnIfDeletesDisabled(server)
	// Chapters degrade to 404 without Audible credentials (see
	// ChapterHelper.chaptersConfigured). Said ONCE at startup so a deployment
	// that MEANT to serve chapters learns it here, rather than from every
	// chapter request quietly 404ing forever.
	if (!chaptersConfigured())
		server.log.warn(
			'ADP_TOKEN/PRIVATE_KEY unset: chapter requests will answer 404. ' +
				'Set both to enable chapters; ignore this if you do not want them.'
		)

	try {
		registerPerformanceHooks(server)
		registerMetricsRoute(server)
	} catch (err) {
		server.log.warn({ err }, 'Failed to register metrics, continuing without metrics')
	}
}

/**
 * Starts the server
 * Should be called after registering plugins and routes
 */
async function startServer() {
	// Build trusted proxies list (includes Cloudflare IPs)
	trustedProxies = await buildTrustedProxies()

	// Initialize fastify server with trusted proxies
	server = fastify({
		logger: {
			level: logLevel
		},
		trustProxy: trustedProxies
	})

	server.log.info(`Trusted proxies configured: ${trustedProxies.length} ranges`)

	// Which Goodreads instance we talk to, and how hard we defend against it.
	// Worth a startup line: "enrichment is slow" and "this answer is stale" are
	// both answered by the profile, and otherwise the only way to tell which one
	// is active is to read the container's environment.
	server.log.info(goodreadsTuningSummary())

	// Register plugins
	await registerPlugins().then(() => server.log.info('Plugins registered'))

	// Register routes
	await registerRoutes().then(() => server.log.info('Routes registered'))
	server.log.info('Registered routes: %s', server.printRoutes())

	// Start main server
	try {
		const address = await server.listen({ port, host })
		if (ctx) {
			// The REAL logger: an index that fails to build is a silent, permanent
			// degradation (author search 500s forever), so it must reach the log.
			await initialize({ client: await ctx.client.connect() }, server.log)
			server.log.info('Connected to DB')
			server.mongoClient = ctx.client
		} else {
			// Open (and create) the sqlite file NOW so a bad path fails the boot
			// loudly — the most likely first-install failure is a bind mount the
			// container user cannot write (#7.4), and it must not surface later
			// as a raw bun:sqlite error mid-request.
			sqliteDb()
			server.log.info(`Connected to DB (sqlite: ${process.env.SQLITE_PATH || './data/incipit.db'})`)
			// /health's database check pings whatever sits on server.mongoClient.
			// This duck-typed stand-in answers that exact call with a sqlite
			// SELECT 1, so the health CONTRACT (checks.database) keeps meaning
			// "the storage backend answers" without forking health.ts (#7.4).
			server.mongoClient = {
				db: () => ({
					command: async () => {
						sqliteDb().prepare('SELECT 1').get()
						return { ok: 1 }
					}
				})
			} as unknown as MongoClient
		}
		server.log.info(`Server listening at ${address}`)
	} catch (err) {
		server.log.error(err)
		process.exit(1)
	}

	// The scheduler start used to live INSIDE the mongo liveness ping's .then()
	// — easy to mistake for a deletable check when it was actually the only
	// entry point (#7.2). Named function, called from whichever backend's
	// readiness path applies.
	const startScheduler = () => {
		server.log.info(`Update interval: ${updateInterval} days`)
		const updateScheduler = new UpdateScheduler(updateInterval, server.redis, server.log)
		;(server as unknown as { updateScheduler: UpdateScheduler }).updateScheduler = updateScheduler
		server.scheduler.addLongIntervalJob(updateScheduler.updateAllJob())
		startBackupJob()
	}

	/**
	 * Snapshot the SQLite database on a schedule, from inside the container.
	 *
	 * Under DB_BACKEND=sqlite the ENTIRE datastore is one file on one volume.
	 * `bun run backup` has existed for days and had never run unattended — the
	 * newest snapshot on the live deployment was a day old and sat in the same
	 * directory as the database it was protecting. A backup that depends on
	 * someone remembering is not a backup.
	 *
	 * Interval and retention are env-tunable; SQLITE_BACKUP_INTERVAL_HOURS=0
	 * turns it off for anyone who backs the volume up their own way.
	 */
	function startBackupJob() {
		if (process.env.DB_BACKEND !== 'sqlite' || !process.env.SQLITE_PATH) return
		const hours = envInt(process.env.SQLITE_BACKUP_INTERVAL_HOURS, 24, 0, 24 * 30)
		if (hours === 0) {
			server.log.info('SQLite backup job disabled (SQLITE_BACKUP_INTERVAL_HOURS=0)')
			return
		}
		const keep = envInt(process.env.SQLITE_BACKUP_KEEP, 7, 1, 365)
		const sqlitePath = process.env.SQLITE_PATH
		const minFraction = parseMinFraction(process.env.BACKUP_MIN_FRACTION)
		const task = new AsyncTask(
			'sqlite-backup',
			async () => {
				const res = backupSqlite(sqlitePath, undefined, minFraction)
				// A refusal is logged at ERROR, not swallowed: the whole point is
				// that nobody is watching, so a silently-skipped backup would be
				// indistinguishable from a working one.
				if (!res.ok) server.log.error(`SQLite backup FAILED — ${res.message}`)
				else {
					server.log.info(`SQLite backup OK: ${res.message}`)
					const gone = pruneBackups(sqlitePath, keep)
					if (gone.length) server.log.info(`Pruned ${gone.length} old backup(s), keeping ${keep}`)
				}
			},
			(err) => server.log.error(err)
		)
		server.scheduler.addSimpleIntervalJob(
			new SimpleIntervalJob({ hours, runImmediately: true }, task)
		)
		server.log.info(`SQLite backup every ${hours}h, keeping ${keep}`)
	}
	server.ready(() => {
		if (!ctx) {
			// sqlite proved itself at boot (the file opened); start directly.
			startScheduler()
			return
		}
		// test that db is connected
		ctx.client
			.db('papr')
			.command({ ping: 1 })
			.then(startScheduler)
			.catch((err) => {
				server.log.error(err)
				process.exit(1)
			})
	})
}

/**
 * Shuts down the server and closes the DB connection
 */
async function stopServer() {
	if (!server) {
		process.exit(0)
	}
	server.log.info('Closing HTTP server')
	// Only stop scheduler if it was initialized
	if (server.scheduler) {
		server.scheduler.stop()
	}
	try {
		await server.close()
		server.log.info('HTTP server closed')
		// Close whichever backend is live. sqlite gets a WAL checkpoint on the
		// way out — with the DB in-process, a lost close means a hot -wal file
		// on every docker stop (#7.2).
		if (ctx) await ctx.client.close()
		else closeSqlite()
		server.log.info('DB connection closed')
		process.exit(0)
	} catch (err) {
		server.log.error(err)
		process.exit(1)
	}
}

// Last-resort handlers: the bootstrap awaits (trusted proxies, plugins, routes)
// run before the server logger exists, so without these a rejection there — or
// any stray async error — would exit ambiguously with no log line. Fail loudly.
process.on('unhandledRejection', (reason) => {
	console.error('Unhandled promise rejection:', reason)
	process.exit(1)
})
process.on('uncaughtException', (err) => {
	console.error('Uncaught exception:', err)
	process.exit(1)
})

// Start the server; surface a bootstrap failure that happens before the logger.
startServer().catch((err) => {
	console.error('Failed to start server:', err)
	process.exit(1)
})

// Handle SIGTERM and SIGINT
process.on('SIGTERM', stopServer)
process.on('SIGINT', stopServer)

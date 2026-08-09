import { FastifyInstance } from 'fastify'
import { MongoClient } from 'mongodb'

/**
 * Timeout duration in milliseconds for health check pings
 */
const PING_TIMEOUT_MS = 5000

/**
 * Wraps a promise with a timeout, clearing the timer when the promise settles
 */
function withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
	let timer: NodeJS.Timeout
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`${operation} timed out after ${PING_TIMEOUT_MS}ms`))
		}, PING_TIMEOUT_MS)
	})

	return Promise.race([promise, timeoutPromise]).finally(() => {
		clearTimeout(timer)
	}) as Promise<T>
}

/**
 * Health check response structure
 */
export interface HealthCheckResponse {
	status: 'healthy' | 'unhealthy'
	timestamp: string
	checks: {
		server: boolean
		database: boolean
		redis: boolean | null
	}
	/**
	 * WHAT this container is actually running, not just whether it answers.
	 *
	 * Two database backends now sit behind DB_BACKEND and two cache modes behind
	 * REDIS_URL, and until this was added nothing reported which pair was live —
	 * `database: true` reads identically whether it pinged Mongo or ran SELECT 1
	 * against SQLite. Diagnosing a deployment meant shelling into the host, which
	 * is precisely the reaching-in this project is trying to stop needing.
	 */
	runtime: {
		/** 'sqlite' | 'mongo' — which adapter the models are bound to. */
		backend: string
		/** 'redis' | 'memory' — a real Redis, or the bounded in-process LRU. */
		cache: string
	}
}

/**
 * Extended FastifyInstance with MongoDB client
 */
interface FastifyInstanceWithMongo extends FastifyInstance {
	mongoClient?: MongoClient
	mongoClientCleanup?: () => Promise<void>
}

/**
 * Health check route for monitoring service health
 * Checks server, database, and optionally Redis connectivity
 */
async function health(app: FastifyInstance) {
	app.get<{ Reply: HealthCheckResponse }>('/health', async (request, reply) => {
		const checks = {
			server: true,
			database: false,
			redis: null as boolean | null
		}

		// Check server (always passes if the route is executing)

		// Check MongoDB with timeout (only if mongoClient is available)
		const mongoClient = (app as FastifyInstanceWithMongo).mongoClient
		if (mongoClient) {
			try {
				await withTimeout(mongoClient.db().command({ ping: 1 }), 'MongoDB ping')
				checks.database = true
			} catch (error) {
				checks.database = false
				request.log.error({ err: error }, 'MongoDB health check failed')
			}
		}

		// Check Redis (conditional on Redis being registered)
		const redis = (app as unknown as { redis?: { ping: () => Promise<string> } }).redis
		if (redis) {
			try {
				await withTimeout(redis.ping(), 'Redis ping')
				checks.redis = true
			} catch (error) {
				checks.redis = false
				request.log.error({ err: error }, 'Redis health check failed')
			}
		} else {
			checks.redis = null
		}

		// Determine overall status
		const isHealthy = checks.database && (checks.redis === null || checks.redis)

		// Set status code based on health
		const statusCode = isHealthy ? 200 : 503

		const response: HealthCheckResponse = {
			status: isHealthy ? 'healthy' : 'unhealthy',
			timestamp: new Date().toISOString(),
			// Read from the SAME env the wiring reads, not from a separate copy:
			// a second source of truth here would eventually disagree with the
			// code and report a backend the container is not using.
			runtime: {
				backend: process.env.DB_BACKEND === 'sqlite' ? 'sqlite' : 'mongo',
				cache: process.env.REDIS_URL ? 'redis' : 'memory'
			},
			checks
		}

		return reply.status(statusCode).send(response)
	})
}

export default health

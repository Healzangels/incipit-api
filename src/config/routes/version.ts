import { FastifyInstance } from 'fastify'

/**
 * Process start, captured once -- this genuinely is process-scoped, and it is
 * what distinguishes a bare container restart from an actual redeploy.
 */
const STARTED_AT = new Date().toISOString()

/**
 * Build identity, injected as ENV by the Dockerfile.
 *
 * Read per request rather than cached at module load. The values cannot change
 * while the process lives, so caching would be free -- but it would also make
 * the populated case untestable, since a test cannot set the env before the
 * module it imports is evaluated. Two env lookups per request on a route that
 * is called by hand is not a cost worth trading test coverage for. `unknown` is
 * the honest answer for a local `bun run serve`, where no image build happened.
 */
function buildIdentity(): { commit: string; builtAt: string } {
	return {
		commit: process.env.GIT_SHA || 'unknown',
		builtAt: process.env.BUILD_TIME || 'unknown'
	}
}

export interface VersionResponse {
	/** Full git SHA the image was built from, or "unknown" outside a build. */
	commit: string
	/** Short SHA, for eyeballing against `git log --oneline`. */
	commitShort: string
	/** ISO timestamp the image was built. */
	builtAt: string
	/** ISO timestamp this process started -- distinguishes a restart from a redeploy. */
	startedAt: string
	/** Seconds since process start. */
	uptimeSeconds: number
}

/**
 * Build-identity route.
 *
 * Exists because verifying an API deploy was previously guesswork: `docker
 * compose pull` reports "Pulled" whether or not anything changed, a healthy
 * /health answers identically for the old and the new build, and a tag mixup
 * (:latest tracking `release` while the deploy expected `nightly`) once served
 * a stale image silently for days. The Plex bundle solves the same problem with
 * a version banner in its log; this is the API's equivalent, reachable in one
 * curl:
 *
 *     curl -s http://<host>:3737/version
 *
 * Deliberately unauthenticated and free of build paths, dependency versions and
 * env values: a commit SHA identifies the build without describing the host.
 */
async function version(app: FastifyInstance) {
	app.get<{ Reply: VersionResponse }>('/version', async (_request, reply) => {
		const { commit, builtAt } = buildIdentity()
		return reply.status(200).send({
			commit,
			commitShort: commit === 'unknown' ? 'unknown' : commit.slice(0, 7),
			builtAt,
			startedAt: STARTED_AT,
			uptimeSeconds: Math.round(process.uptime())
		})
	})
}

export default version

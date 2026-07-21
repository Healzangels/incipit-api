import crypto from 'crypto'
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import ipRangeCheck from 'ip-range-check'

import { getPerformanceConfig } from '#config/performance'
import { getPerformanceMetrics } from '#config/performance/hooks'
import { getMatchMetrics, type MatchMetrics } from '#helpers/utils/matchTelemetry'

/**
 * Strip the library-content fields from the recent match decisions.
 *
 * `recent` carries the title, author, matched title and ASIN of the last ~50
 * searches — i.e. what books the operator owns. On an instance with no auth
 * configured, /metrics is publicly reachable (only a warn log), which turned an
 * ops endpoint into a catalog disclosure. Open mode keeps every aggregate and
 * the per-decision quality numbers (confidence, risky, provider, flags) so the
 * dashboard use survives; the identifying strings need auth. New objects, not
 * mutations — the store's decision objects are shared.
 */
type RedactedMatchMetrics = Omit<MatchMetrics, 'recent'> & {
	recentRedacted: true
	recent: Array<
		Omit<MatchMetrics['recent'][number], 'title' | 'author' | 'matchedTitle' | 'asin'> & {
			title: null
			author: null
			matchedTitle: null
			asin: null
		}
	>
}

function redactMatchMetrics(match: MatchMetrics): RedactedMatchMetrics {
	return {
		...match,
		recentRedacted: true,
		recent: match.recent.map((d) => ({
			...d,
			title: null,
			author: null,
			matchedTitle: null,
			asin: null
		}))
	}
}

/**
 * Parse comma-separated environment variable into array
 * Returns undefined if value is not set or empty
 */
export function parseEnvArray(value: string | undefined): string[] | undefined {
	if (value === undefined || value.trim() === '') return undefined
	const result = value
		.split(',')
		.map((ip) => ip.trim())
		.filter((ip) => ip.length > 0)
	return result.length > 0 ? result : undefined
}

/**
 * THE definition of "metrics auth is configured" — used by the auth check, the
 * startup warning, and the open-mode redaction gate. Three hand-rolled copies
 * of this env test is how the redaction and the auth check drift apart (e.g. a
 * future auth mechanism added to one but not the others silently reopens the
 * catalog disclosure the redaction exists to close).
 */
export function metricsAuthConfigured(): boolean {
	return !!process.env.METRICS_AUTH_TOKEN || !!parseEnvArray(process.env.METRICS_ALLOWED_IPS)
}

/**
 * Check if request IP is in allowed list
 * Supports single IPs and CIDR ranges (e.g., "192.168.1.0/24")
 */
export function isIpAllowed(request: FastifyRequest, allowedIps: string[]): boolean {
	// Extract first IP from x-forwarded-for header (handles string or array)
	const forwardedFor = request.headers['x-forwarded-for']
	let firstForwardedIp: string | undefined

	if (Array.isArray(forwardedFor)) {
		firstForwardedIp = forwardedFor[0]
	} else if (typeof forwardedFor === 'string') {
		firstForwardedIp = forwardedFor.split(',')[0]
	}

	const clientIp = request.ip ?? firstForwardedIp?.trim() ?? 'unknown'

	// Handle 'unknown' IP specially (not a valid IP for ip-range-check)
	if (clientIp === 'unknown') {
		return allowedIps.includes('unknown')
	}

	try {
		return ipRangeCheck(clientIp, allowedIps)
	} catch {
		// Treat parsing errors as non-match
		return false
	}
}

/**
 * Validate metrics authentication
 * Returns true if access is allowed, false if denied
 */
function validateMetricsAuth(request: FastifyRequest): boolean {
	// If neither auth token nor allowed IPs are configured, skip auth check
	if (!metricsAuthConfigured()) {
		return true
	}
	const authToken = process.env.METRICS_AUTH_TOKEN
	const allowedIps = parseEnvArray(process.env.METRICS_ALLOWED_IPS)

	// Check IP-based access first
	if (allowedIps && allowedIps.length > 0) {
		if (isIpAllowed(request, allowedIps)) {
			return true
		}
	}

	// Check token-based access
	if (authToken) {
		const requestToken = request.headers['x-metrics-token']?.toString()
		if (requestToken && authToken) {
			const bufRequest = Buffer.from(requestToken)
			const bufAuth = Buffer.from(authToken)
			if (bufRequest.length !== bufAuth.length) {
				return false
			}
			if (crypto.timingSafeEqual(bufRequest, bufAuth)) {
				return true
			}
		}
	}

	return false
}

/**
 * Register metrics route on Fastify instance
 * Returns performance metrics including memory usage and request timings
 */
export function registerMetricsRoute(fastify: FastifyInstance): void {
	const config = getPerformanceConfig()

	// Check if metrics are enabled but no auth is configured
	if (config.METRICS_ENABLED) {
		if (!metricsAuthConfigured()) {
			fastify.log.warn(
				'Metrics endpoint is enabled without authentication (METRICS_AUTH_TOKEN and METRICS_ALLOWED_IPS not set). The /metrics endpoint is publicly accessible.'
			)
		}
	}

	fastify.get('/metrics', async (request: FastifyRequest, reply: FastifyReply) => {
		// Return 404 if metrics endpoint is disabled
		if (!config.METRICS_ENABLED) {
			return reply.code(404).send({ error: 'Metrics endpoint disabled' })
		}

		// Validate auth if configured
		if (!validateMetricsAuth(request)) {
			return reply.code(403).send({ error: 'Forbidden' })
		}

		const metrics = getPerformanceMetrics()
		// Match-quality aggregates alongside the request/memory ones. Request counts
		// and latency say nothing about whether the matcher picked the RIGHT book,
		// which is its actual failure mode — this makes quality a number to watch
		// during a bulk import rather than something found by eyeballing shelves.
		//
		// With NO auth configured this endpoint is open (validateMetricsAuth
		// passes everyone), so the recent decisions' library-content fields are
		// redacted — aggregates and per-decision quality numbers survive; the
		// titles/authors/ASINs of what the operator owns require auth.
		const match = getMatchMetrics()
		return { ...metrics, match: metricsAuthConfigured() ? match : redactMatchMetrics(match) }
	})
}

export default { registerMetricsRoute }

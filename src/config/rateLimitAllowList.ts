import { FastifyRequest } from 'fastify'

import { isIpAllowed, parseEnvArray } from '#config/routes/metrics'

/**
 * Rate-limit allowlist predicate for @fastify/rate-limit's `allowList` option.
 *
 * A trusted local caller — chiefly the self-hosted Plex agent — legitimately
 * bursts hundreds of GETs during a from-scratch library scan: Plex re-runs an
 * album match once per track, and a multi-file audiobook can hold 100+ tracks.
 * Every one of those requests shares a single source IP, so the default
 * 100/min bucket trips and the scan 429s itself — even though provider search
 * results are already Redis-cached, so the limiter is guarding nothing here.
 * Listing that IP (or CIDR) in RATE_LIMIT_ALLOWLIST exempts it.
 *
 * Unconfigured (the default) → returns false → every client is rate-limited,
 * exactly as before. CIDR-aware and matches the DELETE_ALLOWED_IPS convention.
 * @param {FastifyRequest} request the incoming request
 * @returns {boolean} true if this request should bypass the rate limit
 */
// Memoized on the raw env value: this predicate runs on EVERY request inside
// the rate-limit hook, and the env var never changes at runtime — but keying
// the memo on the raw string (rather than parsing once at import) keeps tests
// that set the env per-case working.
let memoRaw: string | undefined
let memoList: string[] | undefined
export function rateLimitAllowList(request: FastifyRequest): boolean {
	const raw = process.env.RATE_LIMIT_ALLOWLIST
	if (raw !== memoRaw) {
		memoRaw = raw
		memoList = parseEnvArray(raw)
	}
	return memoList ? isIpAllowed(request, memoList) : false
}

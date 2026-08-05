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
 * Two ways to be exempt: listed in RATE_LIMIT_ALLOWLIST, or reaching us
 * DIRECTLY (no x-forwarded-for) from loopback/private space — see
 * isDirectLocalInfra, which is what makes the container-to-host hop work
 * without the operator having to know their docker subnet. A remote client
 * behind a proxy is still judged on the configured list alone.
 * CIDR-aware and matches the DELETE_ALLOWED_IPS convention.
 * @param {FastifyRequest} request the incoming request
 * @returns {boolean} true if this request should bypass the rate limit
 */
// Memoized on the raw env value: this predicate runs on EVERY request inside
// the rate-limit hook, and the env var never changes at runtime — but keying
// the memo on the raw string (rather than parsing once at import) keeps tests
// that set the env per-case working.
let memoRaw: string | undefined
let memoList: string[] | undefined

/**
 * Loopback and the private ranges. A container talking to its host, or a host
 * talking to itself, can only appear as one of these.
 */
const LOCAL_INFRA = [
	'127.0.0.0/8',
	'::1/128',
	'10.0.0.0/8',
	'172.16.0.0/12',
	'192.168.0.0/16',
	'169.254.0.0/16',
	'fc00::/7'
]

/**
 * True when the request reached us DIRECTLY from local infrastructure.
 *
 * Measured 2026-08-05, on a from-scratch rebuild of 1,591 albums. The operator
 * had RATE_LIMIT_ALLOWLIST set to their LAN, and a LAN client was correctly
 * exempt (no x-ratelimit headers at all). The Plex agent still got 429s --
 * because the bundle calls the API at the HOST address from INSIDE the Plex
 * container, so what arrives here is the container's docker-bridge address
 * (172.x), which the operator's LAN CIDR does not cover. Nothing in the 429
 * says "your allowlist is missing the docker range", so the failure is
 * invisible: 34 albums silently kept their raw file-tag titles because
 * update() could not fetch, and three more went unmatched.
 *
 * The `x-forwarded-for` test is what keeps this narrow. A proxied request
 * carries that header, so it is judged on the configured allowlist against the
 * real client. Only an UNPROXIED request from a private/loopback source is
 * treated as our own infrastructure -- which is exactly the container-to-host
 * hop, and is not something an external client can produce.
 * @param {FastifyRequest} request the incoming request
 * @returns {boolean} true when this is a direct call from local infrastructure
 */
function isDirectLocalInfra(request: FastifyRequest): boolean {
	if (request.headers['x-forwarded-for']) return false
	return isIpAllowed(request, LOCAL_INFRA)
}

export function rateLimitAllowList(request: FastifyRequest): boolean {
	const raw = process.env.RATE_LIMIT_ALLOWLIST
	if (raw !== memoRaw) {
		memoRaw = raw
		memoList = parseEnvArray(raw)
	}
	if (memoList && isIpAllowed(request, memoList)) return true
	return isDirectLocalInfra(request)
}

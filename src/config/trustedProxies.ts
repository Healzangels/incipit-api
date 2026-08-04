import { getAllIps as getCloudflareIps } from '#helpers/utils/cloudflareIps'

/**
 * Which proxies may set `request.ip` through X-Forwarded-For.
 *
 * THIS IS AN AUTHENTICATION SURFACE, not a networking detail. `request.ip` is
 * the only credential the DELETE routes accept on its own — writeAuth.ts returns
 * true on an IP allowlist match with no token — and it also gates /metrics and
 * the rate-limit exemption. Whoever is trusted here can claim to be any of those
 * addresses.
 *
 * Lives in its own module because server.ts cannot be imported by a test: it
 * throws at module scope without MONGODB_URI and then listens. A
 * security-critical decision that no test can reach is one edit from silently
 * reverting, which is exactly how the Cloudflare merge below went unnoticed.
 */

/** Proxies the operator configured. Defaults to loopback only. */
export function userTrustedProxies(): string[] {
	return process.env.TRUSTED_PROXIES
		? process.env.TRUSTED_PROXIES.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: ['127.0.0.1']
}

/**
 * Build the trusted-proxy list, merging Cloudflare's ranges ONLY on request.
 *
 * Cloudflare used to be merged unconditionally. That trusts ~22 CIDRs belonging
 * to a third party anyone can originate traffic from: a free Cloudflare Worker
 * sending `X-Forwarded-For: 127.0.0.1` arrives from a trusted hop, so proxy-addr
 * walks the chain and returns that attacker-chosen value as `request.ip` —
 * satisfying `DELETE_ALLOWED_IPS=127.0.0.1` with no token.
 *
 * Enable it only when the instance sits behind your own Cloudflare tunnel AND is
 * unreachable by any other route, because from then on every IP allowlist is
 * only as strong as that tunnel.
 * @returns {Promise<string[]>} addresses whose X-Forwarded-For may set request.ip
 */
export async function buildTrustedProxies(): Promise<string[]> {
	const configured = userTrustedProxies()
	if (process.env.TRUST_CLOUDFLARE !== 'true') return configured
	try {
		return [...new Set([...configured, ...(await getCloudflareIps())])]
	} catch (error) {
		// A failed fetch must never widen trust; fall back to the operator's list.
		console.warn('Failed to fetch Cloudflare IPs', error)
		return configured
	}
}

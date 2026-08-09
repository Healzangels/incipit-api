import { parseEnvArray } from '#config/routes/metrics'

/**
 * CORS policy, extracted so it can be tested.
 *
 * It was `{ origin: true, methods: 'GET,HEAD,PUT,PATCH,POST,DELETE' }` inline in
 * server.ts, which reflects ANY origin and pre-approves the DELETE preflight
 * along with the `x-delete-token` header. That matters here because the write
 * gate and the metrics gate are ambient IP authority, not cookies: a browser on
 * the LAN already satisfies `DELETE_ALLOWED_IPS` / `METRICS_ALLOWED_IPS`, so
 * reflecting an origin lends that authority to whatever page the operator has
 * open. Confirmed live on 2026-07-31 — an `evil.example.com` preflight returned
 * 204 with `Allow-Headers: x-delete-token`, and a cross-origin GET /metrics
 * returned the unredacted catalog.
 *
 * The Plex agent is a server-side client and sends no Origin header, so it is
 * unaffected by any of this; nothing browser-based consumes the API today.
 * Default is therefore DENY, with an explicit opt-in for a real browser client.
 */

/** Comma-separated origins, e.g. "https://app.example.com,https://admin.example.com". */
const ORIGINS_ENV = 'CORS_ALLOWED_ORIGINS'

/**
 * The methods the API actually serves: 6 GET routes, 3 DELETE routes, and one
 * POST (/images/similar). PUT and PATCH have no routes at all — pre-approving
 * them only widens what a preflight blesses.
 */
export const CORS_METHODS = 'GET,HEAD,POST,DELETE'

/**
 * Resolve the allowed origins.
 *
 * Deliberately can never return `true`, and never a wildcard ENTRY either:
 * '*' and 'null' are filtered out, so no configuration can reinstate
 * reflect-any-origin (see the filter below for why each is a hazard). An unset, empty or separators-only
 * value is a DENY — the empty-string env hole (`KEY=` reading as "configured")
 * has bitten this codebase before.
 * @returns {string[] | false} the configured origins, or false to deny cross-origin
 */
export function corsOrigin(): string[] | false {
	const origins = parseEnvArray(process.env[ORIGINS_ENV])
	if (!origins || !origins.length) return false
	// A WILDCARD ENTRY IS A WILDCARD. The claim above was false as written:
	// `CORS_ALLOWED_ORIGINS=*` produced ['*'], which @fastify/cors collapses to
	// origin '*' — reinstating by configuration the exact `origin: true` this
	// module exists to remove, and lending the LAN's ambient IP authority (the
	// DELETE and metrics gates) to any page the operator has open. `null` is
	// the same hazard wearing a different hat: it is the Origin a sandboxed
	// iframe or a file:// page sends, so allowlisting it opens the API to any
	// such document.
	//
	// Refused rather than honoured: an operator who genuinely wants a browser
	// client can name its origin, which is both safer and what the rest of this
	// module assumes. Filtered (not rejected wholesale) so one bad entry in a
	// list cannot silently deny the good ones.
	const safe = origins.filter((o) => o !== '*' && o.toLowerCase() !== 'null')
	return safe.length ? safe : false
}

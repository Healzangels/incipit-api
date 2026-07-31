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
 * Deliberately can never return `true`: a wildcard is not reachable by
 * configuration, only an explicit list. An unset, empty or separators-only
 * value is a DENY — the empty-string env hole (`KEY=` reading as "configured")
 * has bitten this codebase before.
 * @returns {string[] | false} the configured origins, or false to deny cross-origin
 */
export function corsOrigin(): string[] | false {
	const origins = parseEnvArray(process.env[ORIGINS_ENV])
	return origins && origins.length ? origins : false
}

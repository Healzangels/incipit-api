import { afterEach, describe, expect, test } from 'bun:test'

import { CORS_METHODS, corsOrigin } from '#config/corsOptions'

/**
 * CORS composes with the IP allowlists, so it is an access-control decision,
 * not cosmetics. Verified live on 2026-07-31 against a deployed instance with the
 * previous `origin: true`:
 *
 *   OPTIONS /books/<asin>  Origin: https://evil.example.com
 *     -> 204, Access-Control-Allow-Origin: https://evil.example.com
 *        Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE
 *        Access-Control-Allow-Headers: x-delete-token
 *
 * Because `requireDeleteAuth` in allowlist mode trusts `request.ip`, and a
 * browser on the LAN satisfies that, reflecting any origin hands a hostile page
 * the operator's ambient authority: it can read /metrics (the full catalog)
 * cross-origin and, where DELETE_ALLOWED_IPS is set, issue deletes.
 */
const ENV = 'CORS_ALLOWED_ORIGINS'

afterEach(() => {
	delete process.env[ENV]
})

describe('corsOrigin', () => {
	test('denies cross-origin by default — no browser client consumes this API', () => {
		delete process.env[ENV]
		expect(corsOrigin()).toBe(false)
	})

	test('an empty or whitespace-only value is still a deny, not an allow-all', () => {
		// The empty-string env hole this codebase has been bitten by before:
		// `KEY=` must not read as "configured".
		process.env[ENV] = ''
		expect(corsOrigin()).toBe(false)
		process.env[ENV] = '   ,  ,'
		expect(corsOrigin()).toBe(false)
	})

	test('an explicit allowlist is honoured exactly', () => {
		process.env[ENV] = 'https://app.example.com, https://admin.example.com'
		expect(corsOrigin()).toEqual(['https://app.example.com', 'https://admin.example.com'])
	})

	test('never returns true — reflecting any origin must not be reachable by config', () => {
		for (const value of ['true', '1', 'yes']) {
			process.env[ENV] = value
			const got = corsOrigin()
			expect(got).not.toBe(true)
			expect(Array.isArray(got) || got === false).toBe(true)
		}
	})

	test('a WILDCARD ENTRY is refused, not passed through as an origin string', () => {
		// This test used to assert only `not.toBe(true)` and pass happily on
		// ['*'] — pinning the TYPE while the security property leaked. But
		// @fastify/cors collapses an origins array containing '*' to origin
		// '*', so `CORS_ALLOWED_ORIGINS=*` reinstated by configuration the
		// exact `origin: true` this module exists to remove.
		process.env[ENV] = '*'
		expect(corsOrigin()).toBe(false)
	})

	test("'null' is refused too — it is the Origin of a sandboxed iframe", () => {
		process.env[ENV] = 'null'
		expect(corsOrigin()).toBe(false)
		process.env[ENV] = 'NULL'
		expect(corsOrigin()).toBe(false)
	})

	test('one bad entry does not deny the good ones', () => {
		// Filtered, not rejected wholesale: an operator who adds '*' beside a
		// real origin keeps the real origin working.
		process.env[ENV] = 'https://app.example.com,*'
		expect(corsOrigin()).toEqual(['https://app.example.com'])
	})
})

describe('CORS_METHODS', () => {
	test('names only methods the API actually serves', () => {
		// Enumerated 2026-07-31: 6 GET, 3 DELETE, 1 POST (/images/similar).
		// PUT and PATCH have no routes at all and must not be pre-approved.
		expect(CORS_METHODS).toContain('GET')
		expect(CORS_METHODS).toContain('DELETE')
		expect(CORS_METHODS).toContain('POST')
		expect(CORS_METHODS).not.toContain('PUT')
		expect(CORS_METHODS).not.toContain('PATCH')
	})
})

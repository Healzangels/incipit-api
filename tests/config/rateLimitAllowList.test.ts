import rateLimit from '@fastify/rate-limit'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import Fastify, { FastifyRequest } from 'fastify'

import { rateLimitAllowList } from '#config/rateLimitAllowList'

// Minimal stand-in for the fields rateLimitAllowList / isIpAllowed read.
function req(ip = '127.0.0.1'): FastifyRequest {
	return { headers: {}, ip } as unknown as FastifyRequest
}

describe('rateLimitAllowList predicate', () => {
	let saved: string | undefined
	beforeEach(() => {
		saved = process.env.RATE_LIMIT_ALLOWLIST
		delete process.env.RATE_LIMIT_ALLOWLIST
	})
	afterEach(() => {
		if (saved === undefined) delete process.env.RATE_LIMIT_ALLOWLIST
		else process.env.RATE_LIMIT_ALLOWLIST = saved
	})

	it('returns false when unconfigured, so every client stays rate-limited', () => {
		expect(rateLimitAllowList(req('192.0.2.50'))).toBe(false)
	})

	it('exempts an exact allowlisted IP and nothing else', () => {
		process.env.RATE_LIMIT_ALLOWLIST = '192.0.2.10'
		expect(rateLimitAllowList(req('192.0.2.10'))).toBe(true)
		expect(rateLimitAllowList(req('192.0.2.11'))).toBe(false)
	})

	it('supports CIDR ranges (matches DELETE_ALLOWED_IPS convention)', () => {
		process.env.RATE_LIMIT_ALLOWLIST = '192.0.2.0/24'
		expect(rateLimitAllowList(req('192.0.2.200'))).toBe(true)
		// Counter-example must be PUBLIC. It used to be 192.168.0.1, which is
		// now exempt for a different and deliberate reason (direct local
		// infrastructure) -- leaving it here would have made this test look like
		// a regression rather than what it checks, which is that a non-member of
		// the configured range is denied.
		expect(rateLimitAllowList(req('198.51.100.7'))).toBe(false)
	})

	it('accepts a comma-separated mix of IPs and CIDRs', () => {
		process.env.RATE_LIMIT_ALLOWLIST = '127.0.0.1, 192.0.2.0/24'
		expect(rateLimitAllowList(req('127.0.0.1'))).toBe(true)
		expect(rateLimitAllowList(req('192.0.2.5'))).toBe(true)
		expect(rateLimitAllowList(req('8.8.8.8'))).toBe(false)
	})

	it('re-parses when the env value changes (memo keyed on the raw string)', () => {
		process.env.RATE_LIMIT_ALLOWLIST = '192.0.2.10'
		expect(rateLimitAllowList(req('192.0.2.10'))).toBe(true)
		expect(rateLimitAllowList(req('198.51.100.10'))).toBe(false)
		// Change the env: the memo must invalidate, not serve the old list.
		process.env.RATE_LIMIT_ALLOWLIST = '198.51.100.10'
		expect(rateLimitAllowList(req('198.51.100.10'))).toBe(true)
		expect(rateLimitAllowList(req('192.0.2.10'))).toBe(false)
		// Unset entirely: back to "everyone limited".
		delete process.env.RATE_LIMIT_ALLOWLIST
		expect(rateLimitAllowList(req('198.51.100.10'))).toBe(false)
	})
})

describe('@fastify/rate-limit honours the allowlist end-to-end', () => {
	let saved: string | undefined
	beforeEach(() => {
		saved = process.env.RATE_LIMIT_ALLOWLIST
	})
	afterEach(() => {
		if (saved === undefined) delete process.env.RATE_LIMIT_ALLOWLIST
		else process.env.RATE_LIMIT_ALLOWLIST = saved
	})

	async function app() {
		const f = Fastify()
		await f.register(rateLimit, {
			global: true,
			max: 2,
			timeWindow: '1 minute',
			allowList: rateLimitAllowList
		})
		f.get('/ping', async () => ({ ok: true }))
		await f.ready()
		return f
	}

	it('429s a non-allowlisted IP past the limit but never an allowlisted one', async () => {
		process.env.RATE_LIMIT_ALLOWLIST = '192.0.2.10'
		const f = await app()
		try {
			const other = '192.0.2.50'
			expect(
				(await f.inject({ method: 'GET', url: '/ping', remoteAddress: other })).statusCode
			).toBe(200)
			expect(
				(await f.inject({ method: 'GET', url: '/ping', remoteAddress: other })).statusCode
			).toBe(200)
			// third request from the same non-allowlisted IP trips max=2
			expect(
				(await f.inject({ method: 'GET', url: '/ping', remoteAddress: other })).statusCode
			).toBe(429)

			// the allowlisted IP bursts well past the limit and is never throttled
			for (let i = 0; i < 6; i++) {
				const res = await f.inject({ method: 'GET', url: '/ping', remoteAddress: '192.0.2.10' })
				expect(res.statusCode).toBe(200)
			}
		} finally {
			await f.close()
		}
	})
})

/**
 * The container-to-host hop must not be rate-limited.
 *
 * This is the defect these tests exist for, measured on a from-scratch rebuild
 * of 1,591 albums: RATE_LIMIT_ALLOWLIST was set to the operator's LAN and a LAN
 * client was correctly exempt, but the Plex agent calls the API at the HOST
 * address from INSIDE the Plex container, so what arrived was a docker-bridge
 * address the LAN CIDR did not cover. It 429'd its own scan. 34 albums silently
 * kept their raw file-tag titles and three more went unmatched, with nothing in
 * the response to suggest the allowlist was the problem.
 *
 * The exemption is deliberately narrow: DIRECT (unproxied) requests only. The
 * second block is the security boundary and matters more than the first -- a
 * private source address is trivially forgeable as an X-Forwarded-For value, so
 * anything arriving through a proxy has to be judged on the configured list.
 */
describe('direct local infrastructure is exempt without configuration', () => {
	let saved: string | undefined
	beforeEach(() => {
		saved = process.env.RATE_LIMIT_ALLOWLIST
		delete process.env.RATE_LIMIT_ALLOWLIST
	})
	afterEach(() => {
		if (saved === undefined) delete process.env.RATE_LIMIT_ALLOWLIST
		else process.env.RATE_LIMIT_ALLOWLIST = saved
	})

	it('exempts docker-bridge, loopback and LAN sources with no allowlist set', () => {
		// 172.16/12 is the range docker hands out; this is the exact case that broke.
		expect(rateLimitAllowList(req('172.18.0.5'))).toBe(true)
		expect(rateLimitAllowList(req('127.0.0.1'))).toBe(true)
		expect(rateLimitAllowList(req('10.0.1.99'))).toBe(true)
		expect(rateLimitAllowList(req('192.168.1.20'))).toBe(true)
	})

	it('still rate-limits a public client', () => {
		expect(rateLimitAllowList(req('8.8.8.8'))).toBe(false)
		expect(rateLimitAllowList(req('198.51.100.7'))).toBe(false)
	})

	it('does NOT exempt a proxied request, even from a private source', () => {
		// A reverse proxy on the LAN forwarding a public client: request.ip may
		// be private, but the presence of x-forwarded-for means this is not our
		// own infrastructure talking to itself.
		const proxied = {
			headers: { 'x-forwarded-for': '8.8.8.8' },
			ip: '172.18.0.9'
		} as unknown as FastifyRequest
		expect(rateLimitAllowList(proxied)).toBe(false)
	})

	it('a proxied request is still exempt when the resolved client IS allowlisted', () => {
		// trustProxy resolves request.ip to the real client; the configured list
		// governs, exactly as before this change.
		process.env.RATE_LIMIT_ALLOWLIST = '203.0.113.5'
		const proxied = {
			headers: { 'x-forwarded-for': '203.0.113.5' },
			ip: '203.0.113.5'
		} as unknown as FastifyRequest
		expect(rateLimitAllowList(proxied)).toBe(true)
	})
})

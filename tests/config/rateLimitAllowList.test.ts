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
		expect(rateLimitAllowList(req('192.168.0.1'))).toBe(false)
	})

	it('accepts a comma-separated mix of IPs and CIDRs', () => {
		process.env.RATE_LIMIT_ALLOWLIST = '127.0.0.1, 192.0.2.0/24'
		expect(rateLimitAllowList(req('127.0.0.1'))).toBe(true)
		expect(rateLimitAllowList(req('192.0.2.5'))).toBe(true)
		expect(rateLimitAllowList(req('8.8.8.8'))).toBe(false)
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

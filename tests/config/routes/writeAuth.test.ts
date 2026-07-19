import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import Fastify, { FastifyRequest } from 'fastify'

import { isDeleteAllowed, requireDeleteAuth } from '#config/routes/writeAuth'

// Minimal stand-in for the fields isDeleteAllowed / isIpAllowed read.
function req(over: { token?: string; ip?: string; xff?: string } = {}): FastifyRequest {
	const headers: Record<string, string> = {}
	if (over.token !== undefined) headers['x-delete-token'] = over.token
	if (over.xff !== undefined) headers['x-forwarded-for'] = over.xff
	return { headers, ip: over.ip ?? '127.0.0.1', log: { warn() {} } } as unknown as FastifyRequest
}

describe('isDeleteAllowed (destructive routes default CLOSED)', () => {
	let token: string | undefined
	let ips: string | undefined
	beforeEach(() => {
		token = process.env.DELETE_AUTH_TOKEN
		ips = process.env.DELETE_ALLOWED_IPS
		delete process.env.DELETE_AUTH_TOKEN
		delete process.env.DELETE_ALLOWED_IPS
	})
	afterEach(() => {
		token === undefined
			? delete process.env.DELETE_AUTH_TOKEN
			: (process.env.DELETE_AUTH_TOKEN = token)
		ips === undefined
			? delete process.env.DELETE_ALLOWED_IPS
			: (process.env.DELETE_ALLOWED_IPS = ips)
	})

	it('denies when neither a token nor an allowlist is configured', () => {
		expect(isDeleteAllowed(req({ token: 'anything' }))).toBe(false)
	})

	it('allows the correct token and denies a wrong or missing one', () => {
		process.env.DELETE_AUTH_TOKEN = 'sekret'
		expect(isDeleteAllowed(req({ token: 'sekret' }))).toBe(true)
		expect(isDeleteAllowed(req({ token: 'nope' }))).toBe(false)
		expect(isDeleteAllowed(req({}))).toBe(false)
	})

	it('does not throw and denies when the token length differs (timingSafeEqual guard)', () => {
		process.env.DELETE_AUTH_TOKEN = 'a-long-token'
		expect(isDeleteAllowed(req({ token: 'x' }))).toBe(false)
	})

	it('allows a request from an allowlisted IP', () => {
		process.env.DELETE_ALLOWED_IPS = '10.0.1.0/24'
		expect(isDeleteAllowed(req({ ip: '10.0.1.50' }))).toBe(true)
		expect(isDeleteAllowed(req({ ip: '192.168.0.1' }))).toBe(false)
	})
})

describe('requireDeleteAuth preHandler', () => {
	let token: string | undefined
	beforeEach(() => {
		token = process.env.DELETE_AUTH_TOKEN
		delete process.env.DELETE_AUTH_TOKEN
	})
	afterEach(() => {
		token === undefined
			? delete process.env.DELETE_AUTH_TOKEN
			: (process.env.DELETE_AUTH_TOKEN = token)
	})

	async function appWithGuardedRoute() {
		const app = Fastify()
		app.delete('/guarded', { preHandler: requireDeleteAuth }, async () => ({ ok: true }))
		await app.ready()
		return app
	}

	it('403s an unauthorized delete before the handler runs', async () => {
		const app = await appWithGuardedRoute()
		const res = await app.inject({ method: 'DELETE', url: '/guarded' })
		expect(res.statusCode).toBe(403)
		// The handler never ran (no { ok: true }); Fastify serialized the 403 error.
		expect(res.json()).not.toEqual({ ok: true })
		await app.close()
	})

	it('lets an authorized delete through to the handler', async () => {
		process.env.DELETE_AUTH_TOKEN = 'sekret'
		const app = await appWithGuardedRoute()
		const res = await app.inject({
			method: 'DELETE',
			url: '/guarded',
			headers: { 'x-delete-token': 'sekret' }
		})
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual({ ok: true })
		await app.close()
	})
})

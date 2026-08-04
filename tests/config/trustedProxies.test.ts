import { afterEach, describe, expect, mock, test } from 'bun:test'

/**
 * WHO MAY SET `request.ip`.
 *
 * Trusting a proxy means letting it choose the address every IP allowlist is
 * then checked against — and writeAuth.ts grants DELETE on an IP match with no
 * token at all. So this list is authentication, and it needs tests that fail
 * when it widens.
 *
 * The specific regression these pin: Cloudflare's ~22 ranges were merged in
 * unconditionally. Anyone can originate traffic from Cloudflare (a free Worker
 * is enough), so `X-Forwarded-For: 127.0.0.1` from there made proxy-addr hand
 * back `127.0.0.1` as request.ip — satisfying DELETE_ALLOWED_IPS with no token.
 */

let cloudflareCalls = 0
mock.module('#helpers/utils/cloudflareIps', () => ({
	getAllIps: async () => {
		cloudflareCalls += 1
		return ['173.245.48.0/20', '103.21.244.0/22']
	}
}))

const { buildTrustedProxies, userTrustedProxies } = await import('#config/trustedProxies')

afterEach(() => {
	delete process.env.TRUST_CLOUDFLARE
	delete process.env.TRUSTED_PROXIES
	cloudflareCalls = 0
})

describe('buildTrustedProxies', () => {
	test('does NOT trust Cloudflare unless asked', async () => {
		expect(await buildTrustedProxies()).toEqual(['127.0.0.1'])
	})

	test('does not even FETCH the Cloudflare ranges when disabled', async () => {
		// Stronger than checking the result: proves the gate short-circuits before
		// the network call, so a fetch failure can never widen trust by accident.
		await buildTrustedProxies()
		expect(cloudflareCalls).toBe(0)
	})

	test('merges Cloudflare only on the explicit opt-in', async () => {
		process.env.TRUST_CLOUDFLARE = 'true'
		const out = await buildTrustedProxies()
		expect(out).toContain('173.245.48.0/20')
		expect(out).toContain('127.0.0.1')
		expect(cloudflareCalls).toBe(1)
	})

	test('only the exact string "true" opts in', async () => {
		for (const v of ['1', 'yes', 'TRUE', 'True', '']) {
			process.env.TRUST_CLOUDFLARE = v
			expect(await buildTrustedProxies()).toEqual(['127.0.0.1'])
		}
	})

	test('keeps the operator list and adds nothing when Cloudflare is off', async () => {
		process.env.TRUSTED_PROXIES = '10.0.0.5, 172.16.0.0/12'
		expect(await buildTrustedProxies()).toEqual(['10.0.0.5', '172.16.0.0/12'])
	})

	test('a Cloudflare fetch failure narrows to the operator list, never widens', async () => {
		process.env.TRUST_CLOUDFLARE = 'true'
		process.env.TRUSTED_PROXIES = '10.0.0.5'
		mock.module('#helpers/utils/cloudflareIps', () => ({
			getAllIps: async () => {
				throw new Error('cloudflare unreachable')
			}
		}))
		const mod = await import('#config/trustedProxies?fail')
		expect(await mod.buildTrustedProxies()).toEqual(['10.0.0.5'])
	})
})

describe('userTrustedProxies', () => {
	test('defaults to loopback only', () => {
		expect(userTrustedProxies()).toEqual(['127.0.0.1'])
	})

	test('drops empty entries a trailing comma would produce', () => {
		// '10.0.0.5,' used to yield ['10.0.0.5', ''] and an empty string in a
		// trust list is a parser's guess, not an address.
		process.env.TRUSTED_PROXIES = '10.0.0.5, ,'
		expect(userTrustedProxies()).toEqual(['10.0.0.5'])
	})
})

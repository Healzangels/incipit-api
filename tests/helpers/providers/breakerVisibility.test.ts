import { describe, expect, test } from 'bun:test'

import AppleBooksProvider from '#helpers/providers/AppleBooksProvider'

/**
 * A TRANSPORT FAILURE MUST REACH THE CIRCUIT BREAKER.
 *
 * `ProviderRegistry` wraps each provider's search in `breakerFor(name).execute`,
 * and a thunk that RESOLVES is recorded as a success. Apple's search caught its
 * own transport errors and returned `[]`, so every refusal looked like "the
 * provider answered, with nothing" — and the breaker could never open.
 *
 * The registry's own comment records what that cost, measured on a 1,341-book
 * scan: Apple rate-limited us six minutes in and then refused 942 CONSECUTIVE
 * searches (751× 429, 191× 403) for the rest of the run. Every one was a doomed
 * round-trip, and each also kept Apple unusable for the square-cover lookup that
 * runs on every book response.
 *
 * The distinction that matters, and the reason this isn't just "remove the
 * catch": a provider that genuinely has no results for a title must still
 * resolve to `[]`. Only a transport failure propagates.
 */
describe('AppleBooksProvider.search', () => {
	const provider = (searchFetch: () => Promise<never[]>) =>
		new AppleBooksProvider({ searchFetch: searchFetch as never })

	test('a TRANSPORT failure propagates, so the breaker can see it', async () => {
		const p = provider(() => Promise.reject(new Error('429 Too Many Requests')))
		await expect(p.search({ title: 'Mistborn', region: 'us' } as never)).rejects.toThrow(/429/)
	})

	test('a genuinely EMPTY result still resolves — that is not a failure', async () => {
		const p = provider(() => Promise.resolve([]))
		await expect(p.search({ title: 'Mistborn', region: 'us' } as never)).resolves.toEqual([])
	})

	test('a missing title still short-circuits to empty without touching transport', async () => {
		let called = false
		const p = provider(() => {
			called = true
			return Promise.resolve([])
		})
		await expect(p.search({ region: 'us' } as never)).resolves.toEqual([])
		expect(called).toBe(false)
	})
})

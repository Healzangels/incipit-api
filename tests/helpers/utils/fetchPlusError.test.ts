import { describe, expect, test } from 'bun:test'

import { FetchError } from '#helpers/utils/fetchPlus'

/**
 * Pins the SHAPE of the error fetchPlus rejects with.
 *
 * Consumers branch on the HTTP status to decide policy -- the Goodreads client
 * stands down for a cooldown on a 429/503, and treats a 404 as a real "not
 * found" worth caching. That client read `err.response?.status`, which no
 * fetchPlus rejection has ever carried, so the stand-down silently never fired
 * and the mirror rate-limited us off. Its own unit test passed only because it
 * fabricated the `{response:{status}}` shape it expected.
 *
 * This file exists so that mistake cannot recur unnoticed: any consumer's
 * assumption about the error shape is checked here against the real class, in a
 * file that deliberately does NOT mock fetchPlus.
 */
describe('FetchError shape (the contract consumers branch on)', () => {
	test('carries the status TOP-LEVEL, not under .response', () => {
		const err = new FetchError('Request failed with status 429', 429)
		expect(err.status).toBe(429)
		// The shape that fooled the Goodreads backoff: it must stay absent, so a
		// consumer reading it gets undefined here exactly as it would in production.
		expect((err as unknown as { response?: unknown }).response).toBeUndefined()
	})

	test('is an Error named FetchError and can carry a network code', () => {
		const err = new FetchError('timeout of 8000ms exceeded', undefined, 'ECONNABORTED')
		expect(err).toBeInstanceOf(Error)
		expect(err.name).toBe('FetchError')
		expect(err.code).toBe('ECONNABORTED')
		// A network failure has no HTTP status at all -- consumers must treat that
		// as "no answer" rather than as a status they can compare.
		expect(err.status).toBeUndefined()
	})
})

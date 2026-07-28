import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

import { fakeRedis } from '#tests/setup/fakeRedis'

// Pacing off: this file asserts the BACKOFF, not the inter-request gap.
process.env.GOODREADS_MIN_GAP_MS = '0'

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { fetchGoodreadsAuthorInfo, withGoodreadsAuthorInfo, resetGoodreadsThrottle } =
	await import('#helpers/providers/goodreadsSeries')

// The throttle state lives in the module, which is SHARED across test files in a
// single process: leaving the backoff tripped blanks every later Goodreads test
// (measured: 7 sibling failures, and which ones depended on file order).
afterAll(() => resetGoodreadsThrottle())
// ...and SHARED between the tests in THIS file too. Each one below trips the
// backoff; without a fresh start the first test only passed when it ran first
// (its "network was hit" assertion fails under --randomize), and the miss-cache
// test passed VACUOUSLY -- the tripped backoff short-circuited before any fetch
// or cache write, so "nothing was cached" was true because nothing had happened.
beforeEach(() => resetGoodreadsThrottle())

/**
 * Rate-limit backoff, in its own file on purpose: tripping the backoff sets
 * module-level state that suppresses every later call for a cooldown, which would
 * silently blank out sibling tests sharing the module.
 *
 * Origin: bookinfo.pro answered "Server capacity exceeded" (HTTP 429) during a
 * live author enrichment pass and then stopped answering at all. A 429'd author
 * comes back with no portrait -- indistinguishable from an author who genuinely
 * has none -- so hammering it costs real data as well as being impolite.
 */
// The REAL rejection shape: fetchPlus throws FetchError, which carries `status`
// TOP-LEVEL and has no `.response`. An earlier version of this helper faked
// `{response:{status}}` -- a shape fetchPlus never emits -- so it green-lit a
// backoff that could not fire in production. The class itself cannot be imported
// here because this file mocks the module it lives in, so the shape is built by
// hand; fetchPlusError.test.ts pins that shape against the real implementation.
function rejectWithStatus(status: number) {
	fetchMock.mockReset()
	fetchMock.mockImplementation(() =>
		Promise.reject(
			Object.assign(new Error('Request failed with status ' + status), {
				name: 'FetchError',
				status
			})
		)
	)
}

describe('bookinfo.pro rate-limit backoff', () => {
	test('a 429 stands the client down: later calls are skipped without hitting the network', async () => {
		rejectWithStatus(429)

		// First lookup takes the 429 and trips the backoff.
		expect(await fetchGoodreadsAuthorInfo('Jessica Townsend')).toEqual({ image: null, bio: null })
		const callsAfter429 = fetchMock.mock.calls.length
		expect(callsAfter429).toBeGreaterThan(0)

		// Subsequent lookups must not add to the pile while standing down.
		expect(await fetchGoodreadsAuthorInfo('Graham McNeill')).toEqual({ image: null, bio: null })
		expect(await fetchGoodreadsAuthorInfo('Martin Gurri')).toEqual({ image: null, bio: null })
		expect(fetchMock.mock.calls.length).toBe(callsAfter429)
	})

	test('a rate-limit and the stand-down that follows are both LOGGED', async () => {
		// The whole reason a missing author portrait took five diagnostic steps: a
		// 429, a stand-down skip and a genuine "no such author" all returned null
		// with no trace, so production could not tell them apart.
		rejectWithStatus(429)
		const warns: string[] = []
		const debugs: string[] = []
		const logger = {
			warn: (_o: unknown, msg?: string) => warns.push(String(msg ?? '')),
			debug: (_o: unknown, msg?: string) => debugs.push(String(msg ?? '')),
			info: () => undefined,
			error: () => undefined
		} as never

		await fetchGoodreadsAuthorInfo('Jessica Townsend', logger)
		expect(warns.some((m) => m.includes('rate-limited'))).toBe(true)

		// The NEXT call is skipped by the backoff -- that skip must say so too.
		await fetchGoodreadsAuthorInfo('Graham McNeill', logger)
		expect(debugs.some((m) => m.includes('standing down'))).toBe(true)
	})

	test('a rate-limited miss is NOT cached (a throttled scan must not blank the library)', async () => {
		// The dangerous interaction: miss-caching exists so a photo-less author is not
		// re-queried forever, but a null produced while throttled says nothing about
		// whether a photo exists. Caching it during a full-library refresh would pin
		// "no portrait" on every author processed in that window for the whole TTL.
		rejectWithStatus(429)
		const redis = fakeRedis()

		const out = await withGoodreadsAuthorInfo('Jessica Townsend', redis)
		expect(out).toEqual({ image: null, bio: null })
		// The 429 actually happened IN THIS TEST -- without this, a backoff left
		// tripped by an earlier test made both assertions pass with no fetch and
		// no cache decision at all.
		expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
		expect(redis.store.size).toBe(0) // nothing written -> it will retry later
	})
})

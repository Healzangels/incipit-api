import { afterAll, describe, expect, mock, test } from 'bun:test'

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

/** Minimal in-memory stand-in for the redis client the route passes. */
function fakeRedis() {
	const store = new Map<string, string>()
	return {
		store,
		get: async (k: string) => store.get(k) ?? null,
		set: async (k: string, v: string) => {
			store.set(k, v)
			return 'OK'
		}
	}
}

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
function rejectWithStatus(status: number) {
	fetchMock.mockReset()
	fetchMock.mockImplementation(() =>
		Promise.reject(Object.assign(new Error('rate limited'), { response: { status } }))
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

	test('a rate-limited miss is NOT cached (a throttled scan must not blank the library)', async () => {
		// The dangerous interaction: miss-caching exists so a photo-less author is not
		// re-queried forever, but a null produced while throttled says nothing about
		// whether a photo exists. Caching it during a full-library refresh would pin
		// "no portrait" on every author processed in that window for the whole TTL.
		rejectWithStatus(429)
		const redis = fakeRedis()

		const out = await withGoodreadsAuthorInfo('Jessica Townsend', redis)
		expect(out).toEqual({ image: null, bio: null })
		expect(redis.store.size).toBe(0) // nothing written -> it will retry later
	})
})

import { describe, expect, mock, test } from 'bun:test'

// Pacing off: this file asserts the BACKOFF, not the inter-request gap.
process.env.GOODREADS_MIN_GAP_MS = '0'

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { fetchGoodreadsAuthorInfo } = await import('#helpers/providers/goodreadsSeries')

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
})

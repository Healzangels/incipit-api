import { afterAll, describe, expect, mock, test } from 'bun:test'

// The ONLY suite that leaves pacing ON. Every other Goodreads suite sets
// GOODREADS_MIN_GAP_MS=0 (the real 1.1s gap would add ~45s for no coverage),
// which left the pacer -- the thing standing between us and being rate-limited
// off a free community mirror -- with zero tests. A small gap is used here so the
// behaviour is asserted without the wall-clock cost.
const GAP_MS = 40
process.env.GOODREADS_MIN_GAP_MS = String(GAP_MS)

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { fetchGoodreadsAuthorInfo, resetGoodreadsThrottle } = await import(
	'#helpers/providers/goodreadsSeries'
)

// Pacing state is module-level and shared across files in one process.
afterAll(() => {
	process.env.GOODREADS_MIN_GAP_MS = '0'
	resetGoodreadsThrottle()
})

describe('bookinfo.pro outbound pacing', () => {
	test('holds a minimum gap between calls, even when issued concurrently', async () => {
		resetGoodreadsThrottle()
		const at: number[] = []
		fetchMock.mockReset()
		fetchMock.mockImplementation(() => {
			at.push(Date.now())
			// One search hit -> one /author call, so each lookup makes 2 requests.
			return Promise.resolve({ data: [{ author: { id: 1 } }] })
		})

		// Fire three lookups at once: the pacer must serialize them rather than let
		// them all leave together, which is what buries the mirror during a scan.
		await Promise.all([
			fetchGoodreadsAuthorInfo('Author One'),
			fetchGoodreadsAuthorInfo('Author Two'),
			fetchGoodreadsAuthorInfo('Author Three')
		])

		expect(at.length).toBeGreaterThan(1)
		const gaps = at.slice(1).map((t, i) => t - at[i])
		// Allow a little scheduler slop, but every pair must be genuinely spaced --
		// without the pacer these land in the same millisecond.
		for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(GAP_MS - 10)
	})

	test('a single lookup is not delayed before its first request', async () => {
		resetGoodreadsThrottle()
		fetchMock.mockReset()
		fetchMock.mockImplementation(() => Promise.resolve({ data: [] }))
		const started = Date.now()
		await fetchGoodreadsAuthorInfo('Someone')
		// The gap is enforced BETWEEN calls; the first must not pay it, or every
		// cold lookup would eat the full gap for nothing.
		expect(Date.now() - started).toBeLessThan(GAP_MS)
	})
})

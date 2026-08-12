import { afterAll, describe, expect, mock, test } from 'bun:test'

// The ONLY suite that leaves pacing ON. Every other Goodreads suite sets
// GOODREADS_MIN_GAP_MS=0 (the real 1.1s gap would add ~45s for no coverage),
// which left the pacer -- the thing standing between us and being rate-limited
// off a free community mirror -- with zero tests. A small gap is used here so the
// behaviour is asserted without the wall-clock cost.
const GAP_MS = 40
process.env.GOODREADS_MIN_GAP_MS = String(GAP_MS)
// Short enough that a REGRESSION costs a few seconds, not the 60s default -- a
// test that fails by hanging is one people learn to skip.
const BACKOFF_MS = 3000

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

	test('a caller ALREADY QUEUED when a 429 lands is shed, not parked for the cooldown', async () => {
		// Pins the pacer policy goodreadsSeries chooses ('shed', not the default
		// 'wait'). getJson's standingDown() guard cannot cover this: these callers
		// passed it before the push-back existed, and only reach the pacer after.
		// Under 'wait' each would sleep out the remaining cooldown ON A SERVE PATH
		// -- 60s in production. Nothing else in the suite fails if that flips.
		resetGoodreadsThrottle()
		process.env.GOODREADS_BACKOFF_MS = String(BACKOFF_MS)
		fetchMock.mockReset()
		let n = 0
		fetchMock.mockImplementation(() => {
			n += 1
			// The FIRST request is pushed back, arming the stand-down while the
			// callers behind it are already waiting their turn.
			if (n === 1)
				return Promise.reject(Object.assign(new Error('too many requests'), { status: 429 }))
			return Promise.resolve({ data: [] })
		})

		const started = Date.now()
		await Promise.all([
			fetchGoodreadsAuthorInfo('Queued One'),
			fetchGoodreadsAuthorInfo('Queued Two'),
			fetchGoodreadsAuthorInfo('Queued Three'),
			fetchGoodreadsAuthorInfo('Queued Four')
		])
		// Shed: each waits only its own 40ms gap. Parked: at least BACKOFF_MS.
		expect(Date.now() - started).toBeLessThan(BACKOFF_MS / 3)
		process.env.GOODREADS_BACKOFF_MS = '0'
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

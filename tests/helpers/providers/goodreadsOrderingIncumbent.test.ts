import { afterEach, describe, expect, mock, test } from 'bun:test'

// Same transport mock as goodreadsSeries.test.ts: the REAL resolver runs over
// fixture payloads. This file covers ONE decision -- whether a variant-only
// Goodreads answer may replace the provider series -- and the answer now turns
// on whether the provider series is itself a reading ORDER.
// See docs/design/spec-ordering-only-shelf-split.md.
const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')

function respond(...bodies: unknown[]) {
	fetchMock.mockReset()
	for (const body of bodies) fetchMock.mockImplementationOnce(() => Promise.resolve({ data: body }))
}

const members = (n: number) => Array.from({ length: n }, (_, i) => ({ ForeignWorkId: 9000 + i }))

// Every id is per-test: seriesRecord memoizes /series/{id} for the PROCESS
// lifetime, so a test that reuses another test's id reads that test's record and
// never consumes its own fixture. The call-count assertions are what catch it.
const work = (
	workId: number,
	chronId: number,
	pubId: number,
	position: string,
	pubPosition = '1'
) => ({
	Title: 'The Happy Return',
	Series: [
		{
			Title: 'Hornblower Saga: Chronological Order',
			ForeignId: chronId,
			LinkItems: [{ ForeignWorkId: workId, PositionInSeries: position }]
		},
		{
			Title: 'Hornblower Saga: Publication Order',
			ForeignId: pubId,
			LinkItems: [{ ForeignWorkId: workId, PositionInSeries: pubPosition }]
		}
	]
})

const book = (seriesPrimary: { name: string; position: string } | null) => ({
	asin: 'B0045T93UU',
	title: 'The Happy Return',
	authors: [{ name: 'C. S. Forester' }],
	...(seriesPrimary ? { seriesPrimary } : {})
})

describe('a variant-only answer may replace an ORDERING incumbent, never a clean one', () => {
	afterEach(() => fetchMock.mockReset())

	test("an ordering incumbent is released: Audible's reading order loses to Goodreads'", async () => {
		// Live on prod 2026-09-08. Goodreads has no plain Hornblower series, only
		// two reading orders, so every candidate is demoted and the answer is
		// variantOnly. Audible names its own reading order for the eight books it
		// knows, and the three it does not know took the Goodreads name -- one
		// continuum, three shelves.
		respond(
			[{ workId: 1178411 }],
			work(1178411, 549812, 549813, '6'),
			{ LinkItems: members(31) },
			{ LinkItems: members(12) }
		)
		const out = (await withGoodreadsSeries(book({
			name: 'Horatio Hornblower (chronological order)',
			position: '6'
		}) as never, null)) as { seriesPrimary?: { name?: string; position?: string } }
		expect(out.seriesPrimary).toEqual({
			name: 'Hornblower Saga: Chronological Order',
			position: '6'
		})
		// search + work + BOTH series records: the pool really was built and ranked.
		expect(fetchMock.mock.calls.length).toBe(4)
	})

	test('CONTROL: a CLEAN incumbent is still kept, because a fallback cannot spend a real shelf', async () => {
		// The refusal this rule narrows, unchanged: Foundation #0.5 must not become
		// "Foundation (Chronological Order) #1". Identical fixtures, and the only
		// difference is that the provider named a shelf rather than an order.
		respond(
			[{ workId: 2178411 }],
			work(2178411, 649812, 649813, '6'),
			{ LinkItems: members(31) },
			{ LinkItems: members(12) }
		)
		const out = (await withGoodreadsSeries(book({
			name: 'Horatio Hornblower',
			position: '6'
		}) as never, null)) as { seriesPrimary?: { name?: string; position?: string } }
		expect(out.seriesPrimary).toEqual({ name: 'Horatio Hornblower', position: '6' })
		expect(fetchMock.mock.calls.length).toBe(4)
	})

	test('CONTROL: an ordering incumbent is KEPT when the answer cannot number the book', async () => {
		// A Gift of Dragons, 2026-08-18: releasing the ordering for a positionless
		// answer trades an ugly shelf for NO shelf, because shelf policy demotes a
		// positionless primary to the tag slot. The shelvable-position guard sits
		// downstream of the release on purpose; this pins that ordering.
		respond(
			[{ workId: 3178411 }],
			// BOTH listings unnumbered for this work: with one of them numbered the
			// ranking would answer from that one, which is shelvable, and the guard
			// under test would never be reached.
			work(3178411, 749812, 749813, '5-7 omnibus', '8-11 omnibus'),
			{ LinkItems: members(31) },
			{ LinkItems: members(12) }
		)
		const out = (await withGoodreadsSeries(book({
			name: 'Horatio Hornblower (chronological order)',
			position: '7'
		}) as never, null)) as { seriesPrimary?: { name?: string; position?: string } }
		expect(out.seriesPrimary).toEqual({
			name: 'Horatio Hornblower (chronological order)',
			position: '7'
		})
	})

	test('a book with NO provider series is unaffected: it takes the variant-only answer as before', async () => {
		respond(
			[{ workId: 4178411 }],
			work(4178411, 849812, 849813, '6'),
			{ LinkItems: members(31) },
			{ LinkItems: members(12) }
		)
		const out = (await withGoodreadsSeries(book(null) as never, null)) as {
			seriesPrimary?: { name?: string; position?: string }
		}
		expect(out.seriesPrimary).toEqual({
			name: 'Hornblower Saga: Chronological Order',
			position: '6'
		})
		expect(fetchMock.mock.calls.length).toBe(4)
	})
})

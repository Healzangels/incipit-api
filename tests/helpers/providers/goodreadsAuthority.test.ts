import { afterEach, describe, expect, mock, test } from 'bun:test'

import { fakeRedis } from '#tests/setup/fakeRedis'

process.env.GOODREADS_MIN_GAP_MS = '0'

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { withGoodreadsSeries, resetGoodreadsThrottle } = await import(
	'#helpers/providers/goodreadsSeries'
)

/**
 * Goodreads as the series AUTHORITY, not just the gap-filler.
 *
 * WHY THIS CHANGED
 * A book's series used to come from whichever provider won the TITLE match, and
 * providers have incompatible taxonomies. Measured on Katherine Addison's
 * Chronicles of Osreth: Goblin Emperor matched Hardcover (#1), Witness and Grief
 * matched OverDrive (a flattened "Osreth: The Cemeteries of Amalo Trilogy" name
 * with numbering restarting at 1), Tomb matched Audible (#3). Three taxonomies
 * spliced into one shelf, with two "Book 1"s. Every provider was self-consistent;
 * mixing them was the bug.
 *
 * Goodreads answers the whole series in one taxonomy -- 1, 1.1, 2, 3, 4 -- and it
 * is the ordering readers (and this library's folders) actually use.
 *
 * WHY THE ADOPTION RULES ARE SO NARROW
 * As a gap-filler a wrong answer cost nothing: the field was empty. As authority
 * it OVERWRITES correct data and mis-shelves a book that was fine. Both guards
 * below come from a real record, not caution in the abstract.
 */

const respond = (...bodies: Array<unknown | null>) => {
	fetchMock.mockReset()
	for (const body of bodies) {
		if (body === null) fetchMock.mockImplementationOnce(() => Promise.reject(new Error('boom')))
		else fetchMock.mockImplementationOnce(() => Promise.resolve({ data: body }))
	}
}

/** A /work payload placing OUR work (id 42) in `series` at `position`. */
const work = (title: string, series: string, position: string | number | null) => ({
	Title: title,
	Series: [
		{
			Title: series,
			LinkItems: [
				{
					ForeignWorkId: 42,
					PositionInSeries: position == null ? undefined : String(position),
					SeriesPosition: typeof position === 'number' ? position : undefined
				}
			]
		}
	]
})

const book = (over: Record<string, unknown> = {}) => ({
	title: 'The Witness for the Dead',
	authors: [{ name: 'Katherine Addison' }],
	seriesPrimary: { name: 'Chronicles of Osreth: The Cemeteries of Amalo Trilogy', position: '1' },
	...over
})

describe('goodreads as series authority', () => {
	afterEach(() => {
		fetchMock.mockReset()
		resetGoodreadsThrottle()
	})

	test('a numeric Goodreads position OVERRIDES the provider series', async () => {
		// The headline case. OverDrive flattened the sub-series into the NAME and
		// restarted numbering, colliding with The Goblin Emperor at Book 1.
		respond([{ workId: 42 }], work('The Witness for the Dead', 'The Chronicles of Osreth', 2))
		const out = await withGoodreadsSeries(book(), fakeRedis())
		expect(out.seriesPrimary?.name).toBe('The Chronicles of Osreth')
		expect(out.seriesPrimary?.position).toBe('2')
	})

	test('a DECIMAL position survives', async () => {
		// Goodreads numbers novellas 1.1/1.5, which is where this library's folder
		// numbering comes from. Dropping the decimal would collide with book 1.
		respond([{ workId: 42 }], work('The Orb of Cairado', 'The Chronicles of Osreth', '1.1'))
		const out = await withGoodreadsSeries(
			book({ title: 'The Orb of Cairado', seriesPrimary: { name: 'Osreth', position: '1' } }),
			fakeRedis()
		)
		expect(out.seriesPrimary?.position).toBe('1.1')
	})

	test('NO position never overrides -- the provider keeps its shelf key', async () => {
		// Measured: Goodreads has "The Emperor's Soul" in Elantris with NO position
		// while the provider says Elantris #2. A name without a number cannot build
		// a sort title, so adopting it would DELETE the book's place on the shelf.
		respond([{ workId: 42 }], work("The Emperor's Soul", 'Elantris', null))
		const provider = { name: 'Elantris', position: '2' }
		const out = await withGoodreadsSeries(
			book({ title: "The Emperor's Soul", seriesPrimary: provider }),
			fakeRedis()
		)
		expect(out.seriesPrimary).toEqual(provider)
	})

	test('a NON-NUMERIC position never overrides', async () => {
		// Measured: Goodreads gives Konrad Curze position "The Primarchs Short
		// Story". Adopted verbatim that becomes "Book The Primarchs Short Story".
		respond(
			[{ workId: 42 }],
			work('Konrad Curze', 'The Horus Heresy', 'The Primarchs Short Story')
		)
		const provider = { name: 'The Horus Heresy: Primarchs', position: '12' }
		const out = await withGoodreadsSeries(
			book({ title: 'Konrad Curze', seriesPrimary: provider }),
			fakeRedis()
		)
		expect(out.seriesPrimary).toEqual(provider)
	})

	test('a Goodreads MISS leaves the provider series untouched', async () => {
		respond([])
		const provider = { name: 'Chronicles of Osreth', position: '3' }
		const out = await withGoodreadsSeries(book({ seriesPrimary: provider }), fakeRedis())
		expect(out.seriesPrimary).toEqual(provider)
	})

	test('a DEGRADED lookup never overrides', async () => {
		// A rate-limited lookup must never be read as "Goodreads has nothing to
		// say". Note the honest limit of this guard: it keeps THIS book on the
		// provider's series, but a 429 that starts mid-series still leaves books
		// converted before it and books after it unconverted, which is the very
		// mixed-taxonomy shape this feature exists to remove. What resolves that
		// is the 30-day cache plus never caching a degraded miss -- the next
		// refresh converts the stragglers and the shelf converges.
		respond(null)
		const provider = { name: 'Chronicles of Osreth', position: '3' }
		const out = await withGoodreadsSeries(book({ seriesPrimary: provider }), fakeRedis())
		expect(out.seriesPrimary).toEqual(provider)
	})

	test('a book with NO provider series is still gap-filled', async () => {
		// The original behaviour, which must survive: ~24% of updates arrive with
		// no series at all and the agent otherwise falls back to the folder path.
		respond([{ workId: 42 }], work('Warbreaker', 'Warbreaker', 1))
		const out = await withGoodreadsSeries(
			book({ title: 'Warbreaker', seriesPrimary: null }), fakeRedis())
		expect(out.seriesPrimary?.name).toBe('Warbreaker')
	})

	test('a book with no provider series takes even a position-less Goodreads answer', async () => {
		// The numeric-position rule guards OVERRIDES. With nothing to lose, a bare
		// series name still beats none -- the folder fallback can supply a number.
		respond([{ workId: 42 }], work('Arcanum Unbounded', 'The Cosmere', null))
		const out = await withGoodreadsSeries(
			book({ title: 'Arcanum Unbounded', seriesPrimary: null }), fakeRedis())
		expect(out.seriesPrimary?.name).toBe('The Cosmere')
	})

	test('the authority can be switched off without touching the code', async () => {
		// An escape hatch for a library-wide behaviour change: this rewrites sort
		// titles for every book where Goodreads and the provider disagree.
		process.env.GOODREADS_SERIES_AUTHORITY = '0'
		try {
			respond([{ workId: 42 }], work('The Witness for the Dead', 'The Chronicles of Osreth', 2))
			const provider = { name: 'Osreth: The Cemeteries of Amalo Trilogy', position: '1' }
			const out = await withGoodreadsSeries(book({ seriesPrimary: provider }), fakeRedis())
			expect(out.seriesPrimary).toEqual(provider)
			// ...and it must not have spent a request either.
			expect(fetchMock.mock.calls.length).toBe(0)
		} finally {
			delete process.env.GOODREADS_SERIES_AUTHORITY
		}
	})
})

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

/**
 * A /work payload placing OUR work (id 42) in `series` at `position`.
 *
 * `Authors` defaults to empty, which the author gate treats as "nothing to
 * check" -- so these fixtures exercise the series logic without every one of
 * them having to name an author. Pass `{author}` to exercise the gate itself.
 */
const work = (
	title: string,
	series: string,
	position: string | number | null,
	opts: { author?: string } = {}
) => ({
	Title: title,
	Authors: opts.author ? [{ Name: opts.author }] : [],
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

	test('a series-less first hit does not abandon the candidates behind it', async () => {
		// Measured on Pendergast. /search?q=White Fire Douglas Preston returns a
		// COMPANION work first -- titled "White Fire (Pendergast)", credited to
		// "BookBuddy", carrying no series editions -- with the real work third.
		// That first hit cleared the title gate and then hit `return null`, so the
		// two candidates behind it were never fetched and the book came back with
		// NO series at all, silently: the title gate logs its rejections, this
		// path logged nothing. Crimson Shore failed identically ("Brief Books").
		// Every other bail-out inside the candidate loop is a `continue`.
		respond(
			[{ workId: 7 }, { workId: 42 }],
			{ Title: 'White Fire', Authors: [{ Name: 'Douglas Preston' }], Series: [] },
			work('White Fire', 'Pendergast', 13)
		)
		const out = await withGoodreadsSeries(
			book({
				title: 'White Fire',
				authors: [{ name: 'Douglas Preston' }],
				seriesPrimary: null
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('Pendergast')
		expect(out.seriesPrimary?.position).toBe('13')
	})

	test('a work credited to someone else is skipped, not trusted', async () => {
		// The guard that makes walking deeper safe. Goodreads is full of summary
		// and companion records that carry the real title verbatim -- so they sail
		// through the 0.9 title gate -- but belong to a different author and a
		// different series. Without this, reaching candidate 2 to fix the bug
		// above would let one of them attach its series to a real book.
		respond(
			[{ workId: 7 }, { workId: 42 }],
			work('White Fire', "A Summarizer's Companion Series", 4, { author: 'BookBuddy' }),
			work('White Fire', 'Pendergast', 13)
		)
		const out = await withGoodreadsSeries(
			book({
				title: 'White Fire',
				authors: [{ name: 'Douglas Preston' }],
				seriesPrimary: null
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('Pendergast')
	})

	test('a work with no author data is still trusted', async () => {
		// The gate can only reject on a POSITIVE mismatch. The mirror omits
		// Authors on some works, and treating absent as wrong would throw away
		// good answers to guard against a hypothetical one.
		respond([{ workId: 42 }], { ...work('Warbreaker', 'Warbreaker', 1), Authors: [] })
		const out = await withGoodreadsSeries(
			book({ title: 'Warbreaker', seriesPrimary: null }),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('Warbreaker')
	})

	test('a marketing subtitle is retried without it', async () => {
		// Hardcover bakes marketing copy into the title. Measured live: "Esrever
		// Doom: A Fun-Filled Adventure into the Realm of Xanth" returns NO series,
		// while the bare "Esrever Doom" returns Xanth #37.
		//
		// The failure is in /search, NOT the title gate -- worth stating because
		// the obvious theory is wrong: titleSim already scores the bare title
		// against the full one at 1.0, so the gate would have accepted it. What
		// actually happens is that /search returns ZERO hits for the marketing
		// string, so there is never a candidate to gate. Hence the empty first
		// response below; a fixture that fed a hit here would pass with no fix at
		// all, having reproduced a mechanism that does not exist.
		respond(
			[], // 1st pass: /search finds nothing for the marketing title
			[{ workId: 42 }], // retry with the bare title
			work('Esrever Doom', 'Xanth', 37)
		)
		const out = await withGoodreadsSeries(
			book({
				title: 'Esrever Doom: A Fun-Filled Adventure into the Realm of Xanth',
				authors: [{ name: 'Piers Anthony' }],
				seriesPrimary: null
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('Xanth')
		expect(out.seriesPrimary?.position).toBe('37')
	})

	test('a title that already matched is never retried', async () => {
		// The retry must stay a MISS path. "Konrad Curze: The Night Haunter" is a
		// real colon title that resolves on the first pass, and stripping to
		// "Konrad Curze" would be a second lookup for a question already answered
		// -- against a mirror that 429s under load.
		respond([{ workId: 42 }], work('Konrad Curze: The Night Haunter', 'The Horus Heresy', 1))
		const out = await withGoodreadsSeries(
			book({ title: 'Konrad Curze: The Night Haunter', seriesPrimary: null }),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('The Horus Heresy')
		expect(fetchMock.mock.calls.length).toBe(2) // one search, one work. No retry.
	})

	test('a miss on a title with no subtitle costs no extra request', async () => {
		respond([{ workId: 42 }], work('Some Other Book', 'Some Other Series', 1))
		await withGoodreadsSeries(book({ title: 'Warbreaker', seriesPrimary: null }), fakeRedis())
		expect(fetchMock.mock.calls.length).toBe(2)
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

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
 * A /work payload placing OUR work (id 42 by default) in `series` at `position`.
 *
 * `Authors` defaults to empty, which the author gate treats as "nothing to
 * check" -- so these fixtures exercise the series logic without every one of
 * them having to name an author. Pass `{author}` to exercise the gate itself.
 *
 * Pass `{workId}` whenever the /search hit names a work other than 42. The
 * LinkItem has to NAME the work being looked up: positionFor only falls back to a
 * lone link when that link omits ForeignWorkId, precisely so a link belonging to a
 * different work cannot lend it its number.
 */
const work = (
	title: string,
	series: string,
	position: string | number | null,
	opts: { author?: string; workId?: number } = {}
) => ({
	Title: title,
	Authors: opts.author ? [{ Name: opts.author }] : [],
	Series: [
		{
			Title: series,
			LinkItems: [
				{
					ForeignWorkId: opts.workId ?? 42,
					PositionInSeries: position == null ? undefined : String(position),
					SeriesPosition: typeof position === 'number' ? position : undefined
				}
			]
		}
	]
})

/**
 * A /work payload placing OUR work (id 42) in SEVERAL series at once.
 *
 * No ForeignId on the series by default, deliberately: seriesMemberCount
 * short-circuits to 0 without a request when the id is absent, so these
 * fixtures exercise the ranking without having to queue a /series response per
 * candidate. Pass a third tuple element to give a series an id when a test
 * NEEDS the /series call to happen (e.g. to fail it).
 */
const multiWork = (title: string, entries: Array<[string, string | number | null, number?]>) => ({
	Title: title,
	Authors: [],
	Series: entries.map(([name, position, foreignId]) => ({
		Title: name,
		ForeignId: foreignId,
		LinkItems: [
			{
				ForeignWorkId: 42,
				PositionInSeries: position == null ? undefined : String(position),
				SeriesPosition: typeof position === 'number' ? position : undefined
			}
		]
	}))
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

	test('a franchise umbrella rescues a book its sub-series cannot place', async () => {
		// "The Emperor's Soul" is in Elantris with NO position and in The Cosmere
		// Universe at 7.5. A name without a number cannot build a sort title, so
		// the Elantris answer is discarded downstream and the book falls back to
		// its FOLDER -- which is how a shelf ends up half Goodreads-named and half
		// folder-named. The umbrella can place it, so it should.
		respond(
			[{ workId: 42 }],
			multiWork("The Emperor's Soul", [
				['Elantris', null],
				['The Cosmere Universe', '7.5']
			])
		)
		const out = await withGoodreadsSeries(
			book({ title: "The Emperor's Soul", seriesPrimary: null }),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('The Cosmere Universe')
		expect(out.seriesPrimary?.position).toBe('7.5')
	})

	test('a sub-series that CAN place the book still beats the umbrella', async () => {
		// The guard on the rule above, and the case the operator cares about most:
		// The Way of Kings is Stormlight #1 and Cosmere Universe #6. Stormlight
		// places it, so the umbrella must stay demoted. Same for Jack Ryan over
		// Jack Ryan Universe and Ender's Saga over The Enderverse.
		respond(
			[{ workId: 42 }],
			multiWork('The Way of Kings', [
				['The Stormlight Archive', 1],
				['The Cosmere Universe', 6]
			])
		)
		const out = await withGoodreadsSeries(
			book({ title: 'The Way of Kings', seriesPrimary: null }),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('The Stormlight Archive')
		expect(out.seriesPrimary?.position).toBe('1')
	})

	test('a publication-order listing is NEVER rescued', async () => {
		// Why the demotion list had to be split in two. A franchise umbrella is a
		// real shelf a reader uses; a publication/chronological ordering is not --
		// "Forgotten Realms - Publication Order" has 301 members and sweeps in the
		// whole shared universe. It must stay demoted even when the only clean
		// series cannot place the book, which is exactly when the umbrella rule
		// would otherwise let it through.
		respond(
			[{ workId: 42 }],
			multiWork('Homeland', [
				['The Dark Elf Trilogy', null],
				['Forgotten Realms - Publication Order', 9]
			])
		)
		const out = await withGoodreadsSeries(
			book({ title: 'Homeland', seriesPrimary: null }),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('The Dark Elf Trilogy')
	})

	test('an umbrella that cannot place the book either changes nothing', async () => {
		// Arcanum Unbounded: no position in The Mistborn Saga AND none in the
		// umbrella. There is nothing to rescue it with, so it keeps the plain
		// series name and the folder supplies the number, as before.
		respond(
			[{ workId: 42 }],
			multiWork('Arcanum Unbounded', [
				['The Mistborn Saga', null],
				['The Cosmere Universe', null]
			])
		)
		const out = await withGoodreadsSeries(
			book({ title: 'Arcanum Unbounded', seriesPrimary: null }),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('The Mistborn Saga')
		expect(out.seriesPrimary?.position).toBeUndefined()
	})

	test('a DRAMATIZED edition keeps its provider series', async () => {
		// Accurate matching beats tidy naming. "Tress of the Emerald Sea: A Cosmere
		// Novel (Dramatized Adaptation)" is a GraphicAudio production -- a different
		// product from the prose novel, with its own Audible series (Secret
		// Projects, asin B0D1BMZVXV). Goodreads does not model audio editions, so
		// the closest thing it has is the PROSE novel's series, Hoid's Travails.
		//
		// Measured live: the subtitle retry stripped at the colon, found the prose
		// work, and overwrote Secret Projects with Hoid's Travails #1. That is a
		// round peg in a square hole -- it erases the one signal saying this row is
		// a different edition, which is exactly what someone needs in order to
		// notice and correct a wrong version.
		respond(
			[{ workId: 42 }],
			work('Tress of the Emerald Sea', "Hoid's Travails", 1)
		)
		const provider = { asin: 'B0D1BMZVXV', name: 'Secret Projects', position: '1' }
		const out = await withGoodreadsSeries(
			book({
				title: 'Tress of the Emerald Sea: A Cosmere Novel (Dramatized Adaptation)',
				authors: [{ name: 'Brandon Sanderson' }],
				seriesPrimary: provider
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary).toEqual(provider)
	})

	test('an edition-marked title is never retried without its subtitle', async () => {
		// The stripping itself is the danger, not just the override: the bare title
		// resolves to a DIFFERENT product. With nothing to overwrite it would still
		// be wrong, so the retry must not fire at all.
		respond([], [{ workId: 42 }], work('Tress of the Emerald Sea', "Hoid's Travails", 1))
		const out = await withGoodreadsSeries(
			book({
				// Needs the COLON: without one there is no subtitle to strip and the
				// retry never fires anyway, so the test would pass without the guard.
				title: 'Tress of the Emerald Sea: A Cosmere Novel (Dramatized Adaptation)',
				authors: [{ name: 'Brandon Sanderson' }],
				seriesPrimary: null
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary).toBeNull()
		expect(fetchMock.mock.calls.length).toBe(1) // the first search only. No retry.
	})

	test('a plain marketing subtitle is still retried', async () => {
		// The guard must not swallow the case the retry exists for: "Esrever Doom:
		// A Fun-Filled Adventure into the Realm of Xanth" names no edition.
		respond([], [{ workId: 42 }], work('Esrever Doom', 'Xanth', 37))
		const out = await withGoodreadsSeries(
			book({
				title: 'Esrever Doom: A Fun-Filled Adventure into the Realm of Xanth',
				authors: [{ name: 'Piers Anthony' }],
				seriesPrimary: null
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('Xanth')
	})

	test('volumes of one series do not share a cache entry', async () => {
		// The cache key used normalizeTitle, which strips ", Book N" -- so every
		// volume of a series titled "Series, Book N" collapsed to ONE key and the
		// first volume's POSITION was served to all of its siblings for 30 days.
		const redis = fakeRedis()
		respond(
			[{ workId: 42 }],
			work('Defiance of the Fall, Book 9', 'Defiance of the Fall', 9)
		)
		const nine = await withGoodreadsSeries(
			book({
				title: 'Defiance of the Fall, Book 9',
				authors: [{ name: 'TheFirstDefier' }],
				seriesPrimary: null
			}),
			redis
		)
		expect(nine.seriesPrimary?.position).toBe('9')
		respond(
			[{ workId: 43 }],
			work('Defiance of the Fall, Book 10', 'Defiance of the Fall', 10, { workId: 43 })
		)
		const ten = await withGoodreadsSeries(
			book({
				title: 'Defiance of the Fall, Book 10',
				authors: [{ name: 'TheFirstDefier' }],
				seriesPrimary: null
			}),
			redis
		)
		expect(ten.seriesPrimary?.position).toBe('10')
	})

	test('a degraded alias fetch applies the canonical name, cached only under the SHORT TTL', async () => {
		// Single-series path, alias language = default English. The /series call
		// that carries the alias fails; the identity answer is still sound, so it
		// applies -- but under the HIT TTL it would pin the canonical (possibly
		// untranslated) name for a month while a sibling's healthy lookup gets
		// the alias: one shelf split across two names BY THE CACHE. It used to
		// not be cached AT ALL, which re-ran the full lookup on every serve when
		// the alias leg failed persistently -- so the contract is now the
		// uncacheable TTL: hours, after which the retry gets the rename.
		const redis = fakeRedis()
		const single = {
			Title: 'The Witness for the Dead',
			Authors: [],
			Series: [
				{
					Title: 'Tintenwelt',
					ForeignId: 90210,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1', SeriesPosition: 1 }]
				}
			]
		}
		respond([{ workId: 42 }], single, null)
		const first = await withGoodreadsSeries(
			book({ title: 'The Witness for the Dead', seriesPrimary: null }),
			redis
		)
		expect(first.seriesPrimary?.name).toBe('Tintenwelt')
		const key = [...redis.store.keys()].find((k) => k.startsWith('grseries:'))
		expect(key).toBeDefined()
		// The shared-profile uncacheable TTL, NOT the 30-day hit TTL.
		expect(redis.expires.get(key as string)).toBe(21600)

		// Within the TTL the pinned canonical name serves from cache -- that is
		// the accepted, bounded cost of not re-running the lookup per serve.
		respond()
		const pinned = await withGoodreadsSeries(
			book({ title: 'The Witness for the Dead', seriesPrimary: null }),
			redis
		)
		expect(pinned.seriesPrimary?.name).toBe('Tintenwelt')
		expect(fetchMock.mock.calls.length).toBe(0)

		// fakeRedis has no clock: deleting the entry models the TTL expiring.
		// The re-ask must then still get the rename.
		redis.store.delete(key as string)
		respond([{ workId: 42 }], single, {
			Title: 'Tintenwelt',
			Description: '<b>Also known as:</b>\n - Inkworld (English)',
			LinkItems: [1]
		})
		const healed = await withGoodreadsSeries(
			book({ title: 'The Witness for the Dead', seriesPrimary: null }),
			redis
		)
		expect(healed.seriesPrimary?.name).toBe('Inkworld')
	})

	test('a "Series: Title" sequel is not matched to book 1', async () => {
		// Audible titles sequels "Series: Title". titleSim's stem arm scored the
		// series half against book 1's title at 1.0, so book 2 adopted book 1's
		// position -- and in authority mode overwrote a correct provider series.
		respond([{ workId: 42 }], work('Dungeon Crawler Carl', 'Dungeon Crawler Carl', 1))
		const provider = { name: 'Dungeon Crawler Carl', position: '2' }
		const out = await withGoodreadsSeries(
			book({
				title: "Dungeon Crawler Carl: Carl's Doomsday Scenario",
				authors: [{ name: 'Matt Dinniman' }],
				seriesPrimary: provider
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary).toEqual(provider)
	})

	test('a "Series: Title" sequel DOES match its own work', async () => {
		// The flip side: the correct work is titled by the SUBTITLE half, which the
		// old gate scored at 0.687 -- below 0.9, so the right book could never
		// pass. The gate must compare the subtitle half too.
		respond([{ workId: 42 }], work("Carl's Doomsday Scenario", 'Dungeon Crawler Carl', 2))
		const out = await withGoodreadsSeries(
			book({
				title: "Dungeon Crawler Carl: Carl's Doomsday Scenario",
				authors: [{ name: 'Matt Dinniman' }],
				seriesPrimary: null
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('Dungeon Crawler Carl')
		expect(out.seriesPrimary?.position).toBe('2')
	})

	test('a volume marker in our own title vetoes a contradicting position', async () => {
		// "Defiance of the Fall, Book 10" normalizes to the bare series name, which
		// IS book 1's title -- a 1.0 match. The number in our own title is the one
		// fact we hold; an answer that contradicts it is the wrong work.
		respond([{ workId: 42 }], work('Defiance of the Fall', 'Defiance of the Fall', 1))
		const out = await withGoodreadsSeries(
			book({
				title: 'Defiance of the Fall, Book 10',
				authors: [{ name: 'TheFirstDefier' }],
				seriesPrimary: null
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary).toBeNull()
	})

	test('a lookup degraded mid-ranking is not applied', async () => {
		// /search and /work succeed but a /series member-count call fails: the
		// count comes back 0, the pool misranks, and the answer used to be applied
		// anyway (only the cache write was guarded) -- overwriting a correct
		// provider series with a misranked one, uncached, so the next refresh
		// could answer differently. Degraded means: do not apply, do not cache.
		respond(
			[{ workId: 42 }],
			multiWork('The Grief of Stones', [
				['The Cemeteries of Amalo', 2, 701],
				['The Chronicles of Osreth', 3, 702]
			]),
			null, // /series 701 -- transport failure
			null // /series 702 -- transport failure
		)
		const provider = { name: 'The Chronicles of Osreth', position: '3' }
		const out = await withGoodreadsSeries(
			book({ title: 'The Grief of Stones', seriesPrimary: provider }),
			fakeRedis()
		)
		expect(out.seriesPrimary).toEqual(provider)
	})

	test('a free-text position does not outrank the rescued umbrella', async () => {
		// The ranking scored positioned-ness on truthiness while the rescue gate
		// used isShelvablePosition, so a clean series with a free-text position
		// tied the rescued umbrella and won on declaration order -- defeating the
		// rescue the code promises.
		respond(
			[{ workId: 42 }],
			multiWork('Konrad Curze', [
				['The Horus Heresy: The Primarchs', 'The Primarchs Short Story'],
				['Warhammer Universe', 5]
			])
		)
		const out = await withGoodreadsSeries(
			book({ title: 'Konrad Curze', seriesPrimary: null }),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('Warhammer Universe')
		expect(out.seriesPrimary?.position).toBe('5')
	})

	test('gap-fill drops a free-text position but keeps the name', async () => {
		// isShelvablePosition guarded only the override path; gap-fill adopted
		// "The Primarchs Short Story" verbatim, rendering sort title "Book The
		// Primarchs Short Story" -- and the truthy pair then blocked the folder
		// fallback that could have supplied the real number.
		respond([{ workId: 42 }], work('Konrad Curze', 'The Horus Heresy', 'The Primarchs Short Story'))
		const out = await withGoodreadsSeries(
			book({ title: 'Konrad Curze', seriesPrimary: null }),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('The Horus Heresy')
		expect(out.seriesPrimary?.position).toBeUndefined()
	})

	test('an edition marker in the SUBTITLE field also blocks the override', async () => {
		// Audible stores title and subtitle separately; a marker living in the
		// subtitle presented a clean title to the guard and the prose series
		// overwrote the edition's own -- the exact bug the guard was shipped for.
		respond([{ workId: 42 }], work('Tress of the Emerald Sea', "Hoid's Travails", 1))
		const provider = { asin: 'B0D1BMZVXV', name: 'Secret Projects', position: '1' }
		const out = await withGoodreadsSeries(
			book({
				title: 'Tress of the Emerald Sea',
				subtitle: 'A Cosmere Novel (Dramatized Adaptation)',
				authors: [{ name: 'Brandon Sanderson' }],
				seriesPrimary: provider
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary).toEqual(provider)
		expect(fetchMock.mock.calls.length).toBe(0)
	})

	test('a MISS is cached for a day, not a month', async () => {
		// Membership is immutable so a HIT can cache for 30 days -- but a miss is
		// not: the mirror gains records, and a new release refreshed before it is
		// indexed stayed series-less for a month.
		const redis = fakeRedis()
		respond([])
		await withGoodreadsSeries(
			book({ title: 'Some Brand New Release', seriesPrimary: null }),
			redis
		)
		const missTtl = [...redis.expires.values()][0]
		expect(missTtl).toBe(86400)
		respond([{ workId: 42 }], work('Warbreaker', 'Warbreaker', 1))
		await withGoodreadsSeries(book({ title: 'Warbreaker', seriesPrimary: null }), redis)
		const ttls = [...redis.expires.values()]
		expect(ttls[ttls.length - 1]).toBe(2592000)
	})

	test('a lookup over the time budget serves the book un-enriched', async () => {
		// The paced lookup runs inline in GET /books/{id}; a slow mirror could
		// hold the WHOLE response past the Plex agent's 25s timeout, losing the
		// entire metadata update to enrich one field. Over budget: serve the book
		// as-is and let the lookup finish in the background to warm the cache.
		process.env.GOODREADS_TIME_BUDGET_MS = '1'
		try {
			fetchMock.mockReset()
			// Slow but SUCCESSFUL: without the budget this lookup completes and
			// overrides, which is what makes the un-budgeted path fail this test.
			// (A first draft returned the same payload for the /work call; the gate
			// rejected it, the lookup missed, and the test passed with no fix at
			// all -- asserting nothing.)
			const bodies = [
				[{ workId: 42 }],
				work('The Witness for the Dead', 'The Chronicles of Osreth', 2)
			]
			fetchMock.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(() => resolve({ data: bodies.shift() }), 75)
					)
			)
			const provider = { name: 'Chronicles of Osreth', position: '3' }
			const out = await withGoodreadsSeries(
				book({ seriesPrimary: provider }),
				fakeRedis()
			)
			expect(out.seriesPrimary).toEqual(provider)
		} finally {
			delete process.env.GOODREADS_TIME_BUDGET_MS
		}
	})

	test('a multi-colon title strips only its LAST segment on retry', async () => {
		// Measured live on Chaos Seeds: "The Land: Raiders: A LitRPG Saga" missed
		// pass 1, and the retry cut at the FIRST colon -- searching the bare
		// series stem "The Land", which matched book 1's work and shelved Raiders
		// (book 6) at Chaos Seeds #1. Three books of the series landed on #1 this
		// way. The marketing subtitle is the TRAILING segment; strip that.
		respond([], [{ workId: 42 }], work('The Land: Raiders', 'Chaos Seeds', 6))
		const out = await withGoodreadsSeries(
			book({
				title: 'The Land: Raiders: A LitRPG Saga',
				authors: [{ name: 'Aleron Kong' }],
				seriesPrimary: null
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary?.position).toBe('6')
		// The retry's search must carry the distinguishing word, not the bare stem.
		const retryUrl = String(fetchMock.mock.calls[1]?.[0] ?? '')
		expect(retryUrl).toContain(encodeURIComponent('The Land: Raiders'))
	})

	test('a retry stem cannot adopt a SIBLING via the candidate-stem arm', async () => {
		// The residual single-colon case: "Ahriman: Exile" retried as "Ahriman"
		// scores 1.0 against ANY sibling's stem ("Ahriman: Sorcerer" -> "Ahriman").
		// The retry pass must gate on the full string only -- a stripped stem
		// comparing itself to candidate stems is sibling-matching by construction.
		respond([], [{ workId: 42 }], work('Ahriman: Sorcerer', 'Ahriman', 2))
		const out = await withGoodreadsSeries(
			book({
				title: 'Ahriman: Exile',
				authors: [{ name: 'John French' }],
				seriesPrimary: null
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary).toBeNull()
	})

	test('a variant-ONLY answer never overrides a clean provider series', async () => {
		// Measured on Prelude to Foundation during the 2026-07-25 second refresh.
		// The Goodreads work lists THREE series and every one is a demoted
		// variant: "Foundation (Publication Order)", "Foundation (Chronological
		// Order)" and "Greater Foundation Universe". With no clean survivor the
		// ranking falls back to `pool = all` -- right for GAP-FILL, where a
		// variant beats nothing, but wrong for an OVERRIDE: it replaced the
		// provider's clean "Foundation #0.5" with an ordering listing, which is
		// exactly the kind of name the demotion exists to keep off a shelf.
		respond(
			[{ workId: 42 }],
			multiWork('Prelude to Foundation', [
				['Foundation (Publication Order)', 6],
				['Foundation (Chronological Order)', 1],
				['Greater Foundation Universe', 9]
			])
		)
		const provider = { name: 'Foundation', position: '0.5' }
		const out = await withGoodreadsSeries(
			book({ title: 'Prelude to Foundation', seriesPrimary: provider }),
			fakeRedis()
		)
		expect(out.seriesPrimary).toEqual(provider)
	})

	test('a variant-only answer STILL gap-fills a book with no series', async () => {
		// The other half of the rule: with nothing to lose, an ordering listing
		// is better than no shelf at all. Only OVERRIDES are held to the higher
		// bar -- same asymmetry as the shelvable-position guard.
		respond(
			[{ workId: 42 }],
			multiWork('Prelude to Foundation', [
				['Foundation (Chronological Order)', 1],
				['Greater Foundation Universe', 9]
			])
		)
		const out = await withGoodreadsSeries(
			book({ title: 'Prelude to Foundation', seriesPrimary: null }),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('Foundation (Chronological Order)')
	})

	test('one clean series among variants still overrides normally', async () => {
		// The guard must key on "every candidate was demoted", not on "a variant
		// is present" -- most multi-series works list a variant alongside the
		// real series, and those must keep working.
		respond(
			[{ workId: 42 }],
			multiWork('Second Foundation', [
				['Foundation (Publication Order)', 3],
				['Foundation', 3]
			])
		)
		const out = await withGoodreadsSeries(
			book({
				title: 'Second Foundation',
				seriesPrimary: { name: 'Foundation Saga', position: '9' }
			}),
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('Foundation')
		expect(out.seriesPrimary?.position).toBe('3')
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

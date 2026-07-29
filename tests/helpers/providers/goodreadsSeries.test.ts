import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// No outbound pacing in tests: the live client holds a ~1.1s gap between
// bookinfo.pro calls, which would add ~45s to this suite for no coverage.
process.env.GOODREADS_MIN_GAP_MS = '0'

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { fetchGoodreadsSeries, withGoodreadsSeries, seriesAliasFor, resetGoodreadsThrottle } = await import(
	'#helpers/providers/goodreadsSeries'
)

// Pristine module state for EVERY test. The series-record memo lives for the
// process, so without this, whichever test touches a series id first pins its
// member count for every later test that reuses the id -- under --randomize
// three tests here flipped by seed, and the four parent-series tests could
// pass without ever consuming their own member-count fixtures (the counts
// came from the memo). Belt to the braces of the unique ids below.
beforeEach(() => resetGoodreadsThrottle())

/** Queue responses in call order; a `null` entry makes that call reject. */
function respond(...bodies: Array<unknown | null>) {
	fetchMock.mockReset()
	for (const body of bodies) {
		if (body === null) fetchMock.mockImplementationOnce(() => Promise.reject(new Error('boom')))
		else fetchMock.mockImplementationOnce(() => Promise.resolve({ data: body }))
	}
}

const work = (over: Record<string, unknown> = {}) => ({
	Title: 'The Grief of Stones',
	Series: [
		{
			Title: 'The Cemeteries of Amalo',
			LinkItems: [
				{ ForeignWorkId: 999, PositionInSeries: '9', SeriesPosition: 9 },
				{ ForeignWorkId: 42, PositionInSeries: '2', SeriesPosition: 2 }
			]
		}
	],
	...over
})

describe('goodreads series enrichment', () => {
	afterEach(() => fetchMock.mockReset())

	test('returns the series and the position of OUR work', async () => {
		respond([{ workId: 42 }], work())
		const out = await fetchGoodreadsSeries('The Grief of Stones', 'Katherine Addison')
		// Position 2 is ours; 9 belongs to a different member of the same series.
		// Reading LinkItems[0] would have returned someone else's number.
		expect(out).toEqual({ primary: { name: 'The Cemeteries of Amalo', position: '2' } })
	})

	test('refuses a work whose title is not ours', async () => {
		// /search is fuzzy and will return a different book in the same universe.
		// Attaching that book's series would mis-shelve ours while looking
		// authoritative, so an unverified answer must be discarded entirely.
		respond([{ workId: 42 }], work({ Title: 'An Entirely Different Novel' }))
		expect(await fetchGoodreadsSeries('The Grief of Stones', 'Katherine Addison')).toBeNull()
	})

	test('returns null when the work carries no series', async () => {
		respond([{ workId: 42 }], work({ Series: [] }))
		expect(await fetchGoodreadsSeries('The Grief of Stones', null)).toBeNull()
	})

	test('never throws when the service is down', async () => {
		// Enrichment is best-effort: an outage must not fail the request that
		// asked for it, it must just leave the field as empty as it found it.
		respond(null)
		expect(await fetchGoodreadsSeries('The Grief of Stones', null)).toBeNull()
	})

	test('prefers the PARENT series (more members) over its sub-series', async () => {
		// Not the Goodreads "Primary" flag -- measured against how this operator
		// organizes by hand, the parent is the wanted shelf (Chronicles of Osreth
		// over Cemeteries of Amalo). The parent is the container, so it has more
		// members; the ranking asks /series/{id} for each count.
		respond(
			[{ workId: 42 }],
			work({
				Series: [
					{
						Title: 'Sub Series',
						ForeignId: 51,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
					},
					{
						Title: 'Parent Series',
						ForeignId: 52,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '7' }]
					}
				]
			}),
			{ LinkItems: Array.from({ length: 4 }, (_, i) => i) }, // Sub: 4 members
			{ LinkItems: Array.from({ length: 9 }, (_, i) => i) } // Parent: 9 members
		)
		const out = await fetchGoodreadsSeries('The Grief of Stones', null)
		expect(out?.primary).toEqual({ name: 'Parent Series', position: '7' })
		// The sub-series is still carried, so a consumer that disagrees can use it.
		expect(out?.secondary).toEqual({ name: 'Sub Series', position: '1' })
		// Both member counts came from THIS test's fixtures (search + work + two
		// /series/{id} calls), not from the process-lifetime memo.
		expect(fetchMock.mock.calls.length).toBe(4)
	})

	test('omits position when the work has no link of its own', async () => {
		// A series naming only OTHER members tells us nothing about our position,
		// and inventing one would mis-order the shelf.
		respond(
			[{ workId: 42 }],
			work({
				Series: [
					{
						Title: 'Someone Elses Series',
						LinkItems: [
							{ ForeignWorkId: 111, PositionInSeries: '1' },
							{ ForeignWorkId: 222, PositionInSeries: '2' }
						]
					}
				]
			})
		)
		const out = await fetchGoodreadsSeries('The Grief of Stones', null)
		expect(out?.primary).toEqual({ name: 'Someone Elses Series' })
	})
})

describe('parent-series preference', () => {
	// A work in a sub-series, its parent, and a variant. The variant has the
	// most members but is an edition listing; the parent has more members than
	// the sub. Order: search, work, then one /series/{id} per pooled series.
	//
	// `base` keeps every test's series ids UNIQUE (like the language-preference
	// describe's 9000x ids): reusing ids 1 and 2 across tests meant whichever
	// ran first pinned their member counts in the module memo, and the fixtures
	// queued here were never consumed -- these tests passed on someone else's
	// counts.
	const multi = (base: number) => ({
		Title: 'The Grief of Stones',
		Series: [
			{
				Title: 'The Cemeteries of Amalo',
				ForeignId: base + 1,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '2' }]
			},
			{
				Title: 'The Chronicles of Osreth',
				ForeignId: base + 2,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '3' }]
			},
			{
				Title: 'Osreth Omnibus Edition',
				ForeignId: base + 3,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
			}
		]
	})
	// member-count responses, in ForeignId order of the CLEAN pool (base+1 then base+2)
	const members = (n) => ({ LinkItems: Array.from({ length: n }, (_, i) => i) })
	// search + work + one /series/{id} per CLEAN-pool series: the counts the
	// test claims to rank on were fetched from ITS fixtures, not the memo.
	const expectFixturesConsumed = () => expect(fetchMock.mock.calls.length).toBe(4)

	test('prefers the parent (more members) among clean series', async () => {
		// clean pool = Cemeteries(111), Osreth(112); the Omnibus Edition is excluded
		respond([{ workId: 42 }], multi(110), members(6), members(9))
		const out = await fetchGoodreadsSeries('The Grief of Stones', null)
		expect(out?.primary).toEqual({ name: 'The Chronicles of Osreth', position: '3' })
		expect(out?.secondary).toEqual({ name: 'The Cemeteries of Amalo', position: '2' })
		expectFixturesConsumed()
	})

	test('excludes an edition/ordering variant even when it is largest', async () => {
		// If the variant filter were off, Omnibus with a huge count could win.
		respond([{ workId: 42 }], multi(120), members(6), members(9))
		const out = await fetchGoodreadsSeries('The Grief of Stones', null)
		expect(out?.primary?.name).not.toContain('Omnibus')
		expect(out?.secondary?.name).not.toContain('Omnibus')
		expectFixturesConsumed()
	})

	test('drops a franchise UMBRELLA (-verse/Universe) for the sub-series', async () => {
		// Measured live: "The Enderverse" (18) and "Jack Ryan Universe" (45) beat
		// the wanted sub-series on member count, so a size rule alone reintroduces
		// them. They carry the tell in their NAME while a same-size TIGHT parent
		// (The Legend of Drizzt) does not, so the name is what excludes them.
		respond(
			[{ workId: 42 }],
			{
				Title: 'Xenocide',
				Series: [
					{
						Title: "Ender's Saga",
						ForeignId: 131,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '3' }]
					},
					{
						Title: 'The Enderverse',
						ForeignId: 132,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '14' }]
					}
				]
			},
			{ LinkItems: Array.from({ length: 9 }, (_, i) => i) } // Ender's Saga: 9
		)
		const out = await fetchGoodreadsSeries('Xenocide', null)
		// The umbrella is larger, but the sub-series is what a reader means.
		expect(out?.primary).toEqual({ name: "Ender's Saga", position: '3' })
		// THREE calls, not four: the umbrella is dropped from the pool BY NAME
		// before member counts are fetched, so its size is never even asked for —
		// that is the point of name-detection (a size rule would reinstate it).
		// An Enderverse count fixture used to be queued here and never consumed,
		// which is how this test read as count-based while running on the memo.
		expect(fetchMock.mock.calls.length).toBe(3)
	})

	test('keeps a large TIGHT parent that carries no umbrella marker', async () => {
		// The Legend of Drizzt (~37) dwarfs its sub-arc but IS the wanted series,
		// so it must NOT be demoted the way a "-verse" umbrella is.
		respond(
			[{ workId: 42 }],
			{
				Title: 'Passage to Dawn',
				Series: [
					{
						Title: 'Legacy of the Drow',
						ForeignId: 141,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '4' }]
					},
					{
						Title: 'The Legend of Drizzt',
						ForeignId: 142,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '10' }]
					}
				]
			},
			{ LinkItems: Array.from({ length: 4 }, (_, i) => i) }, // sub-arc: 4
			{ LinkItems: Array.from({ length: 37 }, (_, i) => i) } // parent: 37
		)
		const out = await fetchGoodreadsSeries('Passage to Dawn', null)
		expect(out?.primary).toEqual({ name: 'The Legend of Drizzt', position: '10' })
		expectFixturesConsumed()
	})
})

describe('withGoodreadsSeries enrichment wrapper', () => {
	const fakeRedis = () => {
		const store = new Map<string, string>()
		return {
			store,
			get: (k: string) => Promise.resolve(store.get(k) ?? null),
			set: (k: string, v: string) => {
				store.set(k, v)
				return Promise.resolve('OK')
			}
		}
	}

	test('with the authority OFF, a book that already has a series is untouched', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		fetchMock.mockReset()
		const redis = fakeRedis()
		const book = {
			title: 'Some Book',
			authors: [{ name: 'Someone' }],
			seriesPrimary: { name: 'Existing Series', position: '3' }
		}
		// This pinned the ORIGINAL contract: Goodreads was a gap-filler and a book
		// that already had a series was never looked up. That contract has been
		// deliberately replaced -- providers disagree with each other across one
		// series, so the provider's answer is no longer treated as authoritative
		// and Goodreads is consulted for every book. The assertion is kept, scoped
		// to the escape hatch, because "authority off" must still mean the old
		// behaviour exactly: no override, no request, no cache write.
		process.env.GOODREADS_SERIES_AUTHORITY = '0'
		try {
			const out = await withGoodreadsSeries(book, redis)
			expect(out.seriesPrimary).toEqual({ name: 'Existing Series', position: '3' })
			expect(fetchMock).not.toHaveBeenCalled()
			expect(redis.store.size).toBe(0)
		} finally {
			delete process.env.GOODREADS_SERIES_AUTHORITY
		}
	})

	test('fills a missing series from Goodreads and caches it', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond([{ workId: 42 }], work())
		const redis = fakeRedis()
		const book = { title: 'The Grief of Stones', authors: [{ name: 'Katherine Addison' }] }
		const out = await withGoodreadsSeries(book, redis)
		expect(out.seriesPrimary).toEqual({ name: 'The Cemeteries of Amalo', position: '2' })

		// Second call is served from cache -- no further upstream fetches.
		fetchMock.mockReset()
		const again = await withGoodreadsSeries(book, redis)
		expect(again.seriesPrimary).toEqual({ name: 'The Cemeteries of Amalo', position: '2' })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('remembers a MISS so it is not re-fetched every refresh', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond([]) // /search returns nothing -> null result
		const redis = fakeRedis()
		const book = { title: 'Standalone Novel', authors: [{ name: 'Nobody' }] }
		const first = await withGoodreadsSeries(book, redis)
		expect(first.seriesPrimary).toBeUndefined()

		fetchMock.mockReset()
		const second = await withGoodreadsSeries(book, redis)
		expect(second.seriesPrimary).toBeUndefined()
		// The cached miss short-circuits before any upstream call.
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('never fails the response when the lookup throws', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond(null) // /search rejects
		const book = { title: 'Some Book', authors: [{ name: 'Someone' }] }
		const out = await withGoodreadsSeries(book, null)
		expect(out).toEqual(book)
	})
})

/**
 * Translated-series naming. Measured on Cornelia Funke's Inkworld shelf
 * (2026-07-26): Goodreads' canonical series name is the GERMAN original
 * ("Tintenwelt", series 44451), so authority mode renamed an English library's
 * shelf into German -- and book 4's Goodreads WORK is titled "Die Farbe der
 * Rache" (every title form German, only its Books[] carry the English edition
 * titles), so the title gates rejected it and it kept its provider series
 * ("Inkheart" from Audible). One root cause, two symptoms: a German shelf AND
 * a split shelf.
 *
 * The mirror itself declares the fix: /series/44451's Description reads
 * "Also known as:\n - Inkworld (English)\n - Svet iz črnila (Slovenian)...".
 * When the preferred language (GOODREADS_SERIES_LANGUAGE, default English)
 * has a declared alias, the shelf uses it; the series IDENTITY (id, positions,
 * ranking) is untouched, so the one-taxonomy guarantee survives.
 */
describe('series language preference', () => {
	afterEach(() => {
		fetchMock.mockReset()
		delete process.env.GOODREADS_SERIES_LANGUAGE
	})

	const TINTENWELT_DESC =
		'<b>Also known as:</b>\n - Inkworld (English)\n - Svet iz črnila (Slovenian)\n - Mundo de tinta (Spanish)'

	const germanCanonical = (foreignId: number, over: Record<string, unknown> = {}) => ({
		Title: 'Inkheart',
		Series: [
			{
				Title: 'Tintenwelt',
				ForeignId: foreignId,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1', SeriesPosition: 1 }]
			}
		],
		...over
	})

	test('renames the primary series to its declared English alias', async () => {
		respond([{ workId: 42 }], germanCanonical(90001), {
			Title: 'Tintenwelt',
			Description: TINTENWELT_DESC,
			LinkItems: [1, 2, 3, 4]
		})
		const out = await fetchGoodreadsSeries('Inkheart', 'Cornelia Funke')
		expect(out).toEqual({ primary: { name: 'Inkworld', position: '1' } })
	})

	test('keeps the canonical name when no alias is declared', async () => {
		respond([{ workId: 42 }], germanCanonical(90002), {
			Title: 'Tintenwelt',
			Description: 'TODO',
			LinkItems: [1, 2]
		})
		const out = await fetchGoodreadsSeries('Inkheart', 'Cornelia Funke')
		expect(out).toEqual({ primary: { name: 'Tintenwelt', position: '1' } })
	})

	test('keeps the canonical name when the alias fetch fails, and still answers', async () => {
		// The alias is a cosmetic upgrade: losing it must not degrade or discard
		// an otherwise sound answer.
		respond([{ workId: 42 }], germanCanonical(90003), null)
		const out = await fetchGoodreadsSeries('Inkheart', 'Cornelia Funke')
		expect(out).toEqual({ primary: { name: 'Tintenwelt', position: '1' } })
	})

	test('a failed alias fetch marks the answer uncacheable, not degraded', async () => {
		// The identity work is sound, so the canonical answer still applies -- but
		// the NAME in hand may be the one the alias would have replaced. Cached
		// under the hit TTL it pins the canonical name for a week while a sibling
		// book's healthy lookup gets the alias: one shelf, two names, split by the
		// cache. The middle state: apply now, let the next refresh re-ask.
		const state = { degraded: false }
		respond([{ workId: 42 }], germanCanonical(90006), null)
		const out = await fetchGoodreadsSeries('Inkheart', 'Cornelia Funke', undefined, state)
		expect(out).toEqual({ primary: { name: 'Tintenwelt', position: '1' } })
		expect(state.degraded).toBe(false)
		expect((state as { uncacheable?: boolean }).uncacheable).toBe(true)
	})

	test('a sound alias fetch leaves the answer fully cacheable', async () => {
		const state = { degraded: false }
		respond([{ workId: 42 }], germanCanonical(90007), {
			Title: 'Tintenwelt',
			Description: TINTENWELT_DESC,
			LinkItems: [1]
		})
		const out = await fetchGoodreadsSeries('Inkheart', 'Cornelia Funke', undefined, state)
		expect(out).toEqual({ primary: { name: 'Inkworld', position: '1' } })
		expect((state as { uncacheable?: boolean }).uncacheable).toBeUndefined()
	})

	test('GOODREADS_SERIES_LANGUAGE=0 disables the rename and the extra fetch', async () => {
		process.env.GOODREADS_SERIES_LANGUAGE = '0'
		respond([{ workId: 42 }], germanCanonical(90004))
		const out = await fetchGoodreadsSeries('Inkheart', 'Cornelia Funke')
		expect(out).toEqual({ primary: { name: 'Tintenwelt', position: '1' } })
		// /search + /work only -- no /series call was made at all.
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	test('a different preferred language picks that alias', async () => {
		process.env.GOODREADS_SERIES_LANGUAGE = 'Spanish'
		respond([{ workId: 42 }], germanCanonical(90005), {
			Title: 'Tintenwelt',
			Description: TINTENWELT_DESC,
			LinkItems: [1]
		})
		const out = await fetchGoodreadsSeries('Inkheart', 'Cornelia Funke')
		expect(out).toEqual({ primary: { name: 'Mundo de tinta', position: '1' } })
	})
})

describe('seriesAliasFor', () => {
	test('reads an alias from the declared list', () => {
		expect(
			seriesAliasFor('<b>Also known as:</b>\n - Inkworld (English)\n - Mundo de tinta (Spanish)', 'English')
		).toBe('Inkworld')
	})

	test('a hyphen plus a language tag in PROSE is not an alias', () => {
		// The claim the function makes -- "a description that merely mentions a
		// language in prose declares nothing" -- must hold even when the header
		// exists elsewhere in the description: only the contiguous list after the
		// header is the librarian declaration, everything past its first paragraph
		// break is prose again. Without the bound, this renames the shelf to
		// "The Ink Trilogy" and caches it for a week.
		const desc =
			'<b>Also known as:</b>\n - Mundo de tinta (Spanish)\n\n' +
			'First published in Germany, the trilogy was later released as a ' +
			'boxed set - The Ink Trilogy (English) in 2010.'
		expect(seriesAliasFor(desc, 'English')).toBeNull()
	})

	test('prose before the header cannot declare an alias either', () => {
		const desc =
			'Originally serialized - Der Tintentod (German) in magazines.\n\n' +
			'<b>Also known as:</b>\n - Inkworld (English)'
		expect(seriesAliasFor(desc, 'German')).toBeNull()
		expect(seriesAliasFor(desc, 'English')).toBe('Inkworld')
	})

	test('no header, no alias', () => {
		expect(seriesAliasFor('A trilogy - Inkworld (English) fans adore.', 'English')).toBeNull()
	})
})

describe('edition-title verification', () => {
	afterEach(() => fetchMock.mockReset())

	/** Book 4's real shape: every WORK title form is German; the English titles
	 * live only on the Books[] edition records. */
	const germanWork = (over: Record<string, unknown> = {}) => ({
		Title: 'Die Farbe der Rache',
		FullTitle: 'Die Farbe der Rache',
		ShortTitle: 'Die Farbe der Rache',
		Books: [
			{ Title: 'Die Farbe der Rache', Language: 'deu' },
			{ Title: 'The Color of Revenge', Language: 'eng' },
			{ Title: 'Цвет мести', Language: 'rus' }
		],
		Series: [
			{
				Title: 'Tintenwelt',
				ForeignId: 90101,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '4', SeriesPosition: 4 }]
			}
		],
		...over
	})

	test('accepts a work whose EDITION title matches ours', async () => {
		respond([{ workId: 42 }], germanWork(), {
			Title: 'Tintenwelt',
			Description: 'TODO',
			LinkItems: [1, 2, 3, 4]
		})
		const out = await fetchGoodreadsSeries('Inkworld: The Color of Revenge', 'Cornelia Funke')
		expect(out).toEqual({ primary: { name: 'Tintenwelt', position: '4' } })
	})

	test('still refuses a work whose titles AND editions are all far from ours', async () => {
		respond(
			[{ workId: 42 }],
			germanWork({ Books: [{ Title: 'Etwas völlig anderes', Language: 'deu' }] })
		)
		const out = await fetchGoodreadsSeries('Inkworld: The Color of Revenge', 'Cornelia Funke')
		expect(out).toBeNull()
	})

	test('end to end: German-canonical work, English query, English alias', async () => {
		// The full Lost-Stories-shelf mechanism in one pass: the edition arm
		// accepts the work, the series comes back positioned, and the alias
		// renames the shelf -- "Inkworld, Book 4", uniform with books 1-3.
		respond(
			[{ workId: 42 }],
			germanWork({
				Series: [
					{
						Title: 'Tintenwelt',
						ForeignId: 90102,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '4', SeriesPosition: 4 }]
					}
				]
			}),
			{
				Title: 'Tintenwelt',
				Description: '<b>Also known as:</b>\n - Inkworld (English)',
				LinkItems: [1, 2, 3, 4]
			}
		)
		const out = await fetchGoodreadsSeries('Inkworld: The Color of Revenge', 'Cornelia Funke')
		expect(out).toEqual({ primary: { name: 'Inkworld', position: '4' } })
	})
})

describe('series name hygiene', () => {
	afterEach(() => fetchMock.mockReset())

	test('a librarian trailing space in the series title is trimmed', async () => {
		// Measured live on Goodreads series 131836, literally titled
		// "Six of Crows " -- adopted verbatim, it built the Plex sort title
		// "Six of Crows , Book 2" and split the shelf from its clean-named
		// sibling. Whitespace is never identity.
		respond([{ workId: 42 }], {
			Title: 'Crooked Kingdom',
			Series: [
				{
					Title: 'Six of Crows ',
					ForeignId: 90201,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '2', SeriesPosition: 2 }]
				}
			]
		})
		const out = await fetchGoodreadsSeries('Crooked Kingdom', 'Leigh Bardugo')
		expect(out?.primary?.name).toBe('Six of Crows')
	})

	test('a dirty name in an already-CACHED answer is cleaned on read', async () => {
		// The redis cache holds answers recorded before this fix (hit TTL is a
		// week), so the trim must sit on the APPLY path, where fresh and cached
		// answers converge -- not only inside the lookup.
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		fetchMock.mockReset()
		const redis = fakeRedisFor('grseries:v4:crooked kingdom|leigh bardugo', {
			primary: { name: 'Six of Crows ', position: '2' }
		})
		const book = { title: 'Crooked Kingdom', authors: [{ name: 'Leigh Bardugo' }] }
		const out = await withGoodreadsSeries(book, redis)
		expect(out.seriesPrimary).toEqual({ name: 'Six of Crows', position: '2' })
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

function fakeRedisFor(key: string, value: unknown) {
	const store = new Map<string, string>([[key, JSON.stringify(value)]])
	return {
		get: (k: string) => Promise.resolve(store.get(k) ?? null),
		set: (k: string, v: string) => {
			store.set(k, v)
			return Promise.resolve('OK')
		}
	}
}

describe('a broken /work record falls back to the AUTHOR record', () => {
	/**
	 * Measured live 2026-07-29 on Brian Andrews' Tier One series (10 books):
	 *   /search "The Adversary Brian Andrews"  -> workId 249535826, author 5155903
	 *   /work/249535826                        -> HTTP 500, persistent (3 of 3)
	 *   /work/<the other nine>                 -> all fine, Series ["Tier One"]
	 *   /series/180345 ("Tier One")            -> lists 249535826 at position 9
	 *
	 * One broken upstream record, and the whole visible symptom: with no
	 * Goodreads answer the book KEPT Audible's series name, so book 9 shelved as
	 * "The Tier One Thrillers, Book 9" while book 10 shelved as "Tier One, Book
	 * 10" -- one series, two shelves, unfixable from the UI.
	 *
	 * The author record closes it by IDENTITY, not by comparing names:
	 *   /author/5155903 -> Series[] where id 180345 "Tier One" has a LinkItems
	 *   entry naming ForeignWorkId 249535826 at position 9, and Works[] carries
	 *   that work's Title so the title gate still runs.
	 *
	 * Frequency: 0 failures in 40 random library books, so this is a rare
	 * outlier -- but it fires ONLY where the current code produces nothing, so it
	 * cannot change the series of any book that resolves today.
	 */

	const AUTHOR_ID = 5155903
	const WORK_ID = 249535826

	const authorRecord = (over: Record<string, unknown> = {}) => ({
		ForeignId: AUTHOR_ID,
		Name: 'Brian Andrews',
		Works: [{ ForeignId: WORK_ID, Title: 'The Adversary' }],
		Series: [
			{
				ForeignId: 180345,
				Title: 'Tier One',
				LinkItems: [
					{ ForeignWorkId: WORK_ID, PositionInSeries: '9', SeriesPosition: 9 },
					{ ForeignWorkId: 269094999, PositionInSeries: '10', SeriesPosition: 10 }
				]
			}
		],
		...over
	})

	afterEach(() => fetchMock.mockReset())

	test('a 500 on the work is recovered from the author record', async () => {
		respond([{ workId: WORK_ID, author: { id: AUTHOR_ID } }], null, authorRecord())
		const out = await fetchGoodreadsSeries('The Adversary', 'Brian Andrews')
		expect(out?.primary?.name).toBe('Tier One')
		expect(out?.primary?.position).toBe('9')
	})

	test('the fallback does NOT bypass the caller title gate', async () => {
		// Works[] names a completely different book for this workId, so the work
		// we were handed is not ours and its series must not be adopted.
		//
		// Verified by mutation that the CALLER's gate is what rejects this:
		// disabling workFromAuthorRecord's own title check leaves this test green,
		// because the synthetic record then carries the wrong title onward and the
		// caller scores it against ours. That is the property worth pinning -- the
		// fallback feeds the existing gates rather than routing around them. The
		// in-function check is defence-in-depth (it fails closed one step earlier
		// and logs why), NOT load-bearing, and this test does not claim to cover it.
		respond(
			[{ workId: WORK_ID, author: { id: AUTHOR_ID } }],
			null,
			authorRecord({ Works: [{ ForeignId: WORK_ID, Title: 'Some Entirely Other Book' }] })
		)
		expect(await fetchGoodreadsSeries('The Adversary', 'Brian Andrews')).toBeNull()
	})

	test('the author gate still runs', async () => {
		respond(
			[{ workId: WORK_ID, author: { id: AUTHOR_ID } }],
			null,
			authorRecord({ Name: 'Someone Else Entirely' })
		)
		expect(await fetchGoodreadsSeries('The Adversary', 'Brian Andrews')).toBeNull()
	})

	test('a series that does not name our work is not adopted', async () => {
		// The author's other series must not leak onto this book.
		respond(
			[{ workId: WORK_ID, author: { id: AUTHOR_ID } }],
			null,
			authorRecord({
				Series: [
					{
						ForeignId: 49079,
						Title: 'Jack Ryan',
						LinkItems: [{ ForeignWorkId: 111111, PositionInSeries: '3', SeriesPosition: 3 }]
					}
				]
			})
		)
		expect(await fetchGoodreadsSeries('The Adversary', 'Brian Andrews')).toBeNull()
	})

	test('no author id on the search hit means no fallback FETCH', async () => {
		// The CALL COUNT is the assertion. Without it this test passes even with
		// the authorId guard removed: /author/undefined has no queued response,
		// so it resolves to nothing and the outcome looks identical. Two calls =
		// /search and /work only.
		respond([{ workId: WORK_ID }], null)
		expect(await fetchGoodreadsSeries('The Adversary', 'Brian Andrews')).toBeNull()
		expect(fetchMock.mock.calls.length).toBe(2)
	})

	test('a working /work record never triggers the author fetch', async () => {
		// THE blast-radius guarantee: books that resolve today are untouched, and
		// they must not pay an extra round trip either.
		respond([{ workId: 42, author: { id: AUTHOR_ID } }], work())
		const out = await fetchGoodreadsSeries('The Grief of Stones', 'Katherine Addison')
		expect(out?.primary?.name).toBe('The Cemeteries of Amalo')
		// Two calls: /search and /work. A third would mean the author record was
		// fetched for a book that never needed it.
		expect(fetchMock.mock.calls.length).toBe(2)
	})
})

describe('a recovered work must not be discarded as degraded', () => {
	/**
	 * THE gap my first pass missed, caught only by reading the live logs.
	 *
	 * The fallback worked immediately in production -- every request logged
	 * "recovered this series from the author record" with series ["Tier One"] --
	 * and the response STILL served Audible's "The Tier One Thrillers", and the
	 * answer was never cached (so it re-ran on every single request).
	 *
	 * Because the failed /work call sets state.degraded, and withGoodreadsSeries
	 * refuses to apply OR cache a degraded lookup. That guard is right in
	 * general: a call that failed means we cannot be sure we saw the best
	 * candidate, so overriding a provider series on partial evidence is exactly
	 * the mis-shelving it exists to prevent.
	 *
	 * It is wrong HERE. We did not proceed on partial evidence -- we resolved the
	 * work by IDENTITY through the author record, which named our work id in a
	 * series with a position. The failure was routed around, not ignored.
	 *
	 * Note the fidelity lesson: the earlier tests drove fetchGoodreadsSeries,
	 * which returns before that guard, so they passed while production did the
	 * opposite. This one drives withGoodreadsSeries -- what the route calls.
	 */

	const AUTHOR_ID = 5155903
	const WORK_ID = 249535826

	const authorRecord = {
		ForeignId: AUTHOR_ID,
		Name: 'Brian Andrews',
		Works: [{ ForeignId: WORK_ID, Title: 'The Adversary' }],
		Series: [
			{
				ForeignId: 180345,
				Title: 'Tier One',
				LinkItems: [{ ForeignWorkId: WORK_ID, PositionInSeries: '9', SeriesPosition: 9 }]
			}
		]
	}

	const audibleBook = () => ({
		title: 'The Adversary',
		subtitle: 'Tier One Thrillers, Book 9',
		authors: [{ name: 'Brian Andrews' }],
		seriesPrimary: { name: 'The Tier One Thrillers', position: '9' }
	})

	afterEach(() => fetchMock.mockReset())

	test('the recovered series IS applied over the provider series', async () => {
		respond([{ workId: WORK_ID, author: { id: AUTHOR_ID } }], null, authorRecord)
		const out = await withGoodreadsSeries(audibleBook(), null)
		expect(out.seriesPrimary?.name).toBe('Tier One')
	})

	test('a failed recovery keeps the degradation, so no stem retry runs', async () => {
		// CALL COUNT is the assertion. /work fails and the author record fails too,
		// so nothing was resolved and the lookup stays degraded -- which is what
		// stops fetchGoodreadsSeries paying for a second paced search against a
		// mirror that just pushed back. Clearing the flag unconditionally (rather
		// than only on a successful recovery) lets that retry run.
		respond([{ workId: WORK_ID, author: { id: AUTHOR_ID } }], null, null)
		await withGoodreadsSeries(audibleBook(), null)
		expect(fetchMock.mock.calls.length).toBe(3) // search + work + author, then stop
	})

	test('degradation from an EARLIER hit is preserved, not cleared', async () => {
		// Two hits. The first degrades the lookup (its /work fails and its author
		// record fails too). The second recovers by identity -- but the lookup as a
		// whole HAS lost evidence, so restoring the pre-call value must restore
		// TRUE, not hardcode false. Otherwise one recovered hit launders away a
		// real failure on another and a partial answer gets applied.
		respond(
			[
				{ workId: 111111, author: { id: 999999 } },
				{ workId: WORK_ID, author: { id: AUTHOR_ID } }
			],
			null, // hit 1 /work fails      -> degraded
			null, // hit 1 /author fails    -> no recovery, degradation stands
			null, // hit 2 /work fails
			authorRecord // hit 2 recovers by identity
		)
		const out = await withGoodreadsSeries(audibleBook(), null)
		expect(out.seriesPrimary?.name).toBe('The Tier One Thrillers')
	})

	test('a genuinely degraded lookup still declines to apply', async () => {
		// The guard must survive: /work fails AND the author record fails too, so
		// nothing was resolved by identity and the provider series stands.
		respond([{ workId: WORK_ID, author: { id: AUTHOR_ID } }], null, null)
		const out = await withGoodreadsSeries(audibleBook(), null)
		expect(out.seriesPrimary?.name).toBe('The Tier One Thrillers')
	})
})

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { fakeRedis } from '#tests/setup/fakeRedis'

// No outbound pacing in tests: the live client holds a ~1.1s gap between
// bookinfo.pro calls, which would add ~45s to this suite for no coverage.
process.env.GOODREADS_MIN_GAP_MS = '0'

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const {
	fetchGoodreadsSeries,
	withGoodreadsSeries,
	seriesAliasFor,
	resetGoodreadsThrottle,
	mirrorKeyFor
} = await import('#helpers/providers/goodreadsSeries')

// The cache key carries the MIRROR's identity (a switch must not serve the
// previous backend's answers), so tests that address an exact key derive the
// fragment from the same helper the module uses rather than hardcoding it.
const SERIES_PREFIX = `grseries:v6:${mirrorKeyFor(process.env.GOODREADS_SERIES_URL || 'https://api.bookinfo.pro')}:`

// Pristine module state for EVERY test. The series-record memo lives for the
// process, so without this, whichever test touches a series id first pins its
// member count for every later test that reuses the id -- under --randomize
// three tests here flipped by seed, and the four parent-series tests could
// pass without ever consuming their own member-count fixtures (the counts
// came from the memo). Belt to the braces of the unique ids below.
beforeEach(() => resetGoodreadsThrottle())

/**
 * Queue responses in call order.
 *  - `null`      -> that call rejects with NO status (a transport failure)
 *  - `status(n)` -> that call rejects with an HTTP status (the mirror ANSWERING)
 *
 * The distinction is load-bearing and used to be inexpressible here: every
 * simulated failure was a status-less transport error, so the whole "the mirror
 * answered 404" branch — which is classified as ANSWERED, not degraded, and is
 * therefore memoized — had no test coverage at all.
 */
function status(code: number) {
	return { __status: code }
}
function respond(...bodies: Array<unknown | null>) {
	fetchMock.mockReset()
	for (const body of bodies) {
		if (body === null) fetchMock.mockImplementationOnce(() => Promise.reject(new Error('boom')))
		else if (body && typeof body === 'object' && '__status' in body)
			fetchMock.mockImplementationOnce(() =>
				Promise.reject(
					Object.assign(
						new Error('Request failed with status ' + (body as { __status: number }).__status),
						{
							name: 'FetchError',
							status: (body as { __status: number }).__status
						}
					)
				)
			)
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

	test('a 404 on the parent /series does NOT pin it at zero members', async () => {
		// A 404 is the mirror ANSWERING, so it is classified as answered rather
		// than degraded — and an answered response used to be memoized. That put
		// count: 0 in a process-lifetime memo with no TTL, and the member count is
		// exactly how a parent series is told from its sub-series. So one 404 on a
		// renamed/moved/deleted series id demoted the parent for EVERY remaining
		// book in that series until the container restarted: the "one series, two
		// shelves" split this module exists to prevent, produced by the module.
		//
		// First book: the parent's count is unknown, so the sub-arc wins — that is
		// correct and unavoidable on the evidence available.
		respond([{ workId: 42 }], multi(190), members(6), status(404))
		const first = await fetchGoodreadsSeries('The Grief of Stones', null)
		expect(first?.primary).toEqual({ name: 'The Cemeteries of Amalo', position: '2' })

		// Second book, same series, mirror now healthy. Note the call shape: the
		// SUB-ARC's count (6) was a real answer and IS memoized, so only the
		// parent — the one that 404'd — is asked again. Three calls, not four,
		// and that asymmetry is the fix working: successes still memoize, zeros
		// never do.
		respond([{ workId: 42 }], multi(190), members(9))
		const second = await fetchGoodreadsSeries('The Grief of Stones', null)
		expect(second?.primary).toEqual({ name: 'The Chronicles of Osreth', position: '3' })
		expect(fetchMock.mock.calls.length).toBe(3)
	})

	test('a REAL empty series is still memoized-free but ranks last, not first', async () => {
		// Refusing to memoize a zero costs one re-ask per book for a genuinely
		// empty series; it must not change the ranking outcome.
		respond([{ workId: 42 }], multi(200), members(6), members(0))
		const out = await fetchGoodreadsSeries('The Grief of Stones', null)
		expect(out?.primary).toEqual({ name: 'The Cemeteries of Amalo', position: '2' })
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

	test('a stem match that proves only its own NAME is applied but capped', async () => {
		// THE SHAPE (measured live 2026-08-08 with a volume the mirror does not
		// hold): "Series: Distinct Title" where the stem IS the series name.
		// Pass 1 on the full title finds nothing; the stem pass searches
		// "He Who Fights with Monsters", the mirror answers with BOOK 1 — whose
		// title equals the series — at position 1, and with no volume marker in
		// either half the veto is dark. The answer looks confident and carries
		// no evidence beyond "a series by that name exists".
		//
		// It is APPLIED (for a real book 1 with a marketing subtitle it is
		// exactly right, and refusing would break the common case to fix the
		// rare one) but must not be pinned for a week: uncacheable caps the
		// write so a mirror that later gains the real work corrects the row.
		const state = { degraded: false }
		respond(
			[], // pass 1: full title -> no hits
			[{ workId: 42 }], // stem pass: a hit
			{
				Title: 'He Who Fights with Monsters',
				Series: [
					{
						Title: 'He Who Fights with Monsters',
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1', SeriesPosition: 1 }]
					}
				]
			}
		)
		const out = await fetchGoodreadsSeries(
			'He Who Fights with Monsters: A Fabricated Subtitle',
			'Shirtaloon',
			undefined,
			state
		)
		expect(out?.primary?.name).toBe('He Who Fights with Monsters')
		expect(state.degraded).toBe(false)
		expect((state as { uncacheable?: boolean }).uncacheable).toBe(true)
	})

	test('a stem match whose series DIFFERS keeps the full TTL', async () => {
		// The pass's motivating case, untouched: "Esrever Doom" resolves to a
		// work whose series is "Xanth" — a name the query never mentioned, so
		// the answer carries real information and earns the long cache.
		const state = { degraded: false }
		respond([], [{ workId: 42 }], {
			Title: 'Esrever Doom',
			Series: [
				{
					Title: 'Xanth',
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '37', SeriesPosition: 37 }]
				}
			]
		})
		const out = await fetchGoodreadsSeries(
			'Esrever Doom: A Xanth Novel',
			'Piers Anthony',
			undefined,
			state
		)
		expect(out?.primary).toEqual({ name: 'Xanth', position: '37' })
		expect((state as { uncacheable?: boolean }).uncacheable).toBeUndefined()
	})

	test('a VOLUME MARKER means the veto was live, so the answer keeps its TTL', async () => {
		// With "Book 11" in the subtitle the volume veto is armed and the answer
		// survived a real test — capping it would punish the well-evidenced case.
		const state = { degraded: false }
		respond([], [{ workId: 42 }], {
			Title: 'He Who Fights with Monsters',
			Series: [
				{
					Title: 'He Who Fights with Monsters',
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '11', SeriesPosition: 11 }]
				}
			]
		})
		const out = await fetchGoodreadsSeries(
			'He Who Fights with Monsters: A LitRPG Adventure',
			'Shirtaloon',
			undefined,
			state,
			'He Who Fights with Monsters, Book 11'
		)
		expect(out?.primary?.position).toBe('11')
		expect((state as { uncacheable?: boolean }).uncacheable).toBeUndefined()
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
			seriesAliasFor(
				'<b>Also known as:</b>\n - Inkworld (English)\n - Mundo de tinta (Spanish)',
				'English'
			)
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
		const redis = fakeRedisFor(`${SERIES_PREFIX}crooked kingdom|leigh bardugo|||English`, {
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
	const SERIES_ID = 180345
	// The shared profile these tests run under (no GOODREADS_SERIES_URL set).
	const HIT_TTL = 2592000

	const authorRecord = {
		ForeignId: AUTHOR_ID,
		Name: 'Brian Andrews',
		Works: [{ ForeignId: WORK_ID, Title: 'The Adversary' }],
		Series: [
			{
				ForeignId: SERIES_ID,
				Title: 'Tier One',
				// TWO links, so "resolved by IDENTITY" is actually anchored. With a lone
				// link, positionFor's sole-link fallback could hand back this position
				// even if the ForeignWorkId match were broken, and the block's headline
				// claim would hold for the wrong reason.
				LinkItems: [
					{ ForeignWorkId: WORK_ID, PositionInSeries: '9', SeriesPosition: 9 },
					{ ForeignWorkId: 269094999, PositionInSeries: '10', SeriesPosition: 10 }
				]
			}
		]
	}

	// The /series record the alias rename asks for after the answer is resolved.
	// Queued explicitly in every fixture below: an EXHAUSTED bun mock returns
	// `undefined` rather than rejecting, so an unqueued call is silently absorbed as
	// a degraded fetch -- which is how the first version of this block cached
	// nothing while asserting only the series name, and passed.
	const seriesRecord = { LinkItems: [{ ForeignWorkId: WORK_ID }], Description: '' }

	const audibleBook = () => ({
		title: 'The Adversary',
		subtitle: 'Tier One Thrillers, Book 9',
		authors: [{ name: 'Brian Andrews' }],
		seriesPrimary: { name: 'The Tier One Thrillers', position: '9' }
	})

	afterEach(() => fetchMock.mockReset())

	test('the recovered series is applied over the provider series AND cached', async () => {
		// Drives the REAL redis surface, because "nothing was ever cached" is half
		// the reported symptom and asserting the series name alone cannot see it.
		const redis = fakeRedis()
		respond([{ workId: WORK_ID, author: { id: AUTHOR_ID } }], null, authorRecord, seriesRecord)
		const out = await withGoodreadsSeries(audibleBook(), redis)
		expect(out.seriesPrimary).toEqual({ name: 'Tier One', position: '9' })
		// The fallback is only reached by asking the AUTHOR record -- assert the path,
		// not just the queue position, or a regression that re-fetched /work would
		// consume this fixture's body and still look green.
		expect(fetchMock.mock.calls[2][0]).toContain(`/author/${AUTHOR_ID}`)
		// The v5 key carries the volume hint + folded provider series + language;
		// assert the single grseries entry rather than hand-assembling segments.
		const key = [...redis.store.keys()].find((k) => k.startsWith('grseries:v6:'))
		expect(key).toBeDefined()
		expect(redis.store.get(key as string)).toBe(
			JSON.stringify({ primary: { name: 'Tier One', position: '9' } })
		)
		expect(redis.expires.get(key as string)).toBe(HIT_TTL)
	})

	test('a failed recovery keeps the degradation, so no stem retry runs', async () => {
		// CALL COUNT is the assertion, and the title carries a COLON so the stem
		// retry is actually reachable -- with a colon-less title `titleWithoutSubtitle`
		// returns null and the count is pinned by the title shape rather than by the
		// flag, which is why the first version of this test could not fail.
		//
		// /work fails and the author record fails too, so nothing was resolved and the
		// lookup stays degraded -- which is what stops fetchGoodreadsSeries paying for
		// a second paced search against a mirror that just pushed back.
		respond([{ workId: WORK_ID, author: { id: AUTHOR_ID } }], null, null)
		await withGoodreadsSeries(
			{ ...audibleBook(), title: 'The Adversary: A Tier One Thriller' },
			null
		)
		expect(fetchMock.mock.calls.length).toBe(3) // search + work + author, then stop
	})

	test('degradation from an EARLIER hit is preserved, not cleared', async () => {
		// Two hits. The first degrades the lookup (its /work fails and its author
		// record fails too). The second recovers by identity -- but the lookup as a
		// whole HAS lost evidence, so the forgiveness must not reach back and clear
		// it. Otherwise one recovered hit launders away a real failure on another and
		// a partial answer gets applied.
		const redis = fakeRedis()
		respond(
			[
				{ workId: 111111, author: { id: 999999 } },
				{ workId: WORK_ID, author: { id: AUTHOR_ID } }
			],
			null, // hit 1 /work fails      -> degraded
			null, // hit 1 /author fails    -> no recovery, degradation stands
			null, // hit 2 /work fails
			authorRecord, // hit 2 recovers by identity
			seriesRecord
		)
		const out = await withGoodreadsSeries(audibleBook(), redis)
		expect(out.seriesPrimary?.name).toBe('The Tier One Thrillers')
		expect(redis.store.size).toBe(0)
	})

	test('a recovery the GATES REJECT stays degraded, so nothing is applied or cached', async () => {
		// The forgiveness must be spent only on the hit that becomes the ANSWER. Here
		// the author record resolves the work by identity, so the recovery succeeds --
		// and then the title gate throws that work away, which means the /work failure
		// was not routed around after all and its lost evidence still counts.
		//
		// Forgiving at the recovery site instead reports a PRISTINE lookup: measured,
		// that applied a rejected candidate's series over the provider's, and where
		// nothing else answered it pinned this book's miss in the cache for the miss
		// TTL -- a "no series" verdict manufactured entirely out of a failed call.
		const redis = fakeRedis()
		respond(
			[{ workId: WORK_ID, author: { id: AUTHOR_ID } }],
			null, // /work fails -> degraded
			// Recovers by identity, but titles the work something else entirely.
			{ ...authorRecord, Works: [{ ForeignId: WORK_ID, Title: 'An Entirely Different Novel' }] }
		)
		const out = await withGoodreadsSeries(audibleBook(), redis)
		expect(out.seriesPrimary?.name).toBe('The Tier One Thrillers')
		expect(redis.store.size).toBe(0)
	})
})

describe('volume-prefixed titles: retry with the half after the colon', () => {
	/**
	 * Measured corpus, 7 of 1512 albums match `<words> <roman|N>: <rest>`:
	 *
	 *  | title                          | existing chain | reaches retry |
	 *  |--------------------------------|----------------|---------------|
	 *  | Sons of Valor IV: False Flag   | NO ANSWER      | YES -> fixed  |
	 *  | A Soldier's Life: Book 3: ...  | NO ANSWER      | yes -> 0 hits |
	 *  | The 6:20 Man                   | answer         | no (gate 0)   |
	 *  | Artemis Fowl 6: The Time ...   | answer         | no (gate 0)   |
	 *  | Diablo III: The Order          | answer         | no (gate 0)   |
	 *  | He Who Fights with Monsters 11 | answer         | no (gate 0)   |
	 *  | He Who Fights with Monsters 12 | answer         | no (gate 0)   |
	 *
	 * So the LIVE blast radius is one album fixed, none changed. Gates 1 and 2
	 * are unreachable today -- they are here because a future mirror change that
	 * turns any of those five into a no-answer would open the path, and HWFWM is
	 * a series where a wrong match has already cost this operator.
	 *
	 * WHY the existing stem retry cannot do this: it strips the LAST colon and
	 * keeps what precedes it, because providers stack "Series: Title: Marketing".
	 * Here the provider prepended a VOLUME instead, so the identity is the half
	 * it discards -- /search "Sons of Valor IV" returns 0 hits while
	 * /search "False Flag" returns the right work (228408706, Sons of Valor #4).
	 */

	const sonsWork = {
		Title: 'False Flag',
		Authors: [{ Name: 'Brian Andrews' }],
		Series: [
			{
				Title: 'Sons of Valor',
				ForeignId: 312471,
				LinkItems: [{ ForeignWorkId: 228408706, PositionInSeries: '4', SeriesPosition: 4 }]
			}
		]
	}

	const sonsBook = (over: Record<string, unknown> = {}) => ({
		title: 'Sons of Valor IV: False Flag',
		authors: [{ name: 'Brian Andrews' }],
		seriesPrimary: { name: 'The Sons of Valor Series', position: '4' },
		...over
	})

	/** Every path fetched, so a gate can assert a query was never ISSUED. */
	const paths = () => fetchMock.mock.calls.map((c) => String(c[0]))
	/** The exact q= values searched, decoded. Substring matching is useless here:
	 *  the FULL-title search already contains the post-colon half, so a loose
	 *  needle reports the third pass ran when it did not. */
	const queries = () =>
		paths()
			.filter((u) => u.includes('/search'))
			.map((u) => decodeURIComponent(u.split('q=')[1] ?? ''))
	const searchedExactly = (q: string) => queries().includes(q)

	afterEach(() => fetchMock.mockReset())

	test('the post-colon half recovers the series', async () => {
		// pass 1 full title: 0 hits. pass 2 stem "Sons of Valor IV": 0 hits.
		// pass 3 "False Flag": the right work.
		respond([], [], [{ workId: 228408706, author: { id: 5155903 } }], sonsWork)
		const out = await withGoodreadsSeries(sonsBook(), null)
		expect(out.seriesPrimary?.name).toBe('Sons of Valor')
		expect(out.seriesPrimary?.position).toBe('4')
	})

	test('GATE 2: an answer whose series disagrees is rejected (the HWFWM shape)', async () => {
		// The post-colon half is generic sales copy, so the search lands on an
		// unrelated work. Its series does not match the one we already hold, so
		// the provider series must stand.
		const strayWork = {
			Title: 'A LitRPG Adventure',
			Authors: [{ Name: 'Shirtaloon' }],
			Series: [
				{
					Title: 'Some Other Series',
					ForeignId: 99,
					LinkItems: [{ ForeignWorkId: 555, PositionInSeries: '1' }]
				}
			]
		}
		respond([], [], [{ workId: 555, author: { id: 1 } }], strayWork)
		const out = await withGoodreadsSeries(
			{
				title: 'He Who Fights with Monsters 11: A LitRPG Adventure',
				authors: [{ name: 'Shirtaloon' }],
				seriesPrimary: { name: 'He Who Fights with Monsters', position: '11' }
			},
			null
		)
		expect(out.seriesPrimary?.name).toBe('He Who Fights with Monsters')
	})

	test('GATE 2: an answer with NO series is rejected (the Diablo shape)', async () => {
		respond([], [], [{ workId: 777, author: { id: 1 } }], {
			Title: 'The Order',
			Authors: [{ Name: 'Nate Kenyon' }],
			Series: []
		})
		const out = await withGoodreadsSeries(
			{
				title: 'Diablo III: The Order',
				authors: [{ name: 'Nate Kenyon' }],
				seriesPrimary: { name: 'Diablo', position: '8' }
			},
			null
		)
		expect(out.seriesPrimary?.name).toBe('Diablo')
	})

	test('GATE 1: a clock time is not a volume -- no third search at all', async () => {
		// "The 6:20 Man": the pre-colon half is "The", which is not a volume
		// designation of "The 6:20 Man". CALL COUNT is the assertion: two searches
		// (full + stem), never a third.
		respond([], [])
		await withGoodreadsSeries(
			{
				title: 'The 6:20 Man',
				authors: [{ name: 'David Baldacci' }],
				seriesPrimary: { name: 'The 6:20 Man', position: '1' }
			},
			null
		)
		expect(searchedExactly('20 Man David Baldacci')).toBe(false)
	})

	test('GATE 1: no provider series means nothing to verify against, so no retry', async () => {
		respond([], [])
		await withGoodreadsSeries(
			{ title: 'Sons of Valor IV: False Flag', authors: [{ name: 'Brian Andrews' }] },
			null
		)
		expect(searchedExactly('False Flag Brian Andrews')).toBe(false)
	})

	test('a SINGLE roman letter is not treated as a volume (deliberate)', async () => {
		// "The Expanse I: Leviathan Wakes" would in fact retry correctly -- the
		// post-colon half IS the real title. It is excluded anyway: a lone I/V/X/L/C
		// is far more often an initial or a word than a volume, and nothing in the
		// 1512-album library needs it. Widening the net for a case we do not have
		// is how the earlier title heuristics went wrong, so this pins the narrow
		// choice rather than leaving it to drift.
		respond([], [])
		await withGoodreadsSeries(
			{
				title: 'The Expanse I: Leviathan Wakes',
				authors: [{ name: 'James S. A. Corey' }],
				seriesPrimary: { name: 'The Expanse', position: '1' }
			},
			null
		)
		expect(searchedExactly('Leviathan Wakes James S. A. Corey')).toBe(false)
	})

	test('GATE 0: a book the first pass answers never reaches the retry', async () => {
		respond([{ workId: 228408706, author: { id: 5155903 } }], sonsWork)
		const out = await withGoodreadsSeries(sonsBook(), null)
		expect(out.seriesPrimary?.name).toBe('Sons of Valor')
		// Not a raw call count: a series carrying a ForeignId also triggers one
		// /series/{id} alias fetch. What matters is that no SECOND search ran.
		expect(paths().filter((u) => u.includes('/search')).length).toBe(1)
	})
})

describe('a rescued umbrella must not spend the sub-series it stepped over', () => {
	// THE EMPEROR'S SOUL. Measured live 2026-07-29 against the mirror at
	// a self-hosted rreading-glasses mirror and the API:
	//
	//   /work/19161502 Series:
	//     "Elantris"             id 87970   LinkItems[ours] PositionInSeries ""   SeriesPosition 0
	//     "The Cosmere Universe" id 135117  LinkItems[ours] PositionInSeries "7.5"
	//   api.audible.com/1.0/catalog/products/B009XEKR3O
	//     series [{ asin B08KXL8CWM, title "Elantris", sequence "2" }]
	//   GET /books/B009XEKR3O -> seriesPrimary { "The Cosmere Universe", "7.5" }
	//   Plex titleSort "Cosmere Universe, Book 7.5 - The Emperor's Soul"
	//
	// The umbrella rescue is not missing here -- it is the mechanism that produced
	// that row. Elantris cannot place the book (PositionInSeries ""), so the rescue
	// branch re-admits the umbrella, and positioned-first ranking puts it at
	// ranked[0], where it overwrites Audible's clean, positioned "Elantris #2".
	//
	// The module's own doctrine (see the refusals in withGoodreadsSeries) is that a
	// FALLBACK answer must not spend a clean provider series. The rescue branch is
	// the one path that produces a fallback without declaring itself one.
	//
	// Blast radius, measured over 1401 resolvable library records: exactly ONE sets
	// rescuedOver -- B009XEKR3O. The gate is inert on the other 1400.
	const emperorsSoul = (base: number) => ({
		Title: "The Emperor's Soul",
		Series: [
			{
				Title: 'Elantris',
				ForeignId: base + 1,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '', SeriesPosition: 0 }]
			},
			{
				Title: 'The Cosmere Universe',
				ForeignId: base + 2,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '7.5' }]
			}
		]
	})
	const members = (n: number) => ({ LinkItems: Array.from({ length: n }, (_, i) => i) })

	test('the rescue still fires, so a book with NO series is still gap-filled', async () => {
		// Guard against "fixing" this by deleting the rescue. Its whole purpose is
		// a book that would otherwise have no shelf at all.
		respond([{ workId: 42 }], emperorsSoul(200), members(9), members(32))
		const out = await fetchGoodreadsSeries("The Emperor's Soul", 'Brandon Sanderson')
		expect(out?.primary).toEqual({ name: 'The Cosmere Universe', position: '7.5' })
		expect(out?.rescuedOver).toEqual(['Elantris'])
	})

	test('rescuedOver is NOT set when a clean sub-series could place the book', async () => {
		// Hoid's Travails: Tress -> #1, Yumi -> #2, both POSITIONED, so
		// clean.some(canPlace) is true and the rescue branch is never entered.
		// A previous sub-series demotion was reverted for breaking this shelf.
		respond(
			[{ workId: 42 }],
			{
				Title: 'Tress of the Emerald Sea',
				Series: [
					{
						Title: "Hoid's Travails",
						ForeignId: 211,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
					},
					{
						Title: 'The Cosmere Universe',
						ForeignId: 212,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '30' }]
					}
				]
			},
			members(2)
		)
		const out = await fetchGoodreadsSeries('Tress of the Emerald Sea', 'Brandon Sanderson')
		expect(out?.primary).toEqual({ name: "Hoid's Travails", position: '1' })
		expect(out?.rescuedOver).toBeUndefined()
	})

	test('the provider Elantris #2 survives instead of being overwritten', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond([{ workId: 42 }], emperorsSoul(220), members(9), members(32))
		const book = {
			title: "The Emperor's Soul",
			authors: [{ name: 'Brandon Sanderson' }],
			seriesPrimary: { name: 'Elantris', position: '2' }
		}
		const out = await withGoodreadsSeries(book, fakeRedis())
		expect(out.seriesPrimary).toEqual({ name: 'Elantris', position: '2' })
	})

	test('EVERY displaced sub-series is recorded, not just the first', async () => {
		// Two clean sub-series, NEITHER able to number this book, plus an umbrella
		// that can. Recording only clean[0] would let the umbrella spend the second
		// one -- a mutation that survived the rest of this suite.
		const twoSubs = {
			Title: "The Emperor's Soul",
			Series: [
				{
					Title: 'Elantris',
					ForeignId: 261,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '' }]
				},
				{
					Title: 'Dragonsteel',
					ForeignId: 262,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '' }]
				},
				{
					Title: 'The Cosmere Universe',
					ForeignId: 263,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '7.5' }]
				}
			]
		}
		respond([{ workId: 42 }], twoSubs, members(9), members(4), members(32))
		const out = await fetchGoodreadsSeries("The Emperor's Soul", 'Brandon Sanderson')
		expect(out?.rescuedOver).toEqual(['Elantris', 'Dragonsteel'])

		// ...and the SECOND one is protected on the apply path too.
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond([{ workId: 42 }], twoSubs, members(9), members(4), members(32))
		const out2 = await withGoodreadsSeries(
			{
				title: "The Emperor's Soul",
				authors: [{ name: 'Brandon Sanderson' }],
				seriesPrimary: { name: 'Dragonsteel', position: '1' }
			},
			fakeRedis()
		)
		expect(out2.seriesPrimary).toEqual({ name: 'Dragonsteel', position: '1' })
	})

	test('a DIFFERENT provider series is still overwritten, so authority is kept', async () => {
		// The blanket alternative -- marking every rescued answer variantOnly --
		// would refuse here too and lose Goodreads authority for the whole
		// franchise. Measured: Mistborn Saga #9 must still be replaced.
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond([{ workId: 42 }], emperorsSoul(240), members(9), members(32))
		const book = {
			title: "The Emperor's Soul",
			authors: [{ name: 'Brandon Sanderson' }],
			seriesPrimary: { name: 'The Mistborn Saga', position: '9' }
		}
		const out = await withGoodreadsSeries(book, fakeRedis())
		expect(out.seriesPrimary).toEqual({ name: 'The Cosmere Universe', position: '7.5' })
	})
})

describe('the fold that decides "the same series"', () => {
	// EXACT after fold. Never substring, never descriptor nouns -- the two `flat`
	// helpers already in this module do both, and reusing either would merge
	// shelves this library deliberately keeps apart.
	let rescueWouldSpendItsOwnSubSeries: (r: unknown, n?: string | null) => boolean

	beforeEach(async () => {
		;({ rescueWouldSpendItsOwnSubSeries } = await import('#helpers/providers/goodreadsSeries'))
	})

	const rescued = (...names: string[]) => ({
		primary: { name: 'X', position: '1' },
		rescuedOver: names
	})

	test('an exact name matches', () => {
		expect(rescueWouldSpendItsOwnSubSeries(rescued('Elantris'), 'Elantris')).toBe(true)
	})

	test('a leading article is folded', () => {
		expect(rescueWouldSpendItsOwnSubSeries(rescued('The Elantris'), 'Elantris')).toBe(true)
		expect(rescueWouldSpendItsOwnSubSeries(rescued('Elantris'), 'The Elantris')).toBe(true)
	})

	test('a curly apostrophe is folded', () => {
		expect(rescueWouldSpendItsOwnSubSeries(rescued('Hoid’s Travails'), "Hoid's Travails")).toBe(
			true
		)
	})

	test('descriptor nouns are NOT folded: Riyria is not The Riyria Chronicles', () => {
		// Both are real, DISTINCT shelves in this library (census 2026-07-29,
		// rk 155492 Drumindor: primary "Riyria" #5, secondary "The Riyria
		// Chronicles" #5). The module's existing `flat` strips "chronicles" and
		// would merge them.
		expect(rescueWouldSpendItsOwnSubSeries(rescued('Riyria'), 'The Riyria Chronicles')).toBe(false)
	})

	test('a substring is NOT a match: Jack Ryan is not Jack Ryan, Jr.', () => {
		// rk 155442 Tom Clancy Firing Point: primary "Jack Ryan" #16, secondary
		// "Jack Ryan, Jr." #13. Substring matching would collapse them.
		expect(rescueWouldSpendItsOwnSubSeries(rescued('Jack Ryan'), 'Jack Ryan, Jr.')).toBe(false)
		expect(rescueWouldSpendItsOwnSubSeries(rescued('Jack Ryan, Jr.'), 'Jack Ryan')).toBe(false)
	})

	test('no rescue means no refusal, whatever the provider series says', () => {
		expect(rescueWouldSpendItsOwnSubSeries({ primary: { name: 'X' } }, 'Elantris')).toBe(false)
		expect(rescueWouldSpendItsOwnSubSeries(rescued(), 'Elantris')).toBe(false)
		expect(rescueWouldSpendItsOwnSubSeries(null, 'Elantris')).toBe(false)
	})

	test('no provider series means no refusal', () => {
		expect(rescueWouldSpendItsOwnSubSeries(rescued('Elantris'), undefined)).toBe(false)
		expect(rescueWouldSpendItsOwnSubSeries(rescued('Elantris'), '')).toBe(false)
		expect(rescueWouldSpendItsOwnSubSeries(rescued('Elantris'), '   ')).toBe(false)
	})

	test('it checks EVERY series the rescue stepped over, not just the first', () => {
		expect(rescueWouldSpendItsOwnSubSeries(rescued('Other', 'Elantris'), 'Elantris')).toBe(true)
	})
})

describe('the volume hint may number a DIFFERENT series of the right work', () => {
	// THE DRIZZT REGRESSION. Measured 2026-07-29 over all 1401 resolvable library
	// records: the veto fires on 34, and 30 of those are rows whose live answer a
	// cold lookup no longer reproduces.
	//
	// Audible subtitles a sub-arc: "Legend of Drizzt: Legacy of the Drow, Book 2".
	// VOLUME_HINT_RE reads 2 out of that, while the ranked Goodreads answer is the
	// PARENT series at #8 -- and the ranking prefers the parent deliberately. Both
	// numbers are right for their own series, but the veto compared them as though
	// they named one, threw the whole work away, and because these ASINs carry a
	// null publication_name there is no provider series to catch the fall: 12
	// Legend of Drizzt albums end up with NO SERIES AT ALL.
	//
	// The corroboration the fix rests on is in the mirror's own record: a listing
	// of THE SAME WORK sits at the hint's number. 19 of the 30 rows are
	// corroborated that way (12 Drizzt, 5 Thomas Covenant, Mage of No Renown, The
	// Empire's Ruin) and are what this repairs. The other 11 are not -- the hint
	// numbers an ordering Goodreads does not carry (7 Galaxy's Edge seasons, 3
	// Jack Ryan chronological, The Law) -- and they stay vetoed.
	//
	// Blast radius, both arms run over all 1401 records: 19 change, every one from
	// "no answer" to an answer, and every one lands on exactly what the live API
	// serves today. Relative to the current shelves this changes zero albums; it
	// stops 19 from moving when their TTL expires.
	const drizzt = {
		Title: 'Starless Night',
		Series: [
			{
				Title: 'The Legend of Drizzt',
				ForeignId: 301,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '8' }]
			},
			{
				Title: 'Legacy of the Drow',
				ForeignId: 302,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '2' }]
			}
		]
	}
	const members = (n: number) => ({ LinkItems: Array.from({ length: n }, (_, i) => i) })

	test('a hint numbering the sub-arc no longer vetoes the parent answer', async () => {
		respond([{ workId: 42 }], drizzt, members(30), members(4))
		const out = await fetchGoodreadsSeries(
			'Starless Night',
			'R. A. Salvatore',
			undefined,
			undefined,
			'Legend of Drizzt: Legacy of the Drow, Book 2'
		)
		expect(out?.primary).toEqual({ name: 'The Legend of Drizzt', position: '8' })
		expect(out?.secondary).toEqual({ name: 'Legacy of the Drow', position: '2' })
	})

	test('an UNcorroborated hint still vetoes -- no listing of the work is at that number', async () => {
		// The guard the veto exists for: "Ahriman" + subtitle "Ahriman, Book 3"
		// adopted the sibling work "Ahriman: Exile" at position 1, putting two
		// books at #1 on one shelf. No series positions THAT work at 3, so the
		// corroboration search finds nothing and the veto still fires.
		respond([{ workId: 42 }], {
			Title: 'Ahriman: Exile',
			Series: [
				{
					Title: 'Ahriman',
					ForeignId: 303,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				}
			]
		})
		const out = await fetchGoodreadsSeries(
			'Ahriman',
			'John French',
			undefined,
			undefined,
			'Ahriman, Book 3'
		)
		expect(out).toBeNull()
	})

	test('an unpositioned listing cannot corroborate a hint', async () => {
		// Number(undefined) and Number('') are not the hint, so a positionless
		// sibling listing must not launder a contradiction into an accept.
		respond([{ workId: 42 }], {
			Title: 'Some Book',
			Series: [
				{
					Title: 'Real Series',
					ForeignId: 304,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				},
				{
					Title: 'Vague Listing',
					ForeignId: 305,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '' }]
				}
			]
		})
		const out = await fetchGoodreadsSeries(
			'Some Book',
			'An Author',
			undefined,
			undefined,
			'Real Series, Book 7'
		)
		expect(out).toBeNull()
	})
})

describe('volumeHintRulesOutWork', () => {
	let ruled: (
		h: string | undefined,
		a: string | null | undefined,
		w: Array<string | null | undefined>
	) => boolean
	beforeEach(async () => {
		;({ volumeHintRulesOutWork: ruled } = await import('#helpers/providers/goodreadsSeries'))
	})

	test('no hint never rules anything out', () => {
		expect(ruled(undefined, '8', ['8'])).toBe(false)
		expect(ruled('', '8', ['8'])).toBe(false)
	})

	test('an answer with no position cannot contradict a hint', () => {
		expect(ruled('2', undefined, [])).toBe(false)
		expect(ruled('2', null, [])).toBe(false)
		expect(ruled('2', '', [])).toBe(false)
	})

	test('a non-numeric hint cannot contradict anything', () => {
		// Number('') is 0, so the emptiness guard is load-bearing, not decoration.
		expect(ruled('The Primarchs Short Story', '8', ['8'])).toBe(false)
	})

	test('the hint matching ANY of the work series positions corroborates it', () => {
		expect(ruled('2', '8', ['8', '2'])).toBe(false)
		expect(ruled('2', '2', ['2'])).toBe(false)
		expect(ruled('7.5', '1', ['1', '7.5'])).toBe(false)
	})

	test('the hint matching NO series position rules the work out', () => {
		expect(ruled('3', '1', ['1'])).toBe(true)
		expect(ruled('3', '1', ['1', '2'])).toBe(true)
	})

	test('a positionless or free-text listing cannot corroborate', () => {
		expect(ruled('7', '1', ['1', undefined, null, '', '1-2'])).toBe(true)
	})
})

describe('defects found by review of the 2026-07-29/30 series work', () => {
	const members = (n: number) => ({ LinkItems: Array.from({ length: n }, (_, i) => i) })

	test('an ORDERING listing must not corroborate the volume hint', async () => {
		// REGRESSION from dd72fcd. volumeHintRulesOutWork is handed
		// `all.map(positionFor)` -- EVERY listing on the work, including the
		// publication-order / chronological / omnibus listings that isOrdering()
		// demotes out of the shelving pool a few lines above. So a listing the module
		// itself declares unfit to be a shelf is trusted to disarm the veto.
		//
		// Title "Ahriman" + subtitle "Ahriman, Book 3" is the exact shape the veto
		// exists for: the sibling work "Ahriman: Exile" sits at #1 and must be
		// refused. A "Black Library Publication Order" listing that happens to place
		// it at 3 corroborates the hint and lets the wrong work through -- two books
		// at #1 on one shelf.
		respond(
			[{ workId: 7 }],
			{
				Title: 'Ahriman: Exile',
				Series: [
					{
						Title: 'Ahriman',
						ForeignId: 500,
						LinkItems: [{ ForeignWorkId: 7, PositionInSeries: '1' }]
					},
					{
						Title: 'Black Library Publication Order',
						ForeignId: 600,
						LinkItems: [{ ForeignWorkId: 7, PositionInSeries: '3' }]
					}
				]
			},
			members(9),
			members(400)
		)
		const out = await fetchGoodreadsSeries(
			'Ahriman',
			'John French',
			undefined,
			undefined,
			'Ahriman, Book 3'
		)
		expect(out).toBeNull()
	})

	test('a REAL sibling series still corroborates', async () => {
		// The counterpart, so the fix cannot be "reject everything": Legacy of the
		// Drow #2 is a genuine shelf and must still disarm the veto for
		// The Legend of Drizzt #8.
		respond(
			[{ workId: 42 }],
			{
				Title: 'Starless Night',
				Series: [
					{
						Title: 'The Legend of Drizzt',
						ForeignId: 301,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '8' }]
					},
					{
						Title: 'Legacy of the Drow',
						ForeignId: 302,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '2' }]
					}
				]
			},
			members(30),
			members(4)
		)
		const out = await fetchGoodreadsSeries(
			'Starless Night',
			'R. A. Salvatore',
			undefined,
			undefined,
			'Legend of Drizzt: Legacy of the Drow, Book 2'
		)
		expect(out?.primary).toEqual({ name: 'The Legend of Drizzt', position: '8' })
	})

	test('the series-name fold survives a Unicode normalization difference', async () => {
		// foldSeriesName normalized apostrophes but not Unicode form, so an NFD name
		// never compared equal to its visually identical NFC twin and Gate C silently
		// did not fire. The repo already ships src/helpers/utils/foldDiacritics.ts.
		const { rescueWouldSpendItsOwnSubSeries } = await import('#helpers/providers/goodreadsSeries')
		const nfc = 'Elantriz\u00e9'
		const nfd = 'Elantrize\u0301'
		expect(nfc).not.toBe(nfd)
		expect(
			rescueWouldSpendItsOwnSubSeries(
				{ primary: { name: 'X', position: '1' }, rescuedOver: [nfd] },
				nfc
			)
		).toBe(true)
	})

	test('one malformed /work record does not abandon the remaining candidates', async () => {
		// 5863bc7 hardened workFromAuthorRecord with Array.isArray on the stated
		// premise that a mirror under load answers with an object where a list
		// belongs -- but left the three `?? []` reads on the PRIMARY /work parse,
		// which run on every hit of every lookup. The same commit's blanket
		// try/catch then turns the TypeError into a silent abandonment.
		respond(
			[{ workId: 1 }, { workId: 2 }],
			{ Title: 'The Grief of Stones', Series: { Title: 'Not An Array' } },
			{
				Title: 'The Grief of Stones',
				Series: [
					{
						Title: 'The Cemeteries of Amalo',
						ForeignId: 700,
						LinkItems: [{ ForeignWorkId: 2, PositionInSeries: '2' }]
					}
				]
			}
		)
		const out = await fetchGoodreadsSeries('The Grief of Stones', 'Katherine Addison')
		expect(out?.primary).toEqual({ name: 'The Cemeteries of Amalo', position: '2' })
	})
})

describe('review round two: shared state, hyphenated umbrellas, aliased rescues', () => {
	const members = (n: number) => ({ LinkItems: Array.from({ length: n }, (_, i) => i) })

	test('a count failure on a DISCARDED candidate does not kill the lookup', async () => {
		// The per-hit workProbe idiom from 5863bc7 was never extended to the /series
		// member counts, which still write to the SHARED state. The volume veto is the
		// only `continue` that can fire AFTER the counts, so a cosmetic count failure
		// on a candidate the veto then throws away can never be rewound -- and a later
		// clean hit is refused because state.degraded is set.
		//
		// Reachable: of the 11 library rows the veto still fires on, the 3 Jack Ryan
		// chronological ones sit on works carrying THREE series, so a count IS paid
		// and then discarded. A 429 also arms a module-wide 60s backoff, so count
		// failures arrive in bursts rather than singly.
		respond(
			[{ workId: 42 }, { workId: 43 }],
			{
				Title: 'Alpha Book',
				Series: [
					{
						Title: 'Alpha One',
						ForeignId: 501,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '5' }]
					},
					{
						Title: 'Alpha Two',
						ForeignId: 502,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '8' }]
					}
				]
			},
			null, // /series/501 fails -- a count on the candidate the veto discards
			members(9),
			{
				Title: 'Alpha Book',
				Series: [
					{
						Title: 'Alpha Three',
						ForeignId: 503,
						LinkItems: [{ ForeignWorkId: 43, PositionInSeries: '3' }]
					}
				]
			}
		)
		const state = { degraded: false }
		const out = await fetchGoodreadsSeries(
			'Alpha Book',
			'An Author',
			undefined,
			state,
			'Probe Series, Book 3'
		)
		expect(out?.primary).toEqual({ name: 'Alpha Three', position: '3' })
		// The surviving answer paid no failed count of its own, so nothing may be
		// degraded -- that flag is what stops the answer being applied AND cached.
		expect(state.degraded).toBe(false)
	})

	test('a count failure on the SURVIVING answer still degrades', async () => {
		// The counterpart: the documented guarantee is that a wrong count misranks
		// the pool, so a failure that touched the answer we return must still be
		// reported. Fixing the above by simply never propagating would break this.
		respond(
			[{ workId: 42 }],
			{
				Title: 'Beta Book',
				Series: [
					{
						Title: 'Beta One',
						ForeignId: 511,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
					},
					{
						Title: 'Beta Two',
						ForeignId: 512,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '2' }]
					}
				]
			},
			null,
			members(9)
		)
		const state = { degraded: false }
		await fetchGoodreadsSeries('Beta Book', 'An Author', undefined, state)
		expect(state.degraded).toBe(true)
	})

	test('a hyphen-joined -Verse still reads as a franchise umbrella', async () => {
		// SERIES_UMBRELLA_RE matches \w* words, and \w cannot cross a hyphen, so
		// "Spider-Verse" tokenizes to the bare word "Verse" -- which is in the
		// stopword list. The umbrella then entered the pool as a CLEAN series and won
		// on member count, overwriting the provider's positioned sub-series.
		// Measured on the live mirror: 8 titles diverge between the old and new
		// predicate, 4 of them on multi-series works.
		respond(
			[{ workId: 42 }],
			{
				Title: 'A Spider Book',
				Series: [
					{
						Title: 'Spider-Man',
						ForeignId: 601,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '5' }]
					},
					{
						Title: 'Spider-Verse',
						ForeignId: 602,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '3' }]
					}
				]
			},
			members(3),
			members(40)
		)
		const out = await fetchGoodreadsSeries('A Spider Book', 'An Author')
		expect(out?.primary).toEqual({ name: 'Spider-Man', position: '5' })
	})

	test('the words the stopword list exists for are still NOT umbrellas', async () => {
		// "Reverse Harem Story" and "Lucky Lady Reverse Harem" are real series and are
		// exactly the false positives the stopword list was added to fix. The hyphen
		// exemption must not readmit them.
		respond(
			[{ workId: 42 }],
			{
				Title: 'A Harem Book',
				Series: [
					{
						Title: 'Reverse Harem Story',
						ForeignId: 611,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '2' }]
					},
					{
						Title: 'Some Other Shelf',
						ForeignId: 612,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '4' }]
					}
				]
			},
			members(30),
			members(3)
		)
		const out = await fetchGoodreadsSeries('A Harem Book', 'An Author')
		// Both are clean, so the larger one wins on member count -- the point is that
		// "Reverse Harem Story" was NOT demoted as an umbrella.
		expect(out?.primary).toEqual({ name: 'Reverse Harem Story', position: '2' })
	})
})

describe('Gate C must survive the shelf-language rename', () => {
	afterEach(() => {
		fetchMock.mockReset()
		delete process.env.GOODREADS_SERIES_LANGUAGE
	})

	const members = (n: number) => ({ LinkItems: Array.from({ length: n }, (_, i) => i) })
	const TINTENWELT_DESC =
		'<b>Also known as:</b>\n - Inkworld (English)\n - Mundo de tinta (Spanish)'

	// rescuedOver is filled from the CANONICAL Goodreads titles inside the ranking,
	// while the shelf-language rename rewrites only result.primary/secondary. So the
	// same response can hand back secondary "Inkworld" and rescuedOver ["Tintenwelt"]
	// -- and a provider holding the English name never matched, letting the umbrella
	// take a shelf Gate C exists to protect. The rename is live on this deployment
	// (Inkheart resolves to "Inkworld" while /work and /series both say "Tintenwelt").
	const aliasedRescue = (base: number) => ({
		Title: 'The Color of Revenge',
		Series: [
			{
				Title: 'Tintenwelt',
				ForeignId: base + 1,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '' }]
			},
			{
				Title: 'The Funke Universe',
				ForeignId: base + 2,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '4' }]
			}
		]
	})

	test('a provider holding the ALIASED name is still protected', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond(
			[{ workId: 42 }],
			aliasedRescue(92000),
			{ Title: 'Tintenwelt', Description: TINTENWELT_DESC, LinkItems: [1, 2, 3] },
			members(40),
			{ Title: 'The Funke Universe', Description: 'TODO', LinkItems: [1, 2, 3] },
			{ Title: 'Tintenwelt', Description: TINTENWELT_DESC, LinkItems: [1, 2, 3] }
		)
		const out = await withGoodreadsSeries(
			{
				title: 'The Color of Revenge',
				authors: [{ name: 'Cornelia Funke' }],
				seriesPrimary: { name: 'Inkworld', position: '4' }
			},
			fakeRedis()
		)
		expect(out.seriesPrimary).toEqual({ name: 'Inkworld', position: '4' })
	})

	test('a provider holding the CANONICAL name is still protected', async () => {
		// The pre-existing arm must not regress while the alias arm is added.
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond(
			[{ workId: 42 }],
			aliasedRescue(92100),
			{ Title: 'Tintenwelt', Description: TINTENWELT_DESC, LinkItems: [1, 2, 3] },
			members(40),
			{ Title: 'The Funke Universe', Description: 'TODO', LinkItems: [1, 2, 3] },
			{ Title: 'Tintenwelt', Description: TINTENWELT_DESC, LinkItems: [1, 2, 3] }
		)
		const out = await withGoodreadsSeries(
			{
				title: 'The Color of Revenge',
				authors: [{ name: 'Cornelia Funke' }],
				seriesPrimary: { name: 'Tintenwelt', position: '4' }
			},
			fakeRedis()
		)
		expect(out.seriesPrimary).toEqual({ name: 'Tintenwelt', position: '4' })
	})

	test('an UNRELATED provider series is still overwritten', async () => {
		// Gate C stays narrow: only the displaced series is protected.
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond(
			[{ workId: 42 }],
			aliasedRescue(92200),
			{ Title: 'Tintenwelt', Description: TINTENWELT_DESC, LinkItems: [1, 2, 3] },
			members(40),
			{ Title: 'The Funke Universe', Description: 'TODO', LinkItems: [1, 2, 3] },
			{ Title: 'Tintenwelt', Description: TINTENWELT_DESC, LinkItems: [1, 2, 3] }
		)
		const out = await withGoodreadsSeries(
			{
				title: 'The Color of Revenge',
				authors: [{ name: 'Cornelia Funke' }],
				seriesPrimary: { name: 'Something Else Entirely', position: '9' }
			},
			fakeRedis()
		)
		expect(out.seriesPrimary?.name).toBe('The Funke Universe')
	})
})

describe('the volume veto: who may vouch for a volume', () => {
	const members = (n: number) => ({ LinkItems: Array.from({ length: n }, (_, i) => i) })

	test('an UMBRELLA listing must not corroborate the volume hint either', async () => {
		// b2094a5 filtered ORDERINGS out of the corroboration set but left UMBRELLAS
		// in, although the pool filter three lines above demotes both identically
		// (`!isOrdering(s) && !isUmbrella(s)`). A franchise umbrella the module
		// refuses to shelve on was still trusted to vouch for a volume.
		//
		// Live shape: "Mistborn" + subtitle "Mistborn, Book 2" -- work 66322 lists
		// The Mistborn Saga #1, The Cosmere Universe #2, Mistborn Era 1 #1. The hint
		// is 2 and only the UMBRELLA supplies a 2, so the veto stayed silent and the
		// answer came back as The Mistborn Saga #1 for a book whose own subtitle says
		// Book 2. Measured base rate on the mirror: 15 of 148 sampled works (10.1%)
		// have a second corroborating position supplied ONLY by an umbrella.
		respond(
			[{ workId: 42 }],
			{
				Title: 'Mistborn',
				Series: [
					{
						Title: 'The Mistborn Saga',
						ForeignId: 801,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
					},
					{
						Title: 'The Cosmere Universe',
						ForeignId: 802,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '2' }]
					}
				]
			},
			members(9)
		)
		const out = await fetchGoodreadsSeries(
			'Mistborn',
			'Brandon Sanderson',
			undefined,
			undefined,
			'Mistborn, Book 2'
		)
		expect(out).toBeNull()
	})

	test('an answer that IS an ordering may vouch for its own position', async () => {
		// REGRESSION from b2094a5. volumeHintRulesOutWork deliberately omits a
		// `Number(answerPosition) === want` shortcut, on the documented grounds that
		// "the ranked series is itself one of workPositions". The ordering filter
		// falsified that: on the variantOnly path (clean is empty, so pool = all) the
		// ANSWER is an ordering, so its own position was filtered out of the set that
		// vouches for it -- and the answer was vetoed by a hint it exactly agrees
		// with.
		//
		// Live: three Foundation rows (Foundation/Book 3, Prelude/Book 1, Forward the
		// Foundation/Book 2) all self-agreeing, all returning null since b2094a5.
		respond([{ workId: 42 }], {
			Title: 'Forward the Foundation',
			Series: [
				{
					Title: 'Foundation (Chronological Order)',
					ForeignId: 811,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '2' }]
				}
			]
		})
		const out = await fetchGoodreadsSeries(
			'Forward the Foundation',
			'Isaac Asimov',
			undefined,
			undefined,
			'The Foundation Series, Book 2'
		)
		expect(out?.primary).toEqual({ name: 'Foundation (Chronological Order)', position: '2' })
	})

	test('a CLEAN sibling listing still vouches', async () => {
		// The property the whole veto relaxation exists for must survive both fixes.
		respond(
			[{ workId: 42 }],
			{
				Title: 'Starless Night',
				Series: [
					{
						Title: 'The Legend of Drizzt',
						ForeignId: 821,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '8' }]
					},
					{
						Title: 'Legacy of the Drow',
						ForeignId: 822,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '2' }]
					}
				]
			},
			members(30),
			members(4)
		)
		const out = await fetchGoodreadsSeries(
			'Starless Night',
			'R. A. Salvatore',
			undefined,
			undefined,
			'Legend of Drizzt: Legacy of the Drow, Book 2'
		)
		expect(out?.primary).toEqual({ name: 'The Legend of Drizzt', position: '8' })
	})
})

describe('the cache key carries everything the answer depends on', () => {
	// PROBE-PROVEN cross-row poisoning (review 2026-07-30): row A {title
	// 'Ahriman', no subtitle, no provider series} resolves the sibling work at
	// #1 and caches it; row B {same title+author, subtitle 'Ahriman, Book 3',
	// provider Ahriman #3} then read that entry with ZERO fetches, never ran
	// the volume veto, and was overwritten to #1 — two books at #1 on one
	// shelf, the exact symptom the veto exists to prevent, reintroduced
	// through the cache. The key was (title, author) while the answer also
	// depends on the volume hint, the provider series, and the serve language.
	const members = (n: number) => ({ LinkItems: Array.from({ length: n }, (_, i) => i) })
	// The single-series path pays one /series alias fetch (language rename);
	// an exhausted mock reads as degraded -> uncacheable -> nothing cached, so
	// every successful-lookup fixture must queue it.
	const aliasRecord = () => ({ Title: 'Ahriman', Description: 'TODO', LinkItems: [1, 2] })
	const ahrimanExile = {
		Title: 'Ahriman: Exile',
		Series: [
			{
				Title: 'Ahriman',
				ForeignId: 901,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
			}
		]
	}

	test("a row WITH a volume hint never consumes a hintless row's entry", async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		const redis = fakeRedis()
		// Row A: no subtitle, no provider series — adopts Ahriman #1 and caches it.
		respond([{ workId: 42 }], ahrimanExile, aliasRecord())
		const a = await withGoodreadsSeries(
			{ title: 'Ahriman', authors: [{ name: 'John French' }] },
			redis
		)
		expect(a.seriesPrimary).toEqual({ name: 'Ahriman', position: '1' })
		expect(redis.store.size).toBeGreaterThan(0)

		// Row B: same title+author, subtitle names Book 3, provider holds #3.
		// It must MISS the cache (different key), re-run the lookup, and keep
		// its provider series — not adopt A's #1.
		respond([{ workId: 42 }], ahrimanExile, aliasRecord())
		const b = await withGoodreadsSeries(
			{
				title: 'Ahriman',
				subtitle: 'Ahriman, Book 3',
				authors: [{ name: 'John French' }],
				seriesPrimary: { name: 'Ahriman', position: '3' }
			},
			redis
		)
		expect(b.seriesPrimary).toEqual({ name: 'Ahriman', position: '3' })
		expect(fetchMock).toHaveBeenCalled()
	})

	test("a row with a DIFFERENT provider series misses a series-less row's null", async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		const redis = fakeRedis()
		// Series-less row misses everything and caches the null sentinel.
		respond([], [])
		await withGoodreadsSeries(
			{ title: 'Sons of Valor IV: False Flag', authors: [{ name: 'Brian Andrews' }] },
			redis
		)
		const nullEntries = [...redis.store.values()].filter((v) => v === 'null').length
		expect(nullEntries).toBe(1)

		// The same title WITH a provider series must not short-circuit on that
		// sentinel — its gates depend on the series it carries.
		respond(
			[],
			[],
			[{ workId: 42 }],
			{
				Title: 'False Flag',
				Series: [
					{
						Title: 'Sons of Valor',
						ForeignId: 902,
						LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '4' }]
					}
				]
			},
			members(4),
			{ Title: 'Sons of Valor', Description: 'TODO', LinkItems: [1, 2] }
		)
		const out = await withGoodreadsSeries(
			{
				title: 'Sons of Valor IV: False Flag',
				authors: [{ name: 'Brian Andrews' }],
				seriesPrimary: { name: 'The Sons of Valor Series', position: '4' }
			},
			redis
		)
		expect(out.seriesPrimary?.name).toBe('Sons of Valor')
	})

	test('the SAME full identity still hits the cache', async () => {
		// The key must not overshoot: identical inputs -> second call is free.
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		const redis = fakeRedis()
		respond([{ workId: 42 }], ahrimanExile, aliasRecord())
		await withGoodreadsSeries(
			{ title: 'Ahriman: Exile', authors: [{ name: 'John French' }] },
			redis
		)
		fetchMock.mockReset()
		const again = await withGoodreadsSeries(
			{ title: 'Ahriman: Exile', authors: [{ name: 'John French' }] },
			redis
		)
		expect(again.seriesPrimary).toEqual({ name: 'Ahriman', position: '1' })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('cosmetic subtitle variants with the SAME hint share one entry', async () => {
		// The key carries the DERIVED volume hint, not the raw subtitle: two rows
		// whose subtitles differ cosmetically but say the same "Book 3" must hit
		// one entry — keying the raw string would shred the hit rate for nothing.
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		const redis = fakeRedis()
		const book = (subtitle: string) => ({
			title: 'Ahriman',
			subtitle,
			authors: [{ name: 'John French' }],
			seriesPrimary: { name: 'Ahriman', position: '3' }
		})
		respond([], [], [])
		await withGoodreadsSeries(book('Ahriman, Book 3'), redis)
		fetchMock.mockReset()
		await withGoodreadsSeries(book('Ahriman,  Book 3 '), redis)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('the key namespace is v5', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		const redis = fakeRedis()
		respond([{ workId: 42 }], ahrimanExile, aliasRecord())
		await withGoodreadsSeries(
			{ title: 'Ahriman: Exile', authors: [{ name: 'John French' }] },
			redis
		)
		expect([...redis.store.keys()].every((k) => k.startsWith('grseries:v6:'))).toBe(true)
	})
})

describe('a forgiven recovery whose answer GATE 2 rejects must not cache a miss', () => {
	// PROBE-PROVEN (review 2026-07-30): passes 1-2 miss cleanly, pass 3's /work
	// fails on transport, the author record recovers the work, every gate inside
	// lookupByTitle passes and `return result` forgives the degradation — then
	// volumePrefixRetry's GATE 2 rejects the answer for naming a different
	// series and returns null with probe.degraded FALSE. seriesEnriched wrote
	// the 'null' sentinel: one transport blip blanked the book's enrichment for
	// the whole miss TTL. The forgiveness is conditioned on lookupByTitle's own
	// return, but gate 2 lives one level UP, which the promise never covered.
	test('the manufactured miss is not cached', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		const redis = fakeRedis()
		respond(
			[], // pass 1: full title
			[], // pass 2: stem
			[{ workId: 77, author: { id: 9 } }], // pass 3: post-colon half
			null, // /work/77 transport failure
			{
				// author record recovers the work — with a series GATE 2 will reject
				Name: 'Brian Andrews',
				Works: [{ ForeignId: 77, Title: 'Assault' }],
				Series: [
					{
						Title: 'Bravo Team',
						ForeignId: 903,
						LinkItems: [{ ForeignWorkId: 77, PositionInSeries: '2' }]
					}
				]
			},
			// The alias record MUST be queued: an exhausted mock reads as a degraded
			// alias fetch -> uncacheable -> nothing cached, which masks this very
			// defect for an unrelated reason (caught doing exactly that, first try).
			{ Title: 'Bravo Team', Description: 'TODO', LinkItems: [1, 2] }
		)
		const out = await withGoodreadsSeries(
			{
				title: 'Sons of Valor II: Assault',
				authors: [{ name: 'Brian Andrews' }],
				seriesPrimary: { name: 'Sons of Valor', position: '2' }
			},
			redis
		)
		expect(out.seriesPrimary).toEqual({ name: 'Sons of Valor', position: '2' })
		// The whole point: NOTHING may be cached off the back of a failed /work.
		expect(redis.store.size).toBe(0)
	})

	test('a CLEAN gate-2 rejection still caches the miss', async () => {
		// The fix must stay narrow: with no transport failure anywhere, a gate-2
		// rejection is a real, cacheable "Goodreads has nothing for this row".
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		const redis = fakeRedis()
		respond(
			[],
			[],
			[{ workId: 78 }],
			{
				Title: 'Assault',
				Series: [
					{
						Title: 'Bravo Team',
						ForeignId: 904,
						LinkItems: [{ ForeignWorkId: 78, PositionInSeries: '2' }]
					}
				]
			},
			{ Title: 'Bravo Team', Description: 'TODO', LinkItems: [1, 2] }
		)
		const out = await withGoodreadsSeries(
			{
				title: 'Sons of Valor II: Assault',
				authors: [{ name: 'Brian Andrews' }],
				seriesPrimary: { name: 'Sons of Valor', position: '2' }
			},
			redis
		)
		expect(out.seriesPrimary).toEqual({ name: 'Sons of Valor', position: '2' })
		expect([...redis.store.values()]).toContain('null')
	})
})

/**
 * ORDERING VOCABULARY — measured against the real ledger, 2026-08-01.
 *
 * Spec rule R3 says orderings never shelve, and `SERIES_ORDERING_RE` implements
 * it — but only for the literal phrases "publication order" and "chronological".
 * Enumerating all 402 distinct series names across the 1,607 ledger rows found
 * five ordering listings it misses, together carrying 26 rows:
 *
 *    14  The Horus Heresy - Black Library recommended reading order
 *     3  The MaddAddam Trilogy (Published Order)
 *     3  Shannara - Terry's Suggested Reading Order for Revisiting Readers
 *     3  Malazan Authors' Suggested Reading Order
 *     3  The Chronicles of Narnia (Author's Preferred Order)
 *
 * The rule is right; its vocabulary is too narrow. Widening it is strictly
 * safer than adding a THIRD mechanism alongside isUmbrella and
 * CONTAINER_SHELF_NAMES, which the holistic review already flags as one concept
 * too many.
 *
 * The danger is over-matching on a bare "Order", which is a perfectly ordinary
 * word in a real series name — "Order of the Centurion" is a genuine Galaxy's
 * Edge sub-series sitting in the ledger right now. So "order" only counts when
 * a qualifier precedes it.
 */
describe('isSeriesOrdering', () => {
	const MISSED = [
		'The Horus Heresy - Black Library recommended reading order',
		'The MaddAddam Trilogy (Published Order)',
		"Shannara - Terry's Suggested Reading Order for Revisiting Readers",
		"Malazan Authors' Suggested Reading Order",
		"The Chronicles of Narnia (Author's Preferred Order)"
	]
	const ALREADY_CAUGHT = [
		'A Jack Ryan Novel (publication order)',
		'Redwall (chronological order)',
		'The Witcher (Publication order)',
		'Foundation (Chronological Order)',
		'The Expanse (omnibus)'
	]
	// Every one of these is a REAL shelf in the ledger. A false positive here is
	// worse than the miss: the book keeps the inconsistent provider name and can
	// never converge.
	const REAL_SERIES = [
		'Order of the Centurion',
		"Galaxy's Edge: Order of the Centurion",
		"Ender's Saga",
		"Galaxy's Edge",
		"Hoid's Travails",
		'Riftwar Cycle',
		"Gaunt's Ghosts",
		"King's Dark Tidings",
		'The Remembrance of Earth’s Past'
	]

	test('catches the ordering listings the old vocabulary missed', async () => {
		const { isSeriesOrdering } = await import('#helpers/providers/goodreadsSeries')
		for (const name of MISSED) expect(isSeriesOrdering(name)).toBe(true)
	})

	test('still catches everything it already caught', async () => {
		const { isSeriesOrdering } = await import('#helpers/providers/goodreadsSeries')
		for (const name of ALREADY_CAUGHT) expect(isSeriesOrdering(name)).toBe(true)
	})

	test('never fires on a real series that merely contains "Order"', async () => {
		const { isSeriesOrdering } = await import('#helpers/providers/goodreadsSeries')
		for (const name of REAL_SERIES) expect(isSeriesOrdering(name)).toBe(false)
	})

	test('tolerates a missing name', async () => {
		const { isSeriesOrdering } = await import('#helpers/providers/goodreadsSeries')
		expect(isSeriesOrdering(null)).toBe(false)
		expect(isSeriesOrdering(undefined)).toBe(false)
		expect(isSeriesOrdering('')).toBe(false)
	})
})

describe('a persistently failing leg must not re-run the full lookup per serve', () => {
	/**
	 * Measured live on B017V4IM1G (2026-08-07): the mirror answers /work/4640799
	 * with HTTP 500 on EVERY call (it cannot decode that record), the
	 * author-record recovery is then discarded by the title gate, and the
	 * degraded lookup is -- correctly -- neither applied nor cached. But "not
	 * cached" meant every serve of that book re-paid the whole
	 * search + work + author leg: 1.4-1.6s per request, indefinitely, while
	 * neighbouring books served from cache in 15ms.
	 *
	 * Two escapes, one per flag:
	 *  - `uncacheable` (answer SOUND, alias cosmetics missing): cache it under a
	 *    SHORT TTL instead of never. The TTL bounds how long a shelf can stay
	 *    split across canonical/alias names; per-serve re-asking bounded nothing.
	 *  - `degraded` (answer untrusted): the null still must NEVER be written to
	 *    redis, so bound the repeat with a per-row in-process stand-down instead.
	 */
	afterEach(() => {
		fetchMock.mockReset()
		delete process.env.GOODREADS_DEGRADED_COOLDOWN_MS
	})

	// Shared-profile default (these tests set no GOODREADS_SERIES_URL).
	const UNCACHEABLE_TTL = 21600

	const inkheartWork = (seriesId: number) => ({
		Title: 'Inkheart',
		Series: [
			{
				Title: 'Tintenwelt',
				ForeignId: seriesId,
				LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1', SeriesPosition: 1 }]
			}
		]
	})

	test('an uncacheable answer is cached under the SHORT TTL, not left uncached', async () => {
		const redis = fakeRedis()
		// Single-series path: the alias /series fetch is the one extra call, and
		// it fails on transport -> the answer applies but comes back uncacheable.
		respond([{ workId: 42 }], inkheartWork(96001), null)
		const out = await withGoodreadsSeries(
			{ title: 'Inkheart', authors: [{ name: 'Cornelia Funke' }] },
			redis
		)
		expect(out.seriesPrimary).toEqual({ name: 'Tintenwelt', position: '1' })
		const key = [...redis.store.keys()].find((k) => k.startsWith('grseries:v6:'))
		expect(key).toBeDefined()
		expect(JSON.parse(redis.store.get(key as string) as string)).toEqual({
			primary: { name: 'Tintenwelt', position: '1' }
		})
		// The SHORT ttl, not the 30-day hit TTL: the alias must be re-asked soon.
		expect(redis.expires.get(key as string)).toBe(UNCACHEABLE_TTL)
	})

	test('a degraded lookup arms a per-row stand-down: the next serve makes no calls', async () => {
		const redis = fakeRedis()
		const book = () => ({
			title: 'The Adversary Row',
			authors: [{ name: 'Persist Fail' }],
			seriesPrimary: { name: 'Provider Series', position: '2' }
		})
		// /work fails and the author record fails too -> the lookup is degraded.
		respond([{ workId: 61043, author: { id: 7001 } }], null, null)
		const first = await withGoodreadsSeries(book(), redis)
		expect(first.seriesPrimary).toEqual({ name: 'Provider Series', position: '2' })
		// The degraded null must STAY out of redis -- that guard is not up for
		// renegotiation; the stand-down below is what bounds the repeat instead.
		expect(redis.store.size).toBe(0)

		const debugs: string[] = []
		const logger = {
			debug: (_o: unknown, msg?: string) => debugs.push(String(msg ?? '')),
			warn: () => undefined,
			info: () => undefined,
			error: () => undefined
		} as never
		// A fresh queue that must NOT be consumed: within the stand-down the row
		// serves as-is without touching the mirror at all. respond() also clears
		// the mock's call history, so "no calls" below means none SINCE this line.
		respond(null)
		const second = await withGoodreadsSeries(book(), redis, logger)
		expect(second.seriesPrimary).toEqual({ name: 'Provider Series', position: '2' })
		expect(fetchMock.mock.calls.length).toBe(0)
		// The skip must SAY so: an invisible stand-down is the diagnosis trap the
		// module-wide backoff already learned to log its way out of.
		expect(debugs.some((m) => m.includes('standing down'))).toBe(true)
		expect(redis.store.size).toBe(0)
	})

	test('the stand-down is BOUNDED: once expired, the row is re-asked and can heal', async () => {
		// A zero window expires immediately -- the boundedness is the contract:
		// when the mirror recovers, the row must converge without a restart.
		process.env.GOODREADS_DEGRADED_COOLDOWN_MS = '0'
		const redis = fakeRedis()
		const book = () => ({
			title: 'Inkheart',
			authors: [{ name: 'Bounded Retry' }],
			seriesPrimary: { name: 'Provider Series', position: '1' }
		})
		respond([{ workId: 61044, author: { id: 7002 } }], null, null)
		await withGoodreadsSeries(book(), redis)
		expect(redis.store.size).toBe(0)

		// The mirror heals; the very next serve must reach it, apply the answer,
		// and cache it normally.
		respond([{ workId: 42 }], inkheartWork(96002), {
			Title: 'Tintenwelt',
			Description: 'TODO',
			LinkItems: [1, 2]
		})
		const healed = await withGoodreadsSeries(book(), redis)
		expect(healed.seriesPrimary).toEqual({ name: 'Tintenwelt', position: '1' })
		expect(redis.store.size).toBeGreaterThan(0)
	})

	test('resetGoodreadsThrottle clears the stand-down (one reset restores everything)', async () => {
		const redis = fakeRedis()
		const book = () => ({
			title: 'Inkheart',
			authors: [{ name: 'Reset Clears' }],
			seriesPrimary: { name: 'Provider Series', position: '1' }
		})
		respond([{ workId: 61045, author: { id: 7003 } }], null, null)
		await withGoodreadsSeries(book(), redis)

		resetGoodreadsThrottle()
		respond([{ workId: 42 }], inkheartWork(96003), {
			Title: 'Tintenwelt',
			Description: 'TODO',
			LinkItems: [1, 2]
		})
		const out = await withGoodreadsSeries(book(), redis)
		expect(out.seriesPrimary).toEqual({ name: 'Tintenwelt', position: '1' })
	})
})

/**
 * The SECONDARY shelf is chosen from the librarians' own declarations.
 *
 * Measured live on 2026-08-11: 47 albums carried a translated shelf as their
 * secondary -- 24 on "Kolekcja Swiat Dysku", 7 on "Les Annales de la Compagnie
 * Noire", 6 on "Der grosse Bruderkrieg" -- because the ranking sorts on
 * position and member count and nothing else, and `ranked[1]` was taken by
 * index. Plex writes the secondary as a mood, and moods never clear, so a wrong
 * one is permanent.
 *
 * Three earlier candidates were measured and rejected before this one: ordering
 * getSeriesSecondary (fixed nothing, worsened 3 of the 4 books it touched), a
 * name-based language heuristic (fired on "Tales from Alagaesia", Bronte, Anais
 * Nin), and a description-TEXT rule (fired on the CORRECT primary, whose alias
 * list mentions "French numbering"). The link direction is what none of them had.
 */
describe('secondary shelf: librarian declarations decide', () => {
	const members = (n: number) => ({ LinkItems: Array.from({ length: n }, (_, i) => i) })
	const workWith = (series: unknown[]) => ({ Title: 'Declared Book', Series: series })

	test('a shelf the primary lists under "Also known as" is never the secondary', async () => {
		// The re-listing is LINKED from the canonical shelf, so its id is known
		// exactly -- no name matching, no language guess.
		respond(
			[{ workId: 42 }],
			workWith([
				{
					Title: 'The Canonical Shelf',
					ForeignId: 8100,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				},
				{
					Title: 'Les Annales de la Version Traduite',
					ForeignId: 8101,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				},
				{
					Title: 'The Real Sub-Arc',
					ForeignId: 8102,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				}
			]),
			{
				...members(400),
				Description:
					'Also known as:\n    * <a href="/series/8101-les-annales">Les Annales de la Version Traduite</a> (see for French numbering)\n\nA blurb.'
			},
			// The re-listing must OUTRANK the real arc (30 > 12), or member count
			// alone would keep it out of the slot and this test would pass without
			// the denylist doing anything -- it did exactly that until a mutation
			// run caught it.
			members(30),
			members(12)
		)
		const out = await fetchGoodreadsSeries('Declared Book', null)
		expect(out?.primary).toEqual({ name: 'The Canonical Shelf', position: '1' })
		expect(out?.secondary).toEqual({ name: 'The Real Sub-Arc', position: '1' })
	})

	test('when the primary declares "Sub-series", an undeclared candidate cannot be the secondary', async () => {
		// Discworld publishes seven arcs; the Polish custom-order listing is not
		// one of them, so it is not a sub-arc of this shelf however it ranks.
		respond(
			[{ workId: 42 }],
			workWith([
				{
					Title: 'Discworld-ish',
					ForeignId: 8200,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '8' }]
				},
				{
					Title: 'Kolekcja Undeclared',
					ForeignId: 8201,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				},
				{
					Title: 'Declared Arc',
					ForeignId: 8202,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				}
			]),
			{
				...members(400),
				Description:
					'See also: stuff\n\nSub-series:\n    <li><a href="/series/8202-declared-arc">Declared Arc</a>\n\nEnd.'
			},
			members(40),
			members(9)
		)
		const out = await fetchGoodreadsSeries('Declared Book', null)
		// Kolekcja outranks Declared Arc on member count (40 > 9) and would have
		// won by index; the declaration is what keeps it out.
		expect(out?.secondary).toEqual({ name: 'Declared Arc', position: '1' })
	})

	test('with NO declarations the filter is inert -- the old ranking still decides', async () => {
		// Absence of a librarian list is not evidence against a candidate. Most
		// works have neither section and must be completely unaffected.
		respond(
			[{ workId: 42 }],
			workWith([
				{
					Title: 'Plain Parent',
					ForeignId: 8300,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '3' }]
				},
				{
					Title: 'Plain Sub',
					ForeignId: 8301,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				}
			]),
			{ ...members(400), Description: 'Just prose, no lists.' },
			{ ...members(20), Description: 'Also prose.' }
		)
		const out = await fetchGoodreadsSeries('Declared Book', null)
		expect(out?.secondary).toEqual({ name: 'Plain Sub', position: '1' })
	})

	test('a non-Latin-SCRIPT shelf is never promoted into the slot', async () => {
		// The backstop, and deliberately script-only: an English-language series
		// is never written in Hebrew or CJK, while DIACRITICS are common in one
		// ("Tales from Alagaesia" with a diaeresis is English). Without this, an
		// exclusion that empties the slot lets the translation move up into it --
		// measured on A Song of Ice and Fire, which landed on its Hebrew shelf.
		respond(
			[{ workId: 42 }],
			workWith([
				{
					Title: 'A Song of Something',
					ForeignId: 8400,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				},
				{
					Title: 'שיר של אש ושל קרח',
					ForeignId: 8401,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				}
			]),
			{ ...members(400), Description: 'No lists here.' },
			members(30)
		)
		const out = await fetchGoodreadsSeries('Declared Book', null)
		expect(out?.primary).toEqual({ name: 'A Song of Something', position: '1' })
		expect(out?.secondary).toBeUndefined()
	})

	test('a Latin shelf with DIACRITICS is still allowed -- it is not a language test', async () => {
		// The guard the false-positive review demanded: Alagaesia/Bronte/Anais are
		// English shelves and must survive.
		respond(
			[{ workId: 42 }],
			workWith([
				{
					Title: 'Inheritance Cycle',
					ForeignId: 8500,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				},
				{
					Title: 'Tales from Alagaësia',
					ForeignId: 8501,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }]
				}
			]),
			{ ...members(400), Description: 'No lists here.' },
			members(30)
		)
		const out = await fetchGoodreadsSeries('Declared Book', null)
		expect(out?.secondary).toEqual({ name: 'Tales from Alagaësia', position: '1' })
	})
})

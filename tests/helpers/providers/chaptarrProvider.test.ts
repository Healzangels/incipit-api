import { describe, expect, test } from 'bun:test'

import ChaptarrProvider, {
	type ChaptarrWorkResponse,
	editionForAsin,
	editionStoreIds,
	workRouteFor
} from '#helpers/providers/ChaptarrProvider'
import type { FetchBookOptions } from '#helpers/providers/types'
import fixture from '#tests/fixtures/chaptarr-work-annihilation.json'
import liveFixture from '#tests/fixtures/chaptarr-work-ninth-house-live.json'

/**
 * Chaptarr metadata service provider (api2.chaptarr.com, opened 2026-08-08).
 *
 * The fixture is a TRIMMED LIVE CAPTURE of /api/v5/book/az:B00HYGYN5Q from
 * 2026-08-08 — Annihilation, the book chosen because it is one of the two the
 * whole genre-backfill effort started from. It carries the shapes that matter:
 * an eng audiobook edition with narrator + durationSeconds + chapters, a
 * Dutch physical edition with NO asin, and a German ebook WITH an asin — so
 * the audiobook/asin/language filters all have something to discriminate.
 */

const work = fixture as unknown as ChaptarrWorkResponse
const OPTS: FetchBookOptions = { region: 'us' }

function provider(over: {
	matches?: { work_id?: string; author?: string }[]
	works?: Record<string, ChaptarrWorkResponse | null>
	matchCalls?: string[]
	matchTags?: { artist?: string; album?: string }[]
	workCalls?: string[]
}) {
	return new ChaptarrProvider({
		matchFetch: async (q, tags) => {
			over.matchCalls?.push(q)
			over.matchTags?.push(tags)
			return over.matches ?? []
		},
		workFetch: async (id) => {
			over.workCalls?.push(id)
			return over.works?.[id] ?? null
		}
	})
}

describe('search', () => {
	test('match -> work -> asin-bearing AUDIOBOOK editions only', async () => {
		const p = provider({
			matches: [{ work_id: 'hc:192491' }],
			works: { 'hc:192491': work }
		})
		const out = await p.search({ title: 'Annihilation', author: 'Jeff VanderMeer', region: 'us' })
		// The Dutch physical edition has no asin; the German EBOOK has one but is
		// not an audiobook. Exactly one candidate survives.
		expect(out.length).toBe(1)
		const c = out[0]
		expect(c.provider).toBe('chaptarr')
		expect(c.asin).toBe('B00HYGYN5Q')
		expect(c.id).toBe('B00HYGYN5Q')
		expect(c.title).toBe('Annihilation')
		expect(c.authors).toEqual(['Jeff VanderMeer'])
		expect(c.narrators).toEqual(['Carolyn McCormick'])
		expect(c.audioSeconds).toBe(22260)
		expect(c.language).toBe('en')
		expect(c.cover).toContain('media-amazon')
	})

	test('consults at most two works and dedupes work ids', async () => {
		const workCalls: string[] = []
		const p = provider({
			matches: [{ work_id: 'hc:1' }, { work_id: 'hc:1' }, { work_id: 'hc:2' }, { work_id: 'hc:3' }],
			works: { 'hc:1': work, 'hc:2': work, 'hc:3': work },
			workCalls
		})
		await p.search({ title: 'Annihilation', region: 'us' })
		expect(workCalls).toEqual(['hc:1', 'hc:2'])
	})

	test('the match call carries the TAGS the server requires', async () => {
		// A bare {q, media_type} body gets {} back — no error, no matches
		// (measured live 2026-08-08; it cost the first deploy its candidates).
		const matchTags: { artist?: string; album?: string }[] = []
		const p = provider({ matches: [], matchTags })
		await p.search({ title: 'Annihilation', author: 'Jeff VanderMeer', region: 'us' })
		expect(matchTags).toEqual([{ artist: 'Jeff VanderMeer', album: 'Annihilation' }])
	})

	test('an empty query asks nothing', async () => {
		const matchCalls: string[] = []
		const p = provider({ matchCalls })
		const out = await p.search({ title: '', region: 'us' })
		expect(out).toEqual([])
		expect(matchCalls).toEqual([])
	})

	test('a work fetch returning null is skipped, not fatal', async () => {
		const p = provider({
			matches: [{ work_id: 'hc:dead' }, { work_id: 'hc:192491' }],
			works: { 'hc:dead': null, 'hc:192491': work }
		})
		const out = await p.search({ title: 'Annihilation', region: 'us' })
		expect(out.length).toBe(1)
	})
})

describe('fetchBookByAsin (the rescue path)', () => {
	test('maps the exact-asin edition to a full ProviderBook', async () => {
		const p = provider({ works: { 'az:B00HYGYN5Q': work } })
		const book = await p.fetchBookByAsin('B00HYGYN5Q', OPTS)
		expect(book).not.toBeNull()
		expect(book?.asin).toBe('B00HYGYN5Q')
		expect(book?.title).toBe('Annihilation')
		expect(book?.authors).toEqual([{ name: 'Jeff VanderMeer' }])
		expect(book?.narrators).toEqual([{ name: 'Carolyn McCormick' }])
		expect(book?.publisherName).toBe('Blackstone Audio, Inc.')
		expect(book?.language).toBe('en')
		// The canonical ENGLISH series field, not the translated series[] array.
		expect(book?.seriesPrimary).toEqual({ name: 'Southern Reach', position: '1' })
	})

	test('an asin the work does not carry returns null', async () => {
		const p = provider({ works: { 'az:B0NOSUCH00': work } })
		expect(await p.fetchBookByAsin('B0NOSUCH00', OPTS)).toBeNull()
	})

	test('a regional az VARIANT still finds its edition', () => {
		const editions = [
			{
				asin: 'B00HYGYN5Q',
				formatType: 'audiobook',
				providerIdsAll: { az: ['az:B00HYG9KMC', 'az:B00HYGYN5Q'] }
			}
		]
		expect(editionForAsin(editions, 'b00hyg9kmc')?.asin).toBe('B00HYGYN5Q')
		expect(editionForAsin(editions, 'B0ABSENT99')).toBeNull()
	})

	test('an EXACT asin beats a variant listing regardless of list order', () => {
		// A parent edition that merely LISTS the child's asin in providerIdsAll.az
		// sat earlier in the array and shadowed the child's own edition. The
		// duration oracle then measured the child's file against the PARENT's
		// length, saw a variant match, and capped a real truncation to "report".
		const editions = [
			{
				asin: 'B00PARENT1',
				formatType: 'audiobook',
				durationSeconds: 70000,
				providerIdsAll: { az: ['az:B00PARENT1', 'az:B00CHILD01'] }
			},
			{ asin: 'B00CHILD01', formatType: 'audiobook', durationSeconds: 35000 }
		]
		expect(editionForAsin(editions, 'B00CHILD01')?.asin).toBe('B00CHILD01')
		// The variant path still works when there is no exact edition at all.
		expect(editionForAsin(editions.slice(0, 1), 'B00CHILD01')?.asin).toBe('B00PARENT1')
	})
})

/**
 * THE RESCUE PATHS MUST NOT HAND BACK A PRINT EDITION.
 *
 * Both are reached through withPinnedEdition, whose comment rested on "only
 * Audible implements fetchCandidateByAsin, and Audible's catalog holds no print
 * editions". Chaptarr implements it too, is registered AFTER Audible (so it is
 * exactly the fallthrough for an ASIN Audible declines), and its work carries
 * every edition of the book. Whatever it returns is stamped `provider: 'pinned'`
 * and then held at the confidence floor — i.e. GUARANTEED to be offered as the
 * audiobook match.
 */
describe('the audiobook filter on the rescue paths', () => {
	// The fixture's German KINDLE EBOOK: a real asin, formatType 'ebook',
	// readingFormatId 3, durationSeconds null. Before the filter it came back
	// as a candidate and as a served ProviderBook.
	const EBOOK_ASIN = 'B09LVB8T3V'

	test('fetchCandidateByAsin refuses an EBOOK edition', async () => {
		const p = provider({ works: { [`az:${EBOOK_ASIN}`]: work } })
		expect(await p.fetchCandidateByAsin(EBOOK_ASIN, OPTS)).toBeNull()
	})

	test('fetchBookByAsin refuses an EBOOK edition', async () => {
		const p = provider({ works: { [`az:${EBOOK_ASIN}`]: work } })
		expect(await p.fetchBookByAsin(EBOOK_ASIN, OPTS)).toBeNull()
	})

	test('editionForAsin refuses a PRINT edition and still finds the audio one', () => {
		const editions = [
			{ asin: 'B0PRINT001', formatType: 'physical', readingFormatId: 1 },
			{ asin: 'B0AUDIO001', formatType: 'audiobook', readingFormatId: 2 }
		]
		expect(editionForAsin(editions, 'B0PRINT001')).toBeNull()
		expect(editionForAsin(editions, 'B0AUDIO001')?.asin).toBe('B0AUDIO001')
	})
})

/**
 * THE EMITTED ASIN IS THE ONE THAT WAS ASKED FOR.
 *
 * editionForAsin matches through `providerIdsAll.az`, so a regional variant
 * resolves an edition whose OWN asin is the parent. Emitting the parent means
 * withPinnedEdition appends a row carrying an asin the operator never named:
 * `isPinned` is false for every row, `promoteDeadPinToIsbn` reads the live pin
 * as DEAD, and the named edition gets a floor-held row with zero pin protection.
 */
describe('the rescue paths stamp the REQUESTED asin', () => {
	const VARIANT = 'B00HYG9KMC' // resolves the edition whose own asin is B00HYGYN5Q

	test('fetchCandidateByAsin does NOT inject a regional variant (spec-chaptarr-wire-drift)', async () => {
		// SUPERSEDED CONTRACT (2026-09-25): this used to assert the variant was
		// injected under the asked-for id. The injection path is only reached when
		// Audible declined the id, so a rescued variant is an id no store sells;
		// injected, it out-ranked the recording's own store listing (the 45
		// variant-class albums; The Bone Season in the same-data A/B). Serving the
		// variant is still fetchBookByAsin's job, below.
		const p = provider({ works: { [`az:${VARIANT}`]: work } })
		expect(await p.fetchCandidateByAsin(VARIANT, OPTS)).toBeNull()
		// ...while the edition's OWN asin is still injectable, runtime included.
		const own = provider({ works: { 'az:B00HYGYN5Q': work } })
		const c = await own.fetchCandidateByAsin('B00HYGYN5Q', OPTS)
		expect(c?.asin).toBe('B00HYGYN5Q')
		expect(c?.audioSeconds).toBe(22260)
	})

	test('fetchBookByAsin identifies the record by the asin asked for', async () => {
		const p = provider({ works: { [`az:${VARIANT}`]: work } })
		expect((await p.fetchBookByAsin(VARIANT, OPTS))?.asin).toBe(VARIANT)
	})

	test('search still identifies each row by the EDITION it emitted', async () => {
		// No asin was "requested" on the search path, so the edition's own asin
		// is the identity — the stamp must not leak a caller id in here.
		const p = provider({ matches: [{ work_id: 'hc:192491' }], works: { 'hc:192491': work } })
		const out = await p.search({ title: 'Annihilation', region: 'us' })
		expect(out[0].asin).toBe('B00HYGYN5Q')
	})

	test('an asin-less edition never becomes an identity-less ProviderBook', async () => {
		// `GET /books/:asin` has no response schema, so a record with
		// `asin: null` would be served 200 and nothing downstream could key it.
		const asinless: ChaptarrWorkResponse = {
			work: { title: 'X' },
			authors: [],
			editions: [{ asin: null, title: 'X', formatType: 'audiobook' }]
		}
		const p = provider({ works: { 'az:': asinless } })
		expect(await p.fetchBookByAsin('', OPTS)).toBeNull()
		expect(await p.fetchCandidateByAsin('', OPTS)).toBeNull()
	})
})

/**
 * NO WORK-COVER FALLBACK. The work cover is the PRINT jacket. A chaptarr
 * candidate carries audioSeconds, which is exactly what dedupe's `isAudioArt`
 * accepts as proof of audiobook art — so the jacket would be admitted into
 * coverAlternates and become the record's own cover when the row wins its
 * group. An audiobook edition with no edition cover has no audiobook art.
 */
describe('cover provenance', () => {
	const NO_EDITION_COVER: ChaptarrWorkResponse = {
		work: { title: 'X', coverUrl: 'https://example.test/print-jacket.jpg' },
		authors: [],
		editions: [
			{
				asin: 'B0NOCOVER1',
				title: 'X',
				formatType: 'audiobook',
				durationSeconds: 3600,
				coverUrl: null
			}
		]
	}

	test('a candidate with no EDITION cover has no cover, not the print jacket', async () => {
		const p = provider({ works: { 'az:B0NOCOVER1': NO_EDITION_COVER } })
		expect((await p.fetchCandidateByAsin('B0NOCOVER1', OPTS))?.cover).toBeNull()
	})

	test('a served book with no EDITION cover has no image, not the print jacket', async () => {
		const p = provider({ works: { 'az:B0NOCOVER1': NO_EDITION_COVER } })
		expect((await p.fetchBookByAsin('B0NOCOVER1', OPTS))?.image).toBeNull()
	})

	test('search emits no cover for an edition that has none', async () => {
		const p = provider({
			matches: [{ work_id: 'hc:1' }],
			works: { 'hc:1': NO_EDITION_COVER }
		})
		expect((await p.search({ title: 'X', region: 'us' }))[0].cover).toBeNull()
	})
})

describe('workRouteFor', () => {
	test('edition-level az ids take /book/, work ids take /work/', () => {
		// /book/hc:192491 404s live while /work/hc:192491 answers — and the
		// match endpoint hands back hc: WORK ids, so getting this wrong turns
		// every search into zero candidates with zero errors.
		expect(workRouteFor('az:B00HYGYN5Q')).toBe('book')
		expect(workRouteFor('AZ:B00HYGYN5Q')).toBe('book')
		expect(workRouteFor('hc:192491')).toBe('work')
		expect(workRouteFor('gr:241505514')).toBe('work')
	})
})

describe('fetchCandidateByAsin (pinned-edition injection)', () => {
	test('returns the candidate shape WITH audioSeconds intact', async () => {
		const p = provider({ works: { 'az:B00HYGYN5Q': work } })
		const c = await p.fetchCandidateByAsin('B00HYGYN5Q', OPTS)
		expect(c?.audioSeconds).toBe(22260)
		expect(c?.narrators).toEqual(['Carolyn McCormick'])
	})
})

describe('regional store ids (spec-regional-pin-sibling)', () => {
	/**
	 * A TRIMMED LIVE CAPTURE of /api/v5/work/hc:427736, 2026-09-25: the wire now
	 * spells the store ids `provider_ids_all` (snake_case) and adds a flat
	 * `asins`, where the 2026-08-08 fixture above says `providerIdsAll`. The
	 * edition's own asin, B07LH8GF23, is sold by no Audible region; B07LHB5ZJ6 in
	 * the same list is what audible.com sells.
	 */
	const ninthHouse: ChaptarrWorkResponse = {
		work: { id: 'hc:427736', title: 'Ninth House' },
		authors: [{ name: 'Leigh Bardugo' }],
		editions: [
			{
				asin: 'B07LH8GF23',
				title: 'Ninth House',
				readingFormatId: 2,
				durationSeconds: 58920,
				narratorNames: ['Lauren Fortgang', 'Michael David Axtell'],
				asins: ['1250230918', 'B07LH8GF23', 'B07LHB5ZJ6'],
				provider_ids_all: { az: ['az:1250230918', 'az:B07LH8GF23', 'az:B07LHB5ZJ6'] }
			}
		]
	}

	test('editionStoreIds reads the live snake_case ids and the flat list', () => {
		expect(editionStoreIds(ninthHouse.editions![0])).toEqual([
			'B07LH8GF23',
			'1250230918',
			'B07LHB5ZJ6'
		])
	})

	test('editionStoreIds still reads the 2026-08-08 camelCase spelling', () => {
		const audio = work.editions!.find((e) => e.asin === 'B00HYGYN5Q')!
		expect(editionStoreIds(audio)).toEqual(['B00HYGYN5Q', 'B00HYG9KMC'])
	})

	test('editionStoreIds uppercases, strips the namespace and dedupes', () => {
		expect(
			editionStoreIds({
				asin: 'b0aaaaaaaa',
				asins: ['B0AAAAAAAA', ' b0bbbbbbbb ', 'b0eeeeeeee'],
				provider_ids_all: { az: ['AZ:B0CCCCCCCC', 'az:b0bbbbbbbb', ''] },
				providerIdsAll: { az: ['az:B0DDDDDDDD'] }
			})
		).toEqual(['B0AAAAAAAA', 'B0CCCCCCCC', 'B0BBBBBBBB', 'B0DDDDDDDD', 'B0EEEEEEEE'])
	})

	test("a search row carries its edition's OTHER store ids as asinAliases", async () => {
		const p = provider({ matches: [{ work_id: 'hc:427736' }], works: { 'hc:427736': ninthHouse } })
		const [c] = await p.search({ title: 'Ninth House', author: 'Leigh Bardugo', region: 'us' })
		expect(c.asin).toBe('B07LH8GF23')
		expect(c.asinAliases).toEqual(['1250230918', 'B07LHB5ZJ6'])
	})

	test("an injected own-asin row lists its edition's other ids, never itself", async () => {
		const p = provider({ works: { 'az:B00HYGYN5Q': work } })
		const c = await p.fetchCandidateByAsin('B00HYGYN5Q', OPTS)
		expect(c?.asin).toBe('B00HYGYN5Q')
		expect(c?.asinAliases).toEqual(['B00HYG9KMC'])
	})

	test('an edition with no other ids carries no alias list at all', async () => {
		const lone: ChaptarrWorkResponse = {
			...ninthHouse,
			editions: [{ ...ninthHouse.editions![0], asins: ['B07LH8GF23'], provider_ids_all: undefined }]
		}
		const p = provider({ matches: [{ work_id: 'hc:427736' }], works: { 'hc:427736': lone } })
		const [c] = await p.search({ title: 'Ninth House', author: 'Leigh Bardugo', region: 'us' })
		expect(c.asinAliases).toBeUndefined()
	})

	test('the search cache is versioned: v1 rows carry no aliases', () => {
		expect(new ChaptarrProvider().cacheVersion).toBe(2)
	})
})

describe('the snake_case wire (spec-chaptarr-wire-drift)', () => {
	/**
	 * The 2026-08-08 fixture above is camelCase (providerIdsAll, formatType,
	 * language); the service has since renamed them (provider_ids_all + asins,
	 * format, languageCode) and dropped description. This is a TRIMMED LIVE
	 * CAPTURE of /api/v5/work/hc:427736 from 2026-09-25: Ninth House's English
	 * audiobook (own asin B07LH8GF23, twelve store ids incl. audible.com's
	 * B07LHB5ZJ6), its German audiobook (deu), and an ebook.
	 */
	const live = liveFixture as unknown as ChaptarrWorkResponse
	const english = live.editions!.find((e) => e.asin === 'B07LH8GF23')!

	test('a variant id resolves through provider_ids_all', () => {
		expect(editionForAsin(live.editions, 'B07LHB5ZJ6')?.asin).toBe('B07LH8GF23')
	})

	test('...and through the flat asins list alone', () => {
		const flatOnly = [{ ...english, provider_ids_all: undefined }]
		expect(editionForAsin(flatOnly, 'B07LHB5ZJ6')?.asin).toBe('B07LH8GF23')
	})

	test('`format` alone marks an audiobook (no formatType, no readingFormatId)', () => {
		const bare = [{ ...english, readingFormatId: undefined, format: 'audiobook' }]
		expect(editionForAsin(bare, 'B07LH8GF23')?.asin).toBe('B07LH8GF23')
		const ebook = [{ ...english, readingFormatId: undefined, format: 'ebook' }]
		expect(editionForAsin(ebook, 'B07LH8GF23')).toBeNull()
	})

	test('SERVING a variant id works again (it answered 404); injecting one does not', async () => {
		const p = provider({ works: { 'az:B07LHB5ZJ6': live, 'az:B07LH8GF23': live } })
		const book = await p.fetchBookByAsin('B07LHB5ZJ6', OPTS)
		expect(book?.asin).toBe('B07LHB5ZJ6')
		expect(book?.title).toBe('Ninth House')
		expect(await p.fetchCandidateByAsin('B07LHB5ZJ6', OPTS)).toBeNull()
		const own = await p.fetchCandidateByAsin('B07LH8GF23', OPTS)
		expect(own?.audioSeconds).toBe(58_920)
		expect(own?.asinAliases).toContain('B07LHB5ZJ6')
		expect(own?.asinAliases).not.toContain('B07LH8GF23')
	})

	test('languageCode is read: eng -> en, deu -> de, on rows and served records', async () => {
		const p = provider({
			matches: [{ work_id: 'hc:427736' }],
			works: { 'hc:427736': live, 'az:B07LH8GF23': live }
		})
		const rows = await p.search({ title: 'Ninth House', author: 'Leigh Bardugo', region: 'us' })
		expect(Object.fromEntries(rows.map((r) => [r.asin, r.language]))).toEqual({
			B07LH8GF23: 'en',
			B084NW2C1F: 'de'
		})
		expect((await p.fetchBookByAsin('B07LH8GF23', OPTS))?.language).toBe('en')
	})
})

import { describe, expect, test } from 'bun:test'

import ChaptarrProvider, {
	type ChaptarrWorkResponse,
	editionForAsin,
	workRouteFor
} from '#helpers/providers/ChaptarrProvider'
import type { FetchBookOptions } from '#helpers/providers/types'
import fixture from '#tests/fixtures/chaptarr-work-annihilation.json'

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

	test('fetchCandidateByAsin identifies the row by the asin asked for', async () => {
		const p = provider({ works: { [`az:${VARIANT}`]: work } })
		const c = await p.fetchCandidateByAsin(VARIANT, OPTS)
		expect(c?.asin).toBe(VARIANT)
		expect(c?.id).toBe(VARIANT)
		// Still the resolved edition's data, runtime included.
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

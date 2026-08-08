import { beforeEach, describe, expect, mock, test } from 'bun:test'
import Fastify from 'fastify'

/**
 * WIRING for the main serving path.
 *
 * `books/show.ts` is what Plex actually reads on every refresh, and until this
 * file it had no route test — only its constituent predicates were covered.
 * That is the same shape as the DELETE-auth hole: a mutation sweep on
 * 2026-07-31 removed `applyShelfPolicy`, passed `null` instead of the asin to
 * `applyPins`, removed `withSquareCover`, and removed `flagLanguageMismatch`,
 * and ALL FOUR survived a fully green 1744-test gate. Every shelf decision the
 * operator made on 2026-07-30 — the Jack Ryan publication shelf, the family
 * calls, all 88 pins — could stop reaching Plex without a single red test.
 *
 * So these assertions are deliberately made through the REGISTERED ROUTE via
 * `app.inject`, never by calling the helpers directly: the point is that the
 * stages are wired, not that they work in isolation.
 *
 * The heavy collaborators (Mongo-backed helper, the live Goodreads chain, the
 * iTunes lookup) are stubbed so the pipeline runs hermetically. `applyPins` and
 * `applyShelfPolicy` are deliberately NOT stubbed — they are the subject.
 */

const SQUARE_URL = 'https://example.invalid/square-1400.jpg'

/** Whatever the "database" hands the route for this request. */
let served: Record<string, unknown> = {}

/** What `handler()` does: return a record, or throw the given error. */
let handlerThrows: Error | null = null
/** What the STORED record lookup returns when the fallback reaches for it. */
let storedRecord: Record<string, unknown> | null = null

mock.module('#helpers/routes/BookShowHelper', () => ({
	default: class {
		async handler() {
			if (handlerThrows) throw handlerThrows
			return served
		}
		async getDataWithProjection() {
			if (!storedRecord) throw new Error('no stored record')
			return storedRecord
		}
	}
}))

// Identity: the Goodreads chain has its own suites; here it must simply not
// reach the network, and must not be the thing that supplies the series.
// Spread the real module — shelfPolicy and shelfPins import `foldSeriesName`
// from it, so replacing the whole namespace breaks the very stages under test.
// Instrumentation seam for the concurrency pin at the bottom of this file.
// Default is a no-op so every other test is unaffected; the concurrency test
// swaps it to record start/end events per enrichment leg.
let enrichTrace: (leg: string) => Promise<void> = async () => {}

const realGoodreads = await import('#helpers/providers/goodreadsSeries')
mock.module('#helpers/providers/goodreadsSeries', () => ({
	...realGoodreads,
	withGoodreadsSeries: async (book: unknown) => {
		await enrichTrace('goodreads')
		return book
	}
}))

mock.module('#helpers/providers/squareCover', () => ({
	bestSquareCover: async () => {
		await enrichTrace('square')
		return SQUARE_URL
	}
}))

/** What the Hardcover genre backfill "finds". Its own suite covers the cache
 * and query mechanics; here the subject is the WIRING — that a genre-less
 * record gets the backfill, a genre-carrying record does not, and the answer
 * reaches the response. Key-sensitivity is asserted via backfilledIds, the
 * same lesson as recalledKeys below. */
let backfillGenres: { asin: string; name: string; type: string }[] = []
let backfilledIds: string[] = []
mock.module('#helpers/providers/hardcoverGenres', () => ({
	backfillHardcoverGenres: async ({ id }: { id: string }) => {
		await enrichTrace('genres')
		backfilledIds.push(id)
		return backfillGenres
	}
}))

// The provider-id branch (hardcover-*, openlibrary-*, apple-audiobook-*) is a
// SECOND, earlier return inside the same handler — ~90 albums in the library
// reach Plex through it — so it needs its own coverage or half the route is
// still unwired. `isProviderId` keeps the real decoder so id routing is honest.
const { decodeProviderId } = await import('#helpers/providers/providerId')
let servedByProvider: Record<string, unknown> | null = null
mock.module('#helpers/routes/BookDataHelper', () => ({
	default: class {
		constructor(
			private readonly registry: unknown,
			private readonly id: string
		) {}
		get isProviderId() {
			return decodeProviderId(this.id) !== null
		}
		async fetch() {
			return servedByProvider
		}
	}
}))

/** What a prior SEARCH recorded for this id. NULL = nobody has ever looked. */
let cachedAlternates: string[] | null = []
/** Every (id, urls) pair the route wrote back, so the warm can be asserted. */
let remembered: [string, string[] | undefined][] = []
mock.module('#helpers/providers/alternateCoverCache', () => ({
	alternateCoverKey: (id: string) => `incipit:altcover:${(id ?? '').split('_')[0].toUpperCase()}`,
	rememberAlternates: async (_r: unknown, id: string, urls: string[] | undefined) => {
		remembered.push([id, urls])
	},
	// KEY-SENSITIVE on purpose. A mock that ignores the id cannot tell which key
	// the route asked for, so a test asserting "recall uses the requested id"
	// passes no matter what -- proven: reverting the fix failed nothing until
	// this recorded the key.
	recallAlternates: async (_r: unknown, id: string) => {
		await enrichTrace('alternates')
		recalledKeys.push(id)
		return cachedAlternates
	}
}))

/** Every id the route handed to recallAlternates, in order. */
let recalledKeys: string[] = []

/** Candidates the on-miss compute "finds". Empty = the search returned nothing. */
let searchResults: Record<string, unknown>[] = []
/** How many times the route ran a search — the cost this design must bound. */
let searchCalls = 0
mock.module('#helpers/routes/BookSearchHelper', () => ({
	default: class {
		async search() {
			searchCalls += 1
			if (searchThrows) throw searchThrows
			return searchResults
		}
	}
}))
/** Set to make the on-miss compute blow up, as a dead upstream would. */
let searchThrows: Error | null = null

const { default: booksShow } = await import('#config/routes/books/show')
const { getMatchMetrics, resetMatchMetrics } = await import('#helpers/utils/matchTelemetry')
const { NotFoundError } = await import('#helpers/errors/ApiErrors')

/** Whether the instance has redis. The compute path requires it -- see below. */
let hasRedis = true

async function get(asin: string, query = '') {
	const app = Fastify()
	try {
		if (hasRedis) app.decorate('redis', { async get() {}, async set() {} } as never)
		await app.register(booksShow as never)
		const res = await app.inject({ method: 'GET', url: `/books/${asin}${query}` })
		return { status: res.statusCode, body: res.json() as Record<string, unknown> }
	} finally {
		await app.close()
	}
}

/** A minimal ApiBook-ish record. `image` matters: the route only runs the
 * enrichment pipeline for objects carrying it. */
const bookRecord = (over: Record<string, unknown> = {}) => ({
	asin: 'B0TESTASIN',
	title: 'A Test Book',
	authors: [{ name: 'A Test Author' }],
	narrators: [],
	image: 'https://example.invalid/cover.jpg',
	...over
})

describe('GET /books/:asin runs the whole serve pipeline', () => {
	beforeEach(() => {
		resetMatchMetrics()
		served = bookRecord()
		handlerThrows = null
		storedRecord = null
	})

	test('an operator PIN reaches the response (applyPins gets the real asin)', async () => {
		// 1797104802 is a shipped pin: Holly Gibney #2 (If It Bleeds), from the
		// 2026-07-31 Gibney/Hodges family decision. Passing null instead of the
		// asin — a mutation that survived before this test — silently drops all
		// 88 pins.
		served = bookRecord({ asin: '1797104802', title: 'If It Bleeds' })
		const { status, body } = await get('1797104802')
		expect(status).toBe(200)
		expect(body.seriesPrimary).toEqual({ name: 'Holly Gibney', position: '2' })
	})

	test('SHELF POLICY runs: a positionless primary never ships as the shelf', async () => {
		// Q2, decided 2026-07-30: a positionless primary with a positioned
		// secondary promotes the secondary. Removing applyShelfPolicy leaves
		// "Warhammer 40,000" (no position) sitting on the shelf.
		served = bookRecord({
			asin: 'B0NOPIN123',
			title: 'Baneblade',
			seriesPrimary: { name: 'Warhammer 40,000' },
			seriesSecondary: { name: 'Warhammer 40,000: Imperial Guard', position: '1' }
		})
		const { status, body } = await get('B0NOPIN123')
		expect(status).toBe(200)
		expect(body.seriesPrimary).toEqual({
			name: 'Warhammer 40,000: Imperial Guard',
			position: '1'
		})
	})

	test('the SQUARE COVER lookup is wired into the response', async () => {
		const { status, body } = await get('B0TESTASIN')
		expect(status).toBe(200)
		expect(body.imageSquare).toBe(SQUARE_URL)
	})

	test('a language-conflicting record is FLAGGED, not silently served', async () => {
		// The early warning for a stale/wrong pinned ASIN — a listing that changed
		// hands. Removing the call loses the only signal that this happened.
		served = bookRecord({ language: 'spanish' })
		const before = getMatchMetrics().languageMismatchedLookups
		const { status } = await get('B0TESTASIN', '?region=us')
		expect(status).toBe(200)
		expect(getMatchMetrics().languageMismatchedLookups).toBe(before + 1)
	})

	test('the PROVIDER-ID branch runs the same pipeline', async () => {
		// A Hardcover/OpenLibrary record returns from an earlier branch in the
		// same handler. Before this, that whole path was untested: policy, pins,
		// square cover and the language flag could each be missing there while
		// the ASIN branch stayed green.
		servedByProvider = bookRecord({
			asin: null,
			title: 'Baneblade',
			language: 'spanish',
			seriesPrimary: { name: 'Warhammer 40,000' },
			seriesSecondary: { name: 'Warhammer 40,000: Imperial Guard', position: '1' }
		})
		const before = getMatchMetrics().languageMismatchedLookups
		const { status, body } = await get('hardcover-book-376172', '?region=us')
		servedByProvider = null
		expect(status).toBe(200)
		expect(body.seriesPrimary).toEqual({
			name: 'Warhammer 40,000: Imperial Guard',
			position: '1'
		})
		expect(body.imageSquare).toBe(SQUARE_URL)
		expect(getMatchMetrics().languageMismatchedLookups).toBe(before + 1)
	})

	test('a record whose language matches the region is NOT flagged', async () => {
		// Guards the assertion above from passing on a counter that only ever
		// increments.
		served = bookRecord({ language: 'english' })
		const before = getMatchMetrics().languageMismatchedLookups
		await get('B0TESTASIN', '?region=us')
		expect(getMatchMetrics().languageMismatchedLookups).toBe(before)
	})
})

/**
 * The Hardcover genre backfill must reach the RESPONSE, and only for records
 * that carry no genres of their own.
 *
 * The class this serves, measured 2026-08-07: Audible has no category data
 * for some listings (Annihilation B00HYGYN5Q), so their records are honestly
 * genre-less, the bundle's clear-and-replace never fires, and comma-joined
 * file-tag junk ("Literary Fiction, Dystopian, Post-Apocalyptic, Horror" as
 * ONE genre) rolls up into artist-page mega-tags. Serving real genres is the
 * whole fix — the bundle already replaces when genres are present.
 */
describe('genre backfill on the item response', () => {
	const HC_GENRES = [
		{ asin: '1000000001', name: 'Horror', type: 'genre' },
		{ asin: '1000000002', name: 'Science Fiction', type: 'genre' }
	]

	beforeEach(() => {
		served = bookRecord()
		handlerThrows = null
		storedRecord = null
		servedByProvider = null
		backfillGenres = []
		backfilledIds = []
	})

	test('a genre-less record gets Hardcover genres attached', async () => {
		backfillGenres = HC_GENRES
		const { body } = await get('B0TESTASIN')
		expect(body.genres).toEqual(HC_GENRES)
		// ...asked for under the REQUESTED id, the key the cache is written by.
		expect(backfilledIds).toEqual(['B0TESTASIN'])
	})

	test('a record WITH genres is never overridden — Audible data wins', async () => {
		const audible = [{ asin: '18574597011', name: 'Science Fiction & Fantasy', type: 'genre' }]
		served = bookRecord({ genres: audible })
		backfillGenres = HC_GENRES
		const { body } = await get('B0TESTASIN')
		expect(body.genres).toEqual(audible)
	})

	test('no genres anywhere leaves the field OFF — the bundle reads presence', async () => {
		// NOTE: a mutation that attaches the key unconditionally survives this
		// through app.inject — `genres: undefined` disappears in JSON
		// serialization — so the conditional merge is wire-equivalent hygiene
		// matching the sibling legs' idiom, not separately testable here.
		backfillGenres = []
		const { body } = await get('B0TESTASIN')
		expect(body.genres).toBeUndefined()
	})

	test('the backfill keys on the REQUESTED id, not the record\'s own asin', async () => {
		// The same trap recallAlternates hit: a record can carry an unrelated
		// asin (Hardcover exposes one for dedup), and the cache is written under
		// the id the route was ASKED for. Keying on book.asin reads and writes
		// keys nothing else uses. A `book.asin ?? asin` mutant survives the
		// provider-branch test above because that record's asin is null — this
		// record's DIFFERS, which is what discriminates.
		served = bookRecord({ asin: 'B0DIFFERENT' })
		backfillGenres = HC_GENRES
		await get('B0TESTASIN')
		expect(backfilledIds).toEqual(['B0TESTASIN'])
	})

	test('the provider-id branch gets the backfill too — it is a SECOND return', async () => {
		servedByProvider = bookRecord({ asin: null })
		backfillGenres = HC_GENRES
		const { body } = await get('hardcover-edition-27515221')
		expect(body.genres).toEqual(HC_GENRES)
		expect(backfilledIds).toEqual(['hardcover-edition-27515221'])
	})

	test('the stale-while-error path serves genres on the stored record', async () => {
		handlerThrows = new NotFoundError('delisted', {
			asin: 'B0TESTASIN',
			code: 'PRODUCT_DELISTED'
		})
		storedRecord = bookRecord()
		backfillGenres = HC_GENRES
		const { status, body } = await get('B0TESTASIN')
		expect(status).toBe(200)
		expect(body.genres).toEqual(HC_GENRES)
	})
})

/**
 * A transient upstream refusal must not read as "this book does not exist".
 *
 * Measured 2026-07-31 against the deployed api: 20 concurrent requests for one
 * known-good ASIN returned 404 PRODUCT_DELISTED twenty times out of twenty,
 * while the same record served fine when asked once. A library refresh IS that
 * access pattern, and the agent's documented response to a failed fetch is to
 * keep existing metadata and move on — which is why ~15% of albums silently did
 * not update in that day's full refresh.
 */
describe('upstream says unavailable but we hold a record', () => {
	beforeEach(() => {
		resetMatchMetrics()
		handlerThrows = new NotFoundError('delisted', {
			asin: 'B0TESTASIN',
			code: 'PRODUCT_DELISTED'
		})
		storedRecord = null
	})

	test('serves the STORED record rather than 404ing', async () => {
		storedRecord = bookRecord({ title: 'A Stored Book' })
		const { status, body } = await get('B0TESTASIN')
		expect(status).toBe(200)
		expect(body.title).toBe('A Stored Book')
		// and the pipeline still runs on it
		expect(body.imageSquare).toBe(SQUARE_URL)
	})

	test('counts it, so a refusing upstream is visible behind the 200', async () => {
		storedRecord = bookRecord()
		const before = getMatchMetrics().staleServedOnUpstreamUnavailable
		await get('B0TESTASIN')
		expect(getMatchMetrics().staleServedOnUpstreamUnavailable).toBe(before + 1)
	})

	test('still 404s when there is genuinely no stored record', async () => {
		storedRecord = null
		const { status } = await get('B0TESTASIN')
		expect(status).toBe(404)
		expect(getMatchMetrics().staleServedOnUpstreamUnavailable).toBe(0)
	})

	test('a NON-availability failure is not swallowed by the fallback', async () => {
		// Only PRODUCT_DELISTED / REGION_UNAVAILABLE are rescued; anything else
		// must keep propagating or a real bug hides behind a stale record.
		handlerThrows = new NotFoundError('not in db', { asin: 'B0TESTASIN', code: 'OTHER' })
		storedRecord = bookRecord({ title: 'Should Not Be Served' })
		const { status, body } = await get('B0TESTASIN')
		expect(status).toBe(404)
		expect(body.title).toBeUndefined()
	})
})

/**
 * The cached alternates must reach the RESPONSE.
 *
 * alternateCoverCache has its own suite, but those pass whether or not the
 * route calls it — the same unwired-stage shape that let four mutations
 * through on 2026-07-31, and that let the first version of this very feature
 * survive deleting its call site with 1839 tests green.
 *
 * This is also the fix for v1.3.183's real defect: the plugin-side memo only
 * filled during a SEARCH, so a plain refresh never saw alternates. Serving them
 * from the item route is what makes a refresh work.
 */
describe('alternate covers on the item response', () => {
	beforeEach(() => {
		handlerThrows = null
		storedRecord = null
		servedByProvider = null
		cachedAlternates = []
		remembered = []
		recalledKeys = []
		searchResults = []
		searchCalls = 0
		searchThrows = null
		hasRedis = true
	})

	test('a cached alternate is attached to the served book', async () => {
		cachedAlternates = ['https://m.media-amazon.com/images/I/99ZZZ.jpg']
		served = bookRecord()
		const { body } = await get('B0TESTASIN')
		expect(body.imageAlternates).toEqual(cachedAlternates)
	})

	test('nothing cached leaves the field off entirely', async () => {
		served = bookRecord()
		const { body } = await get('B0TESTASIN')
		expect(body.imageAlternates).toBeUndefined()
	})

	test('a MISS computes them — the path a plain refresh actually takes', async () => {
		// The defect this fixes, measured live 2026-08-01: The Testaments is
		// matched to `hardcover-edition-30404079`, and refreshing it served no
		// alternates however many times it was refreshed, because alternates were
		// only ever written by a SEARCH and `update()` never searches. A cached
		// empty list ([]) is a real answer; only NULL means nobody has looked.
		cachedAlternates = null
		searchResults = [
			{ id: 'B0TESTASIN', coverAlternates: ['https://example.invalid/borrowed.jpg'] }
		]
		served = bookRecord()
		const { body } = await get('B0TESTASIN')
		expect(searchCalls).toBe(1)
		expect(body.imageAlternates).toEqual(['https://example.invalid/borrowed.jpg'])
	})

	test('a cached EMPTY list does NOT re-search — that is what it is for', async () => {
		// Without this, every alternate-less book in the library fans out across
		// every provider on every refresh, forever.
		cachedAlternates = []
		served = bookRecord()
		await get('B0TESTASIN')
		expect(searchCalls).toBe(0)
	})

	test('the compute writes back EVERY row, warming the near-tie siblings', async () => {
		// The siblings are precisely the rows that lent this book its art, so the
		// next refresh of any of them is already paid for.
		cachedAlternates = null
		searchResults = [
			{ id: 'B0TESTASIN', coverAlternates: ['a.jpg'] },
			{ id: 'B0SIBLING1', coverAlternates: ['b.jpg'] },
			{ id: 'B0NOALTS01' }
		]
		served = bookRecord()
		await get('B0TESTASIN')
		expect(remembered).toEqual([
			['B0TESTASIN', ['a.jpg']],
			['B0SIBLING1', ['b.jpg']],
			['B0NOALTS01', []],
			// ...and the requested id explicitly, which is the key recall reads.
			['B0TESTASIN', ['a.jpg']]
		])
	})

	test('the REQUESTED id is recorded even when absent from its own results', () => {
		// The gap this closes: the write loop only covers ids the search returned.
		// A delisted ASIN on the stale-while-error path is never in its own search
		// results, so nothing was written for it and the next request recalled
		// null and paid for the entire provider fan-out again -- every request,
		// forever, for exactly the books least able to afford it.
		cachedAlternates = null
		searchResults = [{ id: 'B0SOMEONEELSE', coverAlternates: ['x.jpg'] }]
		served = bookRecord()
		return get('B0TESTASIN').then(() => {
			expect(remembered).toContainEqual(['B0TESTASIN', []])
		})
	})

	test('recall keys on the REQUESTED id, not on the record\'s own asin', async () => {
		// A provider record can carry an unrelated `asin` (Hardcover exposes one
		// for dedup). Keying recall on it read a key nothing ever wrote.
		cachedAlternates = ['https://example.invalid/cached.jpg']
		served = bookRecord({ asin: 'B0DIFFERENT' })
		const { body } = await get('B0TESTASIN')
		expect(body.imageAlternates).toEqual(['https://example.invalid/cached.jpg'])
		expect(searchCalls).toBe(0)
		// The assertion that actually discriminates.
		expect(recalledKeys).toEqual(['B0TESTASIN'])
		expect(recalledKeys).not.toContain('B0DIFFERENT')
	})

	test('NO REDIS means no compute — nowhere to record the answer', async () => {
		// A redis-less instance must not pay for a provider fan-out on every
		// single book lookup to attach spare art. It goes without, as before.
		hasRedis = false
		cachedAlternates = null
		searchResults = [{ id: 'B0TESTASIN', coverAlternates: ['nope.jpg'] }]
		served = bookRecord()
		const { body } = await get('B0TESTASIN')
		expect(searchCalls).toBe(0)
		expect(body.imageAlternates).toBeUndefined()
	})

	test('a search that THROWS still serves the book', async () => {
		// Spare art is never worth a 500. Every provider being down must cost the
		// refresh its alternates and nothing else.
		cachedAlternates = null
		searchThrows = new Error('every provider is down')
		served = bookRecord()
		const { status, body } = await get('B0TESTASIN')
		expect(status).toBe(200)
		expect(body.title).toBe('A Test Book')
		expect(body.imageAlternates).toBeUndefined()
	})

	test('the provider-id branch gets them too — it is a SECOND return', async () => {
		// ~90 albums reach Plex through the hardcover-*/apple-* branch; wiring
		// only the audnexus path would leave half the library without art.
		cachedAlternates = ['https://m.media-amazon.com/images/I/77YYY.jpg']
		servedByProvider = bookRecord({ asin: null })
		const { body } = await get('hardcover-edition-27515221')
		expect(body.imageAlternates).toEqual(cachedAlternates)
	})
})

/**
 * THE FOUR ENRICHMENTS MUST RUN CONCURRENTLY.
 *
 * finish() used to await square cover, then alternate covers, then Goodreads
 * series — independent network calls whose latency therefore SUMMED.
 * Measured across the entire 2026-08-05 rebuild: /books/:asin averaged 907 ms
 * with a 0.8 ms DB path, i.e. the serve chain was essentially all enrichment
 * wait. They are safe to overlap because their reads and writes are disjoint,
 * verified leg by leg before this test existed: square reads title/author/image
 * and writes only imageSquare; alternates reads title/author (computeAlternates)
 * and writes only imageAlternates; Goodreads reads title/subtitle/author/series
 * and writes only the series fields. Nothing reads what another writes.
 *
 * The pin is ORDER-BASED, not timing-based: each leg records start, yields for
 * a real timer tick, then records end. Sequential execution interleaves
 * (start,end,start,end,…) — the first leg's end lands before the last leg's
 * start — while concurrent execution starts every leg before any can end.
 * 15 ms dwarfs microtask scheduling, so this cannot flake on a slow runner.
 */
describe('finish() enrichment concurrency', () => {
	test('every leg starts before any leg finishes, and all contributions merge', async () => {
		const events: string[] = []
		enrichTrace = async (leg: string) => {
			events.push(`start:${leg}`)
			await new Promise((r) => setTimeout(r, 15))
			events.push(`end:${leg}`)
		}
		try {
			cachedAlternates = ['https://m.media-amazon.com/images/I/88ZZZ.jpg']
			served = bookRecord()
			const { status, body } = await get('B0TESTASIN')
			expect(status).toBe(200)

			// All four legs ran.
			const starts = events.filter((e) => e.startsWith('start:'))
			expect(starts.sort()).toEqual([
				'start:alternates',
				'start:genres',
				'start:goodreads',
				'start:square'
			])

			// Concurrency: the LAST start precedes the FIRST end. Under the old
			// sequential chain this fails immediately (square ends before
			// alternates starts).
			const lastStart = Math.max(...events.map((e, i) => (e.startsWith('start:') ? i : -1)))
			const firstEnd = Math.min(
				...events.map((e, i) => (e.startsWith('end:') ? i : Infinity))
			)
			expect(lastStart).toBeLessThan(firstEnd)

			// The merge keeps every leg's contribution — parallelizing must not
			// drop a field the sequential chain used to thread through.
			expect(body.imageSquare).toBe(SQUARE_URL)
			expect(body.imageAlternates).toEqual(cachedAlternates)
			expect(body.title).toBe('A Test Book')
		} finally {
			enrichTrace = async () => {}
			cachedAlternates = []
		}
	})
})


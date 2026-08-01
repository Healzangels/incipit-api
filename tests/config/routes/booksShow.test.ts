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
const realGoodreads = await import('#helpers/providers/goodreadsSeries')
mock.module('#helpers/providers/goodreadsSeries', () => ({
	...realGoodreads,
	withGoodreadsSeries: async (book: unknown) => book
}))

mock.module('#helpers/providers/squareCover', () => ({
	bestSquareCover: async () => SQUARE_URL
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

/** What the sibling-marketplace lookup returns, per test. */
let siblingRecord: Record<string, unknown> | null = null
/** How many times the sibling-marketplace lookup was actually issued. The
 *  cost-control test asserts on this; without it the assertion is vacuous. */
let siblingLookups = 0
mock.module('#helpers/providers/registry', () => ({
	default: {
		fetchBookByAsin: async () => {
			siblingLookups += 1
			return siblingRecord
		},
		searchAll: async () => []
	}
}))

const { default: booksShow } = await import('#config/routes/books/show')
const { getMatchMetrics, resetMatchMetrics } = await import('#helpers/utils/matchTelemetry')
const { NotFoundError } = await import('#helpers/errors/ApiErrors')

async function get(asin: string, query = '') {
	const app = Fastify()
	try {
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
 * The ALTERNATE-REGION cover, wired.
 *
 * `alternateCover.ts` has its own unit suite, but those pass whether or not the
 * route ever calls it — verified by mutation: deleting `withAlternateCovers`
 * from the pipeline left all 1839 tests green. That is the same unwired-stage
 * shape this file exists for, so the assertion has to come through the route.
 */
describe('alternate-region cover art', () => {
	const AMAZON = 'https://m.media-amazon.com/images/I/51AAA._SL500_.jpg'
	const OTHER = 'https://m.media-amazon.com/images/I/99ZZZ._SL500_.jpg'

	beforeEach(() => {
		handlerThrows = null
		storedRecord = null
		servedByProvider = null
		siblingRecord = null
		siblingLookups = 0
	})

	test('offers the sibling marketplace cover when the narrators match', async () => {
		served = bookRecord({ image: AMAZON, narrators: [{ name: 'Ann Dowd' }] })
		siblingRecord = { image: OTHER, narrators: [{ name: 'Ann Dowd' }] }
		const { body } = await get('B0TESTASIN')
		expect(body.imageAlternates).toEqual([OTHER])
	})

	test('does NOT offer it when the narrator differs — the Fever Dream case', async () => {
		served = bookRecord({ image: AMAZON, narrators: [{ name: 'Ann Dowd' }] })
		siblingRecord = { image: OTHER, narrators: [{ name: 'Someone Else' }] }
		const { body } = await get('B0TESTASIN')
		expect(body.imageAlternates).toBeUndefined()
	})

	test('does not even look when the cover is not an Amazon asset', async () => {
		// A Hardcover/OpenLibrary match has no sibling-ASIN concept, so the
		// lookup could only ever miss — this is the per-response cost control.
		siblingRecord = { image: OTHER, narrators: [{ name: 'Ann Dowd' }] }
		served = bookRecord({
			image: 'https://images.hardcover.app/x/cover.jpg',
			narrators: [{ name: 'Ann Dowd' }]
		})
		const { body } = await get('B0TESTASIN')
		expect(siblingLookups).toBe(0)
		expect(body.imageAlternates).toBeUndefined()
	})
})

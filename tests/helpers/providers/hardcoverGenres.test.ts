import { beforeEach, describe, expect, test } from 'bun:test'

import { ApiGenreSchema } from '#config/types'
import {
	backfillHardcoverGenres,
	genresFromCachedTags,
	hardcoverGenreKey,
	syntheticGenreAsin
} from '#helpers/providers/hardcoverGenres'

/**
 * Genre backfill from Hardcover for books whose record carries none.
 *
 * The class this covers, measured live 2026-08-07: Audible's catalog API has
 * an EMPTY category_ladders for some listings (Annihilation B00HYGYN5Q,
 * Absolution B0D33SC327), so their served records carry no genres, the
 * bundle's clear-and-replace never fires, and the comma-joined junk in the
 * files' ©gen tags ("Literary Fiction, Dystopian, Post-Apocalyptic, Horror"
 * as ONE genre) reaches the artist page as mega-tags. Hardcover's
 * cached_tags.Genre answers by the same asin — both books above verified.
 */

/** The exact wire shape measured live for Annihilation, 2026-08-07. */
const ANNIHILATION_TAGS = {
	Tag: [{ tag: 'Unloveable Characters' }, { tag: 'Character driven' }],
	Mood: [{ tag: 'mysterious' }, { tag: 'dark' }],
	Genre: [
		{ tag: 'Fiction' },
		{ tag: 'Horror' },
		{ tag: 'Science Fiction' },
		{ tag: 'Adventure' },
		{ tag: 'Suspense' },
		{ tag: 'General' }
	],
	'Content Warning': [{ tag: 'Violence' }]
}

describe('genresFromCachedTags', () => {
	test('takes the Genre bucket only — Moods and Tags are review vocabulary', () => {
		const names = genresFromCachedTags(ANNIHILATION_TAGS).map((g) => g.name)
		expect(names).toEqual(['Fiction', 'Horror', 'Science Fiction', 'Adventure', 'Suspense'])
		expect(names).not.toContain('mysterious')
		expect(names).not.toContain('Unloveable Characters')
	})

	test('drops "General" — BISAC filler, not a genre', () => {
		const names = genresFromCachedTags(ANNIHILATION_TAGS).map((g) => g.name)
		expect(names).not.toContain('General')
	})

	test('every entry passes ApiGenreSchema (10-digit asin, type genre)', () => {
		for (const g of genresFromCachedTags(ANNIHILATION_TAGS)) {
			expect(() => ApiGenreSchema.parse(g)).not.toThrow()
			expect(g.type).toBe('genre')
		}
	})

	test('dedupes case-insensitively and caps the list', () => {
		const bucket = Array.from({ length: 20 }, (_, i) => ({ tag: `Genre ${i}` }))
		bucket.unshift({ tag: 'horror' }, { tag: 'Horror' })
		const out = genresFromCachedTags({ Genre: bucket })
		expect(out.filter((g) => g.name.toLowerCase() === 'horror').length).toBe(1)
		expect(out.length).toBe(8)
	})

	test('tolerates the jsonb-as-string form and garbage shapes', () => {
		expect(genresFromCachedTags(JSON.stringify(ANNIHILATION_TAGS)).length).toBe(5)
		expect(genresFromCachedTags('not json')).toEqual([])
		expect(genresFromCachedTags(null)).toEqual([])
		expect(genresFromCachedTags(42)).toEqual([])
		expect(genresFromCachedTags({ Genre: 'not an array' })).toEqual([])
		expect(genresFromCachedTags({ Genre: [{ notTag: 1 }, null, 7] })).toEqual([])
	})

	test('synthetic asins are stable and always exactly 10 digits', () => {
		expect(syntheticGenreAsin('Horror')).toBe(syntheticGenreAsin('horror'))
		for (const name of ['a', 'Science Fiction', '日本語', 'x'.repeat(500)]) {
			expect(syntheticGenreAsin(name)).toMatch(/^\d{10}$/)
		}
		expect(syntheticGenreAsin('Horror')).not.toBe(syntheticGenreAsin('Fantasy'))
	})
})

/** In-memory redis double recording writes so TTL choices can be asserted. */
class FakeRedis {
	store = new Map<string, string>()
	writes: { key: string; value: string; ttl: number }[] = []
	async get(key: string) {
		return this.store.get(key) ?? null
	}
	async set(key: string, value: string, _mode: 'EX', ttl: number) {
		this.store.set(key, value)
		this.writes.push({ key, value, ttl })
	}
}

/** GQL double: returns a canned envelope, counting calls. */
function fakeGql(envelope: unknown) {
	const calls: { query: string; variables: Record<string, unknown> }[] = []
	const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
		calls.push({ query, variables })
		if (envelope instanceof Error) throw envelope
		return envelope as T
	}
	return { gql, calls }
}

const EDITION_ENVELOPE = { editions: [{ book: { cached_tags: ANNIHILATION_TAGS } }] }

describe('backfillHardcoverGenres', () => {
	let redis: FakeRedis
	beforeEach(() => {
		redis = new FakeRedis()
	})

	test('a MISS queries Hardcover by asin and caches the mapped answer', async () => {
		const { gql, calls } = fakeGql(EDITION_ENVELOPE)
		const out = await backfillHardcoverGenres({ id: 'B00HYGYN5Q', redis: redis as never, token: 't', gql })
		expect(out.map((g) => g.name)).toEqual([
			'Fiction',
			'Horror',
			'Science Fiction',
			'Adventure',
			'Suspense'
		])
		expect(calls.length).toBe(1)
		expect(calls[0].variables).toEqual({ asin: 'B00HYGYN5Q' })
		// Cached under the requested id, long TTL for a real answer.
		expect(redis.writes).toEqual([
			expect.objectContaining({ key: hardcoverGenreKey('B00HYGYN5Q'), ttl: 2592000 })
		])
	})

	test('a cached answer is served WITHOUT a query', async () => {
		await redis.set(
			hardcoverGenreKey('B00HYGYN5Q'),
			JSON.stringify([{ asin: '1234567890', name: 'Horror', type: 'genre' }]),
			'EX',
			1
		)
		const { gql, calls } = fakeGql(EDITION_ENVELOPE)
		const out = await backfillHardcoverGenres({ id: 'B00HYGYN5Q', redis: redis as never, token: 't', gql })
		expect(out.map((g) => g.name)).toEqual(['Horror'])
		expect(calls.length).toBe(0)
	})

	test('an EMPTY answer is cached too — "looked, found none" suppresses re-asks', async () => {
		const { gql, calls } = fakeGql({ editions: [] })
		const first = await backfillHardcoverGenres({ id: 'B0NOGENRES', redis: redis as never, token: 't', gql })
		expect(first).toEqual([])
		// Shorter TTL than a hit: Hardcover tags grow, "none yet" gets re-asked sooner.
		expect(redis.writes).toEqual([
			expect.objectContaining({ key: hardcoverGenreKey('B0NOGENRES'), ttl: 604800 })
		])
		const second = await backfillHardcoverGenres({ id: 'B0NOGENRES', redis: redis as never, token: 't', gql })
		expect(second).toEqual([])
		expect(calls.length).toBe(1)
	})

	test('the bundle id form `<id>_<region>` hits the same cache key as the bare id', async () => {
		const { gql } = fakeGql(EDITION_ENVELOPE)
		await backfillHardcoverGenres({ id: 'B00HYGYN5Q', redis: redis as never, token: 't', gql })
		const { gql: gql2, calls: calls2 } = fakeGql(EDITION_ENVELOPE)
		const out = await backfillHardcoverGenres({
			id: 'B00HYGYN5Q_us',
			redis: redis as never,
			token: 't',
			gql: gql2
		})
		expect(out.length).toBe(5)
		expect(calls2.length).toBe(0)
	})

	test('hardcover-edition ids query by edition id, hardcover-book ids by book id', async () => {
		const { gql, calls } = fakeGql(EDITION_ENVELOPE)
		await backfillHardcoverGenres({
			id: 'hardcover-edition-30404079',
			redis: redis as never,
			token: 't',
			gql
		})
		expect(calls[0].query).toContain('editions(where: { id:')
		expect(calls[0].variables).toEqual({ id: 30404079 })

		const bookEnvelope = { books: [{ cached_tags: ANNIHILATION_TAGS }] }
		const { gql: bGql, calls: bCalls } = fakeGql(bookEnvelope)
		const out = await backfillHardcoverGenres({
			id: 'hardcover-book-376172',
			redis: redis as never,
			token: 't',
			gql: bGql
		})
		expect(bCalls[0].query).toContain('books(where: { id:')
		expect(bCalls[0].variables).toEqual({ id: 376172 })
		expect(out.length).toBe(5)
	})

	test('a non-Hardcover provider id asks nothing — Hardcover cannot answer it', async () => {
		const { gql, calls } = fakeGql(EDITION_ENVELOPE)
		const out = await backfillHardcoverGenres({
			id: 'overdrive-565194',
			redis: redis as never,
			token: 't',
			gql
		})
		expect(out).toEqual([])
		expect(calls.length).toBe(0)
	})

	test('NO REDIS means no compute — nowhere to record the answer', async () => {
		const { gql, calls } = fakeGql(EDITION_ENVELOPE)
		const out = await backfillHardcoverGenres({ id: 'B00HYGYN5Q', redis: null, token: 't', gql })
		expect(out).toEqual([])
		expect(calls.length).toBe(0)
	})

	test('no token means no query, and the non-answer is NOT cached', async () => {
		const { gql, calls } = fakeGql(EDITION_ENVELOPE)
		const out = await backfillHardcoverGenres({ id: 'B00HYGYN5Q', redis: redis as never, gql })
		expect(out).toEqual([])
		expect(calls.length).toBe(0)
		expect(redis.writes.length).toBe(0)
	})

	test('an upstream failure serves [] and is NOT cached — transient outages must not pin "no genres"', async () => {
		const { gql } = fakeGql(new Error('hardcover is down'))
		const out = await backfillHardcoverGenres({ id: 'B00HYGYN5Q', redis: redis as never, token: 't', gql })
		expect(out).toEqual([])
		expect(redis.writes.length).toBe(0)
		// The next call is free to try again.
		const { gql: okGql, calls } = fakeGql(EDITION_ENVELOPE)
		await backfillHardcoverGenres({ id: 'B00HYGYN5Q', redis: redis as never, token: 't', gql: okGql })
		expect(calls.length).toBe(1)
	})

	test('a corrupt cache entry is ignored and recomputed', async () => {
		await redis.set(hardcoverGenreKey('B00HYGYN5Q'), 'not json{', 'EX', 1)
		const { gql, calls } = fakeGql(EDITION_ENVELOPE)
		const out = await backfillHardcoverGenres({ id: 'B00HYGYN5Q', redis: redis as never, token: 't', gql })
		expect(out.length).toBe(5)
		expect(calls.length).toBe(1)
	})
})

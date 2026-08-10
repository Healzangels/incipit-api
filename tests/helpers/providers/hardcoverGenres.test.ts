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
		// "Fiction" now sorts LAST rather than first. Hardcover ranks by tag
		// frequency and "Fiction" is the most-tagged thing on almost any novel,
		// which is precisely why it says nothing — and on Fourth Wing (live,
		// 2026-08-10) it took a slot that "High Fantasy" and "Magic" then could
		// not reach. The frequency order among the REAL genres is untouched.
		expect(names).toEqual(['Horror', 'Science Fiction', 'Adventure', 'Suspense', 'Fiction'])
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

	test('emoji are stripped, and the CLEANED name is what dedupes', () => {
		// "🐙 Weird Fiction" is a real Hardcover tag, served live on Absolution
		// (B0D33SC327) by the v1 mapper on 2026-08-08. It must arrive as plain
		// "Weird Fiction" — and collapse with a plain sibling, as on
		// Annihilation where "Weird fiction" also appears.
		const out = genresFromCachedTags({
			Genre: [{ tag: 'Weird fiction' }, { tag: '🐙 Weird Fiction' }]
		})
		expect(out.map((g) => g.name)).toEqual(['Weird fiction'])
		const alone = genresFromCachedTags({ Genre: [{ tag: '🐙 Weird Fiction' }] })
		expect(alone.map((g) => g.name)).toEqual(['Weird Fiction'])
		// A tag that is ONLY emoji has nothing left and is dropped.
		expect(genresFromCachedTags({ Genre: [{ tag: '🐙✨' }] })).toEqual([])
	})

	test('"Sci-fi" folds into Science Fiction — the live duplicate pair', () => {
		// Annihilation's v1 serve carried BOTH "Science Fiction" and "Sci-fi".
		const out = genresFromCachedTags({
			Genre: [{ tag: 'Science Fiction' }, { tag: 'Sci-fi' }, { tag: 'scifi' }]
		})
		expect(out.map((g) => g.name)).toEqual(['Science Fiction'])
		// The fold also applies when the alias arrives alone.
		const alone = genresFromCachedTags({ Genre: [{ tag: 'Sci-fi' }] })
		expect(alone.map((g) => g.name)).toEqual(['Science Fiction'])
	})

	test('a tag named after an Object.prototype member is just a tag', () => {
		// The alias table used to be an object literal indexed by an
		// upstream-controlled key. `GENRE_ALIASES['constructor']` resolves
		// Object.prototype.constructor — a FUNCTION, so `??` does not fall back
		// and the next line's `clean.toLowerCase()` throws TypeError. That
		// throw lands BEFORE the redis.set in both callers, so the book loses
		// every genre AND the empty answer is never cached: a Hardcover GraphQL
		// query plus a Chaptarr work fetch, re-paid on every refresh forever.
		// Chaptarr feeds free-text Goodreads shelves through this same mapper.
		//
		// The INVARIANT is what is asserted here, not the exact output: no throw,
		// the real genre beside the poison still arrives, and every row is
		// schema-valid. This used to assert the poison name came back verbatim,
		// which was a mirror of the then-current formatting — the shelf-noise
		// layer (2026-08-09) legitimately title-cases an all-lowercase name and
		// drops '__proto__' entirely, since its dedupe key is empty once
		// punctuation is stripped. Neither is the defect this test exists for.
		for (const poison of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
			let out: ReturnType<typeof genresFromCachedTags> = []
			expect(() => {
				out = genresFromCachedTags({ Genre: [{ tag: poison }, { tag: 'Horror' }] })
			}).not.toThrow()
			// The genuine genre is never lost to its poisoned neighbour.
			expect(out.map((g) => g.name)).toContain('Horror')
			for (const g of out) {
				expect(() => ApiGenreSchema.parse(g)).not.toThrow()
				// Nothing resolved to a prototype member: every name is a string
				// that came from the tag, never a function or an inherited value.
				expect(typeof g.name).toBe('string')
			}
		}
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
		const out = await backfillHardcoverGenres({
			id: 'B00HYGYN5Q',
			redis: redis as never,
			token: 't',
			gql
		})
		// "Fiction" sorts last — see the ordering note on genresFromCachedTags.
		expect(out.map((g) => g.name)).toEqual([
			'Horror',
			'Science Fiction',
			'Adventure',
			'Suspense',
			'Fiction'
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
		const out = await backfillHardcoverGenres({
			id: 'B00HYGYN5Q',
			redis: redis as never,
			token: 't',
			gql
		})
		expect(out.map((g) => g.name)).toEqual(['Horror'])
		expect(calls.length).toBe(0)
	})

	test('an EMPTY answer is cached too — "looked, found none" suppresses re-asks', async () => {
		const { gql, calls } = fakeGql({ editions: [] })
		const first = await backfillHardcoverGenres({
			id: 'B0NOGENRES',
			redis: redis as never,
			token: 't',
			gql
		})
		expect(first).toEqual([])
		// Shorter TTL than a hit: Hardcover tags grow, "none yet" gets re-asked sooner.
		expect(redis.writes).toEqual([
			expect.objectContaining({ key: hardcoverGenreKey('B0NOGENRES'), ttl: 604800 })
		])
		const second = await backfillHardcoverGenres({
			id: 'B0NOGENRES',
			redis: redis as never,
			token: 't',
			gql
		})
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
		const out = await backfillHardcoverGenres({
			id: 'B00HYGYN5Q',
			redis: redis as never,
			token: 't',
			gql
		})
		expect(out).toEqual([])
		expect(redis.writes.length).toBe(0)
		// The next call is free to try again.
		const { gql: okGql, calls } = fakeGql(EDITION_ENVELOPE)
		await backfillHardcoverGenres({
			id: 'B00HYGYN5Q',
			redis: redis as never,
			token: 't',
			gql: okGql
		})
		expect(calls.length).toBe(1)
	})

	test('an entry cached by the RETIRED v1 mapper generation is never served', async () => {
		// The invariant (not a literal-version mirror): whatever the current
		// KEY_VERSION is, it must not read the v1 generation's keys — v1
		// answers were computed before the emoji/alias rules and really did
		// serve "🐙 Weird Fiction" live. This stays true through every future
		// bump; only reverting to v1 itself fails it.
		redis.store.set(
			'incipit:hcgenres:v1:B00HYGYN5Q',
			JSON.stringify([{ asin: '1000000009', name: '🐙 Weird Fiction', type: 'genre' }])
		)
		const { gql, calls } = fakeGql(EDITION_ENVELOPE)
		const out = await backfillHardcoverGenres({
			id: 'B00HYGYN5Q',
			redis: redis as never,
			token: 't',
			gql
		})
		expect(calls.length).toBe(1)
		expect(out.map((g) => g.name)).not.toContain('🐙 Weird Fiction')
	})

	test('a corrupt cache entry is ignored and recomputed', async () => {
		await redis.set(hardcoverGenreKey('B00HYGYN5Q'), 'not json{', 'EX', 1)
		const { gql, calls } = fakeGql(EDITION_ENVELOPE)
		const out = await backfillHardcoverGenres({
			id: 'B00HYGYN5Q',
			redis: redis as never,
			token: 't',
			gql
		})
		expect(out.length).toBe(5)
		expect(calls.length).toBe(1)
	})
})

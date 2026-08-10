import { beforeEach, describe, expect, test } from 'bun:test'

import { ApiGenreSchema } from '#config/types'
import {
	backfillChaptarrGenres,
	chaptarrGenreKey,
	chaptarrWorkIdFor,
	demoteGenericShelves,
	genresFromWork} from '#helpers/providers/chaptarrGenres'

/**
 * Chaptarr genre backfill — the second source in the genre leg.
 *
 * The genre list is a LIVE CAPTURE from /api/v5/book/az:B00HYGYN5Q
 * (2026-08-08): Goodreads-shelf aggregates, so it carries real genres the
 * Hardcover bucket lacks (Dystopia, Weird fiction) alongside shelving habits
 * that are not genres at all (Audiobook, Book Club, General) and the same
 * alias duplicates the Hardcover mapper already folds (Sci-fi vs Science
 * fiction).
 */

const LIVE_GENRES = [
	'Adventure',
	'Audiobook',
	'Book Club',
	'Dystopia',
	'Fantasy',
	'Fiction',
	'General',
	'Horror',
	'Literary Fiction',
	'Literature & Fiction',
	'Mystery',
	'Science fiction',
	'Science Fiction & Fantasy',
	'Sci-fi',
	'Suspense',
	'Thriller',
	'Weird fiction'
]

describe('genresFromWork', () => {
	test('drops shelf noise, dedupes, caps — the shared discipline', () => {
		const names = genresFromWork(LIVE_GENRES).map((g) => g.name)
		expect(names).not.toContain('Audiobook')
		expect(names).not.toContain('Book Club')
		expect(names).not.toContain('General')
		expect(names).toContain('Dystopia')
		expect(names.length).toBeLessThanOrEqual(8)
	})

	test('the Sci-fi alias FOLDS into an existing Science fiction', () => {
		// This assertion used to read "at most 2 names contain 'science
		// fiction'", measured 0 on LIVE_GENRES — because MAX_GENRES cuts the
		// alphabetical list off at "Mystery", so neither name is even in the
		// answer. It passed identically with the fold deleted. Ask the question
		// on an input where the fold is the ONLY thing that can decide it.
		// The FOLD is what this asserts: three names in, two out, with no 'Sci-fi'
		// sibling. The surviving spelling is now Audible's "Science Fiction"
		// rather than the feed's "Science fiction" — the canonical table
		// (2026-08-09) picks one spelling per genre so the same tag cannot appear
		// twice in the library under two casings.
		const names = genresFromWork(['Science fiction', 'Sci-fi', 'Dystopia']).map((g) => g.name)
		expect(names).toEqual(['Science Fiction', 'Dystopia'])
		expect(names).not.toContain('Sci-fi')
		// And the other direction: with no sibling to fold into, the alias
		// still normalizes rather than passing through raw.
		expect(genresFromWork(['Sci-fi']).map((g) => g.name)).toEqual(['Science Fiction'])
	})

	test('shelf noise is matched POST-CLEAN, the way the set documents itself', () => {
		// The filter used to test the RAW name while cleanGenreName ran later,
		// so every decorated shelf escaped it and was then cleaned into exactly
		// the term the set exists to drop — and cached for 30 days.
		const decorated = ['📚 Audiobook', '🎧 audiobooks', 'Book  Club', 'To  Read', 'Weird fiction']
		expect(genresFromWork(decorated).map((g) => g.name)).toEqual(['Weird fiction'])
	})

	test('every entry passes ApiGenreSchema', () => {
		for (const g of genresFromWork(LIVE_GENRES)) {
			expect(() => ApiGenreSchema.parse(g)).not.toThrow()
			expect(g.type).toBe('genre')
		}
	})

	test('garbage shapes return empty', () => {
		expect(genresFromWork(null)).toEqual([])
		expect(genresFromWork('Fantasy')).toEqual([])
		expect(genresFromWork([1, null, {}])).toEqual([])
	})
})

describe('chaptarrWorkIdFor', () => {
	test('maps the id forms Chaptarr can answer', () => {
		expect(chaptarrWorkIdFor('B00HYGYN5Q')).toBe('az:B00HYGYN5Q')
		expect(chaptarrWorkIdFor('B00HYGYN5Q_us')).toBe('az:B00HYGYN5Q')
		expect(chaptarrWorkIdFor('hardcover-book-376172')).toBe('hc:376172')
		// Edition-shaped and foreign ids stay with the Hardcover leg.
		expect(chaptarrWorkIdFor('hardcover-edition-30404079')).toBeNull()
		expect(chaptarrWorkIdFor('overdrive-565194')).toBeNull()
		expect(chaptarrWorkIdFor('')).toBeNull()
	})
})

class FakeRedis {
	store = new Map<string, string>()
	writes: { key: string; ttl: number }[] = []
	async get(key: string) {
		return this.store.get(key) ?? null
	}
	async set(key: string, value: string, _mode: 'EX', ttl: number) {
		this.store.set(key, value)
		this.writes.push({ key, ttl })
	}
}

describe('backfillChaptarrGenres', () => {
	let redis: FakeRedis
	beforeEach(() => {
		redis = new FakeRedis()
	})

	const WORK = { work: { genres: LIVE_GENRES } }

	test('a MISS fetches the work and caches the mapped answer under the bare id', async () => {
		const calls: string[] = []
		const out = await backfillChaptarrGenres({
			id: 'B00HYGYN5Q_us',
			redis: redis as never,
			workFetch: async (id) => {
				calls.push(id)
				return WORK
			}
		})
		expect(out.length).toBeGreaterThan(0)
		expect(calls).toEqual(['az:B00HYGYN5Q'])
		expect(redis.writes).toEqual([
			expect.objectContaining({ key: chaptarrGenreKey('B00HYGYN5Q'), ttl: 2592000 })
		])
	})

	test('an EMPTY answer is cached with the shorter TTL and suppresses re-asks', async () => {
		const calls: string[] = []
		const fetchEmpty = async (id: string) => {
			calls.push(id)
			return { work: { genres: [] } }
		}
		await backfillChaptarrGenres({ id: 'B0NOGENRES', redis: redis as never, workFetch: fetchEmpty })
		expect(redis.writes).toEqual([expect.objectContaining({ ttl: 604800 })])
		await backfillChaptarrGenres({ id: 'B0NOGENRES', redis: redis as never, workFetch: fetchEmpty })
		expect(calls.length).toBe(1)
	})

	test('an upstream failure serves [] and is NOT cached', async () => {
		const out = await backfillChaptarrGenres({
			id: 'B00HYGYN5Q',
			redis: redis as never,
			workFetch: async () => {
				throw new Error('down')
			}
		})
		expect(out).toEqual([])
		expect(redis.writes.length).toBe(0)
	})

	test('no redis or an unaskable id means no compute', async () => {
		const calls: string[] = []
		const spy = async (id: string) => {
			calls.push(id)
			return WORK
		}
		expect(await backfillChaptarrGenres({ id: 'B00HYGYN5Q', redis: null, workFetch: spy })).toEqual([])
		expect(
			await backfillChaptarrGenres({ id: 'overdrive-1', redis: redis as never, workFetch: spy })
		).toEqual([])
		expect(calls).toEqual([])
	})

	test('CHAPTARR_ENABLED=false silences this leg entirely', async () => {
		// registry.ts gates only the provider REGISTRATION, which governs the
		// search path. This leg calls the transport directly, so without its own
		// check the kill-switch left /books/:asin calling api2.chaptarr.com.
		const previous = process.env.CHAPTARR_ENABLED
		process.env.CHAPTARR_ENABLED = 'false'
		try {
			const calls: string[] = []
			const out = await backfillChaptarrGenres({
				id: 'B00HYGYN5Q',
				redis: redis as never,
				workFetch: async (id) => {
					calls.push(id)
					return WORK
				}
			})
			expect(out).toEqual([])
			expect(calls).toEqual([])
			expect(redis.writes).toEqual([])
		} finally {
			if (previous === undefined) delete process.env.CHAPTARR_ENABLED
			else process.env.CHAPTARR_ENABLED = previous
		}
	})
})

describe('demoteGenericShelves', () => {
	// Chaptarr returns Goodreads shelves ALPHABETICALLY, and namesToGenres caps
	// at MAX_GENRES — which quietly made alphabetical order the selection rule.
	const ANNIHILATION = [
		'Adventure', 'Audiobook', 'Book Club', 'Dystopia', 'Fantasy', 'Fiction',
		'General', 'Horror', 'Literary Fiction', 'Literature & Fiction', 'Mystery',
		'Science fiction', 'Science Fiction & Fantasy', 'Sci-fi', 'Suspense',
		'Thriller', 'Weird fiction'
	]

	test('the defining genre survives the cap — the regression this fixes', () => {
		// Measured before the fix: "Fiction" and "Literature & Fiction" took two
		// of the eight slots and "Science fiction" was cut at the alphabetical
		// boundary, on a book that is literary science fiction.
		const names = genresFromWork(ANNIHILATION).map((g) => g.name.toLowerCase())
		expect(names.some((n) => n.includes('science fiction'))).toBe(true)
		expect(names).not.toContain('fiction')
		expect(names).not.toContain('literature & fiction')
	})

	test('umbrellas go last but are NOT dropped', () => {
		// "Fiction" is true and worth keeping when there is room; it just must
		// not outrank a genre that says something.
		expect(demoteGenericShelves(['Fiction', 'Dystopia', 'General', 'Horror'])).toEqual([
			'Dystopia',
			'Horror',
			'Fiction',
			'General'
		])
	})

	test('order WITHIN each group is left alone', () => {
		// A stable partition, not a sort: reordering the specific genres against
		// each other would invent a ranking this provider never supplied.
		expect(demoteGenericShelves(['Zebra', 'Apple', 'Fiction', 'Mango'])).toEqual([
			'Zebra',
			'Apple',
			'Mango',
			'Fiction'
		])
	})

	test('matching is post-clean and case-insensitive, like SHELF_NOISE', () => {
		const out = demoteGenericShelves(['  FICTION  ', 'Dystopia', 'Literature and Fiction'])
		expect(out[0]).toBe('Dystopia')
		expect(out).toHaveLength(3)
	})

	test('an all-generic list is untouched rather than emptied', () => {
		expect(demoteGenericShelves(['Fiction', 'General'])).toEqual(['Fiction', 'General'])
	})
})

import { beforeEach, describe, expect, test } from 'bun:test'

import { ApiGenreSchema } from '#config/types'
import {
	backfillChaptarrGenres,
	chaptarrGenreKey,
	chaptarrWorkIdFor,
	genresFromWork
} from '#helpers/providers/chaptarrGenres'

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
	test('drops shelf noise, folds aliases, dedupes, caps — the shared discipline', () => {
		const names = genresFromWork(LIVE_GENRES).map((g) => g.name)
		expect(names).not.toContain('Audiobook')
		expect(names).not.toContain('Book Club')
		expect(names).not.toContain('General')
		// Sci-fi folds into the already-present Science fiction (case-deduped).
		expect(names.filter((n) => n.toLowerCase().includes('science fiction')).length)
			.toBeLessThanOrEqual(2) // 'Science fiction' + 'Science Fiction & Fantasy'
		expect(names).toContain('Dystopia')
		expect(names.length).toBeLessThanOrEqual(8)
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
})

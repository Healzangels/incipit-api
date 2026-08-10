import { beforeEach, describe, expect, test } from 'bun:test'

import { ApiGenreSchema } from '#config/types'
import {
	backfillChaptarrGenres,
	chaptarrGenreKey,
	chaptarrGenresByTitle,
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

describe('a generic shelf produced BY A SPLIT is still demoted', () => {
	test('"Fiction" inside a joined shelf cannot outrank a specific genre', () => {
		// Measured live 2026-08-10 on the first forced refresh after the merge
		// shipped: "Fiction" landed ahead of "Space Opera" on Project Hail Mary
		// and ahead of "High Fantasy" on Fourth Wing, where the cap then dropped
		// the specific genre and kept the umbrella. Demotion fixed the ordering;
		// umbrellas are now dropped outright, so the split must not smuggle one
		// back in as a usable name.
		const out = genresFromWork([
			'Fiction / Fantasy / General',
			'High Fantasy',
			'Space Opera'
		]).map((g) => g.name)
		expect(out).toEqual(['Fantasy', 'High Fantasy', 'Space Opera'])
	})

	test('the specific genres inside a joined shelf keep their place', () => {
		// Splitting early must not cost the useful halves their position.
		const out = genresFromWork(['Fiction / Fantasy', 'Horror']).map((g) => g.name)
		expect(out).toEqual(['Fantasy', 'Horror'])
	})
})

describe('genresFromWork', () => {
	test('drops shelf noise, dedupes, caps — the shared discipline', () => {
		const names = genresFromWork(LIVE_GENRES).map((g) => g.name)
		expect(names).not.toContain('Audiobook')
		expect(names).not.toContain('Book Club')
		expect(names).not.toContain('General')
		expect(names).toContain('Dystopian')
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
		expect(names).toEqual(['Science Fiction', 'Dystopian'])
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

describe('umbrella shelves are dropped', () => {
	// Chaptarr returns Goodreads shelves ALPHABETICALLY, and namesToGenres caps
	// at MAX_GENRES — which quietly made alphabetical order the selection rule.
	// Umbrellas were demoted first; that fixed the ordering but still let them
	// occupy slots on books with few community genres, so they are now dropped.
	// demoteGenericShelves went with the change: one rule, in namesToGenres.
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

	test('an umbrella never reaches the output at all', () => {
		const out = genresFromWork(['Fiction', 'Dystopia', 'General', 'Horror']).map((g) => g.name)
		expect(out).toEqual(['Dystopian', 'Horror'])
	})

	test('order among the real genres is left alone', () => {
		// Dropping must not reorder what remains: the provider's sequence is the
		// only ranking there is, and inventing another would lose information.
		const out = genresFromWork(['Zebra', 'Apple', 'Fiction', 'Mango']).map((g) => g.name)
		expect(out).toEqual(['Zebra', 'Apple', 'Mango'])
	})
})

describe('chaptarrGenresByTitle — the last-resort rescue', () => {
	/**
	 * WHY IT EXISTS. Measured on the live library 2026-08-10: 94 of 1,607 albums
	 * carried NO genres at all, and 63 were pinned to `openlibrary-works-…` or
	 * `overdrive-…` editions. chaptarrWorkIdFor maps only az: and hc:, so those
	 * books could never reach the work route — and Audible has no record for them
	 * either, so every source was mute. Their records carry a title and an author
	 * and nothing else (no asin, no isbn — checked), which is why the /match
	 * endpoint is the only handle left.
	 */
	let redis: FakeRedis
	beforeEach(() => {
		redis = new FakeRedis()
	})

	const WORK = { work: { genres: ['Fantasy', 'Adventure', 'Magic'] } }
	const rescue = (over: Record<string, unknown> = {}) =>
		chaptarrGenresByTitle({
			title: 'Castle Roogna',
			author: 'Piers Anthony',
			redis: redis as never,
			matchFetch: async () => [
				{ work_id: 'hc:123645', work_title: 'Castle Roogna', author: 'Piers Anthony' }
			],
			workFetch: async () => WORK,
			...over
		} as never)

	test('a confirmed match yields its genres', async () => {
		// The real shape: /match answered exactly this for Castle Roogna.
		const out = await rescue()
		expect(out.map((g) => g.name)).toEqual(['Fantasy', 'Adventure', 'Magic'])
	})

	test('a SUBTITLED work title still confirms — the reason titleSim is used', async () => {
		// Chaptarr carries the series qualifier the record omits. An exact fold
		// rejected 17 of 65 probed books, nearly all of them this case; titleSim
		// took the yield from 38 to 45 without admitting a wrong book.
		for (const wt of ['Night Mare :Xanth 6', 'Night Mare (Xanth #6)', 'Night Mare: A Novel']) {
			const out = await rescue({
				title: 'Night Mare',
				matchFetch: async () => [{ work_id: 'hc:1', work_title: wt, author: 'Piers Anthony' }]
			})
			expect(out.length).toBeGreaterThan(0)
		}
	})

	test('A WRONG TITLE is refused', async () => {
		// A title query matches far too many books to accept on faith. Attaching
		// another book's genres is silent and permanent.
		expect(
			await rescue({
				matchFetch: async () => [
					{ work_id: 'hc:9', work_title: 'A Spell for Chameleon', author: 'Piers Anthony' }
				]
			})
		).toEqual([])
	})

	test('A WRONG AUTHOR is refused, even when the title is exact', async () => {
		// SEPARATE TEST, AND A SEPARATE REDIS, on purpose. Both assertions used to
		// live in one test sharing `redis`, and the cache key is derived from
		// title+author — so the second call read the first call's cached [] and
		// the author branch was never executed. Mutation testing caught it:
		// replacing the author check with `true` left the suite green.
		redis = new FakeRedis()
		const out = await rescue({
			matchFetch: async () => [
				{ work_id: 'hc:9', work_title: 'Castle Roogna', author: 'Terry Pratchett' }
			]
		})
		expect(out).toEqual([])
	})

	test('no match, no work id, and a thrown fetch all serve []', async () => {
		expect(await rescue({ matchFetch: async () => [] })).toEqual([])
		expect(
			await rescue({
				matchFetch: async () => [{ work_title: 'Castle Roogna', author: 'Piers Anthony' }]
			})
		).toEqual([])
		expect(
			await rescue({
				matchFetch: async () => {
					throw new Error('down')
				}
			})
		).toEqual([])
	})

	test('a title-only or author-only record never even asks', async () => {
		// Both halves are required for the confirmation, so a record missing one
		// cannot be rescued and must not spend a request finding that out.
		const calls: string[] = []
		const spy = async (q: string) => {
			calls.push(q)
			return []
		}
		expect(await rescue({ author: '', matchFetch: spy })).toEqual([])
		expect(await rescue({ title: '', matchFetch: spy })).toEqual([])
		expect(calls).toEqual([])
	})

	test('the answer is cached, including the empty one', async () => {
		let asked = 0
		const counting = async () => {
			asked++
			return [{ work_id: 'hc:9', work_title: 'Something Else', author: 'Nobody' }]
		}
		await rescue({ matchFetch: counting })
		await rescue({ matchFetch: counting })
		expect(asked).toBe(1)
		expect(redis.writes[0]?.ttl).toBe(604800)
	})

	test('no redis means no compute — nowhere to record the answer', async () => {
		const calls: string[] = []
		const spy = async (q: string) => {
			calls.push(q)
			return []
		}
		expect(await rescue({ redis: null, matchFetch: spy })).toEqual([])
		expect(calls).toEqual([])
	})
})

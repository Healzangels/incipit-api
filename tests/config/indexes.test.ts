import { describe, expect, test } from 'bun:test'

import { ensureIndexes, REQUIRED_INDEXES } from '#config/indexes'

/**
 * The index list is data so its SAFETY property can be asserted.
 *
 * A unique index over a collection that already holds duplicate {asin, region}
 * pairs fails to build, `initialize()` rejects inside startServer's try, and the
 * catch calls process.exit(1) — a boot crash-loop. Duplicates are known to exist
 * here: the papr helpers do read-then-insert with no upsert, and Plex fires one
 * lookup per TRACK, so a 27-part book issues 27 near-simultaneous first-touches
 * of the same ASIN. De-duplicating is a separate deliberate migration.
 */
describe('REQUIRED_INDEXES', () => {
	test('covers the lookup every /books/:asin request makes', () => {
		const books = REQUIRED_INDEXES.find(
			(i) => i.collection === 'books' && i.keys.asin === 1 && i.keys.region === 1
		)
		expect(books).toBeDefined()
	})

	test('keeps the authors $text index the author search needs', () => {
		const text = REQUIRED_INDEXES.find((i) => i.collection === 'authors' && i.keys.name === 'text')
		expect(text).toBeDefined()
	})

	test('NONE is unique — a unique build over existing duplicates crash-loops boot', () => {
		expect(REQUIRED_INDEXES.filter((i) => i.unique !== false)).toEqual([])
	})

	test('every spec says why it exists', () => {
		for (const spec of REQUIRED_INDEXES) expect(spec.why.length).toBeGreaterThan(20)
	})
})

describe('ensureIndexes', () => {
	const fakeDb = (onCreate: (collection: string, keys: unknown) => void | Promise<void>) =>
		({
			collection: (name: string) => ({
				createIndex: async (keys: unknown) => onCreate(name, keys)
			})
		}) as never

	test('creates every declared index', async () => {
		const made: string[] = []
		await ensureIndexes(fakeDb((c, k) => void made.push(`${c}:${JSON.stringify(k)}`)))
		expect(made.length).toBe(REQUIRED_INDEXES.length)
		expect(made.some((m) => m.startsWith('books:') && m.includes('asin'))).toBe(true)
	})

	test('a failed index build is logged, not thrown — a slow API beats a dead one', async () => {
		const warnings: string[] = []
		await expect(
			ensureIndexes(
				fakeDb(() => {
					throw new Error('index build failed')
				}),
				{ warn: (m) => void warnings.push(m) }
			)
		).resolves.toBeUndefined()
		expect(warnings.length).toBe(REQUIRED_INDEXES.length)
		expect(warnings[0]).toContain('index build failed')
	})
})

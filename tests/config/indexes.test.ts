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
})

describe('ensureIndexes', () => {
	const fakeDb = (onCreate: (collection: string, args: unknown[]) => void | Promise<void>) =>
		({
			collection: (name: string) => ({
				createIndex: async (...args: unknown[]) => onCreate(name, args)
			})
		}) as never

	test('creates every declared index', async () => {
		const made: string[] = []
		await ensureIndexes(fakeDb((c, a) => void made.push(`${c}:${JSON.stringify(a[0])}`)))
		expect(made.length).toBe(REQUIRED_INDEXES.length)
		expect(made.some((m) => m.startsWith('books:') && m.includes('asin'))).toBe(true)
	})

	test('NONE can be unique — createIndex is called with keys ONLY, no options', () => {
		// Asserted where it is actually DECIDED. The old version of this test
		// filtered the spec list for `unique !== false` against a field typed
		// `false`, which is statically empty — it could never fail, and it
		// constrained nothing about the call that builds the index.
		const calls: unknown[][] = []
		return ensureIndexes(fakeDb((_c, a) => void calls.push(a))).then(() => {
			expect(calls.length).toBe(REQUIRED_INDEXES.length)
			for (const args of calls) expect(args.length).toBe(1)
		})
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

	test('one failure does not skip the others', async () => {
		// The specs are built in parallel with a per-spec catch; a rejection in
		// one must not abort the rest.
		const made: string[] = []
		const warnings: string[] = []
		await ensureIndexes(
			fakeDb((c) => {
				if (c === 'books') throw new Error('index build failed')
				made.push(c)
			}),
			{ warn: (m) => void warnings.push(m) }
		)
		expect(made.length).toBe(REQUIRED_INDEXES.length - 1)
		expect(warnings.length).toBe(1)
	})

	test('a failure with NO logger still says something — silence is the real defect', async () => {
		// Production called this with no logger at all, so `logger?.warn` was a
		// no-op: an index that failed to build produced no output at ANY level and
		// `/authors?name=` 500d forever with nothing to grep for.
		const original = console.warn
		const seen: unknown[] = []
		console.warn = (...args: unknown[]) => void seen.push(args.join(' '))
		try {
			await ensureIndexes(
				fakeDb(() => {
					throw new Error('index build failed')
				})
			)
		} finally {
			console.warn = original
		}
		expect(seen.length).toBe(REQUIRED_INDEXES.length)
		expect(String(seen[0])).toContain('index build failed')
	})
})

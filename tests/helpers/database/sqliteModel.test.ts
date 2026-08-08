import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, unlinkSync } from 'node:fs'

/**
 * SqliteModel semantics that the two-backend oracle cannot see.
 *
 * The oracle (tests-integration) proves substitution for the calls it makes;
 * these are the calls it does NOT make, and they run inside the ordinary gate
 * so a regression is caught before a deploy rather than by a live symptom.
 *
 * The `$currentDate`-only update is the one that bit: PaprAudibleAuthorHelper
 * .touchUpdatedAt sends `{ $currentDate: { updatedAt: true } }` with NO $set,
 * to mark an author whose re-scrape was byte-identical as freshly checked.
 * The adapter parsed the (empty) $set payload through the Api schema, which
 * requires asin+name, so it threw — touchUpdatedAt swallows the throw, so
 * updatedAt never advanced and the scheduler re-fetched every unchanged
 * author on every sweep, forever, hammering the ToS-sensitive Goodreads
 * mirror. Mongo executes the same call natively, so only sqlite diverged.
 */

const DB_PATH = '/tmp/incipit-sqlitemodel-test.db'

function wipe() {
	for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
		if (existsSync(f)) unlinkSync(f)
	}
}

// The seam is the model module itself, so the backend must be chosen before
// it is imported (the same rule the adapter header states).
process.env.DB_BACKEND = 'sqlite'
process.env.SQLITE_PATH = DB_PATH
wipe()
const { default: Author } = await import('#config/models/Author')

const ASIN = 'B0SQLTEST1'

beforeAll(async () => {
	await Author.insertOne({
		asin: ASIN,
		name: 'Sqlite Probe',
		region: 'us',
		description: 'A description.',
		image: 'https://example.invalid/a.jpg',
		genres: [],
		similar: [],
		createdAt: new Date(),
		updatedAt: new Date()
	} as never)
})

afterAll(() => {
	wipe()
})

describe('updateOne', () => {
	test('a $currentDate-only touch ADVANCES updatedAt instead of throwing', async () => {
		const before = (await Author.findOne({ asin: ASIN })) as unknown as { updatedAt: Date }
		// Rewind so the advance is unambiguous.
		await Author.updateOne({ asin: ASIN }, { $set: { updatedAt: new Date(2020, 0, 1) } } as never)
		const rewound = (await Author.findOne({ asin: ASIN })) as unknown as { updatedAt: Date }
		expect(rewound.updatedAt.getFullYear()).toBe(2020)

		await Author.updateOne({ asin: ASIN }, { $currentDate: { updatedAt: true } } as never)

		const after = (await Author.findOne({ asin: ASIN })) as unknown as { updatedAt: Date }
		expect(after.updatedAt.getTime()).toBeGreaterThan(rewound.updatedAt.getTime())
		expect(before).toBeTruthy()
	})

	test('the touch preserves every stored field — it is a timestamp, not a write', async () => {
		await Author.updateOne({ asin: ASIN }, { $currentDate: { updatedAt: true } } as never)
		const after = (await Author.findOne({ asin: ASIN })) as unknown as {
			name: string
			description: string
			image: string
		}
		expect(after.name).toBe('Sqlite Probe')
		expect(after.description).toBe('A description.')
		expect(after.image).toBe('https://example.invalid/a.jpg')
	})

	test('a real $set payload is STILL validated — the parse is skipped, not removed', async () => {
		// The guard the schema parse exists for: a payload that violates the
		// Api schema must be refused, or garbage reaches the stored doc.
		await expect(
			Author.updateOne({ asin: ASIN }, { $set: { name: 42 } } as never)
		).rejects.toThrow()
		const after = (await Author.findOne({ asin: ASIN })) as unknown as { name: string }
		expect(after.name).toBe('Sqlite Probe')
	})

	test('a valid $set still merges on top, leaving absent fields alone', async () => {
		await Author.updateOne({ asin: ASIN }, { $set: { description: 'Rewritten.' } } as never)
		const after = (await Author.findOne({ asin: ASIN })) as unknown as {
			name: string
			description: string
		}
		expect(after.description).toBe('Rewritten.')
		expect(after.name).toBe('Sqlite Probe')
	})
})

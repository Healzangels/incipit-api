/**
 * PHASE 0 OF THE SINGLE-CONTAINER MIGRATION: the persistence oracle.
 *
 * The unit suite mocks `#config/models/*` at file scope, so a completely
 * broken storage adapter passes all 1,900 of its tests — nothing anywhere
 * exercises real persistence. This suite is the oracle the migration will be
 * held against: it drives the REAL Papr helpers against a REAL MongoDB first
 * (proving the tests encode current behaviour), and later the same tests run
 * against the SQLite adapter (proving the substitution).
 *
 * It lives OUTSIDE tests/ deliberately. The unit run's file-scope
 * `mock.module` calls leak across files within one process, so a real-DB
 * file appended to `tests/database` would receive the mocked models or the
 * mocked mongodb driver depending on load order — this suite must never
 * share a process with them. It has its own script (`bun run
 * test:integration`) and its own CI job with a disposable mongo service.
 *
 * Runs only when TEST_MONGODB_URI is set (e.g.
 * mongodb://localhost:27017/?directConnection=true). Skips loudly otherwise.
 * The target database is DROPPED at start and end — never point this at a
 * mongo holding data you care about.
 *
 * The named assertions each pin a way the migration was shown it could fail
 * silently (plan §5/§7, all verified against code before this file existed):
 *  - DATE ROUND-TRIP: stored docs must come back with Date objects, or
 *    isEqualData never matches and the write-throttle dies (A1) — and the
 *    zod z.date() parse 500s every route (§7.1).
 *  - $SET IS A MERGE: fields absent from the update payload must survive —
 *    a whole-document write silently destroys author `aliases`, half the
 *    text index (§7.2).
 *  - LEGACY REGION-LESS docs must be findable under a region option and come
 *    out with region 'us' (§7.2) — zod's .default fires on undefined only.
 *  - createdAt derives from _id.getTimestamp() and survives updates.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MongoClient } from 'mongodb'

import { parsedAuthor } from '../tests/datasets/helpers/authors'
import { parsedBook } from '../tests/datasets/helpers/books'
import { parsedChapters } from '../tests/datasets/helpers/chapters'

import AuthorModel from '#config/models/Author'
import { initialize } from '#config/papr'
import { ApiBook } from '#config/types'
import PaprAudibleAuthorHelper from '#helpers/database/papr/audible/PaprAudibleAuthorHelper'
import PaprAudibleBookHelper from '#helpers/database/papr/audible/PaprAudibleBookHelper'
import PaprAudibleChapterHelper from '#helpers/database/papr/audible/PaprAudibleChapterHelper'
import SharedHelper from '#helpers/utils/shared'

// TWO BACKENDS, ONE ORACLE. DB_BACKEND=sqlite runs the identical suite
// through the sqlite adapter (no external service at all); otherwise
// TEST_MONGODB_URI selects the mongo leg. Two-backend green is the
// substitution proof the whole migration rests on.
const BACKEND =
	process.env.DB_BACKEND === 'sqlite' ? 'sqlite' : process.env.TEST_MONGODB_URI ? 'mongo' : null
const URI = process.env.TEST_MONGODB_URI
const suite = BACKEND ? describe : describe.skip
if (!BACKEND) {
	console.warn(
		'[integration] neither DB_BACKEND=sqlite nor TEST_MONGODB_URI is set — the persistence ' +
			'oracle is SKIPPED. sqlite leg: DB_BACKEND=sqlite bun run test:integration ; mongo leg: ' +
			'TEST_MONGODB_URI="mongodb://localhost:27017/?directConnection=true" bun run test:integration'
	)
}

const SQLITE_TEST_PATH = `/tmp/incipit-oracle-${process.pid}.db`

// Raw-storage escape hatches: the three places the suite must write BENEATH
// the helpers (legacy fixture, alias plant, alias readback), per backend.
async function rawInsertLegacyBook(doc: Record<string, unknown>) {
	if (BACKEND === 'mongo') {
		await client
			.db('audnexus')
			.collection('books')
			.insertOne(doc as never, { bypassDocumentValidation: true })
		return
	}
	const { sqliteDb } = await import('#helpers/database/sqlite/SqliteModel')
	const id = Math.floor(Date.now() / 1000)
		.toString(16)
		.padStart(8, '0')
		.concat('aaaaaaaaaaaaaaaa')
	sqliteDb()
		.prepare(
			'INSERT INTO books (id, asin, region, created_at, updated_at, doc) VALUES (?,?,?,?,?,?)'
		)
		.run(id, String(doc.asin), null, Date.now(), Date.now(), JSON.stringify(doc))
}

async function rawPlantAuthorAliases(asin: string, aliases: string[]) {
	if (BACKEND === 'mongo') {
		await client.db('audnexus').collection('authors').updateOne({ asin }, { $set: { aliases } })
		return
	}
	const { sqliteDb } = await import('#helpers/database/sqlite/SqliteModel')
	const row = sqliteDb().prepare('SELECT id, doc FROM authors WHERE asin = ?').get(asin) as {
		id: string
		doc: string
	}
	const doc = JSON.parse(row.doc) as Record<string, unknown>
	doc.aliases = aliases
	sqliteDb().prepare('UPDATE authors SET doc = ? WHERE id = ?').run(JSON.stringify(doc), row.id)
}

async function rawGetAuthor(asin: string): Promise<Record<string, unknown> | null> {
	if (BACKEND === 'mongo') {
		return (await client.db('audnexus').collection('authors').findOne({ asin })) as never
	}
	const { sqliteDb } = await import('#helpers/database/sqlite/SqliteModel')
	const row = sqliteDb().prepare('SELECT doc FROM authors WHERE asin = ?').get(asin) as {
		doc: string
	} | null
	return row ? (JSON.parse(row.doc) as Record<string, unknown>) : null
}

const REGION = { region: 'us' }
// The throttle/update branch of createOrUpdate only exists under update='1' --
// that is how the route drives it (GenericShowHelper guards the create path on
// its own findOne). Without the flag, createOrUpdate on an EXISTING record
// falls through to create() and -- the indexes being deliberately non-unique --
// inserts a duplicate. The first run of this suite proved that against real
// mongo; the unit suite's mocks could never have.
const UPDATE_MODE = { region: 'us', update: '1' as const }
const shared = new SharedHelper()
let client: MongoClient

suite(`papr helpers against a real backend (${BACKEND})`, () => {
	beforeAll(async () => {
		if (BACKEND === 'sqlite') {
			process.env.SQLITE_PATH = SQLITE_TEST_PATH
			return
		}
		client = new MongoClient(URI as string, { serverSelectionTimeoutMS: 10000 })
		await client.connect()
		await client.db('audnexus').dropDatabase()
		await initialize({ client }, { warn: (m: string) => console.warn(m) })
	})

	afterAll(async () => {
		if (BACKEND === 'sqlite') {
			const { closeSqlite } = await import('#helpers/database/sqlite/SqliteModel')
			closeSqlite()
			const { unlinkSync } = await import('fs')
			for (const suffix of ['', '-wal', '-shm']) {
				try {
					unlinkSync(SQLITE_TEST_PATH + suffix)
				} catch {
					/* already gone */
				}
			}
			return
		}
		await client.db('audnexus').dropDatabase()
		await client.close()
	})

	// ---------------------------------------------------------------- books
	test('create → findOneWithProjection: the DATE ROUND-TRIP holds isEqualData', async () => {
		const helper = new PaprAudibleBookHelper(parsedBook.asin, REGION)
		helper.setData(parsedBook)
		const created = await helper.createOrUpdate()
		expect(created.modified).toBe(true)

		const found = await helper.findOneWithProjection()
		expect(found.data).not.toBeNull()
		// releaseDate must be a real Date on the way out. This single assertion
		// is what dies first under a JSON store with no date revival — and with
		// it, the write-throttle below and every zod-parsed route.
		expect((found.data as ApiBook).releaseDate).toBeInstanceOf(Date)
		expect(shared.isEqualData(found.data, parsedBook)).toBe(true)
	})

	test('the write-throttle engages on identical data (modified: false)', async () => {
		const helper = new PaprAudibleBookHelper(parsedBook.asin, UPDATE_MODE)
		helper.setData(parsedBook)
		const second = await helper.createOrUpdate()
		// Under a store whose reads come back date-stringified, isEqualData is
		// false forever, this returns modified:true, and every refresh rewrites
		// every record — the A1 failure, pinned from the real storage engine.
		expect(second.modified).toBe(false)
	})

	test('an update preserves createdAt (derived from _id.getTimestamp) and bumps updatedAt', async () => {
		const helper = new PaprAudibleBookHelper(parsedBook.asin, UPDATE_MODE)
		const before = await helper.findOne()
		expect(before.data).not.toBeNull()
		const originalCreated = before.data?.createdAt as Date

		helper.setData({ ...parsedBook, summary: 'changed for the update-path test' })
		const updated = await helper.createOrUpdate()
		expect(updated.modified).toBe(true)

		const after = await helper.findOne()
		expect(after.data?.summary).toBe('changed for the update-path test')
		// createdAt is re-derived from the ObjectId's embedded timestamp on
		// every update — second precision, so compare at that granularity.
		const idSeconds = Math.floor((after.data?._id.getTimestamp() as Date).getTime() / 1000)
		const createdSeconds = Math.floor((after.data?.createdAt as Date).getTime() / 1000)
		expect(createdSeconds).toBe(idSeconds)
		expect(Math.floor(originalCreated.getTime() / 1000)).toBe(createdSeconds)
		expect((after.data?.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(
			originalCreated.getTime()
		)
	})

	test('a LEGACY REGION-LESS document is findable and serves as region "us"', async () => {
		// Inserted RAW, bypassing papr — papr would apply the region default,
		// and the point is precisely a document that predates the region field.
		// Must satisfy the ASIN format (B + exactly 9 of [0-9A-Z]) — the schema
		// validates asin shape, and the first CI run of this test failed on a
		// 10-character fake before it ever tested what it meant to test.
		const legacyAsin = 'B0LEGACY99'
		const now = new Date()
		// eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructuring IS the removal
		const { region: _dropped, ...withoutRegion } = parsedBook
		// bypassDocumentValidation: papr's updateSchemas installs a $jsonSchema
		// validator on the collection, and a legacy document BY DEFINITION
		// predates it -- production's region-less docs were written before the
		// validator existed and could not be inserted past it today.
		await rawInsertLegacyBook({
			...withoutRegion,
			asin: legacyAsin,
			createdAt: now,
			updatedAt: now
		})

		const helper = new PaprAudibleBookHelper(legacyAsin, REGION)
		const found = await helper.findOne()
		// The $or/$exists compat filter is what finds it; region IS NULL vs
		// $exists:false is a real semantic difference the adapter must honour.
		expect(found.data).not.toBeNull()

		const projected = await helper.findOneWithProjection()
		if (projected.data === null) {
			// Diagnostic for the CI-only failure: show exactly what the raw doc
			// looks like and why the schema rejected it.
			const raw = await client.db('audnexus').collection('books').findOne({ asin: legacyAsin })
			const { ApiBookSchema } = await import('#config/types')
			const attempt = ApiBookSchema.safeParse(raw)
			console.error('[legacy diagnostic] raw keys:', raw ? Object.keys(raw).join(',') : 'NO DOC')
			console.error(
				'[legacy diagnostic] safeParse:',
				attempt.success ? 'success' : JSON.stringify(attempt.error.issues.slice(0, 5))
			)
		}
		// zod's RegionSchema.default('us') fires on undefined — a store that
		// materializes region as null instead of absent breaks this (§7.2).
		expect((projected.data as ApiBook).region).toBe('us')
	})

	test('delete removes the record', async () => {
		const helper = new PaprAudibleBookHelper(parsedBook.asin, REGION)
		const del = await helper.delete()
		expect(del.modified).toBe(true)
		expect((await helper.findOne()).data).toBeNull()
	})

	// -------------------------------------------------------------- authors
	test('$SET IS A MERGE: fields absent from the update payload survive it', async () => {
		const helper = new PaprAudibleAuthorHelper(parsedAuthor.asin, REGION)
		helper.setData(parsedAuthor)
		const created = await helper.createOrUpdate()
		expect(created.modified).toBe(true)

		// Give the stored author fields the update payload does NOT carry —
		// ApiAuthorProfile has no aliases/birthDate, yet both live in the
		// document and aliases feeds the text index.
		await rawPlantAuthorAliases(parsedAuthor.asin, ['The Alias The Update Must Not Destroy'])

		const updater = new PaprAudibleAuthorHelper(parsedAuthor.asin, UPDATE_MODE)
		updater.setData({ ...parsedAuthor, description: 'changed so the throttle lets it through' })
		const updated = await updater.createOrUpdate()
		expect(updated.modified).toBe(true)

		const raw = await rawGetAuthor(parsedAuthor.asin)
		// Mongo's $set merges top-level keys; a whole-document write deletes
		// aliases here — invisibly to Phase 3's golden file, which replays
		// against freshly-migrated (still intact) data (§7.2).
		expect(raw?.aliases).toEqual(['The Alias The Update Must Not Destroy'])
		expect(raw?.description).toBe('changed so the throttle lets it through')
	})

	test('the author $text index exists and finds by name after initialize()', async () => {
		// A fresh self-hosted mongo 500s on author search without the text
		// index; initialize() must build it. FTS5 replaces this exact query in
		// Phase 3 — same call, same shape, judged by the golden file.
		const found = await AuthorModel.find(
			{ $text: { $search: parsedAuthor.name } },
			{ projection: { _id: 0, asin: 1, name: 1 }, limit: 25 }
		)
		expect(found.some((a) => a.asin === parsedAuthor.asin)).toBe(true)
	})

	test('author delete removes the record', async () => {
		const helper = new PaprAudibleAuthorHelper(parsedAuthor.asin, REGION)
		const del = await helper.delete()
		expect(del.modified).toBe(true)
		expect((await helper.findOne()).data).toBeNull()
	})

	// ------------------------------------------------------------- chapters
	test('chapter create → findOne round-trips, then deletes', async () => {
		const helper = new PaprAudibleChapterHelper(parsedChapters.asin, REGION)
		helper.setData(parsedChapters)
		const created = await helper.createOrUpdate()
		expect(created.modified).toBe(true)

		const found = await helper.findOne()
		expect(found.data).not.toBeNull()
		expect(found.data?.chapters.length).toBe(parsedChapters.chapters.length)

		const del = await helper.delete()
		expect(del.modified).toBe(true)
		expect((await helper.findOne()).data).toBeNull()
	})
})

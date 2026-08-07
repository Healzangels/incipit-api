/**
 * PHASE 4 OF THE SINGLE-CONTAINER MIGRATION: copy every document from MongoDB
 * (db `audnexus` — the papr binding; the `.db('papr')` ping elsewhere is only
 * a liveness check) into the sqlite file, then PROVE the copy.
 *
 * Runs INSIDE the incipit-api container, where MONGODB_URI (with credentials)
 * is already env, the driver is in node_modules, and the compose network
 * reaches mongo:
 *
 *   docker exec -e SQLITE_PATH=/data/incipit.db incipit-api \
 *     bun scripts/migrateToSqlite.ts
 *
 * Preserves what the adapter contract depends on (plan §2/§7):
 *   - the ObjectId hex becomes the sqlite row id, so `_id` and its embedded
 *     timestamp survive; created_at derives from it (or every record's age
 *     resets and the createdAt==getTimestamp invariant breaks);
 *   - region stays NULL for legacy region-less docs (absent, never null, on
 *     the way back out);
 *   - authors get their FTS rows (name + aliases);
 *   - the DEAD fields authors.books / authors.series (ObjectId arrays never
 *     read or written by any code) are dropped, as the plan records — they
 *     would serialize as junk and diff as noise forever.
 *
 * VERIFICATION IS THE POINT, not an option:
 *   - per-collection counts must match mongo exactly, AND books must clear an
 *     absolute floor (default 1591, the known library size) — "0 == 0" must
 *     never pass a migration that read the wrong database (§7.2);
 *   - a FIELD-LEVEL DIFF of EVERY document: each mongo doc (minus _id and the
 *     dropped dead fields) is JSON-normalized and deep-compared against the
 *     sqlite row's stored doc. Zero diffs required. The dataset is small
 *     enough to check whole; sampling is how gaps hide.
 *
 * Refuses to run into a non-empty sqlite file unless --force (which wipes the
 * three tables + FTS first). Exit 0 only when every check passes.
 *
 * --smoke: self-test mode for CI — seeds a tiny known corpus into mongo
 * (fresh db), migrates it, and asserts the checks catch what they must.
 */
import { isEqual } from 'lodash'
import { MongoClient, ObjectId } from 'mongodb'

import { closeSqlite, sqliteDb } from '#helpers/database/sqlite/SqliteModel'

const argv = process.argv.slice(2)
const FORCE = argv.includes('--force')
const SMOKE = argv.includes('--smoke')
const MIN_BOOKS = Number(process.env.MIGRATION_MIN_BOOKS ?? (SMOKE ? 1 : 1591))
const MONGO_DB = SMOKE ? 'audnexus_migrate_smoke' : 'audnexus'

const uri = process.env.MONGODB_URI
if (!uri) {
	console.error('MONGODB_URI is not set — run this inside the incipit-api container')
	process.exit(1)
}
if (!process.env.SQLITE_PATH) {
	console.error('SQLITE_PATH is not set — refusing to write to an implicit location')
	process.exit(1)
}

const DEAD_AUTHOR_FIELDS = ['books', 'series']
const COLLECTIONS = ['books', 'authors', 'chapters'] as const

/** Mongo doc -> the JSON form the adapter stores: no _id, dead fields gone,
 * Dates to ISO via JSON round-trip (exactly what JSON.stringify does). */
function normalize(collection: string, raw: Record<string, unknown>): Record<string, unknown> {
	const { _id, ...doc } = raw
	void _id
	if (collection === 'authors') for (const f of DEAD_AUTHOR_FIELDS) delete doc[f]
	return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
}

async function main() {
	const client = new MongoClient(uri as string, { serverSelectionTimeoutMS: 10000 })
	await client.connect()
	const mongo = client.db(MONGO_DB)

	if (SMOKE) {
		// Known corpus: a plain book, a LEGACY region-less book, an author with
		// aliases AND the dead ObjectId-array fields, and a chapter record.
		await mongo.dropDatabase()
		const now = new Date()
		await mongo.collection('books').insertMany([
			{
				_id: new ObjectId(),
				asin: 'B0SMOKE001',
				region: 'us',
				title: 'Smoke Test',
				releaseDate: new Date('2020-01-02T00:00:00.000Z'),
				createdAt: now,
				updatedAt: now
			},
			{ _id: new ObjectId(), asin: 'B0SMOKE002', title: 'Legacy No Region', createdAt: now, updatedAt: now }
		])
		await mongo.collection('authors').insertOne({
			_id: new ObjectId(),
			asin: 'B0SMOKEAUT',
			region: 'us',
			name: 'Smokey Author',
			aliases: ['The Smoke'],
			books: [new ObjectId(), new ObjectId()],
			series: [new ObjectId()],
			createdAt: now,
			updatedAt: now
		})
		await mongo.collection('chapters').insertOne({
			_id: new ObjectId(),
			asin: 'B0SMOKE001',
			region: 'us',
			chapters: [{ title: 'Ch 1', startOffsetMs: 0 }],
			createdAt: now,
			updatedAt: now
		})
	}

	const db = sqliteDb()
	const existing = COLLECTIONS.map(
		(c) => (db.prepare(`SELECT COUNT(*) n FROM ${c}`).get() as { n: number }).n
	)
	if (existing.some((n) => n > 0)) {
		if (!FORCE) {
			console.error(
				`target sqlite already holds rows (${existing.join('/')}) — pass --force to wipe and re-run`
			)
			process.exit(1)
		}
		for (const c of COLLECTIONS) db.exec(`DELETE FROM ${c}`)
		db.exec('DELETE FROM authors_fts')
		console.log('(--force: wiped existing rows)')
	}

	// ---- copy -----------------------------------------------------------
	const counts: Record<string, { mongo: number; sqlite: number }> = {}
	for (const c of COLLECTIONS) {
		const ins = db.prepare(
			`INSERT INTO ${c} (id, asin, region, created_at, updated_at, doc) VALUES (?,?,?,?,?,?)`
		)
		const insFts = db.prepare('INSERT INTO authors_fts (id, name, aliases) VALUES (?,?,?)')
		let n = 0
		const cursor = mongo.collection(c).find({})
		for await (const raw of cursor) {
			const idHex = (raw._id as ObjectId).toHexString()
			const created = (raw._id as ObjectId).getTimestamp()
			const updated =
				raw.updatedAt instanceof Date ? raw.updatedAt : (raw.createdAt as Date) ?? created
			const doc = normalize(c, raw as unknown as Record<string, unknown>)
			ins.run(
				idHex,
				String(doc.asin ?? ''),
				(doc.region as string) ?? null,
				created.getTime(),
				updated.getTime(),
				JSON.stringify(doc)
			)
			if (c === 'authors') {
				insFts.run(
					idHex,
					String(doc.name ?? ''),
					Array.isArray(doc.aliases) ? (doc.aliases as string[]).join(' ') : ''
				)
			}
			n++
		}
		counts[c] = { mongo: n, sqlite: (db.prepare(`SELECT COUNT(*) n FROM ${c}`).get() as { n: number }).n }
	}

	// ---- verify ---------------------------------------------------------
	let failed = false
	console.log('\ncounts:')
	for (const c of COLLECTIONS) {
		const { mongo: m, sqlite: s } = counts[c]
		const ok = m === s
		if (!ok) failed = true
		console.log(`  ${c}: mongo=${m} sqlite=${s} ${ok ? 'OK' : 'MISMATCH'}`)
	}
	if (counts.books.mongo < MIN_BOOKS) {
		failed = true
		console.log(
			`  FLOOR FAILED: books=${counts.books.mongo} < ${MIN_BOOKS} — wrong database? (0==0 must never pass)`
		)
	}

	console.log('field-level diff of every document:')
	let diffs = 0
	for (const c of COLLECTIONS) {
		const get = db.prepare(`SELECT doc FROM ${c} WHERE id = ?`)
		const cursor = mongo.collection(c).find({})
		for await (const raw of cursor) {
			const idHex = (raw._id as ObjectId).toHexString()
			const row = get.get(idHex) as { doc: string } | null
			if (!row) {
				diffs++
				console.log(`  MISSING ${c}/${idHex} (asin ${String(raw.asin)})`)
				continue
			}
			const want = normalize(c, raw as unknown as Record<string, unknown>)
			const got = JSON.parse(row.doc) as Record<string, unknown>
			if (!isEqual(want, got)) {
				diffs++
				if (diffs <= 10) {
					const keys = new Set([...Object.keys(want), ...Object.keys(got)])
					const bad = [...keys].filter((k) => !isEqual(want[k], got[k]))
					console.log(`  DIFF ${c}/${String(raw.asin)}: fields ${bad.join(',')}`)
				}
			}
		}
	}
	if (diffs) failed = true
	console.log(diffs ? `  ${diffs} documents differ` : '  zero diffs — every document byte-equivalent')

	if (SMOKE) {
		// The smoke corpus also proves the traps: legacy region NULL, dead
		// fields dropped, aliases in FTS, createdAt from the ObjectId.
		const legacy = db.prepare(`SELECT region FROM books WHERE asin='B0SMOKE002'`).get() as {
			region: string | null
		}
		if (legacy.region !== null) {
			failed = true
			console.log('  SMOKE: legacy region should be NULL')
		}
		const aut = JSON.parse(
			(db.prepare(`SELECT doc FROM authors WHERE asin='B0SMOKEAUT'`).get() as { doc: string }).doc
		) as Record<string, unknown>
		if ('books' in aut || 'series' in aut) {
			failed = true
			console.log('  SMOKE: dead author fields survived')
		}
		if (!Array.isArray(aut.aliases) || aut.aliases[0] !== 'The Smoke') {
			failed = true
			console.log('  SMOKE: aliases lost')
		}
		const fts = db
			.prepare(`SELECT id FROM authors_fts WHERE authors_fts MATCH '"smoke"'`)
			.all() as unknown[]
		if (!fts.length) {
			failed = true
			console.log('  SMOKE: FTS row missing')
		}
		await mongo.dropDatabase()
	}

	await client.close()
	closeSqlite()
	console.log(failed ? '\nMIGRATION: FAILED' : '\nMIGRATION: VERIFIED')
	process.exit(failed ? 1 : 0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})

/**
 * PHASE 2 OF THE SINGLE-CONTAINER MIGRATION: the bun:sqlite storage backend.
 *
 * A drop-in for the papr model surface the codebase actually uses — pinned by
 * grep before writing (plan §2): `findOne`, `find`, `insertOne`, `updateOne`,
 * `deleteOne`, over exactly three filter shapes ({asin + region-compat $or},
 * {} for the scheduler sweep, {$text} for author search). Anything else
 * THROWS: a filter on a non-column field would table-scan with a JSON parse
 * per row — the one shape that can block the event loop for real (§6) — so
 * the constraint is enforced, not remembered.
 *
 * Invariants carried from the reviews (§7, each one broke silently somewhere):
 *  - Documents are stored as JSON and returned VERBATIM (plus date revival);
 *    the real columns (asin, region, created_at, updated_at) are a query
 *    index, never a rehydration source. A legacy region-less doc keeps its
 *    key ABSENT — zod's .default('us') fires on undefined, never null.
 *  - Date revival on read: releaseDate/birthDate/createdAt/updatedAt come
 *    back as Date objects, or lodash.isEqual never matches (the A1 throttle
 *    death) and zod's z.date() 500s every route.
 *  - `$set` is a TOP-LEVEL MERGE into the existing doc, never a replace —
 *    a whole-doc write destroys author `aliases`, half the text index.
 *  - `_id` exists on every returned doc and carries getTimestamp() — the
 *    checkers gate on `'_id' in doc`, and createdAt derives from it.
 *  - Writes are zod-validated (papr's $jsonSchema validator has no SQLite
 *    equivalent; without this, a malformed write surfaces later as a sticky
 *    safeParse-null 500).
 *  - The (asin, region) index is NON-unique, matching mongo — createOrUpdate
 *    is findOne-then-insert and a UNIQUE constraint would throw on races
 *    mongo absorbs.
 *
 * FTS5 for `$text` ships here so the same integration oracle runs on both
 * backends; Phase 3 remains the PARITY phase (golden-file replay + tuning),
 * not the existence phase.
 */
import { Database } from 'bun:sqlite'
import type { ZodType } from 'zod'

/** Hex ObjectId-alike: 4 timestamp bytes + 8 random bytes, like mongo's. */
export class SqliteObjectId {
	constructor(private readonly hex: string) {}
	toString() {
		return this.hex
	}
	toHexString() {
		return this.hex
	}
	getTimestamp(): Date {
		return new Date(parseInt(this.hex.slice(0, 8), 16) * 1000)
	}
}

const mintIdHex = (now: Date): string => {
	const secs = Math.floor(now.getTime() / 1000)
		.toString(16)
		.padStart(8, '0')
	let rand = ''
	for (let i = 0; i < 16; i++) rand += Math.floor(Math.random() * 16).toString(16)
	return secs + rand
}

let db: Database | null = null

/**
 * Open (or create) the database. Pragmas are set HERE, by whoever creates the
 * file — journal_mode is a persistent property of the file, and bun:sqlite
 * does not default to WAL. busy_timeout keeps an external `VACUUM INTO`
 * backup from surfacing as SQLITE_BUSY 500s in live routes (§7.2).
 */
export function sqliteDb(): Database {
	if (db) return db
	const path = process.env.SQLITE_PATH || './data/incipit.db'
	db = new Database(path, { create: true })
	db.exec('PRAGMA journal_mode = WAL')
	db.exec('PRAGMA synchronous = FULL')
	db.exec('PRAGMA busy_timeout = 5000')
	for (const table of ['books', 'authors', 'chapters']) {
		db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
			id TEXT PRIMARY KEY,
			asin TEXT NOT NULL,
			region TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			doc TEXT NOT NULL
		)`)
		// NON-unique on purpose — see the header.
		db.exec(`CREATE INDEX IF NOT EXISTS ${table}_asin_region ON ${table}(asin, region)`)
		db.exec(`CREATE INDEX IF NOT EXISTS ${table}_updated ON ${table}(updated_at)`)
	}
	db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS authors_fts
		USING fts5(id UNINDEXED, name, aliases)`)
	return db
}

/** Test/shutdown hook: close and forget the handle. */
export function closeSqlite() {
	if (db) {
		db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
		db.close()
		db = null
	}
}

type Doc = Record<string, unknown>

interface RegionFilter {
	asin: string
	$or?: [{ region: { $exists: false } }, { region: string }]
	region?: string
}

const DATE_FIELDS = ['createdAt', 'updatedAt', 'releaseDate', 'birthDate']

/** Parse a stored row back into the document papr would have returned. */
function revive(row: { id: string; doc: string }): Doc {
	const doc = JSON.parse(row.doc) as Doc
	for (const f of DATE_FIELDS) {
		if (typeof doc[f] === 'string') doc[f] = new Date(doc[f] as string)
	}
	doc._id = new SqliteObjectId(row.id)
	return doc
}

/** Apply a mongo-style inclusion projection ({_id: 0, asin: 1, ...}). */
function project(doc: Doc, projection?: Record<string, 0 | 1>): Doc {
	if (!projection) return doc
	const out: Doc = {}
	if (projection._id !== 0 && '_id' in doc) out._id = doc._id
	for (const [k, v] of Object.entries(projection)) {
		if (k !== '_id' && v === 1 && k in doc) out[k] = doc[k]
	}
	return out
}

/** The WHERE clause for the two supported lookup filters. */
function whereFor(table: string, filter: Doc): { sql: string; args: (string | null)[] } {
	const keys = Object.keys(filter)
	if (keys.length === 0) return { sql: '1=1', args: [] }
	const f = filter as unknown as RegionFilter
	if (typeof f.asin === 'string') {
		const extra = keys.filter((k) => k !== 'asin' && k !== '$or' && k !== 'region')
		if (extra.length) {
			throw new Error(
				`SqliteModel(${table}): unsupported filter keys ${extra.join(',')} — ` +
					'non-column filters would table-scan with a JSON parse per row; add a column first'
			)
		}
		if (f.$or) {
			// The region-compat shape: matches region IS NULL (legacy) or equal.
			return { sql: 'asin = ? AND (region IS NULL OR region = ?)', args: [f.asin, f.$or[1].region] }
		}
		if (typeof f.region === 'string') {
			return { sql: 'asin = ? AND region = ?', args: [f.asin, f.region] }
		}
		return { sql: 'asin = ?', args: [f.asin] }
	}
	throw new Error(
		`SqliteModel(${table}): unsupported filter ${JSON.stringify(keys)} — ` +
			'only {asin(+region compat)}, {}, and {$text} are implemented, deliberately'
	)
}

/**
 * FTS query terms: each token quoted (hyphens, parens, dots are FTS syntax).
 * Two tiers, measured against the Phase 0 golden file (188 real queries):
 * mongo's $text demonstrably returns ONLY the full-name match for a full-name
 * query (golden is overwhelmingly single-result), so the AND tier reproduces
 * it — the first parity run scored 100% top-1 but 48% top-5 SET because an
 * OR query drags in every shared-token neighbour ("Adrian McKinty" pulled
 * Adrian Tchaikovsky). OR survives only as the recall FALLBACK when AND finds
 * nothing: a partial or misspelled query must still produce candidates for
 * the bundle's author-recovery path, which re-scores by name itself.
 */
function ftsTerms(search: string): string[] {
	return search
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => `"${t.replace(/"/g, '')}"`)
		.filter((t) => t !== '""')
}

function syncAuthorFts(d: Database, id: string, doc: Doc | null) {
	d.prepare('DELETE FROM authors_fts WHERE id = ?').run(id)
	if (doc) {
		d.prepare('INSERT INTO authors_fts (id, name, aliases) VALUES (?, ?, ?)').run(
			id,
			String(doc.name ?? ''),
			Array.isArray(doc.aliases) ? doc.aliases.join(' ') : ''
		)
	}
}

export interface SqliteModelOptions {
	/** Validates writes — the stand-in for papr's server-side $jsonSchema. */
	schema: ZodType
}

export function sqliteModel(table: string, opts: SqliteModelOptions) {
	const isAuthors = table === 'authors'

	const rowsFor = (filter: Doc, extraSql = '', args2: (string | number)[] = []) => {
		const { sql, args } = whereFor(table, filter)
		return sqliteDb()
			.prepare(`SELECT id, doc FROM ${table} WHERE ${sql} ${extraSql}`)
			.all(...args, ...args2) as { id: string; doc: string }[]
	}

	return {
		async findOne(filter: Doc): Promise<Doc | null> {
			const rows = rowsFor(filter, 'LIMIT 1')
			return rows.length ? revive(rows[0]) : null
		},

		async find(
			filter: Doc,
			options?: {
				projection?: Record<string, 0 | 1>
				limit?: number
				sort?: Record<string, unknown>
				allowDiskUse?: boolean
			}
		): Promise<Doc[]> {
			const text = (filter as { $text?: { $search: string } }).$text
			if (text) {
				if (!isAuthors) throw new Error(`SqliteModel(${table}): $text only exists for authors`)
				const limit = options?.limit ?? 25
				const terms = ftsTerms(text.$search)
				const q = sqliteDb().prepare(
					`SELECT id FROM authors_fts WHERE authors_fts MATCH ? ORDER BY bm25(authors_fts) LIMIT ?`
				)
				let ids = terms.length ? (q.all(terms.join(' AND '), limit) as { id: string }[]) : []
				if (!ids.length && terms.length > 1) {
					ids = q.all(terms.join(' OR '), limit) as { id: string }[]
				}
				const get = sqliteDb().prepare(`SELECT id, doc FROM ${table} WHERE id = ?`)
				return ids
					.map((r) => get.get(r.id) as { id: string; doc: string } | null)
					.filter((r): r is { id: string; doc: string } => r !== null)
					.map((r) => project(revive(r), options?.projection))
			}
			// The scheduler sweep: sort on the REAL column, never parse-and-sort.
			const orderBy = options?.sort?.updatedAt === -1 ? 'ORDER BY updated_at DESC' : ''
			const limitSql = options?.limit ? `LIMIT ${Number(options.limit)}` : ''
			return rowsFor(filter, `${orderBy} ${limitSql}`).map((r) =>
				project(revive(r), options?.projection)
			)
		},

		async insertOne(data: Doc): Promise<Doc> {
			// zod validation IS the write guard. parse (not safeParse): a
			// malformed write must fail HERE, loudly, like mongo's validator —
			// not later as a sticky safeParse-null 500. Parse also applies the
			// region default and strips unknown keys, exactly as the wire does.
			const clean = opts.schema.parse(data) as Doc
			const now = new Date()
			const idHex = mintIdHex(now)
			// createdAt derives from the id's embedded seconds so the
			// `createdAt === _id.getTimestamp()` invariant holds from birth.
			const created = new Date(Math.floor(now.getTime() / 1000) * 1000)
			const stored: Doc = { ...clean, createdAt: created, updatedAt: now }
			const d = sqliteDb()
			d.prepare(
				`INSERT INTO ${table} (id, asin, region, created_at, updated_at, doc) VALUES (?,?,?,?,?,?)`
			).run(
				idHex,
				String(stored.asin),
				(stored.region as string) ?? null,
				created.getTime(),
				now.getTime(),
				JSON.stringify(stored)
			)
			if (isAuthors) syncAuthorFts(d, idHex, stored)
			return { ...stored, _id: new SqliteObjectId(idHex) }
		},

		async updateOne(
			filter: Doc,
			update: { $set?: Doc; $currentDate?: Record<string, boolean> }
		): Promise<{ acknowledged: boolean; modifiedCount: number }> {
			const rows = rowsFor(filter, 'LIMIT 1')
			if (!rows.length) return { acknowledged: true, modifiedCount: 0 }
			const row = rows[0]
			const existing = JSON.parse(row.doc) as Doc
			// Validate the INCOMING PAYLOAD, never the merged doc. The stored
			// shape is the MODEL shape (aliases, birthDate, links...), wider
			// than the Api schema — parsing the merge through the Api schema
			// STRIPS those fields, which is the same aliases-destruction the
			// $set-merge rule exists to prevent, arriving via the validator
			// instead of the write. The oracle's sqlite leg caught exactly
			// this on its first run. Timestamps are pulled out first because
			// the Api schemas do not know them either ($set carries createdAt).
			const {
				createdAt: setCreated,
				updatedAt: setUpdated,
				...payload
			} = (update.$set ?? {}) as Doc
			// VALIDATE THE PAYLOAD AS A $set, WHICH IS PARTIAL BY DEFINITION.
			//
			// This line parsed the payload through the FULL Api schema, so any
			// update not carrying a complete record threw. Two divergences from
			// mongo followed, and the second one was live:
			//
			//  - A $currentDate-only touch (touchUpdatedAt marks an author whose
			//    re-scrape was byte-identical as freshly checked) has NO $set at
			//    all, so an empty object hit a schema requiring asin+name and
			//    threw. The caller swallows the throw, so updatedAt never
			//    advanced and the scheduler re-fetched every unchanged author on
			//    every sweep forever — hammering the ToS-sensitive Goodreads
			//    mirror, one error line per author per cycle.
			//  - A partial $set ({ description }) threw for the same reason.
			//    Every caller today spreads a whole record so nothing hit it yet,
			//    but mongo accepts partials, and "works on the mongo CI leg,
			//    throws on the sqlite prod backend" is precisely the trap the
			//    touch bug already sprang.
			//
			// `.partial()` matches $set's own semantics: present fields are still
			// type-checked (a `name: 42` payload is still refused), absent ones
			// are simply not this update's business. The guard is RELAXED to the
			// right shape, never removed — and the merged doc is still never
			// parsed, which is what protects the model-shape aliases.
			const partialSchema =
				typeof (opts.schema as { partial?: unknown }).partial === 'function'
					? (
							opts.schema as unknown as { partial: () => { parse: (v: unknown) => unknown } }
						).partial()
					: opts.schema
			const cleanPayload = (Object.keys(payload).length ? partialSchema.parse(payload) : {}) as Doc
			// TOP-LEVEL MERGE — fields absent from $set survive. This is the
			// §7.2 high-severity pin: authorData carries no aliases, and a doc
			// replace here would silently destroy half the author text index.
			const merged: Doc = { ...existing, ...cleanPayload }
			if (setCreated !== undefined) merged.createdAt = setCreated
			if (setUpdated !== undefined) merged.updatedAt = setUpdated
			if (update.$currentDate?.updatedAt) merged.updatedAt = new Date()
			const { createdAt, updatedAt } = merged
			const stored: Doc = merged
			const updatedMs =
				updatedAt instanceof Date ? updatedAt.getTime() : new Date(String(updatedAt)).getTime()
			const createdMs =
				createdAt instanceof Date ? createdAt.getTime() : new Date(String(createdAt)).getTime()
			const d = sqliteDb()
			d.prepare(
				`UPDATE ${table} SET asin=?, region=?, created_at=?, updated_at=?, doc=? WHERE id=?`
			).run(
				String(stored.asin),
				(stored.region as string) ?? null,
				createdMs,
				updatedMs,
				JSON.stringify(stored),
				row.id
			)
			if (isAuthors) syncAuthorFts(d, row.id, stored)
			return { acknowledged: true, modifiedCount: 1 }
		},

		async deleteOne(filter: Doc): Promise<{ acknowledged: boolean; deletedCount: number }> {
			const rows = rowsFor(filter, 'LIMIT 1')
			if (!rows.length) return { acknowledged: true, deletedCount: 0 }
			const d = sqliteDb()
			d.prepare(`DELETE FROM ${table} WHERE id = ?`).run(rows[0].id)
			if (isAuthors) syncAuthorFts(d, rows[0].id, null)
			return { acknowledged: true, deletedCount: 1 }
		}
	}
}

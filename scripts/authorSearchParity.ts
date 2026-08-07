/**
 * PHASE 3 OF THE SINGLE-CONTAINER MIGRATION: replay the author-search golden
 * file against FTS5 and hold it to the plan's thresholds — top-1 identical for
 * ≥99% of queries, top-5 SET identical for ≥95% — before mongo's $text can be
 * replaced in anger.
 *
 * The corpus is the golden file's own result universe: every (asin, name) the
 * live mongo-backed API returned for any of the 188 real library-artist
 * queries. That is the honest recoverable corpus — the golden file does not
 * carry aliases or bios — and it biases the test HARDER, not easier: FTS5
 * must reproduce mongo's ranking using name text alone.
 *
 * Replays go through the REAL adapter (`sqliteModel('authors').find` with the
 * exact {$text}+projection+limit shape PaprAudibleAuthorHelper uses), not a
 * copy of its SQL, so a tuning change to the adapter is what this measures.
 * The route's collapse logic above the adapter is identical code on both
 * backends, so adapter-level parity on identical inputs is route-level parity.
 *
 * Usage:  bun scripts/authorSearchParity.ts [--golden <file>] [--show 15]
 */
import { unlinkSync } from 'fs'

import { ApiAuthorProfileSchema } from '#config/types'
import { closeSqlite, sqliteDb, sqliteModel } from '#helpers/database/sqlite/SqliteModel'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1] ?? '')
const GOLDEN = args.get('--golden') ?? 'tests-integration/golden/author-search-golden.json'
const SHOW = Number(args.get('--show') ?? 10)

interface GoldenEntry {
	query: string
	status: number
	results: { asin: string; name: string }[]
}
const golden = JSON.parse(await Bun.file(GOLDEN).text()) as { entries: GoldenEntry[] }

// Fresh throwaway db for the replay.
const DB = `/tmp/incipit-parity-${process.pid}.db`
process.env.SQLITE_PATH = DB

// ---- seed the corpus: union of all golden results, deduped by asin --------
const corpus = new Map<string, string>()
for (const e of golden.entries) for (const r of e.results) corpus.set(r.asin, r.name)

const d = sqliteDb()
const ins = d.prepare(
	'INSERT INTO authors (id, asin, region, created_at, updated_at, doc) VALUES (?,?,?,?,?,?)'
)
const insFts = d.prepare('INSERT INTO authors_fts (id, name, aliases) VALUES (?, ?, ?)')
let seq = 0
for (const [asin, name] of corpus) {
	const id = 'aaaaaaaa' + String(seq++).padStart(16, '0')
	const doc = { asin, name, region: 'us' }
	ins.run(id, asin, 'us', Date.now(), Date.now(), JSON.stringify(doc))
	insFts.run(id, name, '')
}
console.log(`seeded ${corpus.size} authors from the golden result universe`)

// ---- replay through the real adapter --------------------------------------
const AuthorModel = sqliteModel('authors', { schema: ApiAuthorProfileSchema })

let top1Hit = 0
let top1Total = 0
let top5Hit = 0
let top5Total = 0
let emptyAgree = 0
let emptyTotal = 0
const misses: string[] = []

for (const e of golden.entries) {
	const got = (await AuthorModel.find(
		{ $text: { $search: e.query } },
		{ projection: { _id: 0, asin: 1, name: 1, image: 1, description: 1 }, limit: 25 }
	)) as { asin: string; name: string }[]

	if (e.results.length === 0) {
		emptyTotal++
		if (got.length === 0) emptyAgree++
		else misses.push(`EMPTY-MISMATCH ${JSON.stringify(e.query)}: fts returned ${got.length}`)
		continue
	}

	top1Total++
	if (got[0]?.asin === e.results[0].asin) top1Hit++
	else
		misses.push(
			`TOP1 ${JSON.stringify(e.query)}: golden=${e.results[0].name} fts=${got[0]?.name ?? 'NOTHING'}`
		)

	top5Total++
	const g5 = new Set(e.results.slice(0, 5).map((r) => r.asin))
	const f5 = new Set(got.slice(0, 5).map((r) => r.asin))
	const setEqual = g5.size === f5.size && [...g5].every((a) => f5.has(a))
	if (setEqual) top5Hit++
	else if (got[0]?.asin === e.results[0].asin)
		misses.push(`TOP5 ${JSON.stringify(e.query)}: sets differ (top-1 agrees)`)
}

const pct = (n: number, t: number) => (t ? ((100 * n) / t).toFixed(1) : 'n/a')
console.log(`\ntop-1 identical:  ${top1Hit}/${top1Total}  (${pct(top1Hit, top1Total)}%)  need >=99%`)
console.log(`top-5 SET equal:  ${top5Hit}/${top5Total}  (${pct(top5Hit, top5Total)}%)  need >=95%`)
console.log(`empty agrees:     ${emptyAgree}/${emptyTotal}`)
for (const m of misses.slice(0, SHOW)) console.log('  ' + m)
if (misses.length > SHOW) console.log(`  ... and ${misses.length - SHOW} more`)

closeSqlite()
for (const s of ['', '-wal', '-shm'])
	try {
		unlinkSync(DB + s)
	} catch {
		/* gone */
	}

const pass = (top1Hit / Math.max(top1Total, 1)) * 100 >= 99 && (top5Hit / Math.max(top5Total, 1)) * 100 >= 95
console.log(pass ? '\nPARITY GATE: PASS' : '\nPARITY GATE: FAIL')
process.exit(pass ? 0 : 1)

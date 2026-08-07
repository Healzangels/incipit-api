/**
 * Capture (or re-capture) the author-search GOLDEN FILE — Phase 0/3 of the
 * single-container migration.
 *
 * Records, for every query name, the exact ordered result list the live API
 * serves today. Phase 3 replays this file against the FTS5 implementation and
 * holds it to the plan's thresholds (top-1 match ≥99% of queries, top-5 SET
 * match ≥95%) before mongo's $text can be replaced.
 *
 * Captured through the LIVE API's /authors endpoint on purpose, not a direct
 * mongo connection: the endpoint includes the route's own collapse logic
 * (empty stubs folding into populated records), which is the behaviour that
 * must survive — and a direct MongoClient from a workstation hangs on this
 * deployment's replica-set advertisement anyway (measured 2026-08-05).
 *
 * Usage:
 *   bun scripts/authorSearchGolden.ts --api http://10.0.1.99:3737 \
 *     --names /path/to/names.txt --out tests-integration/golden/author-search-golden.json
 *
 * names.txt: one author name per line, comments with #. The library's own
 * artist list is the right corpus — it is the exact search workload the agent
 * generates.
 */

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) {
	args.set(process.argv[i], process.argv[i + 1] ?? '')
}
const API = args.get('--api')
const NAMES = args.get('--names')
const OUT = args.get('--out') ?? 'tests-integration/golden/author-search-golden.json'

if (!API || !NAMES) {
	console.error('usage: bun scripts/authorSearchGolden.ts --api <url> --names <file> [--out <file>]')
	process.exit(1)
}

const names = (await Bun.file(NAMES).text())
	.split('\n')
	.map((l) => l.trim())
	.filter((l) => l && !l.startsWith('#'))

console.log(`capturing ${names.length} queries against ${API}`)

interface GoldenEntry {
	query: string
	status: number
	results: { asin: string; name: string }[]
}

const entries: GoldenEntry[] = []
for (const name of names) {
	const url = `${API}/authors?name=${encodeURIComponent(name)}&region=us`
	try {
		const res = await fetch(url)
		const body = res.ok ? ((await res.json()) as { asin: string; name: string }[]) : []
		entries.push({
			query: name,
			status: res.status,
			results: body.map((r) => ({ asin: r.asin, name: r.name }))
		})
		if (entries.length % 25 === 0) console.log(`  ${entries.length}/${names.length}`)
	} catch (err) {
		console.error(`  FAILED on ${JSON.stringify(name)}: ${err}`)
		entries.push({ query: name, status: 0, results: [] })
	}
	// Stay far under the API's own pacing; a golden capture must never be the
	// thing that rate-limits the box.
	await new Promise((r) => setTimeout(r, 150))
}

const failed = entries.filter((e) => e.status !== 200).length
const empty = entries.filter((e) => e.status === 200 && e.results.length === 0).length

const payload = {
	capturedAt: new Date().toISOString(),
	api: API,
	queryCount: entries.length,
	notes:
		'Ordered author-search results from the live API. Phase 3 replays these against FTS5: ' +
		'top-1 must match for >=99% of queries, the top-5 SET for >=95%. Recapture with ' +
		'scripts/authorSearchGolden.ts -- do not hand-edit.',
	entries
}

await Bun.write(OUT, JSON.stringify(payload, null, 1))
console.log(
	`wrote ${OUT}: ${entries.length} queries, ${failed} non-200, ${empty} empty result sets`
)

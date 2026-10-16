/**
 * Print what each served overlay entry will show in Plex, rendered by the API's
 * own serve step (applyBookOverlay) against the record the API serves today —
 * and, with --expect, hold it to the text the operator approved.
 *
 *   INCIPIT_API=http://10.0.1.99:3737 bun scripts/renderOverlay.ts \
 *     --file <overlay.json> [--records <dir>] [--expect <approved.txt>]
 *
 * --records <dir> reads `<dir>/<id>.json` instead of the API, so a parity run
 * and an A/B can share ONE capture. --expect compares each entry's body and
 * genres with an approved render (the research renderer's output format:
 * "===== <id>  <title>  [<kind>]  genres: a · b" then the body) and exits 1 on
 * any difference, printing each one.
 *
 * Read-only: one GET per entry, serially. Never a library sweep.
 */
import { applyBookOverlay, compileOverlay } from '#helpers/overlay/bookOverlay'

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(name)
	return i > 0 ? process.argv[i + 1] : undefined
}
const FILE = arg('--file') || process.env.BOOK_OVERLAY_PATH
const RECORDS = arg('--records')
const EXPECT = arg('--expect')
const API = process.env.INCIPIT_API || 'http://localhost:3737'
if (!FILE) {
	console.error('--file <overlay.json> (or BOOK_OVERLAY_PATH) is required')
	process.exit(2)
}

const compiled = compileOverlay(await Bun.file(FILE).json())
if (!compiled.ok) {
	console.error(`the load gate REFUSES ${FILE}:`)
	for (const e of compiled.errors) console.error(`  ${e}`)
	process.exit(2)
}
const table = compiled.table

type Rec = Record<string, unknown> & { title?: string; genres?: { name: string }[] }
const load = async (id: string): Promise<Rec | null> => {
	if (RECORDS) {
		const f = Bun.file(`${RECORDS}/${id}.json`)
		return (await f.exists()) ? ((await f.json()) as Rec) : null
	}
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const r = await fetch(`${API}/books/${id}?region=us`)
			if (r.ok) return (await r.json()) as Rec
		} catch {
			// retry below
		}
		await new Promise((r) => setTimeout(r, 500 * attempt))
	}
	return null
}

interface Block {
	title: string
	genres: string[]
	body: string
}
const rendered = new Map<string, Block>()
for (const [id, entry] of table.byId) {
	const rec = await load(id)
	if (!rec) {
		console.error(`${id}: no served record — cannot render`)
		continue
	}
	const out = applyBookOverlay(rec, rec, id, table) as Rec & { summary?: string }
	const block: Block = {
		title: String(rec.title ?? ''),
		genres: (out.genres ?? []).map((g) => g.name),
		body: String(out.summary ?? '')
	}
	rendered.set(id, block)
	console.log(
		`===== ${id}  ${block.title}  [${entry.work.kind ?? 'pilot'}]  genres: ${block.genres.join(' · ')}`
	)
	console.log(block.body)
	console.log()
}

if (!EXPECT) process.exit(0)

const expected = new Map<string, Block>()
let current: { id: string; block: Block; lines: string[] } | null = null
const flush = () => {
	if (current) {
		current.block.body = current.lines.join('\n').replace(/\s+$/, '')
		expected.set(current.id, current.block)
	}
}
for (const line of (await Bun.file(EXPECT).text()).split('\n')) {
	const head = /^===== (\S+)\s+(.*?)\s+\[[^\]]*\]\s+genres: (.*)$/.exec(line)
	if (head) {
		flush()
		current = {
			id: head[1],
			block: { title: head[2], genres: head[3].split(' · '), body: '' },
			lines: []
		}
	} else if (current) current.lines.push(line)
}
flush()

let differences = 0
console.log(`\n--- parity against ${EXPECT}`)
for (const [id, want] of expected) {
	const got = rendered.get(id)
	if (!got) {
		differences += 1
		console.log(`${id}: approved, but not rendered (not served by this file, or no record)`)
		continue
	}
	if (got.genres.join('|') !== want.genres.join('|')) {
		differences += 1
		console.log(
			`${id}: genres differ\n  - ${want.genres.join(' · ')}\n  + ${got.genres.join(' · ')}`
		)
	}
	if (got.body !== want.body) {
		differences += 1
		const a = want.body.split('\n')
		const b = got.body.split('\n')
		console.log(`${id}: body differs`)
		for (let i = 0; i < Math.max(a.length, b.length); i += 1)
			if (a[i] !== b[i])
				console.log(`  line ${i + 1}\n  - ${a[i] ?? '(none)'}\n  + ${b[i] ?? '(none)'}`)
	}
}
for (const id of rendered.keys())
	if (!expected.has(id)) {
		differences += 1
		console.log(`${id}: rendered, but absent from the approved text`)
	}
console.log(`${expected.size} approved, ${rendered.size} rendered, ${differences} difference(s)`)
process.exit(differences ? 1 : 0)

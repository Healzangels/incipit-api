/**
 * Monthly reviewed sweep — the drift ledger (Phase 5 of the redesign plan).
 *
 * The ledger (tests/fixtures/series-ledger.json) records, per record id, the
 * answer that was SERVING when the operator last reviewed. The sweep re-reads
 * current serving (warm, through pins + shelf policy — exactly what Plex
 * consumes) and diffs:
 *
 *   NEW      first-seen record -> auto-baselined into the ledger. This is the
 *            fresh-adds rule: a book added next month is captured on the first
 *            sweep after it appears and can never drift invisibly afterwards.
 *   CHANGED  serving differs from the reviewed baseline -> the review queue.
 *            Approve by re-running with --accept; reject by pinning the old
 *            answer (corpus + mintPins) and re-sweeping.
 *   GONE     in the ledger but in no library any more (informational).
 *
 * Covers the UNION of both boxes' record sets (test section 56 + prod
 * section 6), so prod-only records are first-class. Read-only against Plex
 * and the api; the only thing it writes is the ledger, and only on --init or
 * --accept.
 *
 *   bun scripts/seriesSweep.ts --init      # first baseline (today's reviewed state)
 *   bun scripts/seriesSweep.ts             # diff; exit 1 when a review is due
 *   bun scripts/seriesSweep.ts --accept    # fold NEW+CHANGED into the ledger
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const LEDGER = join(import.meta.dir, '..', 'tests', 'fixtures', 'series-ledger.json')
const TOKEN = process.env.PLEX_TOKEN
const API = process.env.INCIPIT_API_URL
if (!TOKEN || !API) {
	console.error('PLEX_TOKEN and INCIPIT_API_URL must be set.')
	process.exit(2)
}
const BOXES = [
	{ host: '10.0.1.99', section: '56', name: 'test' },
	{ host: '10.0.1.98', section: '6', name: 'prod' }
]

interface Answer {
	primary: string | null
	secondary: string | null
}
interface LedgerEntry extends Answer {
	firstSeen: string
	reviewedAt: string
	boxes: string[]
}

const show = (s: { name?: string; position?: string | null } | null | undefined): string | null =>
	s?.name ? `${s.name} #${s.position ?? '-'}` : null

async function libraryRecords(): Promise<Map<string, Set<string>>> {
	const ids = new Map<string, Set<string>>()
	for (const box of BOXES) {
		const url = `http://${box.host}:32400/library/sections/${box.section}/all?type=9&X-Plex-Token=${TOKEN}`
		const xml = await (await fetch(url)).text()
		for (const m of xml.matchAll(/guid="com\.plexapp\.agents\.incipit:\/\/([^_"]+)_/g)) {
			const set = ids.get(m[1]) ?? new Set<string>()
			set.add(box.name)
			ids.set(m[1], set)
		}
	}
	return ids
}

async function served(id: string): Promise<Answer> {
	try {
		const r = await fetch(`${API}/books/${encodeURIComponent(id)}?region=us`)
		if (!r.ok) return { primary: `UNAVAILABLE(${r.status})`, secondary: null }
		const d = (await r.json()) as {
			seriesPrimary?: { name?: string; position?: string | null }
			seriesSecondary?: { name?: string; position?: string | null }
		}
		return { primary: show(d.seriesPrimary), secondary: show(d.seriesSecondary) }
	} catch {
		return { primary: 'UNAVAILABLE(error)', secondary: null }
	}
}

async function main(): Promise<void> {
	const init = process.argv.includes('--init')
	const accept = process.argv.includes('--accept')
	const ledger: Record<string, LedgerEntry> = existsSync(LEDGER)
		? (JSON.parse(readFileSync(LEDGER, 'utf8')) as Record<string, LedgerEntry>)
		: {}
	if (init && Object.keys(ledger).length) {
		console.error('ledger already exists; refusing --init (use --accept to fold changes)')
		process.exit(2)
	}
	const records = await libraryRecords()
	console.log(`sweep: ${records.size} distinct records across ${BOXES.length} boxes`)

	const now = new Date().toISOString().slice(0, 10)
	const fresh: string[] = []
	const changed: { id: string; was: Answer; is: Answer }[] = []
	const queue = [...records.entries()]
	let done = 0
	const worker = async (): Promise<void> => {
		for (;;) {
			const next = queue.shift()
			if (!next) return
			const [id, boxes] = next
			const now_ = await served(id)
			const prior = ledger[id]
			if (!prior) {
				fresh.push(id)
				ledger[id] = { ...now_, firstSeen: now, reviewedAt: now, boxes: [...boxes] }
			} else {
				prior.boxes = [...boxes]
				if (prior.primary !== now_.primary) {
					changed.push({
						id,
						was: { primary: prior.primary, secondary: prior.secondary },
						is: now_
					})
					if (accept) {
						ledger[id] = { ...prior, ...now_, reviewedAt: now }
					}
				}
			}
			done += 1
			if (done % 200 === 0) console.log(`  ...${done}/${records.size}`)
		}
	}
	await Promise.all(Array.from({ length: 6 }, () => worker()))

	const gone = Object.keys(ledger).filter((id) => !records.has(id))
	console.log(`\nNEW (auto-baselined): ${fresh.length}`)
	console.log(`CHANGED (review queue): ${changed.length}`)
	for (const c of changed)
		console.log(`  ${c.id}  was ${c.was.primary ?? 'NONE'}  ->  now ${c.is.primary ?? 'NONE'}`)
	console.log(`GONE (in ledger, in no library): ${gone.length}`)

	if (init || accept || fresh.length) {
		writeFileSync(LEDGER, JSON.stringify(ledger, null, 1))
		console.log(`ledger written: ${Object.keys(ledger).length} records`)
	}
	if (!init && !accept && changed.length) process.exit(1)
}

await main()

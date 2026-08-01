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
 *
 * Run it from a host listed in the api's RATE_LIMIT_ALLOWLIST. Without that the
 * sweep trips the 100/min bucket and every 429 costs a backoff wait — correct
 * (nothing is scored as missing) but far slower than it needs to be.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
	fetchBoxGuids,
	fetchServedAnswer,
	parsePlexBoxes,
	type PlexBox
} from '#helpers/series/sweepFetch'

// Determinism: --record <f> captures every mirror exchange; --replay <f> serves
// them back with ZERO network and hard-fails on any miss.
const recPath = process.argv[process.argv.indexOf('--record') + 1]
if (process.argv.includes('--record')) process.env.GOODREADS_RECORD_PATH = recPath
const repPath = process.argv[process.argv.indexOf('--replay') + 1]
if (process.argv.includes('--replay')) process.env.GOODREADS_REPLAY_PATH = repPath

const LEDGER = join(import.meta.dir, '..', 'tests', 'fixtures', 'series-ledger.json')
const TOKEN = process.env.PLEX_TOKEN
const API = process.env.INCIPIT_API_URL
if (!TOKEN || !API) {
	console.error('PLEX_TOKEN and INCIPIT_API_URL must be set.')
	process.exit(2)
}
// The Plex servers to sweep, from the environment — this repo is a public fork
// and must not carry anyone's topology.
//   PLEX_BOXES="host:sectionId:label,host:sectionId:label"
//   e.g. PLEX_BOXES="192.168.1.10:56:test,192.168.1.11:6:prod"
// The label is only used in output and in the ledger's `boxes` field.
// Parsed by a VALIDATING helper: a malformed entry used to be silently dropped
// (or to survive as a nonsense host), and the sweep then audited nothing while
// exiting 0. See parsePlexBoxes.
let BOXES: PlexBox[]
try {
	BOXES = parsePlexBoxes(process.env.PLEX_BOXES)
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err))
	process.exit(2)
}

interface Answer {
	primary: string | null
	secondary: string | null
}
interface LedgerEntry extends Answer {
	firstSeen: string
	reviewedAt: string
	boxes: string[]
}

async function libraryRecords(): Promise<Map<string, Set<string>>> {
	const ids = new Map<string, Set<string>>()
	for (const box of BOXES) {
		// Throws on a non-OK response AND on a section that yields no records:
		// both used to pass silently, and an empty record set makes every later
		// stage empty too, so the `process.exit(1)` review gate is never reached.
		for (const id of await fetchBoxGuids(box, TOKEN as string)) {
			const set = ids.get(id) ?? new Set<string>()
			set.add(box.name)
			ids.set(id, set)
		}
	}
	return ids
}

// Reading one record is a DECISION (429 = slow down, retry; 404 = an answer),
// so it lives in a tested helper rather than inline here — see sweepFetch.ts
// for why a stable "unavailable" count is a limiter fingerprint, not data loss.
const served = (id: string): Promise<Answer & { available: boolean }> => fetchServedAnswer(API, id)

async function main(): Promise<void> {
	const init = process.argv.includes('--init')
	const accept = process.argv.includes('--accept')
	// --only <id,id,...>: selective accept — a review queue routinely mixes
	// approved arrivals with rows held for pins or operator decisions, and
	// all-or-nothing accept would fold the held rows' wrong serving into the
	// baseline. Ignored without --accept.
	const onlyArg = process.argv[process.argv.indexOf('--only') + 1]
	const only = process.argv.includes('--only') ? new Set(onlyArg.split(',')) : null
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
	const flaps: string[] = []
	const resolved: { id: string; is: Answer }[] = []
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
				const priorUnavailable = Boolean(prior.primary?.startsWith('UNAVAILABLE'))
				if (!now_.available) {
					// Not a reading: never queue a real baseline against it, never
					// overwrite the ledger with it. Rate limiting no longer reaches
					// here (sweepFetch retries a 429), so what lands here is a record
					// the api genuinely cannot serve — worth watching, not reviewing.
					if (!priorUnavailable) flaps.push(id)
				} else if (priorUnavailable) {
					// The record's FIRST real answer. This used to fold straight into the
					// reviewed baseline, silently: a genuine drift preceded by a single
					// unavailable sweep was swallowed, and the ledger kept the stale
					// `available: false` beside a real primary (fingerprints of it are
					// still in the shipped file). An answer nobody has reviewed is a
					// review item, so it goes in the queue like any other change.
					resolved.push({ id, is: now_ })
					changed.push({
						id,
						was: { primary: prior.primary, secondary: prior.secondary },
						is: now_
					})
					if (accept && (!only || only.has(id))) {
						ledger[id] = { ...prior, ...now_, reviewedAt: now }
					}
				} else if (prior.primary !== now_.primary || prior.secondary !== now_.secondary) {
					// BOTH slots. Comparing only the primary left the tag slot undiffed
					// even though the ledger stores it and 337 of 1607 entries carry one
					// — the exact fb058d2 blind spot the harness was built to close,
					// re-introduced in the drift tool.
					changed.push({
						id,
						was: { primary: prior.primary, secondary: prior.secondary },
						is: now_
					})
					if (accept && (!only || only.has(id))) {
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
	console.log(`UNSERVABLE (api cannot answer; not queued): ${flaps.length}`)
	for (const id of flaps.slice(0, 20)) console.log(`  ${id}`)
	if (flaps.length > 20) console.log(`  ... and ${flaps.length - 20} more`)
	console.log(`RESOLVED (was unavailable, now answering — queued for review): ${resolved.length}`)
	for (const r of resolved) console.log(`  ${r.id} -> ${r.is.primary ?? 'NONE'}`)
	console.log(`CHANGED (review queue): ${changed.length}`)
	for (const c of changed) {
		console.log(`  ${c.id}  was ${c.was.primary ?? 'NONE'}  ->  now ${c.is.primary ?? 'NONE'}`)
		// Say so when the TAG is what moved, or a secondary-only change reads as
		// a no-op line and gets accepted without anyone seeing what shifted.
		if (c.was.secondary !== c.is.secondary)
			console.log(`      tag: ${c.was.secondary ?? 'NONE'}  ->  ${c.is.secondary ?? 'NONE'}`)
	}
	console.log(`GONE (in ledger, in no library): ${gone.length}`)

	if (init || accept || fresh.length || resolved.length) {
		writeFileSync(LEDGER, JSON.stringify(ledger, null, 1))
		console.log(`ledger written: ${Object.keys(ledger).length} records`)
	}
	if (!init && !accept && changed.length) process.exit(1)
}

// Any failure is a FAILED sweep, never a clean one: exit non-zero and say what
// happened. This gate's whole value is that a green run means "audited and
// unchanged" rather than "audited nothing".
try {
	await main()
} catch (err) {
	console.error(`sweep failed: ${err instanceof Error ? err.message : String(err)}`)
	process.exit(2)
}

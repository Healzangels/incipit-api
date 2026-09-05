/**
 * Series-authority harness — Phase 0 of the redesign plan.
 *
 * Runs the REAL withGoodreadsSeries over the golden corpus
 * (tests/fixtures/series-golden-corpus.json) cache-cold against the live local
 * mirror, scores every row against its REQUIRED outcome, and gates on the
 * refuter-corrected semantics:
 *
 *   * the gate is "no NEW failures vs the stored baseline", never "zero
 *     failures" — standing reds are printed as a burn-down with labels, so
 *     Phase 1 cannot deadlock on defects it does not touch;
 *   * the SECONDARY slot is scored (secondary must never duplicate the
 *     primary) — the fb058d2-class regression the primary-only diff missed;
 *   * an allowlisted row that did NOT change fails the run — a fix that fixes
 *     nothing (the e9ea449 class) must not pass green.
 *
 * Modes:
 *   bun scripts/seriesHarness.ts --smoke            # knownDefectNow rows only
 *   bun scripts/seriesHarness.ts                    # full corpus
 *   bun scripts/seriesHarness.ts --baseline         # full run, then WRITE baseline
 *   bun scripts/seriesHarness.ts --gate             # full run, diff vs baseline
 *   ... --allow <file.json>                         # rows predicted to change
 *   ... --out <results.json>
 *   ... --no-pins   run with both pin tables EMPTY: the A/B arm switch. A pin masks the
 *                   resolver, so a fix is proved only when rows heal without pins.
 *
 * The mirror is nondeterministic infrastructure (429s under load, librarian
 * edits between runs). Until the Phase-2 recorder lands, treat single-row
 * flips across runs with suspicion and re-run before believing them.
 *
 * REQUIRES GOODREADS_SERIES_URL to be set explicitly — refusing the default
 * keeps a misconfigured run from hammering the retired public instance.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
	foldSeriesName,
	sameSeriesName,
	withGoodreadsSeries
} from '#helpers/providers/goodreadsSeries'
import { applyPins } from '#helpers/series/shelfPins'
import { applyShelfPolicy } from '#helpers/series/shelfPolicy'
import { replayStats } from '#helpers/utils/fetchPlus'

interface CorpusSeries {
	name?: string | null
	position?: string | null
}
interface CorpusRow {
	recordId: string
	ratingKey: string
	album: string
	artist: string
	inputs: {
		title?: string | null
		subtitle?: string | null
		author?: string | null
		providerSeries?: CorpusSeries | string | null
		providerSeries2?: CorpusSeries | null
	}
	required: {
		outcome: 'SERIES' | 'NONE' | 'CONDITIONAL'
		series?: string | null
		position?: string | null
		conditional?: { on?: string } & Record<string, unknown>
	}
	pinType: string
	knownDefectNow?: boolean
	group?: string
}
interface Decisions {
	Q1: { resolutions: Record<string, { series?: string | null; position?: string | null }> }
}
interface RowResult {
	ratingKey: string
	album: string
	recordId: string
	classification: string
	required: string
	got: string
	pinType: string
	knownDefectNow: boolean
	excluded: boolean
	reason?: string
}

const FIXTURES = join(import.meta.dir, '..', 'tests', 'fixtures')
const BASELINE_PATH = join(FIXTURES, 'series-harness-baseline.json')

// Determinism: --record <f> captures every mirror exchange; --replay <f> serves
// them back with ZERO network and hard-fails on any miss.
const recPath = process.argv[process.argv.indexOf('--record') + 1]
if (process.argv.includes('--record')) process.env.GOODREADS_RECORD_PATH = recPath
const repPath = process.argv[process.argv.indexOf('--replay') + 1]
if (process.argv.includes('--replay')) process.env.GOODREADS_REPLAY_PATH = repPath
// Determinism mode: concurrency races make the two arms fetch shared-memo
// URLs a different number of times, and the wall-clock backoff skips
// different rows per arm — one worker + no backoff whenever recording or
// replaying. Live un-recorded runs keep 4 workers.
const DETERMINISM = process.argv.includes('--record') || process.argv.includes('--replay')
if (DETERMINISM) process.env.GOODREADS_BACKOFF_MS = '0'
// The per-row degraded stand-down is wall-clock state exactly like the backoff:
// left armed, a degraded row makes a later same-key row skip its lookup —
// consuming zero replay entries and nulling the row while the run reports
// itself faithful. Same remedy, same mode.
if (DETERMINISM) process.env.GOODREADS_DEGRADED_COOLDOWN_MS = '0'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
/** Run with both pin tables empty — the A/B arm switch. See the resolve site. */
const NO_PINS = args.includes('--no-pins')
const opt = (name: string): string | undefined => {
	const i = args.indexOf(name)
	return i >= 0 ? args[i + 1] : undefined
}

if (!process.env.GOODREADS_SERIES_URL) {
	console.error('GOODREADS_SERIES_URL is not set. Refusing to run against a default host.')
	process.exit(2)
}

const corpus = JSON.parse(readFileSync(join(FIXTURES, 'series-golden-corpus.json'), 'utf8')) as {
	rows: CorpusRow[]
}
const decisions = JSON.parse(
	readFileSync(join(FIXTURES, 'series-decisions.json'), 'utf8')
) as Decisions

/** Shelf identity: the same fold the code uses, so the harness cannot drift. */
const key = (name: string | null | undefined): string => (name ? foldSeriesName(name) : '')
const posEq = (a: string | null | undefined, b: string | null | undefined): boolean => {
	const ta = (a ?? '').toString().trim()
	const tb = (b ?? '').toString().trim()
	if (ta === tb) return true
	const na = Number(ta)
	const nb = Number(tb)
	return Number.isFinite(na) && Number.isFinite(nb) && na === nb
}
const show = (s: CorpusSeries | null | undefined): string =>
	s?.name ? `${s.name} #${s.position ?? '?'}` : 'NONE'

/**
 * Resolve the row's required outcome under the recorded operator decisions.
 * Returns null when the row cannot be hard-gated yet (pending family review).
 */
function resolveRequired(row: CorpusRow): { series: CorpusSeries | null } | null {
	const req = row.required
	if (req.outcome === 'SERIES') return { series: { name: req.series, position: req.position } }
	if (req.outcome === 'NONE') return { series: null }
	const on = req.conditional?.on ?? ''
	if (on === 'Q1') {
		const r = decisions.Q1.resolutions[row.ratingKey]
		if (r?.series) return { series: { name: r.series, position: r.position } }
		return { series: null }
	}
	// Q2: both accepted branches are shelf-outcome NONE (tag-vs-nothing is
	// mood-layer policy, recorded in the decisions file, not scored here).
	if (on === 'Q2') return { series: null }
	return null // OPERATOR-REVIEW — pending
}

async function evaluate(row: CorpusRow): Promise<RowResult> {
	const req = resolveRequired(row)
	const base: Omit<RowResult, 'classification' | 'required' | 'got'> = {
		ratingKey: row.ratingKey,
		album: row.album,
		recordId: row.recordId,
		pinType: row.pinType,
		knownDefectNow: Boolean(row.knownDefectNow),
		excluded: false
	}
	if (req === null) {
		return {
			...base,
			classification: 'PENDING_FAMILY',
			required: 'operator-review',
			got: '-',
			excluded: true,
			reason: 'family decision pending'
		}
	}
	const ps = row.inputs.providerSeries
	const inputsPartial = typeof ps === 'string' // "UNKNOWN-not-rebuildable"
	const provider: CorpusSeries | undefined =
		!ps || typeof ps === 'string' ? undefined : { name: ps.name, position: ps.position }

	const book: Record<string, unknown> = {
		title: row.inputs.title ?? row.album,
		authors: row.inputs.author ? [{ name: row.inputs.author }] : []
	}
	if (row.inputs.subtitle) book.subtitle = row.inputs.subtitle
	if (provider?.name) book.seriesPrimary = { name: provider.name, position: provider.position }
	if (row.inputs.providerSeries2?.name) book.seriesSecondary = row.inputs.providerSeries2

	let primary: CorpusSeries | null
	let secondary: CorpusSeries | null
	try {
		// Model the FULL serve pipeline: the route applies the shelf policy after
		// enrichment, so the harness must too or it scores an output nobody serves.
		// NO_PINS runs the pipeline with both pin tables empty. A pin MASKS the
		// resolver: with pins on, a row can read MATCH because an operator answered
		// it by hand, which is exactly what an A/B for a resolver change must not
		// score. Arm A with --no-pins is the honest statement of what the resolver
		// does unaided; a fix is only proved when those rows heal WITHOUT pins.
		const out = applyShelfPolicy(
			NO_PINS
				? await withGoodreadsSeries(book, null)
				: applyPins(await withGoodreadsSeries(book, null), row.recordId)
		) as {
			seriesPrimary?: CorpusSeries
			seriesSecondary?: CorpusSeries
		}
		primary = out.seriesPrimary?.name ? out.seriesPrimary : null
		secondary = out.seriesSecondary?.name ? out.seriesSecondary : null
	} catch (err) {
		return {
			...base,
			classification: 'ERROR',
			required: show(req.series),
			got: String(err).slice(0, 120),
			excluded: inputsPartial,
			reason: inputsPartial ? 'inputs partial (provider unknown)' : undefined
		}
	}

	// Invariant first: the secondary slot must never duplicate the primary.
	// sameSeriesName, not `key`: a bare fold reads a spaced colon as a different
	// series, so the harness scored Baneblade a MATCH while it shipped one series
	// in both slots — the gate was blind to the exact defect it exists to catch.
	if (primary && secondary && sameSeriesName(primary.name, secondary.name)) {
		return {
			...base,
			classification: 'SECONDARY_DUP',
			required: 'secondary != primary',
			got: `${show(primary)} in both slots`
		}
	}

	const requiredStr = show(req.series)
	const gotStr = show(primary)
	let classification: string
	if (!req.series) {
		classification = primary ? 'UNEXPECTED_SERIES' : 'MATCH'
	} else if (!primary) {
		classification = 'MISSING_SERIES'
	} else if (key(primary.name) !== key(req.series.name)) {
		classification = 'WRONG_SERIES'
	} else if (!posEq(primary.position, req.series.position)) {
		classification = 'WRONG_POSITION'
	} else {
		classification = 'MATCH'
	}
	return {
		...base,
		classification,
		required: requiredStr,
		got: gotStr,
		// UNCONDITIONAL on the outcome. This used to be
		// `inputsPartial && classification !== 'MATCH'`, which let a row whose
		// inputs cannot be rebuilt count as GREEN when it happened to match and
		// be silently dropped when it failed. That is a one-way ratchet: it can
		// only ever flatter the gate. It is also why "497 MATCH / 0 standing
		// reds" was reported on 2026-07-31 while 8 rows were in fact failing,
		// two of them live R2 violations (The Sunlit Man on The Cosmere #32).
		//
		// A row whose providerSeries input is the literal "UNKNOWN-not-rebuildable"
		// is fed a book with NO provider series — not the real input — so its
		// result is not evidence in EITHER direction. Not assertable is not the
		// same as passing.
		excluded: inputsPartial,
		reason: inputsPartial ? 'inputs partial (provider unknown)' : undefined
	}
}

async function main(): Promise<void> {
	// --smoke SUBSETS; it must not also stand in for gating. The gate diffs
	// against a baseline recorded over the FULL corpus, so gating a subset
	// compares a handful of rows to all of them and reports PASS for every row
	// it never ran. It is worst when the subset is empty: with the
	// knownDefectNow flags cleared (dda605a) `--smoke --gate` runs 0 rows and
	// prints "gate PASS", exit 0, having asserted literally nothing. Same class
	// as the --gate --baseline cancellation below, found the same way.
	if (flag('--smoke') && flag('--baseline')) {
		console.error(
			'refusing --baseline with --smoke: a subset run must never overwrite the full-corpus ' +
				'reviewed baseline (with the flags cleared it would write rowCount 0, fails []).'
		)
		process.exit(2)
	}
	if (flag('--smoke') && flag('--gate')) {
		console.error(
			'refusing --gate with --smoke: the baseline covers the full corpus, so gating a ' +
				'subset passes on every row it did not run (and passes vacuously when the subset ' +
				'is empty). Run --smoke for the fast loop, --gate on its own to gate.'
		)
		process.exit(2)
	}

	const smoke = flag('--smoke')
	const rows = smoke ? corpus.rows.filter((r) => r.knownDefectNow) : corpus.rows
	if (smoke && !rows.length) {
		console.log(
			'series harness: --smoke selected 0 rows (no knownDefectNow flags are set). Nothing ran.'
		)
		// Not a pass. A smoke run that runs nothing must not exit 0 and read as green.
		process.exit(3)
	}
	console.log(
		`series harness: ${rows.length} rows (${smoke ? 'smoke: knownDefectNow' : 'full corpus'}), mirror=${process.env.GOODREADS_SERIES_URL}${NO_PINS ? ', PINS DISABLED (--no-pins)' : ''}`
	)
	const results: RowResult[] = []
	const queue = [...rows]
	let done = 0
	const worker = async (): Promise<void> => {
		for (;;) {
			const row = queue.shift()
			if (!row) return
			results.push(await evaluate(row))
			done += 1
			if (done % 25 === 0) console.log(`  ...${done}/${rows.length}`)
		}
	}
	await Promise.all(Array.from({ length: DETERMINISM ? 1 : 4 }, () => worker()))

	// Replay misses invalidate the ENTIRE run before any verdict is trusted:
	// a miss may have been swallowed downstream as a degraded fetch, so the
	// gate's conclusion is built on inputs the recording never contained.
	if (process.env.GOODREADS_REPLAY_PATH) {
		const rs = replayStats()
		console.log(`replay: served ${rs.served}, misses ${rs.misses}, remaining ${rs.remaining}`)
		if (rs.misses > 0) {
			console.error('REPLAY MISSES — run invalid; re-record the baseline.')
			process.exit(2)
		}
		// Zero misses is NOT the same as a faithful replay. Leftover entries mean
		// this arm made FEWER requests than the recording did — a short-circuit
		// somewhere (a stale backoff, a cache hit, a heuristic that stopped
		// fetching) — so rows were decided on no evidence while the run reported
		// itself clean. Measured 2026-07-31: served 1 / misses 0 with 3 of 4
		// exchanges unconsumed and the row silently nulled.
		if (rs.remaining > 0) {
			console.error(
				`REPLAY UNDER-CONSUMED: ${rs.remaining} recorded exchange(s) never used — ` +
					'this arm short-circuited somewhere; run invalid.'
			)
			process.exit(2)
		}
	}

	const fails = results.filter((r) => r.classification !== 'MATCH' && !r.excluded)
	const excluded = results.filter((r) => r.excluded)
	const counts = new Map<string, number>()
	for (const r of results) counts.set(r.classification, (counts.get(r.classification) ?? 0) + 1)

	console.log('\n== classification counts ==')
	for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1]))
		console.log(`  ${k.padEnd(18)} ${v}`)

	// State the gate's real reach on EVERY run. A count of assertable rows that
	// nobody prints is how 10.7% of the corpus became structurally unfalsifiable
	// without anyone noticing.
	const assertable = results.length - excluded.length
	const pct = ((excluded.length / Math.max(1, results.length)) * 100).toFixed(1)
	console.log(
		`\n== gate reach ==  ${assertable}/${results.length} rows assertable; ` +
			`${excluded.length} (${pct}%) NOT assertable and cannot fail`
	)
	if (excluded.length) {
		const byReason = new Map<string, number>()
		for (const e of excluded)
			byReason.set(e.reason ?? 'unknown', (byReason.get(e.reason ?? 'unknown') ?? 0) + 1)
		for (const [reason, n] of byReason) console.log(`     ${n} — ${reason}`)
		// Name them. A row that cannot fail is technical debt with a name, not a
		// statistic: rebuilding its inputs is what makes the gate cover it again.
		for (const e of excluded.slice(0, 12))
			console.log(`       rk${e.ratingKey} ${e.album.slice(0, 40)} (${e.classification})`)
		if (excluded.length > 12) console.log(`       ... and ${excluded.length - 12} more`)
	}

	console.log('\n== failures (gate-relevant) ==')
	for (const f of fails.sort((a, b) => a.classification.localeCompare(b.classification)))
		console.log(
			`  ${f.classification.padEnd(17)} rk${f.ratingKey} ${f.album.slice(0, 34).padEnd(35)} required=${f.required} got=${f.got}${f.knownDefectNow ? '  [knownDefect]' : ''}`
		)

	const outPath = opt('--out')
	if (outPath) writeFileSync(outPath, JSON.stringify({ results }, null, 1))

	// Allowlist reconciliation: a row predicted to change that did NOT change fails.
	const allowPath = opt('--allow')
	let reconcileFailed = false
	if (allowPath) {
		const allow = JSON.parse(readFileSync(allowPath, 'utf8')) as { ratingKey: string }[]
		const baseline = existsSync(BASELINE_PATH)
			? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { fails: RowResult[] })
			: null
		for (const a of allow) {
			const now = results.find((r) => r.ratingKey === a.ratingKey)
			const before = baseline?.fails.find((r) => r.ratingKey === a.ratingKey)
			const unchanged =
				now &&
				((before && before.classification === now.classification) ||
					(!before && now.classification === 'MATCH'))
			if (unchanged) {
				console.error(`ALLOWLIST-UNCHANGED: rk${a.ratingKey} was predicted to change and did not`)
				reconcileFailed = true
			}
		}
	}

	// --baseline RECORDS; it must not also stand in for gating. It used to
	// `return` here, so `--gate --baseline` wrote the baseline, printed success
	// and exited 0 having asserted nothing — the two flags silently cancelled.
	if (flag('--baseline')) {
		if (flag('--gate')) {
			console.error(
				'refusing --gate with --baseline: recording the current state and gating against it ' +
					'in one run always passes. Run --baseline, review it, then --gate separately.'
			)
			process.exit(2)
		}
		writeFileSync(
			BASELINE_PATH,
			JSON.stringify(
				{
					writtenAt: new Date().toISOString(),
					rowCount: rows.length,
					assertableCount: assertable,
					excludedCount: excluded.length,
					fails
				},
				null,
				1
			)
		)
		console.log(`\nbaseline written: ${fails.length} standing failures -> ${BASELINE_PATH}`)
		return
	}

	if (flag('--gate')) {
		if (!existsSync(BASELINE_PATH)) {
			console.error('no baseline; run --baseline first')
			process.exit(2)
		}
		const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as {
			fails: RowResult[]
			rowCount?: number
		}
		// THE invariant the two pairwise refusals above are cases of: the gate and
		// the baseline must be computed over the same row set. A gate over FEWER
		// rows than the baseline passes on every row it never ran -- vacuously.
		// More rows is fine (a new corpus row can only add a NEW failure), so warn
		// rather than refuse; a baseline older than the corpus is worth knowing.
		if (typeof baseline.rowCount === 'number') {
			if (rows.length < baseline.rowCount) {
				console.error(
					`refusing to gate ${rows.length} rows against a baseline recorded over ` +
						`${baseline.rowCount}: a subset gate passes vacuously on every row it did not run.`
				)
				process.exit(2)
			}
			if (rows.length > baseline.rowCount) {
				console.log(
					`  note: corpus has ${rows.length} rows, baseline was recorded over ${baseline.rowCount} ` +
						'-- re-run --baseline after reviewing the new rows.'
				)
			}
		}
		// New failures key by ROW, not row|class: an already-red album drifting
		// between red classes (junk name removed -> MISSING instead of WRONG) is
		// progress to report, not a fresh regression to block on.
		const baseByRk = new Map(baseline.fails.map((f) => [f.ratingKey, f]))
		const fresh = fails.filter((f) => !baseByRk.has(f.ratingKey))
		const shifted = fails.filter(
			(f) =>
				baseByRk.has(f.ratingKey) && baseByRk.get(f.ratingKey)?.classification !== f.classification
		)
		const healed = baseline.fails.filter((b) => !fails.some((f) => f.ratingKey === b.ratingKey))
		console.log(`\n== gate ==  baseline reds: ${baseline.fails.length}  now: ${fails.length}`)
		for (const h of healed) console.log(`  HEALED  rk${h.ratingKey} ${h.album.slice(0, 40)}`)
		for (const c of shifted)
			console.log(
				`  CLASS-SHIFT  rk${c.ratingKey} ${c.album.slice(0, 40)} ${baseByRk.get(c.ratingKey)?.classification} -> ${c.classification}`
			)
		for (const f of fresh)
			console.error(`  NEW-FAILURE  ${f.classification} rk${f.ratingKey} ${f.album.slice(0, 40)}`)
		if (fresh.length || reconcileFailed) process.exit(1)
		console.log('gate PASS (no new failures vs baseline)')
		return
	}

	// A plain run is the DOCUMENTED invocation, and it used to print its failures
	// and exit 0 — so any caller that checked the exit code (a hook, a pipeline,
	// a `&&` chain) read a red corpus as success. Failing rows are a failure.
	if (reconcileFailed || fails.length) {
		if (fails.length)
			console.error(
				`\n${fails.length} gate-relevant failure(s). Use --gate to compare against the ` +
					`reviewed baseline instead of failing on standing reds.`
			)
		process.exit(1)
	}
}

await main()

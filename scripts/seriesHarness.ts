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

import { foldSeriesName, withGoodreadsSeries } from '#helpers/providers/goodreadsSeries'
import { applyPins } from '#helpers/series/shelfPins'
import { applyShelfPolicy } from '#helpers/series/shelfPolicy'

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

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
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
		const out = applyShelfPolicy(
			applyPins(await withGoodreadsSeries(book, null), row.recordId)
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
	if (primary && secondary && key(primary.name) === key(secondary.name)) {
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
		excluded: inputsPartial && classification !== 'MATCH',
		reason: inputsPartial ? 'inputs partial (provider unknown)' : undefined
	}
}

async function main(): Promise<void> {
	const smoke = flag('--smoke')
	const rows = smoke ? corpus.rows.filter((r) => r.knownDefectNow) : corpus.rows
	console.log(
		`series harness: ${rows.length} rows (${smoke ? 'smoke: knownDefectNow' : 'full corpus'}), mirror=${process.env.GOODREADS_SERIES_URL}`
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
	await Promise.all(Array.from({ length: 4 }, () => worker()))

	const fails = results.filter((r) => r.classification !== 'MATCH' && !r.excluded)
	const excluded = results.filter((r) => r.excluded)
	const counts = new Map<string, number>()
	for (const r of results) counts.set(r.classification, (counts.get(r.classification) ?? 0) + 1)

	console.log('\n== classification counts ==')
	for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1]))
		console.log(`  ${k.padEnd(18)} ${v}`)
	console.log(`  excluded-from-gate  ${excluded.length}`)

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

	if (flag('--baseline')) {
		writeFileSync(
			BASELINE_PATH,
			JSON.stringify({ writtenAt: new Date().toISOString(), rowCount: rows.length, fails }, null, 1)
		)
		console.log(`\nbaseline written: ${fails.length} standing failures -> ${BASELINE_PATH}`)
		return
	}

	if (flag('--gate')) {
		if (!existsSync(BASELINE_PATH)) {
			console.error('no baseline; run --baseline first')
			process.exit(2)
		}
		const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { fails: RowResult[] }
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

	if (reconcileFailed) process.exit(1)
}

await main()

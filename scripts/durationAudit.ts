/**
 * Duration audit — does the file on disk hold the whole book?
 *
 * Read-only. Prints. Never writes, never re-matches, never a gate.
 *
 * WHY IT EXISTS. Two duration incidents inside a week, both found by accident.
 * Soldiers Live sat in the library as a 6.56h file of a 19.53h book and nothing
 * detected it. Shadows Linger was FINE and was deleted on my advice because I
 * read a wrong `mvhd` as real. Nothing in this stack knew how long a book was
 * SUPPOSED to be: `mvhd` lies, bitrate proves nothing here (64-145 kbps), and
 * Plex's analysed duration only reports what IS on disk.
 *
 *   bun scripts/durationAudit.ts              # full pass
 *   bun scripts/durationAudit.ts --limit 50   # sample, for a cheap look
 *
 * Requires PLEX_TOKEN and PLEX_BOXES (host:sectionId:label, comma-separated).
 *
 * ⚠️ PACING IS NOT OPTIONAL. api2.chaptarr.com is another project's free
 * infrastructure with no SLA. Sizing this feature I burst ~50 requests at it
 * from a workstation and was HTTP 403'd for my trouble. Hence: one shared
 * pacer, a per-ASIN dedupe so a re-ask never happens, and a hard stop after a
 * run of consecutive failures rather than grinding through 3,000 of them.
 *
 * Note the breaker in ProviderRegistry does NOT cover this: it wraps the
 * serving path's provider calls, not `fetchChaptarrWork`. The consecutive-failure
 * stop below is this script's own protection, not something inherited.
 */
import { type DurationBand, durationVerdict } from '#helpers/providers/chaptarrDuration'
import {
	type ChaptarrEdition,
	chaptarrEnabled,
	editionForAsin,
	fetchChaptarrWork
} from '#helpers/providers/ChaptarrProvider'
import { parsePlexBoxes, tracksWithDurations } from '#helpers/series/sweepFetch'
import { createPacer } from '#helpers/utils/pacer'

const TOKEN = process.env.PLEX_TOKEN
if (!TOKEN) {
	console.error('PLEX_TOKEN must be set.')
	process.exit(2)
}
const BOXES = parsePlexBoxes(process.env.PLEX_BOXES)
const limitArg = process.argv[process.argv.indexOf('--limit') + 1]
const LIMIT = process.argv.includes('--limit') ? Number(limitArg) : 0
/** Consecutive transport failures before giving up on the service entirely. */
const GIVE_UP_AFTER = 8

// 'wait', not 'shed': this is a batch job with no time budget, so a push-back
// should slow it down rather than make it skip rows and under-report.
const pacer = createPacer({
	minGapMs: () => Number(process.env.CHAPTARR_AUDIT_GAP_MS ?? 350),
	cooldownMs: () => 60_000,
	onPushBack: 'wait'
})

const hours = (ms: number) => ms / 3_600_000

async function main(): Promise<void> {
	if (!chaptarrEnabled()) {
		console.error('CHAPTARR_ENABLED=false — nothing to audit against.')
		process.exit(2)
	}

	// SUM the parts, do not sample one.
	//
	// An album can hold several tracks (2,891 tracks map to 1,368 ASINs on prod --
	// 2.1 apiece), and Chaptarr's durationSeconds is the WHOLE edition. Comparing
	// one track against the whole book reports every multi-track album as
	// catastrophically short: mass false positives, in exactly the direction that
	// costs files. Sum within a box, then take the best-covered box rather than
	// adding across boxes, which would double-count a book present on both.
	const perBox = new Map<string, Map<string, { title: string; durationMs: number }>>()
	let tracksSeen = 0
	let tracksUsable = 0
	for (const box of BOXES) {
		const url = `http://${box.host}:32400/library/sections/${box.section}/all?type=10&X-Plex-Token=${TOKEN}`
		const xml = await (await fetch(url)).text()
		const rows = tracksWithDurations(xml)
		const seen = (xml.match(/<Track /g) ?? []).length
		tracksSeen += seen
		tracksUsable += rows.length
		const summed = new Map<string, { title: string; durationMs: number }>()
		for (const r of rows) {
			const cur = summed.get(r.asin)
			if (cur) cur.durationMs += r.durationMs
			else summed.set(r.asin, { title: r.title, durationMs: r.durationMs })
		}
		perBox.set(box.name, summed)
		console.log(
			`  ${box.name}: ${rows.length} usable track(s) of ${seen} -> ${summed.size} album(s)`
		)
	}

	const byAsin = new Map<string, { title: string; durationMs: number }>()
	for (const summed of perBox.values()) {
		for (const [asin, row] of summed) {
			const cur = byAsin.get(asin)
			// The longer read wins: a box mid-scan can hold a partial album, and the
			// audit must not report THAT as a truncated file.
			if (!cur || row.durationMs > cur.durationMs) byAsin.set(asin, row)
		}
	}

	// UNCOVERED is tracks that yielded no usable ASIN -- NOT tracks folded into an
	// album. Subtracting the album count instead inflated this to 2,644 of 4,012
	// on the first run, which overstates the blind spot as badly as hiding it
	// would understate it.
	const uncovered = tracksSeen - tracksUsable
	let entries = [...byAsin.entries()]
	if (LIMIT > 0) entries = entries.slice(0, LIMIT)
	console.log(
		`\n${byAsin.size} distinct album(s) to check` +
			(LIMIT > 0 ? ` (limited to ${entries.length})` : '') +
			` \u00b7 ${uncovered} track(s) carry no ASIN and are UNCHECKABLE\n`
	)

	const results: {
		asin: string
		title: string
		band: DurationBand
		drift: number
		plexH: number
		wantH: number
		note: string
	}[] = []
	const counts: Record<string, number> = { agree: 0, report: 0, flag: 0, skip: 0 }
	let failures = 0
	let consecutive = 0
	let checked = 0

	for (const [asin, row] of entries) {
		if (consecutive >= GIVE_UP_AFTER) break
		await pacer.take()
		// Declared without an initialiser: the catch always `continue`s, so this is
		// definitely assigned by the time it is read.
		let edition: ChaptarrEdition | null
		try {
			const work = await fetchChaptarrWork(`az:${asin}`)
			edition = editionForAsin(work?.editions, asin)
			consecutive = 0
		} catch (err) {
			failures += 1
			consecutive += 1
			const status = (err as { status?: number })?.status
			if (status === 429) pacer.pushBack()
			continue
		}
		const v = durationVerdict(row.durationMs, edition, asin)
		counts[v.band] += 1
		checked += 1
		if (v.band !== 'skip' && v.driftPct !== null) {
			results.push({
				asin,
				title: row.title,
				band: v.band,
				drift: v.driftPct,
				plexH: hours(row.durationMs),
				wantH: (v.expectedSeconds ?? 0) / 3600,
				note: v.diagnosis ?? (v.exactAsin ? '' : 'variant match')
			})
		}
	}

	results.sort((a, b) => b.drift - a.drift)
	const show = (band: DurationBand, heading: string) => {
		const rows = results.filter((r) => r.band === band)
		if (!rows.length) return
		console.log(`\n${heading} (${rows.length})`)
		for (const r of rows) {
			console.log(
				`  ${r.drift.toFixed(1).padStart(5)}%  ${r.title.slice(0, 34).padEnd(34)} ` +
					`have ${r.plexH.toFixed(2)}h want ${r.wantH.toFixed(2)}h  ${r.asin}` +
					(r.note ? `  ${r.note}` : '')
			)
		}
	}
	show('flag', 'FLAGGED — short or long enough to be damage')
	show('report', 'REPORT — differs, inside the edition-difference band')

	console.log(
		`\nchecked ${checked} · agree ${counts.agree} · report ${counts.report} · ` +
			`flag ${counts.flag} · skip ${counts.skip} · lookup failures ${failures}`
	)
	if (consecutive >= GIVE_UP_AFTER) {
		console.log(
			`\n⚠️  STOPPED EARLY after ${GIVE_UP_AFTER} consecutive failures — ` +
				`${entries.length - checked - failures} row(s) never checked. ` +
				`This is a partial result, not a clean bill of health.`
		)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})

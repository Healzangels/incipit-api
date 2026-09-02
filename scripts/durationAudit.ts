/**
 * Duration audit — does the file on disk hold the whole book?
 *
 * Read-only. Prints. Never writes to Plex, never re-matches, never a gate.
 *
 * WHY IT EXISTS. Two duration incidents inside a week, both found by accident.
 * Soldiers Live sat in the library as a 6.56h file of a 19.53h book and nothing
 * detected it. Shadows Linger was FINE and was deleted on my advice because I
 * read a wrong `mvhd` as real. Nothing in this stack knew how long a book was
 * SUPPOSED to be: `mvhd` lies, bitrate proves nothing here (64-145 kbps), and
 * Plex's analysed duration only reports what IS on disk.
 *
 *   bun scripts/durationAudit.ts              # full pass (cached rows are free)
 *   bun scripts/durationAudit.ts --limit 50   # look up at most 50 UNCACHED albums
 *
 * Requires PLEX_TOKEN and PLEX_BOXES (host:sectionId:label, comma-separated).
 * DURATION_AUDIT_CACHE overrides the cache path (default .cache/duration-audit.json).
 *
 * PACING AND CACHING LIVE IN THE TRANSPORT, not here. chaptarrGet paces every
 * caller of api2.chaptarr.com through ONE pacer and arms a cooldown on
 * 429/403/503; this script's only jobs are to wait out a cooldown (it is a
 * batch job with no time budget, so it can), to retry the row that took the
 * push-back rather than drop it, and to persist what it learns per ASIN so a
 * re-run -- after a threshold tweak, a fix, or an early stop -- costs nothing
 * for rows already answered. A first version paced only itself, cached
 * nothing, dropped 429'd rows and re-asked all 1,368 ASINs every run, on the
 * free host that had already 403'd a 50-request burst.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { type DurationBand,durationVerdict } from '#helpers/providers/chaptarrDuration'
import {
	type ChaptarrEdition,
	chaptarrEnabled,
	chaptarrStandDownMs,
	chaptarrStandingDown,
	editionForAsin,
	fetchChaptarrWork} from '#helpers/providers/ChaptarrProvider'
import {
	albumsFromListing,
	fetchBoxXml,
	parsePlexBoxes,
	type PlexAlbum,
	type PlexBox
} from '#helpers/series/sweepFetch'
import CircuitBreaker, { CircuitOpenError } from '#helpers/utils/CircuitBreaker'
import sleep from '#helpers/utils/sleep'

// ---- configuration: every failure here is loud and exits 2 ----------------
const TOKEN = process.env.PLEX_TOKEN
if (!TOKEN) {
	console.error('PLEX_TOKEN must be set.')
	process.exit(2)
}
let BOXES: PlexBox[]
try {
	BOXES = parsePlexBoxes(process.env.PLEX_BOXES)
} catch (err) {
	console.error((err as Error).message)
	process.exit(2)
}
const limitArg = process.argv[process.argv.indexOf('--limit') + 1]
const LIMIT = process.argv.includes('--limit') ? Number(limitArg) : 0
// `--limit` as the LAST argument parses to NaN, and NaN > 0 is false -- so the
// sample flag silently ran the full pass. Refuse rather than guess.
if (process.argv.includes('--limit') && !(Number.isInteger(LIMIT) && LIMIT > 0)) {
	console.error(`--limit needs a positive integer, got ${JSON.stringify(limitArg)}`)
	process.exit(2)
}
const CACHE_PATH =
	process.env.DURATION_AUDIT_CACHE ?? join(import.meta.dir, '..', '.cache', 'duration-audit.json')

// ---- the per-ASIN cache: what Chaptarr said, so a re-run does not re-ask -----
interface CachedEdition {
	fetchedAt: string
	/** null = the work resolved but carried no matching audiobook edition */
	edition: Pick<
		ChaptarrEdition,
		'asin' | 'durationSeconds' | 'audibleParts' | 'isAudibleExpectedMultipart'
	> | null
}
type Cache = Record<string, CachedEdition>
const loadCache = (): Cache => {
	if (!existsSync(CACHE_PATH)) return {}
	try {
		return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Cache
	} catch {
		console.error(`cache at ${CACHE_PATH} is unreadable; starting empty`)
		return {}
	}
}
const saveCache = (cache: Cache): void => {
	mkdirSync(dirname(CACHE_PATH), { recursive: true })
	writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1))
}

// Consecutive-failure stop, from the class that already owns that rule rather
// than a hand-kept counter. The ProviderRegistry breaker does not cover this
// call path; this instance is the script's own.
const breaker = new CircuitBreaker({ failureThreshold: 8 })

const hours = (ms: number) => ms / 3_600_000

/** One Chaptarr lookup: wait out a cooldown, retry once on a push-back. */
async function lookup(asin: string): Promise<CachedEdition['edition']> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		// This caller CAN afford to wait, so it does -- the transport sheds.
		while (chaptarrStandingDown()) await sleep(chaptarrStandDownMs() + 50)
		try {
			return await breaker.execute(async () => {
				const work = await fetchChaptarrWork(`az:${asin}`)
				const e = editionForAsin(work?.editions, asin)
				return e
					? {
							asin: e.asin,
							durationSeconds: e.durationSeconds,
							audibleParts: e.audibleParts,
							isAudibleExpectedMultipart: e.isAudibleExpectedMultipart
						}
					: null
			})
		} catch (err) {
			if (err instanceof CircuitOpenError) throw err
			// A push-back armed the transport cooldown; the loop above waits it out
			// and the SAME row is asked again, so a 429 slows the walk rather than
			// silently removing an album from it.
			if (attempt === 0 && chaptarrStandingDown()) continue
			throw err
		}
	}
	throw new Error('unreachable')
}

async function main(): Promise<void> {
	if (!chaptarrEnabled()) {
		console.error('CHAPTARR_ENABLED=false — nothing to audit against.')
		process.exit(2)
	}

	// ---- read Plex: albums, with per-track analysis state ------------------
	// Judged per ALBUM, never summed across albums that share an ASIN: two Plex
	// albums matched to one ASIN (the twin shape this library mints) must be two
	// rows, or a consolidated copy plus a truncated fragment reads as "long, not
	// damage" and the fragment is masked.
	const albums: (PlexAlbum & { box: string })[] = []
	let tracksSeen = 0
	let noAsin = 0
	for (const box of BOXES) {
		const xml = await fetchBoxXml(box, TOKEN, 10)
		const seen = (xml.match(/<Track /g) ?? []).length
		if (!seen) {
			throw new Error(
				`${box.name} returned ZERO tracks. Check the section id and the token — ` +
					'an audit of nothing must not report a clean library.'
			)
		}
		const found = albumsFromListing(xml)
		const asinTracks = found.reduce((n, a) => n + a.tracks.length, 0)
		tracksSeen += seen
		noAsin += seen - asinTracks
		for (const a of found) albums.push({ ...a, box: box.name })
		console.log(`  ${box.name}: ${seen} tracks -> ${found.length} ASIN-keyed album(s)`)
	}

	// Completeness is decided HERE, before anything is summed. A partially
	// analysed album sums to a clean fraction of its real length and reads as
	// "k of N parts" -- the truncation signature, manufactured by Plex not having
	// finished. Its unanalysed tracks are reported as exactly that, separately
	// from tracks that carry no ASIN: one is a permanent blind spot, the other
	// clears when Analyze runs, and conflating them hides the remedy.
	const complete = albums.filter((a) => a.tracks.every((t) => t.durationMs !== null))
	const partial = albums.length - complete.length
	const unanalysedTracks = albums.reduce(
		(n, a) => n + a.tracks.filter((t) => t.durationMs === null).length,
		0
	)
	console.log(
		`\n${albums.length} ASIN-keyed album(s) across ${tracksSeen} track(s) · ` +
			`${noAsin} track(s) carry no ASIN (UNCHECKABLE) · ` +
			`${unanalysedTracks} track(s) in ${partial} album(s) not yet analysed (run Analyze, then re-run)\n`
	)

	// ---- resolve, cached ---------------------------------------------------
	const cache = loadCache()
	const wanted = [...new Set(complete.map((a) => a.asin))]
	const uncached = wanted.filter((asin) => !(asin in cache))
	const toFetch = LIMIT > 0 ? uncached.slice(0, LIMIT) : uncached
	console.log(
		`${wanted.length} distinct ASIN(s) · ${wanted.length - uncached.length} cached · ` +
			`${toFetch.length} to look up` +
			(LIMIT > 0 && uncached.length > toFetch.length
				? ` (limited; ${uncached.length - toFetch.length} more uncached remain)`
				: '') +
			'\n'
	)
	const failed: string[] = []
	let stoppedEarly = false
	for (const asin of toFetch) {
		try {
			cache[asin] = { fetchedAt: new Date().toISOString(), edition: await lookup(asin) }
		} catch (err) {
			if (err instanceof CircuitOpenError) {
				stoppedEarly = true
				break
			}
			failed.push(asin)
		}
	}
	saveCache(cache)

	// ---- judge -------------------------------------------------------------
	interface Row {
		album: PlexAlbum & { box: string }
		band: DurationBand
		drift: number
		plexH: number
		wantH: number
		note: string
	}
	const rows: Row[] = []
	const counts: Record<DurationBand, number> = { agree: 0, report: 0, flag: 0, skip: 0 }
	let unresolved = 0
	for (const album of complete) {
		const cached = cache[album.asin]
		if (!cached) {
			unresolved += 1
			continue
		}
		const total = album.tracks.reduce((n, t) => n + (t.durationMs ?? 0), 0)
		const v = durationVerdict(total, cached.edition as ChaptarrEdition | null, album.asin)
		counts[v.band] += 1
		if (v.band === 'skip' || v.driftPct === null) continue
		rows.push({
			album,
			band: v.band,
			drift: v.driftPct,
			plexH: hours(total),
			wantH: (v.expectedSeconds ?? 0) / 3600,
			note: v.diagnosis ?? (v.exactAsin ? '' : 'variant match')
		})
	}

	// Two albums on one ASIN is itself a finding: name it, do not average it.
	const byAsin = new Map<string, number>()
	for (const a of complete) byAsin.set(a.asin, (byAsin.get(a.asin) ?? 0) + 1)
	const twins = [...byAsin].filter(([, n]) => n > 1)

	rows.sort((a, b) => b.drift - a.drift)
	const show = (band: DurationBand, heading: string) => {
		const some = rows.filter((r) => r.band === band)
		if (!some.length) return
		console.log(`\n${heading} (${some.length})`)
		for (const r of some) {
			console.log(
				`  ${r.drift.toFixed(1).padStart(5)}%  ${r.album.title.slice(0, 34).padEnd(34)} ` +
					`have ${r.plexH.toFixed(2)}h want ${r.wantH.toFixed(2)}h  ${r.album.asin}` +
					(twins.some(([asin]) => asin === r.album.asin)
						? `  [${r.album.box} rk ${r.album.key}]`
						: '') +
					(r.note ? `  ${r.note}` : '')
			)
		}
	}
	show('flag', 'FLAGGED — short enough to be missing content')
	show('report', 'REPORT — differs, but not damage on this evidence')
	if (twins.length) {
		console.log(
			`\nTWINS — one ASIN, more than one album (${twins.length}); each judged on its own above`
		)
		for (const [asin, n] of twins) console.log(`  ${asin}  ${n} albums`)
	}

	console.log(
		`\njudged ${rows.length + counts.skip} album(s) · agree ${counts.agree} · report ${counts.report} · ` +
			`flag ${counts.flag} · skip ${counts.skip} · ` +
			`not yet looked up ${unresolved} · lookup failures ${failed.length}`
	)
	if (failed.length) console.log(`  failed ASINs (re-run to retry): ${failed.join(' ')}`)
	if (stoppedEarly) {
		console.log(
			`\n⚠️  STOPPED EARLY: ${breaker.getStats().failures} consecutive lookup failures. ` +
				`Progress is cached; re-run to resume. This is a partial result, not a clean bill of health.`
		)
		process.exit(1)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})

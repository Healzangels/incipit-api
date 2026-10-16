/**
 * Report book-enrichment overlay entries a library cannot reach, and keys that
 * would reach the WRONG album. Exits 1 on either, 2 when it cannot run (missing
 * config, Plex unreachable, or an overlay file the load gate refuses).
 * Modelled on check:pins (scripts/checkPinLiveness.ts).
 *
 *   PLEX_URL=http://10.0.1.98:32400 PLEX_TOKEN=… PLEX_SECTION=6 \
 *     bun run check:overlay [--file <overlay.json>] [--full]
 *
 * The overlay file is --file, else BOOK_OVERLAY_PATH, else the container
 * default. It is compiled by the SAME gate the API runs at load, so a file this
 * accepts is a file the API serves.
 *
 * DEFAULT: ids only, plus title keys from the ONE bulk section listing. An entry
 * is live when its edition id is an album in the library, or when its title key
 * matches an album's (title, artist); a title key matching two albums is
 * ambiguous. Nothing is read through the API.
 *
 * --full additionally reads EVERY album through the API (INCIPIT_API, default
 * http://localhost:3737) to form narration keys from the served narrators. It
 * is slow and it is not free: a whole-library read has degraded the API's
 * caches and burned provider quota before. Use it deliberately, not by habit.
 * (`--ids-only` is accepted and means the default.)
 */
import { compileOverlay, overlayNarrationKey, overlayTitleKey } from '#helpers/overlay/bookOverlay'
import { albumsByTitleKey, overlayLiveness, plexAlbumRows } from '#helpers/overlay/overlayLiveness'
import { DEFAULT_BOOK_OVERLAY_PATH } from '#helpers/overlay/overlayStore'

const PLEX = process.env.PLEX_URL
const TOKEN = process.env.PLEX_TOKEN
const SECTION = process.env.PLEX_SECTION
const API = process.env.INCIPIT_API || 'http://localhost:3737'
const full = process.argv.includes('--full')
const fileArg = process.argv.indexOf('--file')
const FILE =
	(fileArg > 0 ? process.argv[fileArg + 1] : undefined) ||
	process.env.BOOK_OVERLAY_PATH ||
	DEFAULT_BOOK_OVERLAY_PATH

if (!PLEX || !TOKEN || !SECTION) {
	console.error('PLEX_URL, PLEX_TOKEN and PLEX_SECTION are required')
	process.exit(2)
}

let raw: unknown
try {
	raw = await Bun.file(FILE).json()
} catch (err) {
	console.error(`cannot read the overlay file ${FILE}: ${String(err)}`)
	process.exit(2)
}
const compiled = compileOverlay(raw)
if (!compiled.ok) {
	console.error(`the load gate REFUSES ${FILE} (the API would keep its last good table):`)
	for (const e of compiled.errors) console.error(`  ${e}`)
	process.exit(2)
}
const table = compiled.table

// The token rides a header, never the URL, so it cannot land in a log line.
const res = await fetch(`${PLEX}/library/sections/${SECTION}/all?type=9`, {
	headers: { 'X-Plex-Token': TOKEN, Accept: 'application/xml' }
})
if (!res.ok) {
	console.error(`plex returned ${res.status}`)
	process.exit(2)
}
const rows = plexAlbumRows(await res.text())
const liveIds = new Set(rows.map((r) => r.id))
const albumsByKey = albumsByTitleKey(rows)

let unreadable = 0
if (full) {
	// Same discipline as check:pins: four workers and a retry. At eight the API
	// failed a quarter of the reads under the checker's own load, and an
	// unreadable album reads as a dead entry -- the alarm manufactured itself.
	const WORKERS = 4
	const ATTEMPTS = 3
	const next = (function* () {
		yield* rows
	})()
	type Rec = {
		title?: string
		authors?: { name?: string }[]
		narrators?: { name?: string }[]
	}
	const read = async (id: string): Promise<Rec | null> => {
		for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
			try {
				const r = await fetch(`${API}/books/${id}?region=us`)
				if (r.ok) return (await r.json()) as Rec
			} catch {
				// fall through to the backoff
			}
			if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt))
		}
		return null
	}
	let done = 0
	await Promise.all(
		Array.from({ length: WORKERS }, async () => {
			for (const row of next) {
				const b = await read(row.id)
				if (!b) unreadable += 1
				else {
					// CAVEAT, as in check:pins: the served title is POST-pin, while the
					// lookup keys on the pre-pin title; a pin's displayTitle can only
					// understate key reach here, never invent it.
					const keys = new Set<string>()
					for (const a of b.authors ?? []) {
						const tk = overlayTitleKey(b.title, a?.name)
						if (tk) keys.add(tk)
						for (const n of b.narrators ?? []) {
							const nk = overlayNarrationKey(b.title, a?.name, n?.name)
							if (nk) keys.add(nk)
						}
					}
					for (const k of keys) {
						const have = albumsByKey.get(k) ?? []
						if (!have.includes(row.id)) albumsByKey.set(k, [...have, row.id])
					}
				}
				if (++done % 200 === 0) console.log(`  ...${done}/${rows.length}`)
			}
		})
	)
}

const report = overlayLiveness(table, liveIds, albumsByKey)
console.log(`overlay file      : ${FILE}`)
console.log(
	`mode              : ${full ? 'full (every album read through the API)' : 'ids + title keys from the Plex listing'}`
)
console.log(`albums scanned    : ${liveIds.size}`)
console.log(
	`entries served    : ${report.total} (drafts ${table.report.drafts}, held ${table.report.held.length})`
)
console.log(`reachable         : ${report.live.length}`)
console.log(`  of those, by KEY only (dead without it): ${report.byKeyOnly.length}`)
console.log(`DEAD              : ${report.dead.length}`)
console.log(`AMBIGUOUS keys    : ${report.ambiguous.length}`)
console.log(
	`title keys withheld by the loader (shared by 2+ editions): ${table.report.refusedTitleKeys.length}`
)
for (const r of table.report.refusedTitleKeys) console.log(`  ${r.key} -> ${r.editions.join(', ')}`)
if (!full)
	console.log('narration keys    : not checked (needs --full; the listing carries no narrators)')
if (unreadable)
	console.log(
		`UNREADABLE records: ${unreadable} — the API could not serve these, so their keys\n` +
			'                    are unknown and an entry needing one reads as dead.'
	)

let bad = false
if (report.ambiguous.length) {
	bad = true
	console.error('\nThese keys match MORE THAN ONE album, so an entry would reach a book it')
	console.error('was not written for:')
	for (const a of report.ambiguous)
		console.error(`  ${a.key.padEnd(56)} -> ${a.albums.length} albums: ${a.albums.join(', ')}`)
}
if (report.dead.length) {
	bad = true
	console.error('\nThese entries match no album, so their approved text is NOT being served:')
	for (const id of report.dead) {
		const e = table.byId.get(id)
		console.error(`  ${id.padEnd(24)} ${e?.edition.keys.title ?? ''}`)
	}
	console.error(
		'\nEither the album is not in this library or it was re-matched to an edition\n' +
			'the file does not know. Add that edition (it points at the same work) or drop the entry.'
	)
}
if (bad) process.exit(1)
console.log('\nevery entry is reachable, and no key is ambiguous')

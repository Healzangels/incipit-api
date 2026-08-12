/**
 * Report shelf pins a library cannot reach — and pins that would reach the WRONG
 * book. Exits non-zero on either.
 *
 * A pin is looked up by the matched edition's record id first and then by a
 * folded (title, author) key. Both can miss silently: a re-match changes the id,
 * and a library that has never been matched by this agent carries file-tag
 * titles that key to nothing. Nothing in the code or the data distinguishes a
 * dead pin from a working one, so the only honest check is against a real
 * library.
 *
 * The key also introduces a failure the edition id could not have: one key
 * matching TWO albums, so a pin applies to a book it was never stated for. This
 * script is the only place that can see it — mintPins has no library — so the
 * guarantee is checked here, not asserted at build time.
 *
 *   PLEX_URL=http://10.0.1.99:32400 PLEX_TOKEN=… PLEX_SECTION=63 bun run check:pins
 *
 * Reads each album's record from the API to compute its key the way applyPins
 * does (INCIPIT_API, default http://localhost:3737), so a full run takes a few
 * minutes on a large library. Pass --ids-only to skip that and check edition-id
 * liveness alone.
 *
 * Run it after a rebuild, after a batch of re-matches, and before trusting that
 * an operator decision is still in force.
 */
import { pinKey } from '#helpers/series/pinKey'
import { albumRecordIds, pinLiveness } from '#helpers/series/pinLiveness'
import { SHELF_PIN_KEYS,SHELF_PINS } from '#helpers/series/shelfPins.data'

const PLEX = process.env.PLEX_URL
const TOKEN = process.env.PLEX_TOKEN
const SECTION = process.env.PLEX_SECTION
const API = process.env.INCIPIT_API || 'http://localhost:3737'
const idsOnly = process.argv.includes('--ids-only')

if (!PLEX || !TOKEN || !SECTION) {
	console.error('PLEX_URL, PLEX_TOKEN and PLEX_SECTION are required')
	process.exit(2)
}

const res = await fetch(`${PLEX}/library/sections/${SECTION}/all?type=9&X-Plex-Token=${TOKEN}`)
if (!res.ok) {
	console.error(`plex returned ${res.status}`)
	process.exit(2)
}
const xml = await res.text()

// The agent's own guids carry the record id: incipit://<id>[_<region>]?lang=…
// ALBUM guids only — see albumRecordIds for why a bare scan is wrong.
const liveIds = albumRecordIds(xml)

/**
 * Album ids grouped by the key applyPins would compute for them.
 *
 * CAVEAT, stated rather than hidden: /books/:id runs applyPins, and a pin
 * carrying displayTitle REWRITES the title. For those albums the key computed
 * here is the post-pin title, which is not the string the lookup sees. Five of
 * the ninety pins carry a displayTitle, and on the library they were minted
 * against every one is reachable by edition id anyway, so this cannot turn a
 * live pin dead — it can only understate key reachability for those five.
 */
const albumsByKey = new Map<string, string[]>()
let unreadable = 0
if (!idsOnly) {
	const ids = [...liveIds]
	let done = 0
	// FOUR workers and a retry, not eight and none. Measured: at eight, 475 of
	// 1858 records failed — and every one of a 40-album serial sample then
	// returned 200. The gate was overloading the API and counting its own load as
	// evidence. That matters more here than anywhere: an unreadable record makes
	// a pin read as DEAD, so a checker that manufactures failures manufactures
	// exactly the alarm it exists to raise, and a gate that cries wolf is ignored.
	const WORKERS = 4
	const ATTEMPTS = 3
	const next = (function* () {
		yield* ids
	})()
	const read = async (id: string): Promise<{ title?: string; authors?: { name?: string }[] } | null> => {
		for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
			try {
				const r = await fetch(`${API}/books/${id}?region=us`)
				if (r.ok) return (await r.json()) as { title?: string; authors?: { name?: string }[] }
			} catch {
				// fall through to the backoff
			}
			if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt))
		}
		return null
	}
	await Promise.all(
		Array.from({ length: WORKERS }, async () => {
			for (const id of next) {
				const b = await read(id)
				// A record still unreadable after retries contributes no key, and that
				// CAN report a live pin dead: if the pin's own edition id is absent
				// from this library, the album that would have matched it by key is
				// the very one we failed to read. Counted and surfaced rather than
				// folded into the dead list — on prod the single remaining "dead" pin
				// was an Apple upstream 503, not a bad key.
				if (!b) unreadable += 1
				else
					for (const a of b.authors ?? []) {
						const k = pinKey(b.title, a?.name)
						if (k) albumsByKey.set(k, [...(albumsByKey.get(k) ?? []), id])
					}
				if (++done % 200 === 0) console.log(`  ...${done}/${ids.length}`)
			}
		})
	)
}

const report = pinLiveness(SHELF_PINS, liveIds, idsOnly ? {} : SHELF_PIN_KEYS, albumsByKey)
console.log(`albums scanned    : ${liveIds.size}`)
console.log(`pins defined      : ${report.total}`)
console.log(`reachable         : ${report.live.length}`)
console.log(`  of those, by KEY only (dead without it): ${report.byKeyOnly.length}`)
console.log(`DEAD              : ${report.dead.length}`)
console.log(`AMBIGUOUS keys    : ${report.ambiguous.length}`)
if (unreadable)
	console.log(
		`UNREADABLE records: ${unreadable} — the API could not serve these, so their key\n` +
			'                    is unknown and a pin needing one reads as dead.'
	)

let bad = false

if (report.ambiguous.length) {
	bad = true
	console.error('\nThese keys match MORE THAN ONE album, so the pin applies to a book it')
	console.error('was never stated for:')
	for (const a of report.ambiguous)
		console.error(`  ${a.key.padEnd(46)} -> ${a.albums.length} albums: ${a.albums.join(', ')}`)
	console.error(
		'\nTwo different books share a title and an author. Give the pin an edition\n' +
			'id that is present in THIS library, or drop it — a pin that fires on the\n' +
			'wrong book is worse than no pin.'
	)
}

if (report.dead.length) {
	bad = true
	console.error('\nThese pins match no album, so the decision they encode is NOT in force:')
	for (const key of report.dead) {
		const pin = SHELF_PINS[key]
		console.error(`  ${key.padEnd(14)} ${pin.series}${pin.position ? ` #${pin.position}` : ''}`)
	}
	console.error(
		'\nEither the album is not in this library, or its title and author key to\n' +
			'nothing (a library never matched by this agent carries file-tag titles).\n' +
			'Re-derive from the library and regenerate: edit\n' +
			'tests/fixtures/series-golden-corpus.json, then bun scripts/mintPins.ts'
	)
}

if (bad) process.exit(1)
console.log('\nevery pin is reachable, and no key is ambiguous')

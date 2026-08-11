/**
 * Report shelf pins that no library album can reach, and exit non-zero if any.
 *
 * A pin is keyed on the matched edition's record id, so a re-match changes the
 * key and the lookup silently misses (see pinLiveness.ts). Nothing in the code
 * or the data distinguishes a dead pin from a working one, so the only honest
 * check is against a real library.
 *
 *   PLEX_URL=http://10.0.1.99:32400 PLEX_TOKEN=… PLEX_SECTION=63 bun run check:pins
 *
 * Run it after a rebuild, after a batch of re-matches, and before trusting that
 * an operator decision is still in force.
 */
import { pinLiveness } from '#helpers/series/pinLiveness'
import { SHELF_PINS } from '#helpers/series/shelfPins.data'

const PLEX = process.env.PLEX_URL
const TOKEN = process.env.PLEX_TOKEN
const SECTION = process.env.PLEX_SECTION

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
const liveIds = new Set<string>()
for (const m of xml.matchAll(/incipit:\/\/([A-Za-z0-9-]+?)(?:_[a-z]{2})?\?/g)) liveIds.add(m[1])

const report = pinLiveness(SHELF_PINS, liveIds)
console.log(`albums scanned : ${liveIds.size}`)
console.log(`pins defined   : ${report.total}`)
console.log(`reachable      : ${report.live.length}`)
console.log(`DEAD           : ${report.dead.length}`)

if (report.dead.length) {
	console.error('\nThese pins match no album, so the decision they encode is NOT in force:')
	for (const key of report.dead) {
		const pin = SHELF_PINS[key]
		console.error(`  ${key.padEnd(14)} ${pin.series}${pin.position ? ` #${pin.position}` : ''}`)
	}
	console.error(
		'\nA pin is keyed on the matched EDITION id; a re-match changes it. Re-derive\n' +
			'the recordIds from the library and regenerate: edit\n' +
			'tests/fixtures/series-golden-corpus.json, then bun scripts/mintPins.ts'
	)
	process.exit(1)
}
console.log('\nevery pin is reachable')

/**
 * Daily canary for Chaptarr's wire (src/helpers/providers/chaptarrWireCheck.ts):
 * does the service still send what ChaptarrProvider reads, and do we still read it?
 *
 * Run it INSIDE the API container, where #helpers resolves to the deployed build:
 *
 *   docker exec incipit-api bun run check:chaptarr
 *
 * Exit status: 0 every check passed; 1 the wire or our reading of it changed (the
 * output names the field); 2 the reference work could not be reached at all (an
 * outage, not a drift -- worth a retry before anyone looks).
 */
import { runChaptarrWireCheck } from '#helpers/providers/chaptarrWireCheck'

const report = await runChaptarrWireCheck()
for (const c of report.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`)
if (report.unreachable) {
	console.log('UNREACHABLE: Chaptarr did not answer for the reference work')
	process.exit(2)
}
const failed = report.checks.filter((c) => !c.ok).length
console.log(
	failed
		? `DRIFT: ${failed} of ${report.checks.length} checks failed`
		: `OK: ${report.checks.length} checks`
)
process.exit(failed ? 1 : 0)

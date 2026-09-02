/**
 * Does the file on disk hold the whole book?
 *
 * Nothing else in this stack can answer that. `mvhd` lies -- Shadows Linger's
 * header claimed 1412.69 min for a 635 min book, and I read that as ~13 hours of
 * foreign audio and told the operator to delete a GOOD file. Bitrate proves
 * nothing here either: this shelf encodes anywhere from 64 to 145 kbps, so
 * "implausibly large for spoken word" is not a measurement. And Plex's analysed
 * duration, while authoritative, only ever reports what IS on disk.
 *
 * Chaptarr answers the missing half: how long the edition SHOULD be, keyed by
 * ASIN. Measured 2026-08-26 against Plex's analysed durations -- Soldiers Live
 * 19.53 vs 19.49, Shadows Linger 10.55 vs 10.59, The Dreaming Void 22.58 vs
 * 22.63. Agreement within 0.4% across the board, while the TRUNCATED Soldiers
 * Live was 66% short. The bands below sit in that gap, which is wide.
 *
 * This is a LIBRARY-time signal about completeness, distinct from the matcher's
 * SEARCH-time duration veto, which is about which edition to pick.
 */
import type { ChaptarrEdition } from '#helpers/providers/ChaptarrProvider'

/** Below this is agreement. All three measured matches land under 0.4%. */
export const AGREE_PCT = 2
/** Above this, a SHORT file is damage rather than an edition difference. */
export const FLAG_PCT = 10
/**
 * How far a file may sit from a k/N boundary, in units of ONE PART. Measured in
 * part units the windows can never overlap, so nearest-k and first-fit coincide
 * and an ambiguous shortfall yields no diagnosis rather than a confident wrong
 * one. A tolerance relative to k*part widened with k and, past four parts, let
 * "4 of 8" win over a nearer "5 of 8".
 */
const PART_TOLERANCE = 0.15

export type DurationBand = 'agree' | 'report' | 'flag' | 'skip'
export type DurationDirection = 'short' | 'long' | 'exact'

export interface DurationVerdict {
	band: DurationBand
	/** Which way it differs. Only `short` can flag -- see the band logic. */
	direction: DurationDirection
	/** |plex - expected| / expected, as a percentage. Null when skipped. */
	driftPct: number | null
	expectedSeconds: number | null
	/** True when the edition's own asin matched; false when matched via a variant. */
	exactAsin: boolean
	reason: string
	/** Set only when the shortfall lands on a clean k/N of a multipart title. */
	diagnosis?: string
}

const skip = (reason: string): DurationVerdict => ({
	band: 'skip',
	direction: 'exact',
	driftPct: null,
	expectedSeconds: null,
	exactAsin: false,
	reason
})

/**
 * Which k of N parts does this duration look like, if any?
 *
 * A truncated merge does not lose a random slice -- it loses whole PARTS, so the
 * shortfall lands near k/N of the expected total. Soldiers Live was 6.56h of a
 * 19.53h three-part title: 1 of 3, to within a percent. Reporting that turns
 * "short by 66%" into "holds part 1 of 3", which names the remedy.
 * @param {number} plexSeconds analysed duration of the file on disk
 * @param {number} expected the edition's full duration
 * @param {number} parts how many parts Audible ships
 * @returns {string | undefined} the diagnosis, when one fits
 */
function partDiagnosis(plexSeconds: number, expected: number, parts: number): string | undefined {
	if (parts < 2 || expected <= 0) return undefined
	const part = expected / parts
	// Nearest k, then a window measured in part units -- never first-fit.
	const k = Math.round(plexSeconds / part)
	if (k < 1 || k >= parts) return undefined
	if (Math.abs(plexSeconds - k * part) > PART_TOLERANCE * part) return undefined
	return `looks like ${k} of ${parts} part(s)`
}

/**
 * Compare a file's analysed duration against what Chaptarr says the edition is.
 *
 * Bands are decided on CROSS-MULTIPLIED integers, not on a divided percentage:
 * `(a / b) * 100` is float-noisy at exactly 2% and 10%, landing either side
 * depending on `b` (a file exactly 2% short of 60s reads 1.9999…, of 70308s
 * reads 2.0000…5). The spec says `< 2%` agrees and `> 10%` flags; this is that,
 * exactly.
 *
 * ASYMMETRIC ON PURPOSE. Only a SHORT file means missing content, which is the
 * failure this exists to catch -- Soldiers Live was a third of its book. A file
 * LONGER than expected is almost always an edition difference or bonus
 * material, not damage: the first live run flagged a pirateaba Wandering Inn
 * volume at 42.38h against an expected 38.25h, where Chaptarr's own record was
 * internally inconsistent. Treating that as damage trains the operator to
 * ignore the flag, and an ignored flag is the same as no oracle.
 *
 * ⚠️ A VARIANT match never flags. `editionForAsin` prefers an exact asin but can
 * still resolve through `providerIdsAll.az` to a PARENT edition whose duration
 * legitimately differs. Those rows are capped at `report` however far they
 * drift. A false alarm here is exactly what cost a file once already.
 * @param {number} plexMs analysed Part duration in milliseconds
 * @param {ChaptarrEdition | null} edition the resolved edition, or null
 * @param {string} askedAsin the ASIN the caller looked up
 * @returns {DurationVerdict} band, drift and diagnosis
 */
export function durationVerdict(
	plexMs: number,
	edition: ChaptarrEdition | null,
	askedAsin: string
): DurationVerdict {
	if (!edition) return skip('no chaptarr edition for this asin')
	const expected = edition.durationSeconds
	// Absent is not zero. Treating a missing duration as 0 would report every
	// such row as 100% drift -- an alarm built out of missing data.
	if (typeof expected !== 'number' || expected <= 0) {
		return skip('edition carries no durationSeconds')
	}
	if (!(plexMs > 0)) return skip('no analysed duration on the file')

	const plexSeconds = plexMs / 1000
	const expectedMs = expected * 1000
	const diffMs = Math.abs(plexMs - expectedMs)
	const driftPct = (diffMs / expectedMs) * 100
	const direction: DurationDirection =
		plexMs < expectedMs ? 'short' : plexMs > expectedMs ? 'long' : 'exact'
	const exactAsin = (edition.asin ?? '').toUpperCase() === askedAsin.toUpperCase()
	// diff/expected >= pct/100  <=>  diff*100 >= pct*expected, all integers-ish.
	const atLeast = (pct: number) => diffMs * 100 >= pct * expectedMs
	const over = (pct: number) => diffMs * 100 > pct * expectedMs

	// ONE ordered chain producing band and reason together, so a threshold or
	// direction rule can never be changed in one and not the other.
	let band: DurationBand
	let reason: string
	if (!atLeast(AGREE_PCT)) {
		band = 'agree'
		reason = 'within tolerance'
	} else if (!over(FLAG_PCT)) {
		band = 'report'
		reason = 'differs, but inside the edition-difference band'
	} else if (direction === 'long') {
		band = 'report'
		reason = 'longer than the edition: usually a different edition or bonus content, not damage'
	} else if (!exactAsin) {
		band = 'report'
		reason = 'matched via an az variant, so the parent edition may differ; not flagged'
	} else {
		band = 'flag'
		reason = 'short enough to be missing content'
	}

	const diagnosis =
		band === 'flag' && edition.isAudibleExpectedMultipart
			? partDiagnosis(plexSeconds, expected, (edition.audibleParts ?? []).length)
			: undefined

	return {
		band,
		direction,
		driftPct,
		expectedSeconds: expected,
		exactAsin,
		reason,
		...(diagnosis ? { diagnosis } : {})
	}
}

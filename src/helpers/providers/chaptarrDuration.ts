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

/** Agreement ceiling. All three measured matches land under 0.4%. */
export const AGREE_PCT = 2
/** Above this it is damage, not an edition difference. */
export const FLAG_PCT = 10
/** How close k/N must be to count as "holds k of N parts". */
const PART_TOLERANCE = 0.15

export type DurationBand = 'agree' | 'report' | 'flag' | 'skip'

export interface DurationVerdict {
	band: DurationBand
	/** Which way it differs. Only `short` can flag -- see the band logic. */
	direction: 'short' | 'long' | 'exact'
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
	for (let k = 1; k < parts; k += 1) {
		const want = (expected * k) / parts
		if (Math.abs(plexSeconds - want) / want <= PART_TOLERANCE) {
			return `looks like ${k} of ${parts} part(s)`
		}
	}
	return undefined
}

/**
 * Compare a file's analysed duration against what Chaptarr says the edition is.
 *
 * ⚠️ A VARIANT match never flags. `editionForAsin` resolves through
 * `providerIdsAll.az`, so asking for a regional ASIN can return the PARENT
 * edition -- whose duration may legitimately differ. That is the main
 * false-positive source, so those rows are capped at `report` however far they
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
	const driftPct = (Math.abs(plexSeconds - expected) / expected) * 100
	const exactAsin = (edition.asin ?? '').toUpperCase() === askedAsin.toUpperCase()

	const direction = plexSeconds < expected ? 'short' : plexSeconds > expected ? 'long' : 'exact'

	// ASYMMETRIC ON PURPOSE. Only a SHORT file means missing content, which is the
	// failure this exists to catch -- Soldiers Live was a third of its book. A file
	// LONGER than expected is almost always an edition difference or bonus
	// material, not damage: the first live run flagged a pirateaba Wandering Inn
	// volume at 42.38h against an expected 38.25h, where Chaptarr's own record was
	// internally inconsistent (isAudibleExpectedMultipart false, yet four parts
	// listed). Treating that as damage trains the operator to ignore the flag, and
	// an ignored flag is the same as no oracle.
	let band: DurationBand = 'agree'
	if (driftPct > FLAG_PCT) band = direction === 'short' ? 'flag' : 'report'
	else if (driftPct > AGREE_PCT) band = 'report'

	if (band === 'flag' && !exactAsin) {
		return {
			band: 'report',
			direction,
			driftPct,
			expectedSeconds: expected,
			exactAsin,
			reason: 'matched via an az variant, so the parent edition may differ; not flagged'
		}
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
		reason:
			band === 'agree'
				? 'within tolerance'
				: band === 'report'
					? direction === 'long' && driftPct > FLAG_PCT
						? 'longer than the edition: usually a different edition or bonus content, not damage'
						: 'differs, but inside the edition-difference band'
					: 'short enough to be missing content',
		...(diagnosis ? { diagnosis } : {})
	}
}

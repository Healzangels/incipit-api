import type { ScoredCandidate } from '#helpers/providers/types'

/**
 * Cover art borrowed between candidates that SCORED THE SAME but did not merge.
 *
 * dedupe collapses editions it can prove are one record; everything else stays
 * separate. So a search routinely ends with two rows a point apart — "The
 * Testaments (TV Tie-in)" at 100 and "The Testaments" at 99 — which are plainly
 * the same recording in different packaging, each carrying its own art. Match
 * either one and you see only its own cover.
 *
 * This is a strictly larger source than dedupe's merged-group alternates, for
 * the obvious reason: near-ties are precisely the rows dedupe DECLINED to merge.
 *
 * MEASURED before building, across 30 real library books: 29 had a near-tie
 * inside two points, and 21 of those pairs shared a narrator set — roughly 0.7
 * extra covers per book.
 *
 * THE NARRATOR RULE IS WHAT MAKES IT SAFE, and the same measurement is why it
 * is shaped this way. Of the pairs that did NOT share narrators, almost all were
 * ABSENT rather than conflicting (a Hardcover print row simply lists none), and
 * exactly one was a real conflict: "The Restaurant at the End of the Universe"
 * offering Zannie Adams beside Martin Freeman — a different recording, and
 * exactly what must be refused. So absence is not a match: it is an absence of
 * evidence, and it is where the print rows live.
 *
 * Everything here only ever ADDS to `coverAlternates`. No candidate's own cover,
 * confidence or order changes, so a wrong borrow is a spare tile rather than a
 * changed poster.
 */

/**
 * How close two confidences must be to count as the same answer. Two points:
 * the measured shape is a 100/99 pair, and the band has to stay well under the
 * gap that separates a real alternative edition from a different book.
 */
const CONFIDENCE_BAND = 0.02

/** Hosts whose art is audiobook packaging rather than a print jacket. */
const AUDIO_PROVIDERS = new Set(['audible', 'apple', 'storytel'])

/**
 * Strip an Amazon size modifier so one picture at two sizes compares equal —
 * otherwise `._SL500_` and `._SX450_` would both be offered.
 */
function coverAsset(url: string): string {
	return url.replace(/\._[A-Z0-9,]+_\.(jpg|jpeg|png)(?=$|\?)/i, '.$1')
}

/**
 * Case- and order-insensitive narrator key, with WHITESPACE COLLAPSED.
 *
 * The collapse is not tidiness: the same book came back as `Martin Freeman` and
 * `Martin  Freeman` (double space) in the measurement, and without this the
 * rule rejects a genuine match and silently halves the yield.
 *
 * Returns '' when the row names no narrators, which the caller treats as "no
 * evidence" rather than "matches".
 */
function narratorKey(c: ScoredCandidate): string {
	const names = (c.narrators ?? [])
		.map((n) => (n ?? '').toLowerCase().replace(/\s+/g, ' ').trim())
		.filter(Boolean)
	return [...names].sort().join('|')
}

/** Audiobook packaging, not a print scan. A runtime is positive evidence too. */
function isAudioArt(c: ScoredCandidate): boolean {
	return AUDIO_PROVIDERS.has(c.provider) || c.audioSeconds != null
}

/**
 * Add each candidate's near-tie siblings' covers to its `coverAlternates`.
 *
 * Symmetric by design: the operator may match EITHER row, so both must offer
 * the other's art — that is the whole point of the request this implements.
 * @param {ScoredCandidate[]} candidates the ranked, deduped candidates
 * @returns {ScoredCandidate[]} the same candidates, with alternates extended
 */
export function withNearTieAlternates(candidates: ScoredCandidate[]): ScoredCandidate[] {
	if (!candidates || candidates.length < 2) return candidates ?? []
	return candidates.map((c) => {
		const key = narratorKey(c)
		// No narrators on THIS row means nothing can corroborate a borrow.
		if (!key || !isAudioArt(c)) return c
		const own = new Set(
			[...(c.coverAlternates ?? []), c.cover].filter(Boolean).map((u) => coverAsset(u as string))
		)
		const extra: string[] = []
		for (const other of candidates) {
			if (other === c || !other.cover || !isAudioArt(other)) continue
			if (Math.abs((other.confidence ?? 0) - (c.confidence ?? 0)) > CONFIDENCE_BAND) continue
			if (narratorKey(other) !== key) continue
			const asset = coverAsset(other.cover)
			if (own.has(asset) || extra.some((u) => coverAsset(u) === asset)) continue
			extra.push(other.cover)
		}
		if (!extra.length) return c
		return { ...c, coverAlternates: [...(c.coverAlternates ?? []), ...extra] }
	})
}

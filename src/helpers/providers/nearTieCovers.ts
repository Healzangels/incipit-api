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
 * ONE EXCEPTION, added 2026-08-01 after the rule failed the book it was built
 * for: the AUTHOR credited as a narrator. Margaret Atwood reads part of The
 * Testaments, so two listings name her among the narrators and a third does not
 * -- and that third is the record the album is matched to, so exact-set equality
 * left it with nothing over a single name. See {@link castsAgree} for how narrow
 * the exception is and what a fresh 45-book measurement said it costs.
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

/**
 * Strip an Amazon size modifier so one picture at two sizes compares equal —
 * otherwise `._SL500_` and `._SX450_` would both be offered.
 */
function coverAsset(url: string): string {
	return url.replace(/\._[A-Z0-9,]+_\.(jpg|jpeg|png)(?=$|\?)/i, '.$1')
}

/**
 * Case- and order-insensitive name set, with WHITESPACE COLLAPSED.
 *
 * The collapse is not tidiness: the same book came back as `Martin Freeman` and
 * `Martin  Freeman` (double space) in the measurement, and without it the rule
 * rejects a genuine match and silently halves the yield.
 */
function nameSet(names: (string | null | undefined)[] | null | undefined): Set<string> {
	return new Set(
		(names ?? []).map((n) => (n ?? '').toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean)
	)
}

function narratorSet(c: ScoredCandidate): Set<string> {
	return nameSet(c.narrators)
}

function authorSet(c: ScoredCandidate): Set<string> {
	return nameSet(c.authors)
}

/**
 * How many names the two casts may differ by. Two, because a book can credit a
 * co-author pair, and because this cap is the ONLY thing standing between the
 * author exception and a polluted `authors` field: measured over 45 library
 * books, the largest `authors` array any provider returned was 44 NAMES -- a
 * full-cast production filing its entire cast as authors. Without the cap, one
 * such row could unlock a 44-name difference and lend art between genuinely
 * different castings.
 */
const MAX_AUTHOR_DIFF = 2

/**
 * Whether two rows describe the same recording, judged on their casts.
 *
 * Equal sets are the base rule and the measured majority (50 of 55 near-tie
 * pairs across 45 books). The exception is one specific, harmless cataloguing
 * disagreement: THE AUTHOR CREDITED AS A NARRATOR. Margaret Atwood reads part of
 * The Testaments, so two listings name her among the narrators and a third does
 * not -- and that third is the record the book is matched to, which is how this
 * surfaced. Jim Butcher does the same on Brief Cases.
 *
 * So the sets may differ, but ONLY by names both rows already call an author,
 * only by at most {@link MAX_AUTHOR_DIFF} of them, and only when the rows still
 * share a narrator. An author credit is a fact about who is in the booth for the
 * afterword; it is not evidence of a different recording.
 *
 * MEASURED before shipping, over 45 library books: this admits exactly one extra
 * pair, and refuses every hard case in the sample -- White Sand's full-cast
 * variants (19-40 names apart), Golden Son's GraphicAudio dramatisation against
 * the regular reading, and The Girl with the Dragon Tattoo's UK Martin Wenner
 * against the US Simon Vance. Run against candidate data only, i.e. exactly what
 * this function can see, it agreed with a library-truth oracle on every pair.
 * @param {ScoredCandidate} a one candidate
 * @param {ScoredCandidate} b the other
 * @returns {boolean} true when their casts agree
 */
function castsAgree(a: ScoredCandidate, b: ScoredCandidate): boolean {
	const na = narratorSet(a)
	const nb = narratorSet(b)
	const diff = [...na].filter((n) => !nb.has(n)).concat([...nb].filter((n) => !na.has(n)))
	// Equal casts agree -- unless there is no cast. Two rows naming no narrators
	// have an empty difference and would otherwise "agree" on nothing at all,
	// which is where the print records live.
	if (!diff.length) return na.size > 0
	if (diff.length > MAX_AUTHOR_DIFF) return false
	// Some cast in common. This also settles the MIXED case, where one row names
	// narrators and the other names none: an empty set shares nobody, so it is
	// refused here rather than by a separate emptiness guard -- a guard that
	// checked only one side would be subsumed by this line and untestable.
	if (![...na].some((n) => nb.has(n))) return false
	const bAuthors = authorSet(b)
	const shared = new Set([...authorSet(a)].filter((n) => bAuthors.has(n)))
	return diff.every((n) => shared.has(n))
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
		// No early narrator check here on purpose. `castsAgree` is the SINGLE
		// authority on whether two rows describe the same recording, and a guard
		// here that repeated part of its job made the corresponding check inside
		// it unreachable -- an equivalent mutant, i.e. logic no test could pin.
		// A row naming no narrators simply agrees with nothing.
		const own = new Set(
			[...(c.coverAlternates ?? []), c.cover].filter(Boolean).map((u) => coverAsset(u as string))
		)
		const extra: string[] = []
		for (const other of candidates) {
			if (other === c || !other.cover) continue
			if (Math.abs((other.confidence ?? 0) - (c.confidence ?? 0)) > CONFIDENCE_BAND) continue
			if (!castsAgree(c, other)) continue
			const asset = coverAsset(other.cover)
			if (own.has(asset) || extra.some((u) => coverAsset(u) === asset)) continue
			extra.push(other.cover)
		}
		if (!extra.length) return c
		return { ...c, coverAlternates: [...(c.coverAlternates ?? []), ...extra] }
	})
}

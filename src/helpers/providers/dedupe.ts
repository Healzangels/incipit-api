import type { ScoredCandidate } from '#helpers/providers/types'

/**
 * Collapse candidates that refer to the same edition/book across providers,
 * keeping the best one per group.
 *
 * The fan-out routinely surfaces the same thing more than once — Audible and
 * Hardcover both carry the same ASIN, and Hardcover and OpenLibrary both return a
 * book-level entry for a title with no audio edition. Dedup is edition-aware so
 * it does NOT merge genuinely different editions (which the duration signal is
 * meant to choose between):
 *  - same ASIN            -> same edition (even across providers)
 *  - same title+author+~runtime (no ASIN) -> same audio edition
 *  - same title+author, no runtime        -> same book-level entry
 */

/** Lowercased, alphanumeric-only key fragment. */
function normKey(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The identity key a candidate dedupes on. */
function dedupeKey(c: ScoredCandidate): string {
	if (c.asin) return `asin:${c.asin.toUpperCase()}`
	const title = normKey(c.title)
	const author = normKey(c.authors[0] ?? '')
	if (c.audioSeconds != null) {
		// Bucket to the nearest minute so near-identical runtimes from different
		// sources collapse, while distinct editions (which carry ASINs) do not
		// reach this branch.
		const minutes = Math.round(c.audioSeconds / 60)
		return `dur:${title}|${author}|${minutes}`
	}
	return `book:${title}|${author}`
}

/** How much usable data a candidate carries — the tie-breaker within a group. */
function richness(c: ScoredCandidate): number {
	return (
		(c.asin ? 1 : 0) +
		(c.audioSeconds != null ? 1 : 0) +
		(c.narrators.length ? 1 : 0) +
		(c.cover ? 1 : 0)
	)
}

/** True if `a` should win its group over the incumbent `b`. */
function isBetter(a: ScoredCandidate, b: ScoredCandidate): boolean {
	if (a.confidence !== b.confidence) return a.confidence > b.confidence
	return richness(a) > richness(b)
}

/**
 * Dedupe a scored candidate list, keeping the highest-confidence (then richest)
 * candidate per identity key. Input order is otherwise preserved for stability.
 * @param {ScoredCandidate[]} candidates scored candidates (any order)
 * @returns {ScoredCandidate[]} one candidate per distinct edition/book
 */
export function dedupeCandidates(candidates: ScoredCandidate[]): ScoredCandidate[] {
	const byKey = new Map<string, ScoredCandidate>()
	for (const c of candidates) {
		const key = dedupeKey(c)
		const existing = byKey.get(key)
		if (!existing || isBetter(c, existing)) byKey.set(key, c)
	}
	return [...byKey.values()]
}

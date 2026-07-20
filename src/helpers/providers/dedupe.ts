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

/**
 * The identity keys a candidate shares with its duplicates. A candidate is the
 * SAME edition as another if they share ANY key:
 *  - `asin:<ASIN>`                    — same store listing.
 *  - `dur:<title>|<author>|<minutes>` — same audio content: identical
 *    title+author+runtime-to-the-minute IS the same audiobook even under a
 *    DIFFERENT store ASIN (a regional re-release lists the same narration under
 *    a new ASIN). Editions that genuinely differ carry a different runtime, so
 *    they land in a different minute bucket and stay separate.
 *  - `book:<title>|<author>`          — a book-level entry with no audio edition.
 * Returning multiple keys (via union-find below) collapses a re-release cluster
 * that a single ASIN-first key would leave as N look-alike candidates.
 */
function dedupeKeys(c: ScoredCandidate): string[] {
	const keys: string[] = []
	if (c.asin) keys.push(`asin:${c.asin.toUpperCase()}`)
	const title = normKey(c.title)
	const author = normKey(c.authors[0] ?? '')
	if (c.audioSeconds != null) {
		keys.push(`dur:${title}|${author}|${Math.round(c.audioSeconds / 60)}`)
	} else if (!c.asin) {
		keys.push(`book:${title}|${author}`)
	}
	return keys
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
	const n = candidates.length
	// Union-find: a candidate can share MORE than one identity key (an ASIN and a
	// runtime), so a single-key map can't express "same as A via ASIN, same as B
	// via runtime". Union everything that shares any key, then keep the best per
	// group.
	const parent = Array.from({ length: n }, (_, i) => i)
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	const firstByKey = new Map<string, number>()
	candidates.forEach((c, i) => {
		for (const key of dedupeKeys(c)) {
			const prev = firstByKey.get(key)
			if (prev === undefined) firstByKey.set(key, i)
			else parent[find(i)] = find(prev)
		}
	})

	// Best (highest confidence, then richest) representative per group.
	const best = new Map<number, ScoredCandidate>()
	candidates.forEach((c, i) => {
		const root = find(i)
		const cur = best.get(root)
		if (!cur || isBetter(c, cur)) best.set(root, c)
	})

	// One winner per group, in first-seen group order for stability.
	const emitted = new Set<number>()
	const out: ScoredCandidate[] = []
	candidates.forEach((_, i) => {
		const root = find(i)
		if (!emitted.has(root)) {
			emitted.add(root)
			out.push(best.get(root) as ScoredCandidate)
		}
	})
	return out
}

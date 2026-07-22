import type { ScoredCandidate } from '#helpers/providers/types'
import { normalizeLanguage } from '#helpers/utils/language'

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
 *
 * `pinnedAsin` (the caller's explicitly-hinted ASIN, uppercased) makes the
 * group-winner choice pin-aware: dedupe runs BEFORE the ranker's pinned-first
 * tiebreak, so without this a same-runtime-bucket rival that wins on richness
 * would delete the pinned candidate — and with it the one identity the caller
 * asked for by name — before that tiebreak ever executes.
 * @param {ScoredCandidate[]} candidates scored candidates (any order)
 * @param {string | null} pinnedAsin definitive ASIN to keep as its group's winner
 * @returns {ScoredCandidate[]} one candidate per distinct edition/book
 */
export function dedupeCandidates(
	candidates: ScoredCandidate[],
	pinnedAsin: string | null = null
): ScoredCandidate[] {
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
	// A dur:/book: key match is only "the same edition" when the languages don't
	// positively CONFLICT: a German narration can land in the same minute bucket
	// as the English one (translations run close), but it is a different edition
	// — merging them deletes one language from the results before the ranker's
	// language preference ever runs.
	//
	// The conflict check compares whole GROUP language sets on BOTH sides, not
	// individual tags: union-find is transitive while pairwise compatibility is
	// not. Checking only the occupant group against the joiner's OWN tag closed
	// the first-level bridge (an unknown-language candidate merging en and de)
	// but left the same hole one level deeper — a multi-key candidate with no
	// language of its own joins the en group via its asin: key, then its dur:
	// key dragged that whole group into a fr group. Each root carries the set
	// of known languages among its members; a merge is blocked when the two
	// groups' known languages conflict, and completing one unions the sets. An
	// asin: match stays unconditional — the same store listing IS the same
	// edition, whatever language each provider claims — but still merges the
	// language sets so later dur:/book: checks see the union.
	const keyLists = new Map<string, number[]>()
	const byKey = (key: string): number[] => {
		let list = keyLists.get(key)
		if (!list) {
			list = []
			keyLists.set(key, list)
		}
		return list
	}
	const rootLangs = new Map<number, Set<string>>()
	const langs = candidates.map((c) => normalizeLanguage(c.language))
	const knownLangs = (root: number): Set<string> => {
		let set = rootLangs.get(root)
		if (!set) {
			set = new Set<string>()
			rootLangs.set(root, set)
		}
		return set
	}
	const groupsConflict = (a: number, b: number): boolean => {
		if (a === b) return false
		const left = rootLangs.get(a)
		const right = rootLangs.get(b)
		if (!left?.size || !right?.size) return false
		for (const x of left) for (const y of right) if (x !== y) return true
		return false
	}
	const union = (i: number, into: number): void => {
		const ri = find(i)
		const rt = find(into)
		if (ri === rt) return
		parent[ri] = rt
		const merged = knownLangs(rt)
		for (const lang of rootLangs.get(ri) ?? []) merged.add(lang)
		rootLangs.delete(ri)
	}
	candidates.forEach((c, i) => {
		if (langs[i] != null) knownLangs(find(i)).add(langs[i] as string)
		for (const key of dedupeKeys(c)) {
			const prev = byKey(key)
			if (prev.length === 0) {
				prev.push(i)
				continue
			}
			if (key.startsWith('asin:')) {
				union(i, prev[0])
			} else {
				const root = find(i)
				const compatible = prev.find((p) => !groupsConflict(find(p), root))
				if (compatible !== undefined) union(i, compatible)
			}
			prev.push(i)
		}
	})

	// Best (highest confidence, then richest) representative per group — plus the
	// best ASIN-BEARING member, tracked separately: a group can merge an
	// ASIN-less candidate (via its dur: key) that wins isBetter over the one
	// carrying the real store ASIN, and emitting it as-is would discard the one
	// identity key the caller can act on. The winner keeps its own metadata; only
	// the missing ASIN is grafted from a losing member.
	const best = new Map<number, ScoredCandidate>()
	const bestWithAsin = new Map<number, ScoredCandidate>()
	// Same reasoning for the DESCRIPTIVE fields a losing member may carry. A group
	// is one edition, so a field only one member has still describes the winner --
	// and dropping it loses real data. Measured live: a sidecar pinned "The Blade
	// Itself" to a Hardcover edition with NO narrator, which then collapsed the
	// same-runtime Audible record narrated by Steven Pacey. The richer row was
	// deleted, so the book matched with no narrator at all and the Pacey edition
	// could not even be picked from the Fix Match list.
	const bestWithNarrators = new Map<number, ScoredCandidate>()
	const bestWithCover = new Map<number, ScoredCandidate>()
	// The pin outranks confidence/richness INSIDE a group too: the ranker's
	// pinned-first tiebreak runs after dedupe, so a pinned candidate that loses
	// its group here is gone before that tiebreak exists.
	const isPinned = (c: ScoredCandidate): boolean =>
		pinnedAsin != null && c.asin?.toUpperCase() === pinnedAsin
	candidates.forEach((c, i) => {
		const root = find(i)
		const cur = best.get(root)
		if (
			!cur ||
			(isPinned(c) && !isPinned(cur)) ||
			(isPinned(c) === isPinned(cur) && isBetter(c, cur))
		)
			best.set(root, c)
		if (c.asin) {
			const curAsin = bestWithAsin.get(root)
			if (!curAsin || isBetter(c, curAsin)) bestWithAsin.set(root, c)
		}
		if (c.narrators?.length) {
			const curNarr = bestWithNarrators.get(root)
			if (!curNarr || isBetter(c, curNarr)) bestWithNarrators.set(root, c)
		}
		if (c.cover) {
			const curCover = bestWithCover.get(root)
			if (!curCover || isBetter(c, curCover)) bestWithCover.set(root, c)
		}
	})

	// One winner per group, in first-seen group order for stability.
	const emitted = new Set<number>()
	const out: ScoredCandidate[] = []
	candidates.forEach((_, i) => {
		const root = find(i)
		if (!emitted.has(root)) {
			emitted.add(root)
			const winner = best.get(root) as ScoredCandidate
			// Graft only what the winner is MISSING -- its own values always win.
			const asinDonor = winner.asin ? null : bestWithAsin.get(root)
			const narrDonor = winner.narrators?.length ? null : bestWithNarrators.get(root)
			const coverDonor = winner.cover ? null : bestWithCover.get(root)
			if (asinDonor || narrDonor || coverDonor) {
				out.push({
					...winner,
					asin: asinDonor ? asinDonor.asin : winner.asin,
					narrators: narrDonor ? narrDonor.narrators : winner.narrators,
					cover: coverDonor ? coverDonor.cover : winner.cover
				})
			} else {
				out.push(winner)
			}
		}
	})
	return out
}

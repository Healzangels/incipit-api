import { coverAsset } from '#helpers/providers/nearTieCovers'
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
 * Canonical ordering on INTRINSIC identity — provider, native id, ASIN, title —
 * so any comparison that falls all the way through to it is a total order.
 *
 * Everything upstream of the ranker preserves ARRIVAL order: the fan-out
 * concatenates providers in registry order, each provider returns its API's
 * order, and Array.sort is stable. So every genuine tie used to be decided by
 * whichever row happened to arrive first — deterministic on a warm cache
 * (verified: six identical runs), but a cache expiry, provider timeout, or open
 * breaker reorders arrivals and flips ties. Measured across a deploy on
 * 2026-07-28: 73 albums changed their top match, every one sitting in a
 * multi-candidate tie at exactly 0.850. Ranking must be a pure function of the
 * candidate SET, never of arrival order.
 *
 * Plain code-unit comparison, not localeCompare: ICU collation varies by
 * runtime and locale, which would reintroduce the exact instability this
 * exists to remove.
 */
export function byCandidateIdentity(a: ScoredCandidate, b: ScoredCandidate): number {
	const ka = `${a.provider}\u0000${a.id}\u0000${a.asin ?? ''}\u0000${a.title}`
	const kb = `${b.provider}\u0000${b.id}\u0000${b.asin ?? ''}\u0000${b.title}`
	return ka < kb ? -1 : ka > kb ? 1 : 0
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

/**
 * True if `a` should win its group over the incumbent `b`.
 *
 * No audio-vs-print arm below richness, deliberately (considered 2026-07-28):
 * a row with NEITHER an asin nor a runtime can only ever group through the
 * book: key, whose partner must also lack both -- so an audio row and a
 * non-audio row never share a group, and within reachable groups the grafts
 * (asin, narrators, cover) already carry the identity whichever member
 * fronts. The remaining tie falls to canonical order, which is stable.
 */
function isBetter(a: ScoredCandidate, b: ScoredCandidate): boolean {
	if (a.confidence !== b.confidence) return a.confidence > b.confidence
	return richness(a) > richness(b)
}

/** Providers whose artwork is, by format, the SQUARE audiobook cover. */
const AUDIOBOOK_COVER_PROVIDERS = new Set(['audible', 'apple', 'storytel'])

/**
 * True if this candidate's cover is audiobook artwork rather than a print scan.
 *
 * Cover choice used to ride along with match confidence, so a work-level record
 * that won on confidence imposed its cover on the group. Measured live on Davis
 * Ashura's "A Warrior's Knowledge": the OpenLibrary row won at 0.85 carrying a
 * PORTRAIT scan of the print edition, while the Audible (0.768) and Apple
 * (0.768) rows for the same book carried the square audiobook art. The match was
 * right and the picture was wrong.
 *
 * Audiobook art is square because that is the format; print covers are portrait
 * for the same reason. So classify by what the record IS, not by measuring
 * pixels or sniffing image URLs: an audiobook-only provider, or any row carrying
 * an Audible ASIN or a runtime, describes an audio edition and its cover is that
 * edition's art. A Hardcover work-level row or an OpenLibrary scan is neither.
 */
function hasAudiobookCover(c: ScoredCandidate): boolean {
	if (!c.cover) return false
	if (AUDIOBOOK_COVER_PROVIDERS.has(c.provider)) return true
	return c.asin != null || c.audioSeconds != null
}

/**
 * Dedupe a scored candidate list, keeping the highest-confidence (then richest)
 * candidate per identity key. The result is a pure function of the candidate
 * SET: input arrival order never affects grouping, winners, grafts, or emit
 * order (see byCandidateIdentity).
 *
 * `pinnedAsin` (the caller's explicitly-hinted ASIN, uppercased) makes the
 * group-winner choice pin-aware: dedupe runs BEFORE the ranker's pinned-first
 * tiebreak, so without this a same-runtime-bucket rival that wins on richness
 * would delete the pinned candidate — and with it the one identity the caller
 * asked for by name — before that tiebreak ever executes.
 *
 * `demotedIds` are candidates the consumer has demoted as junk (an AI-narrated
 * "Virtual Voice" edition). They must NOT receive that pin privilege — a stale
 * sidecar ASIN pointing at a junk edition would otherwise let it win its group
 * and delete the real human edition it shares a runtime bucket with, before the
 * ranker's AI exclusion runs — and they must not act as a metadata DONOR, or the
 * junk's narrator/asin/cover would graft onto a real winner that merged with it.
 * They still merge and can still win a group they are ALONE in (a junk-only book).
 *
 * `pinBlockedIds` is the WEAKER form, for a candidate that is real but whose pin
 * we no longer trust (a stale sidecar ASIN the file's runtime contradicts). It
 * loses the pin privilege exactly like a demoted one, but its ASIN, narrators and
 * cover are genuine store data and must still be donated — folding it into
 * `demotedIds` stripped the identity off its group's winner and left the edition
 * unpickable in Fix Match.
 * @param {ScoredCandidate[]} candidates scored candidates (any order)
 * @param {string | null} pinnedAsin definitive ASIN to keep as its group's winner
 * @param {ReadonlySet<string>} demotedIds ids barred from pin-win and from donating
 * @param {ReadonlySet<string>} pinBlockedIds ids barred from pin-win only
 * @returns {ScoredCandidate[]} one candidate per distinct edition/book
 */
export function dedupeCandidates(
	candidates: ScoredCandidate[],
	pinnedAsin: string | null = null,
	demotedIds: ReadonlySet<string> = new Set(),
	pinBlockedIds: ReadonlySet<string> = new Set()
): ScoredCandidate[] {
	// Process in CANONICAL order (see byCandidateIdentity), not arrival order.
	// Three spots below otherwise let arrival order pick between equals: the
	// winner/donor maps keep the incumbent on a full isBetter tie, the
	// language-compatibility union takes the FIRST compatible prior member, and
	// groups emit in first-seen order. Sorting once at the door makes all three
	// — and therefore the whole result — a pure function of the candidate set.
	const ordered = [...candidates].sort(byCandidateIdentity)
	const n = ordered.length
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
	const langs = ordered.map((c) => normalizeLanguage(c.language))
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
	ordered.forEach((c, i) => {
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
	// Tracked separately from bestWithCover because this donor may override a
	// cover the winner ALREADY has -- see hasAudiobookCover and the graft below.
	const bestAudioCover = new Map<number, ScoredCandidate>()
	// The pin outranks confidence/richness INSIDE a group too: the ranker's
	// pinned-first tiebreak runs after dedupe, so a pinned candidate that loses
	// its group here is gone before that tiebreak exists.
	// A demoted-junk candidate never gets the pin privilege (else a stale junk
	// ASIN deletes the real edition it shares a bucket with) and never donates its
	// metadata to a winner (below) -- but it can still win a group it is alone in.
	const isJunk = (c: ScoredCandidate): boolean => demotedIds.has(c.id)
	const isPinned = (c: ScoredCandidate): boolean =>
		pinnedAsin != null &&
		c.asin?.toUpperCase() === pinnedAsin &&
		!isJunk(c) &&
		!pinBlockedIds.has(c.id)
	// Winner precedence inside a group: a pin beats everything, then a REAL edition
	// beats a demoted-junk one regardless of confidence -- so a junk that merged
	// with the real book can never win by out-scoring a weaker human edition; it
	// wins only when it is the sole (junk-only) member -- then the usual
	// confidence-then-richness order. Empty demotedIds -> isJunk always false ->
	// identical to the pre-change (pin, then isBetter) behaviour.
	const winsGroup = (c: ScoredCandidate, cur: ScoredCandidate): boolean => {
		if (isPinned(c) !== isPinned(cur)) return isPinned(c)
		if (isJunk(c) !== isJunk(cur)) return !isJunk(c)
		return isBetter(c, cur)
	}
	ordered.forEach((c, i) => {
		const root = find(i)
		const cur = best.get(root)
		if (!cur || winsGroup(c, cur)) best.set(root, c)
		// Identity donors skip junk: its asin and narrators must not graft onto a real
		// winner that merged with it (no junk store identity, no "Virtual Voice"
		// narrator on a human book). The COVER is EXEMPT -- a Virtual Voice edition
		// still carries the real book's artwork, so it may fill a cover-less winner
		// like any other member; skipping it would strand a good cover.
		if (c.asin && !isJunk(c)) {
			const curAsin = bestWithAsin.get(root)
			if (!curAsin || isBetter(c, curAsin)) bestWithAsin.set(root, c)
		}
		if (c.narrators?.length && !isJunk(c)) {
			const curNarr = bestWithNarrators.get(root)
			if (!curNarr || isBetter(c, curNarr)) bestWithNarrators.set(root, c)
		}
		if (c.cover) {
			const curCover = bestWithCover.get(root)
			if (!curCover || isBetter(c, curCover)) bestWithCover.set(root, c)
		}
		if (hasAudiobookCover(c)) {
			const curAudio = bestAudioCover.get(root)
			if (!curAudio || isBetter(c, curAudio)) bestAudioCover.set(root, c)
		}
	})

	// One winner per group, in first-seen order over the CANONICAL sequence, so
	// the emit order is as arrival-independent as everything above it.
	const emitted = new Set<number>()
	const out: ScoredCandidate[] = []
	// EVERY audiobook cover in each settled group, for the alternate-art list.
	// Built in its own pass because `find` only stabilises once all unions are
	// done -- collecting inside the union loop would file candidates under roots
	// that later change. Junk is excluded on the same principle that bars it
	// from donating an asin or narrators: art from a demoted candidate is no
	// more trustworthy than its metadata. Print covers are excluded because a
	// portrait jacket in a square Plex poster slot is what squareCover exists to
	// prevent.
	//
	// The art test here is STRICTER than hasAudiobookCover, deliberately. That
	// helper accepts a bare `asin` as proof of audiobook art, and a HARDCOVER
	// PRINT edition carries an asin purely so dedupe can match it -- so the
	// looser test admitted exactly the portrait jackets this list must exclude.
	// For an alternate we require the provider to be an audio catalogue, or the
	// record to state a runtime: either is positive evidence of an audio
	// edition, where a bare asin is not.
	const isAudioArt = (c: ScoredCandidate): boolean =>
		AUDIOBOOK_COVER_PROVIDERS.has(c.provider) || c.audioSeconds != null
	const groupCovers = new Map<number, string[]>()
	ordered.forEach((c, i) => {
		if (isJunk(c) || !c.cover || !isAudioArt(c)) return
		const root = find(i)
		const seen = groupCovers.get(root) ?? []
		// Compare by ASSET, keep the URL. Amazon serves one picture at many
		// sizes (`._SL500_`, `._SX450_`), and a raw-string check treats those
		// as two different covers — so the winner's poster shipped again as
		// its own alternate, a duplicate tile in the picker. nearTieCovers has
		// always normalized this way; dedupe now shares the same function
		// rather than a second copy of the rule.
		const asset = coverAsset(c.cover)
		if (!seen.some((u) => coverAsset(u) === asset)) seen.push(c.cover)
		groupCovers.set(root, seen)
	})

	ordered.forEach((_, i) => {
		const root = find(i)
		if (!emitted.has(root)) {
			emitted.add(root)
			const winner = best.get(root) as ScoredCandidate
			// Graft only what the winner is MISSING -- its own values always win.
			const asinDonor = winner.asin ? null : bestWithAsin.get(root)
			const narrDonor = winner.narrators?.length ? null : bestWithNarrators.get(root)
			// Cover is the one field a donor may override rather than only fill.
			// The winner keeps its own cover when it already has audiobook art (or
			// when no group member has any), but a PRINT-source cover yields to an
			// audio edition's art from the same group -- same book, right picture.
			const audioCoverDonor = bestAudioCover.get(root)
			const coverDonor = winner.cover
				? hasAudiobookCover(winner)
					? null
					: (audioCoverDonor ?? null)
				: (audioCoverDonor ?? bestWithCover.get(root))
			const finalCover = coverDonor ? coverDonor.cover : winner.cover
			// Everything the group offers EXCEPT the picture already showing.
			// ...and the same rule on the way out: the picture already showing
			// must not reappear as an alternate merely because the alternate
			// names a different size of it.
			const finalAsset = finalCover ? coverAsset(finalCover) : null
			const alternates = (groupCovers.get(root) ?? []).filter((u) => coverAsset(u) !== finalAsset)
			if (asinDonor || narrDonor || coverDonor || alternates.length) {
				out.push({
					...winner,
					asin: asinDonor ? asinDonor.asin : winner.asin,
					narrators: narrDonor ? narrDonor.narrators : winner.narrators,
					cover: finalCover,
					...(alternates.length ? { coverAlternates: alternates } : {})
				})
			} else {
				out.push(winner)
			}
		}
	})
	return out
}

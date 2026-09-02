/**
 * Confirming a drift row before it is folded into the reviewed baseline.
 *
 * The sweep reads CURRENT SERVING, warm. That read is a sample of a live
 * system, and samples of this one are not always stable: verifying the
 * 2026-08-20 sweep by hand found 3 of its 36 primary-series changes did not
 * reproduce against the api minutes later. Two were a parent series losing its
 * shelf to a sub-series (Wintersmith, Evershore -- see the unknown-count TTL
 * cap); the third, Joyland, had a reviewed baseline of NO SERIES, was swept as
 * "The Hard Case Crime Novels of Stephen King #112", and serves NO SERIES now.
 * Its work record declares no series at all, so the baseline was right and the
 * sweep's read was the outlier.
 *
 * That is the damage this module exists to prevent. `--accept` folds a swept
 * answer into `reviewedAt`, and the ledger is the baseline every LATER sweep
 * diffs against. Accepting a transient does not just record one wrong row: it
 * silently re-bases drift detection for that record, and the real answer then
 * shows up as the drift.
 *
 * So an accept re-reads, and folds only what still agrees.
 *
 * WHAT THIS DOES NOT DO, deliberately: it cannot catch a wrong answer that is
 * sitting in the api's cache across both reads. The api caches serving, so two
 * reads close together see the same entry by construction. What makes the
 * re-read a genuinely independent sample is ELAPSED TIME -- the confirm pass
 * runs after the full sweep (~1700 records) rather than inline, so an early row
 * is re-read many minutes later. All three observed transients had reverted by
 * then. This narrows the window; it does not close it. A row that is wrong for
 * longer than one sweep still needs a human to reject it.
 */
import { type Answer, answerOf, sameAnswer, type ServedAnswer } from '#helpers/series/sweepFetch'

/** A row the sweep would fold, plus the answer it actually read. */
export interface ConfirmCandidate {
	id: string
	swept: Answer
}

export interface UnstableRow {
	id: string
	swept: Answer
	reread: Answer
}

export interface ConfirmResult {
	/** Ids whose re-read still agrees: safe to fold. */
	confirmed: Set<string>
	/** Moved between the two reads: NOT folded, and worth a human's eye. */
	unstable: UnstableRow[]
	/** The api could not answer the re-read: NOT folded. */
	unreadable: string[]
}

/**
 * Re-read every candidate and report which ones still agree with the sweep.
 *
 * BOTH slots are compared, not just the primary. The ledger stores a secondary
 * and 337 of its 1607 entries carry one; a primary-only comparison is the exact
 * blind spot that let a tag change through undiffed once already, and there is
 * no reason to reintroduce it on the confirm side.
 *
 * An UNREADABLE re-read is never treated as agreement. The api failing to answer
 * says nothing about whether the swept value was real, and folding on silence is
 * how an outage would rewrite the baseline wholesale.
 * @param {ConfirmCandidate[]} candidates rows the accept would fold
 * @param {(id: string) => Promise<ServedAnswer>} reread reads current serving
 * @returns {Promise<ConfirmResult>} which rows may be folded, and why not
 */
export async function confirmAccepts(
	candidates: ConfirmCandidate[],
	reread: (id: string) => Promise<ServedAnswer>,
	concurrency = 1
): Promise<ConfirmResult> {
	const confirmed = new Set<string>()
	const unstable: UnstableRow[] = []
	const unreadable: string[] = []
	// Pooled, not serial. The independence argument only needs the re-read to
	// happen AFTER the sweep, not one at a time: a serial pass over --init's
	// ~1,700 fresh rows was ~7 minutes on a ~70s sweep. Results are recorded in
	// candidate order regardless of completion order, so output is stable.
	const queue = [...candidates]
	const worker = async (): Promise<void> => {
		for (;;) {
			const c = queue.shift()
			if (!c) return
			const now = await reread(c.id)
			if (!now.available) {
				unreadable.push(c.id)
				continue
			}
			const seen = answerOf(now)
			if (sameAnswer(c.swept, seen)) confirmed.add(c.id)
			else unstable.push({ id: c.id, swept: c.swept, reread: seen })
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
	const order = new Map(candidates.map((c, i) => [c.id, i]))
	unstable.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
	unreadable.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
	return { confirmed, unstable, unreadable }
}

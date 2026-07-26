/**
 * One-shot delayed retries, deduped per key while in flight.
 *
 * Built for the author-enrichment gap: a brand-new author's FIRST lookup can
 * catch the Goodreads mirror cache-cold -- our own query is what sets it
 * warming, and minutes later the mirror knows the author (measured live on
 * Roger Zelazny). A single delayed re-run closes that window without polling,
 * new cache semantics, or another scheduler.
 *
 * Deliberately in-memory and best-effort: a process restart drops pending
 * retries, and that is fine -- the monthly UpdateScheduler sweep and the
 * operator's force=1 are the durable backstops. The timer is unref'd so a
 * pending retry never holds the process open.
 */

const pending = new Set<string>()

/** Keys with a retry currently in flight -- exported for tests. */
export function pendingSecondChances(): string[] {
	return [...pending]
}

/**
 * Schedule `task` to run once after `delayMs`, unless a retry for `key` is
 * already pending. Rejections are swallowed (a failed second chance is just a
 * miss -- the backstops still exist); the key frees either way, so a LATER gap
 * can earn a fresh retry.
 * @param {string} key dedupe key, e.g. `author:{asin}`
 * @param {number} delayMs how long to wait before the one shot
 * @param {() => Promise<unknown>} task the retry to run
 * @returns {boolean} true when scheduled, false when one was already pending
 */
export function scheduleSecondChance(
	key: string,
	delayMs: number,
	task: () => Promise<unknown>
): boolean {
	if (pending.has(key)) return false
	pending.add(key)
	const timer = setTimeout(() => {
		task()
			.catch(() => undefined)
			.finally(() => pending.delete(key))
	}, delayMs)
	// Node types this as Timeout (which has unref); bun provides it too. Never
	// let a pending retry keep the process alive.
	;(timer as { unref?: () => void }).unref?.()
	return true
}

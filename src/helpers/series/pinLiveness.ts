/**
 * Is every shelf pin still REACHABLE?
 *
 * A pin is keyed on the matched edition's record id (shelfPins.ts:58,
 * `pins[recordId]`), and a re-match changes that id. When it changes the lookup
 * simply MISSES: no error, no log line, and the book quietly reverts to whatever
 * the resolver says. An operator states a decision, watches it take effect, and
 * it evaporates on the next re-match or rebuild with nothing to signal it.
 *
 * Measured on the .99 library 2026-08-11, after the from-scratch rebuild and a
 * day of re-matches: 34 of 84 pins (40%) matched no album at all. Among the dead
 * were the three "Jack Ryan" collisions being chased at the time -- which were
 * never a resolver bug, just pins that had stopped applying -- and the
 * "Hannibal Lecter #3" pin, killed hours earlier by a re-match onto the
 * unabridged edition, in the same session, unnoticed.
 *
 * A dead pin is indistinguishable from a working one by reading the code or the
 * data, so it has to be checked against a real library: `bun run check:pins`.
 */

/** The shape this module needs from a pin table; the real one carries more. */
export interface PinLike {
	series: string
	position?: string
}

export interface PinLivenessReport {
	total: number
	live: string[]
	dead: string[]
}

/**
 * Split a pin table into the keys a library can still reach and the keys it
 * cannot.
 *
 * Pure so the rule is testable without a Plex server; the script supplies the
 * live ids. Comparison is EXACT, because that is what the lookup does -- a
 * "close enough" check here would report a pin as live that `pins[recordId]`
 * will never find.
 * @param {Record<string, PinLike>} pins the pin table
 * @param {Iterable<string>} liveRecordIds record ids the library currently holds
 * @returns {PinLivenessReport} counts plus the live and dead keys, both sorted
 */
export function pinLiveness(
	pins: Record<string, PinLike>,
	liveRecordIds: Iterable<string>
): PinLivenessReport {
	const live = new Set(liveRecordIds)
	const keys = Object.keys(pins)
	const reachable: string[] = []
	const dead: string[] = []
	for (const key of keys) (live.has(key) ? reachable : dead).push(key)
	return { total: keys.length, live: reachable.sort(), dead: dead.sort() }
}

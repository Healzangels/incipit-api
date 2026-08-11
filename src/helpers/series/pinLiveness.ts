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
	/** Reached only by the portable key, not by the edition id — the pins that
	 *  would be dead without it. */
	byKeyOnly: string[]
	/** Keys whose folded (title, author) matches MORE THAN ONE album. A pin on
	 *  one of these applies to a book it was never stated for; an edition id
	 *  could not do this, because it names exactly one record. */
	ambiguous: { key: string; albums: string[] }[]
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
	liveRecordIds: Iterable<string>,
	keyByRecord: Record<string, string[]> = {},
	albumsByKey: ReadonlyMap<string, readonly string[]> = new Map()
): PinLivenessReport {
	const live = new Set(liveRecordIds)
	const keys = Object.keys(pins)
	const reachable: string[] = []
	const dead: string[] = []
	const byKeyOnly: string[] = []
	// A pin is reachable when EITHER lookup finds it, because applyPins tries the
	// edition id and then the portable key. Checking only the id reported 34 of 84
	// pins dead on .99 while the decisions they encode were in force.
	//
	// The record -> key join comes from the generator, never inferred from the
	// answer a pin carries: two pins can legitimately state the same series and
	// position, and inferring would then credit one pin with the other's key.
	for (const key of keys) {
		if (live.has(key)) {
			reachable.push(key)
			continue
		}
		// ANY of the pin's keys reaching an album makes it live — a pin filed under
		// both its own title and a baked-in-series alias is reachable by either.
		const ks = keyByRecord[key] ?? []
		if (ks.some((k) => (albumsByKey.get(k)?.length ?? 0) > 0)) {
			reachable.push(key)
			byKeyOnly.push(key)
			continue
		}
		dead.push(key)
	}
	const ambiguous = [...new Set(Object.values(keyByRecord).flat())]
		.map((k) => ({ key: k, albums: [...(albumsByKey.get(k) ?? [])] }))
		.filter((a) => a.albums.length > 1)
		.sort((a, b) => a.key.localeCompare(b.key))
	return {
		total: keys.length,
		live: reachable.sort(),
		dead: dead.sort(),
		byKeyOnly: byKeyOnly.sort(),
		ambiguous
	}
}

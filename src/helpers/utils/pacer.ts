import sleep from '#helpers/utils/sleep'

/**
 * Self-pacing for a provider that pushes back under load.
 *
 * A library sweep fans one request out across thousands of books, and a
 * provider with a per-minute cap answers the excess with 429. Being throttled
 * is not merely impolite — it silently COSTS DATA. Measured on Hardcover
 * 2026-08-12, during prod's daily metadata sweep: 142 of 349 calls failed with
 * 429, the circuit breaker opened for 60s at a time and skipped 3,028 more, and
 * every book served in those windows came back with no genres at all. Nothing
 * distinguishes that from "this book genuinely has no genres" at the point of
 * use.
 *
 * So the client paces ITSELF: serialize the calls, hold a minimum gap between
 * them, and stand down entirely for a cooldown once the server does push back.
 *
 * Generalised from the pacing that already guards the Goodreads mirror
 * (goodreadsSeries.ts). That copy is deliberately NOT refactored onto this one
 * in the same change — it is entangled with that module's degraded-stand-down
 * and cache-miss semantics, and the series resolver is the last thing that
 * should be destabilised for a tidy-up. Adopting it there is a follow-up with
 * its own tests.
 */
export interface Pacer {
	/** Wait for this caller's turn. Resolves when it may proceed. */
	take(): Promise<void>
	/** Record a push-back (a 429), starting a cooldown. */
	pushBack(): void
	/** Whether a cooldown is currently in force. */
	standingDown(): boolean
	/** Milliseconds until the cooldown lifts, 0 when not standing down. */
	standDownRemainingMs(): number
}

export interface PacerOptions {
	/**
	 * Minimum gap between calls. Read through a FUNCTION, not a value, so an
	 * operator can retune it (or disable it with 0) without a rebuild, and so
	 * tests can change it between cases.
	 */
	minGapMs: () => number
	/** How long to stand down after a push-back. */
	cooldownMs: () => number
	/** Injectable clock and sleep, so tests need no real time. */
	now?: () => number
	wait?: (ms: number) => Promise<void>
}

/**
 * Build a pacer. Each provider gets its OWN — a shared one would make a slow
 * provider throttle a healthy one.
 * @param {PacerOptions} opts pacing configuration
 * @returns {Pacer} the pacer
 */
export function createPacer(opts: PacerOptions): Pacer {
	const now = opts.now ?? (() => Date.now())
	const wait = opts.wait ?? sleep
	let nextAllowedAt = 0
	let cooldownUntil = 0
	// Serializes the arithmetic below. Without a shared tail, N concurrent
	// callers all read the same nextAllowedAt and fire together — which is the
	// burst the gap exists to prevent.
	let chain: Promise<void> = Promise.resolve()

	const take = (): Promise<void> => {
		const slot = chain.then(async () => {
			const gap = opts.minGapMs()
			// A cooldown outranks the gap: after a push-back, waiting the gap and
			// firing anyway is what turns one 429 into a run of them.
			const until = Math.max(nextAllowedAt, cooldownUntil)
			const t = now()
			if (until > t) await wait(until - t)
			// Re-read the clock: the wait above may have overshot, and pinning the
			// next slot to the stale timestamp would let the following call fire
			// early.
			nextAllowedAt = Math.max(until, now()) + Math.max(0, gap)
		})
		// Keep the chain alive even if a link rejects, or one failure stalls every
		// later caller forever.
		chain = slot.catch(() => undefined)
		return slot
	}

	return {
		take,
		pushBack: () => {
			cooldownUntil = Math.max(cooldownUntil, now() + Math.max(0, opts.cooldownMs()))
		},
		standingDown: () => now() < cooldownUntil,
		standDownRemainingMs: () => Math.max(0, cooldownUntil - now())
	}
}

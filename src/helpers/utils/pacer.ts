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
 * Generalised from the pacing that already guarded the Goodreads mirror
 * (goodreadsSeries.ts), which now uses this module too — the reason it took a
 * follow-up to get there is `onPushBack` below. The two providers answer a
 * push-back in opposite ways, and collapsing them onto one policy would have
 * broken whichever lost. Naming the policy is what made the shared version
 * honest rather than merely shorter.
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
	/**
	 * Clear all pacing state. Exists for tests: a pacer is module-level, so
	 * without this one suite's push-back silently stands the next one down.
	 */
	reset(): void
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
	/**
	 * What a push-back does to the callers that follow it.
	 *
	 * `'wait'` (the default) — `take()` holds them until the cooldown lifts,
	 * then lets them through. Right when the caller wants the data and can
	 * afford to wait for it, as Hardcover's genre enrichment can.
	 *
	 * `'shed'` — `take()` ignores the cooldown entirely, and the CALLER is
	 * expected to consult `standingDown()` first and give up on its own terms.
	 * Right where blocking is worse than returning nothing: the Goodreads mirror
	 * sits on a serve path with a time budget, so a caller queued when a
	 * push-back lands would sleep out the whole cooldown and blow it. Shedding
	 * returns immediately and lets the caller mark the result DEGRADED, which is
	 * what keeps an empty answer from being cached as a genuine miss.
	 */
	onPushBack?: 'wait' | 'shed'
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
	const sheds = opts.onPushBack === 'shed'
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
			// firing anyway is what turns one 429 into a run of them. Under 'shed'
			// it is deliberately NOT consulted -- that caller already declined at
			// standingDown() rather than queueing, so honouring it here would only
			// stall the callers that chose to proceed.
			const until = sheds ? nextAllowedAt : Math.max(nextAllowedAt, cooldownUntil)
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
		standDownRemainingMs: () => Math.max(0, cooldownUntil - now()),
		reset: () => {
			nextAllowedAt = 0
			cooldownUntil = 0
			chain = Promise.resolve()
		}
	}
}

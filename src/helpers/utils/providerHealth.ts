/**
 * Per-provider health, recorded at the search fan-out.
 *
 * The circuit breaker already handles a provider that ERRORS. The failure it
 * cannot see is the quiet one: a provider that answers successfully and returns
 * NOTHING, every time. That is what an expired credential looks like from the
 * outside -- Hardcover tokens expire annually on Jan 1, and the provider simply
 * skips itself and returns [] when it has no usable token, so match quality
 * degrades library-wide with no error, no breaker trip, and no log line anyone
 * would grep for.
 *
 * So the useful signal is not "is it failing" but "is it still ANSWERING with
 * anything": a provider with a healthy call count and a 100% empty rate is
 * almost certainly deauthenticated, not genuinely finding nothing.
 */

export interface ProviderHealth {
	/** Searches dispatched to this provider (excluding circuit-open skips). */
	calls: number
	/** Calls that resolved. */
	ok: number
	/** Calls that rejected (timeout, transport, provider error). */
	failed: number
	/** Calls that were skipped because the breaker was open. */
	skipped: number
	/** Calls that resolved but returned ZERO candidates. */
	empty: number
	/** Candidates returned in total, so a low-yield provider is visible too. */
	candidates: number
	/**
	 * Share of resolved calls that came back empty, 0-1, or null before any call
	 * resolved. Sustained 1 with a non-trivial `ok` is the deauthenticated tell.
	 */
	emptyRate: number | null
}

const store = new Map<string, ProviderHealth>()

function entryFor(provider: string): ProviderHealth {
	let e = store.get(provider)
	if (!e) {
		e = { calls: 0, ok: 0, failed: 0, skipped: 0, empty: 0, candidates: 0, emptyRate: null }
		store.set(provider, e)
	}
	return e
}

/** Record a resolved search and how much it actually returned. */
export function recordProviderResult(provider: string, count: number): void {
	const e = entryFor(provider)
	e.calls += 1
	e.ok += 1
	e.candidates += count
	if (count === 0) e.empty += 1
}

/** Record a search that rejected, or was skipped by an open circuit. */
export function recordProviderFailure(provider: string, circuitOpen: boolean): void {
	const e = entryFor(provider)
	if (circuitOpen) {
		// A deliberate skip is not evidence about the provider's own health; it is
		// evidence the breaker already made that call. Counting it as a failure
		// would double-report one outage as thousands.
		e.skipped += 1
		return
	}
	e.calls += 1
	e.failed += 1
}

/**
 * Snapshot per-provider health for /metrics.
 * @returns {Record<string, ProviderHealth>} health keyed by provider name
 */
export function getProviderHealth(): Record<string, ProviderHealth> {
	const out: Record<string, ProviderHealth> = {}
	for (const [name, e] of store) {
		out[name] = { ...e, emptyRate: e.ok > 0 ? e.empty / e.ok : null }
	}
	return out
}

/** Clear all provider health (tests, and any future manual reset). */
export function resetProviderHealth(): void {
	store.clear()
}

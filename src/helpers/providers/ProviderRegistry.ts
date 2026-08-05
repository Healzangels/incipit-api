import type { FastifyBaseLogger } from 'fastify'

import { getPerformanceConfig } from '#config/performance'
import type ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import type {
	BookProvider,
	BookSearchQuery,
	FetchBookOptions,
	ProviderBook,
	ProviderCandidate
} from '#helpers/providers/types'
import CircuitBreaker from '#helpers/utils/CircuitBreaker'
import { recordProviderFailure, recordProviderResult } from '#helpers/utils/providerHealth'

/**
 * Holds the registered book providers and fans a search out across all of them
 * in parallel.
 *
 * Failure isolation is the whole point: a provider that throws (network down,
 * rate-limited, bad response) must not sink the search — its slot yields no
 * candidates and the others still return. This mirrors the Gate 0 lesson that a
 * transport failure must never be read as "no data".
 */
// A single hung provider must not stall the whole fan-out. Each per-request
// call has a 30s connection timeout with retries (~120s worst case); this caps
// any one provider well below that. On timeout the call rejects, so allSettled
// isolates it exactly like any other provider failure.
const PROVIDER_TIMEOUT_MS = 25000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`provider ${label} timed out after ${ms}ms`)), ms)
	})
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Pass-through used when CIRCUIT_BREAKER_ENABLED is false: same shape, no state.
const PASSTHROUGH = { execute: <T>(fn: () => Promise<T>) => fn() }

/**
 * Whether a rejection is the breaker declining to call, rather than a provider
 * failure. One reader, so the two call sites cannot drift apart.
 * @param {unknown} reason the rejection reason
 * @returns {boolean} true when the circuit was open
 */
function isCircuitOpen(reason: unknown): boolean {
	return String((reason as Error)?.message ?? '').includes('Circuit breaker is OPEN')
}

export default class ProviderRegistry {
	private providers: BookProvider[]
	// One breaker per provider: a source that is rate-limiting us must not keep
	// costing every later search a doomed round-trip, and must recover on its own
	// once the limit resets (CLOSED -> OPEN -> HALF_OPEN -> CLOSED).
	private breakers = new Map<string, CircuitBreaker>()

	/** The breaker for one provider, created on first use. */
	private breakerFor(name: string): { execute: <T>(fn: () => Promise<T>) => Promise<T> } {
		if (!getPerformanceConfig().CIRCUIT_BREAKER_ENABLED) return PASSTHROUGH
		let breaker = this.breakers.get(name)
		if (!breaker) {
			breaker = new CircuitBreaker()
			this.breakers.set(name, breaker)
		}
		return breaker
	}

	constructor(providers: BookProvider[] = []) {
		this.providers = providers
	}

	register(provider: BookProvider): this {
		this.providers.push(provider)
		return this
	}

	/** Names of the registered providers, in registration order. */
	get names(): string[] {
		return this.providers.map((p) => p.name)
	}

	/** The registered provider with this name, or undefined. */
	get(name: string): BookProvider | undefined {
		return this.providers.find((p) => p.name === name)
	}

	/**
	 * Ask each provider that can resolve an ASIN itself to do so, in registration
	 * order, and return the first hit. The rescue path for an ASIN Audible will
	 * not serve (see BookProvider.fetchBookByAsin). Failure is isolated exactly
	 * as in searchAll: a throwing provider is logged and skipped, never fatal.
	 * @param {string} asin the ASIN to resolve
	 * @param {FetchBookOptions} opts region, credentials, logger
	 * @returns {Promise<ProviderBook | null>} the first provider's book, or null
	 */
	async fetchBookByAsin(asin: string, opts: FetchBookOptions): Promise<ProviderBook | null> {
		for (const provider of this.providers) {
			if (!provider.fetchBookByAsin) continue
			try {
				// Through the breaker, like every other upstream call. These two
				// ASIN paths were left on withTimeout alone when fetchOne was
				// given a breaker, so a provider that is refusing kept getting
				// asked once per book -- worst during a from-scratch scan, which
				// is the only time this rescue path runs at volume.
				const book = await this.breakerFor(provider.name).execute(() =>
					withTimeout(provider.fetchBookByAsin!(asin, opts), PROVIDER_TIMEOUT_MS, provider.name)
				)
				if (book) return book
			} catch (err) {
				opts.logger?.debug({ err, provider: provider.name, asin }, 'provider asin rescue failed')
			}
		}
		return null
	}

	/**
	 * Resolve one ASIN straight to a search candidate, asking each provider that
	 * can until one answers. Backs the pinned-edition injection in
	 * BookSearchHelper; failure is isolated exactly as in searchAll.
	 *
	 * Separate from fetchBookByAsin, which only Hardcover implements as the rescue
	 * path for ASINs Audible will not serve — it returns a ProviderBook, a shape
	 * with no runtime. A pinned edition must keep its duration or it can be
	 * neither corroborated nor vetoed by it.
	 * @param {string} asin the ASIN to resolve
	 * @param {FetchBookOptions} opts region, credentials, logger
	 * @returns {Promise<ProviderCandidate | null>} the first provider's candidate, or null
	 */
	async fetchCandidateByAsin(
		asin: string,
		opts: FetchBookOptions
	): Promise<ProviderCandidate | null> {
		for (const provider of this.providers) {
			if (!provider.fetchCandidateByAsin) continue
			try {
				const candidate = await this.breakerFor(provider.name).execute(() =>
					withTimeout(
						provider.fetchCandidateByAsin!(asin, opts),
						PROVIDER_TIMEOUT_MS,
						provider.name
					)
				)
				if (candidate) return candidate
			} catch (err) {
				opts.logger?.debug(
					{ err, provider: provider.name, asin },
					'provider asin candidate lookup failed'
				)
			}
		}
		return null
	}

	/**
	 * One provider's search: cache FIRST, then the breaker-guarded upstream call.
	 *
	 * The ordering is load-bearing. With the cache read inside the breaker's
	 * thunk, an OPEN circuit threw away a free Redis hit (the entry is already
	 * paid for and costs the provider nothing), and in HALF_OPEN two cache hits
	 * counted as two successes and CLOSED the circuit without a single upstream
	 * probe — the breaker "recovered" a provider it had never re-tested. Only the
	 * upstream call is the thing the breaker exists to ration.
	 * @param {BookProvider} provider the provider to search
	 * @param {BookSearchQuery} query the search query
	 * @param {FastifyBaseLogger} [logger] optional logger
	 * @param {ProviderSearchCache} [cache] optional per-provider search cache
	 * @returns {Promise<ProviderCandidate[]>} the provider's candidates
	 */
	private async searchProvider(
		provider: BookProvider,
		query: BookSearchQuery,
		logger?: FastifyBaseLogger,
		cache?: ProviderSearchCache
	): Promise<ProviderCandidate[]> {
		// Still time-boxed: the read used to sit inside withTimeout, and a hung
		// Redis must not be able to stall a search forever. A read that times out
		// (or rejects) is simply "no entry" — degrade to the live call.
		const cached = cache
			? await withTimeout(
					cache.get(provider.name, query),
					PROVIDER_TIMEOUT_MS,
					`${provider.name} cache`
				).catch(() => null)
			: null
		if (cached) return cached

		const result = await this.breakerFor(provider.name).execute(() =>
			withTimeout(provider.search(query, logger), PROVIDER_TIMEOUT_MS, provider.name)
		)
		if (cache) await cache.set(provider.name, query, result)
		return result
	}

	/**
	 * Fetch ONE book from ONE registered provider, through its circuit breaker.
	 *
	 * The exact mirror of {@link searchOne}, and it exists for the same measured
	 * reason: a caller that does `registry.get(name)` and calls
	 * `provider.fetchBook()` itself bypasses the breaker in BOTH directions — its
	 * failures never open the circuit, and an open circuit does not stop it
	 * issuing requests. BookDataHelper did exactly that, with no timeout either,
	 * so `GET /books/<provider-id>` was the one serve path with no protection at
	 * all.
	 *
	 * This got sharper when fetchBook stopped swallowing transport failures: a
	 * refusing provider now REJECTS rather than returning null, so without a
	 * breaker every request pays a full timeout on a call that cannot succeed —
	 * the doomed round-trips the breaker was added to stop, on the branch Plex
	 * refreshes hit.
	 *
	 * Rejects on failure (including an open circuit), so the caller decides
	 * whether that is fatal or a degradation.
	 * @param {string} name the registered provider's name
	 * @param {string} nativeId the provider's own id for the book
	 * @param {string} kind the provider's record kind
	 * @param {FetchBookOptions} opts region, credentials and logger
	 * @returns {Promise<ProviderBook | null>} the book, or null when unregistered
	 */
	async fetchOne(
		name: string,
		nativeId: string,
		kind: string,
		opts: FetchBookOptions
	): Promise<ProviderBook | null> {
		const provider = this.get(name)
		if (!provider?.fetchBook) return null
		const fetchBook = provider.fetchBook.bind(provider)
		try {
			return await this.breakerFor(name).execute(() =>
				withTimeout(fetchBook(nativeId, kind, opts), PROVIDER_TIMEOUT_MS, name)
			)
		} catch (err) {
			const open = isCircuitOpen(err)
			recordProviderFailure(name, open)
			if (open) opts.logger?.debug({ provider: name, err }, 'provider fetch skipped: circuit open')
			else opts.logger?.error({ provider: name, err }, 'provider fetch failed')
			throw err
		}
	}

	/**
	 * Search ONE registered provider by name, through its circuit breaker and the
	 * same cache path the fan-out uses.
	 *
	 * Exists because a caller that reaches for `registry.get(name)` and calls
	 * `provider.search()` itself bypasses the breaker in BOTH directions: its
	 * failures never open the circuit, and an open circuit does not stop it
	 * issuing requests. Measured on the square-cover lookup that runs on every
	 * `GET /books/:asin`: 10 failing lookups left Apple's breaker CLOSED, and with
	 * the circuit OPEN searchAll issued 0 calls while the direct caller still
	 * issued one — precisely the doomed round-trips the breaker was added to stop.
	 *
	 * Rejects on failure (including an open circuit), so a caller decides for
	 * itself whether that is fatal or a degradation.
	 * @param {string} name the registered provider's name
	 * @param {BookSearchQuery} query the search query
	 * @param {FastifyBaseLogger} [logger] optional logger
	 * @param {ProviderSearchCache} [cache] optional per-provider search cache
	 * @returns {Promise<ProviderCandidate[]>} the provider's candidates, or [] when unregistered
	 */
	async searchOne(
		name: string,
		query: BookSearchQuery,
		logger?: FastifyBaseLogger,
		cache?: ProviderSearchCache
	): Promise<ProviderCandidate[]> {
		const provider = this.get(name)
		if (!provider) return []
		try {
			const result = await this.searchProvider(provider, query, logger, cache)
			recordProviderResult(name, result.length)
			return result
		} catch (err) {
			// Same bookkeeping and same log levels as the fan-out: an open circuit is
			// a deliberate skip, not a new failure.
			const open = isCircuitOpen(err)
			recordProviderFailure(name, open)
			if (open) logger?.debug({ provider: name, err }, 'provider search skipped: circuit open')
			else logger?.error({ provider: name, err }, 'provider search failed')
			throw err
		}
	}

	/**
	 * Search every provider in parallel and return the flattened candidate pool.
	 * A provider that rejects is logged and contributes nothing. When a cache is
	 * given, each provider's call goes through it (per-provider, so an error caches
	 * nothing).
	 * @param {BookSearchQuery} query the search query
	 * @param {FastifyBaseLogger} logger optional logger for provider failures
	 * @param {ProviderSearchCache} cache optional per-provider search cache
	 * @returns {Promise<ProviderCandidate[]>} combined candidates from all providers
	 */
	async searchAll(
		query: BookSearchQuery,
		logger?: FastifyBaseLogger,
		cache?: ProviderSearchCache
	): Promise<ProviderCandidate[]> {
		const settled = await Promise.allSettled(
			// The breaker wraps a THUNK, so an open circuit costs no request at
			// all. Measured on a 1341-book scan: Apple rate-limited us six
			// minutes in and then refused 942 consecutive searches (751x 429,
			// 191x 403) for the rest of the run -- every one of them a doomed
			// round-trip that also kept Apple unusable for the square-cover
			// lookups that run on every book response.
			this.providers.map((p) => this.searchProvider(p, query, logger, cache))
		)

		const candidates: ProviderCandidate[] = []
		settled.forEach((result, i) => {
			if (result.status === 'fulfilled') {
				// Record how much it actually returned, not just that it answered: a
				// provider that succeeds while returning nothing every time is the
				// deauthenticated-credential signature the breaker cannot see.
				recordProviderResult(this.providers[i].name, result.value.length)
				candidates.push(...result.value)
			} else {
				// An open circuit is a deliberate skip, not a new failure: logging it
				// at error level would bury the ONE real failure under thousands of
				// "we already know this source is down" lines.
				const open = isCircuitOpen(result.reason)
				const line = { provider: this.providers[i].name, err: result.reason }
				recordProviderFailure(this.providers[i].name, open)
				if (open) logger?.debug(line, 'book search provider skipped: circuit open')
				else logger?.error(line, 'book search provider failed')
			}
		})
		return candidates
	}
}

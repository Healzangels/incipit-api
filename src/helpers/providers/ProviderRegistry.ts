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
				const book = await withTimeout(
					provider.fetchBookByAsin(asin, opts),
					PROVIDER_TIMEOUT_MS,
					provider.name
				)
				if (book) return book
			} catch (err) {
				opts.logger?.debug({ err, provider: provider.name, asin }, 'provider asin rescue failed')
			}
		}
		return null
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
			this.providers.map((p) =>
				// The breaker wraps a THUNK, so an open circuit costs no request at
				// all. Measured on a 1341-book scan: Apple rate-limited us six
				// minutes in and then refused 942 consecutive searches (751x 429,
				// 191x 403) for the rest of the run -- every one of them a doomed
				// round-trip that also kept Apple unusable for the square-cover
				// lookups that run on every book response.
				this.breakerFor(p.name).execute(() =>
					withTimeout(
						cache
							? cache.wrap(p.name, query, () => p.search(query, logger))
							: p.search(query, logger),
						PROVIDER_TIMEOUT_MS,
						p.name
					)
				)
			)
		)

		const candidates: ProviderCandidate[] = []
		settled.forEach((result, i) => {
			if (result.status === 'fulfilled') {
				candidates.push(...result.value)
			} else {
				// An open circuit is a deliberate skip, not a new failure: logging it
				// at error level would bury the ONE real failure under thousands of
				// "we already know this source is down" lines.
				const open = String((result.reason as Error)?.message ?? '').includes(
					'Circuit breaker is OPEN'
				)
				const line = { provider: this.providers[i].name, err: result.reason }
				if (open) logger?.debug(line, 'book search provider skipped: circuit open')
				else logger?.error(line, 'book search provider failed')
			}
		})
		return candidates
	}
}

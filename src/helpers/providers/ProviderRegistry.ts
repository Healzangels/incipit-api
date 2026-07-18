import type { FastifyBaseLogger } from 'fastify'

import type ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import type { BookProvider, BookSearchQuery, ProviderCandidate } from '#helpers/providers/types'

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

export default class ProviderRegistry {
	private providers: BookProvider[]

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
			this.providers.map((p) => {
				const call = cache
					? cache.wrap(p.name, query, () => p.search(query, logger))
					: p.search(query, logger)
				return withTimeout(call, PROVIDER_TIMEOUT_MS, p.name)
			})
		)

		const candidates: ProviderCandidate[] = []
		settled.forEach((result, i) => {
			if (result.status === 'fulfilled') {
				candidates.push(...result.value)
			} else {
				logger?.error(
					{ provider: this.providers[i].name, err: result.reason },
					'book search provider failed'
				)
			}
		})
		return candidates
	}
}

import type { FastifyBaseLogger } from 'fastify'

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

	/**
	 * Search every provider in parallel and return the flattened candidate pool.
	 * A provider that rejects is logged and contributes nothing.
	 * @param {BookSearchQuery} query the search query
	 * @param {FastifyBaseLogger} logger optional logger for provider failures
	 * @returns {Promise<ProviderCandidate[]>} combined candidates from all providers
	 */
	async searchAll(
		query: BookSearchQuery,
		logger?: FastifyBaseLogger
	): Promise<ProviderCandidate[]> {
		const settled = await Promise.allSettled(this.providers.map((p) => p.search(query, logger)))

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

import type { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import type { BookSearchQuery, ProviderCandidate } from './types'

import getErrorMessage from '#helpers/utils/getErrorMessage'

/**
 * Per-provider Redis cache for search results.
 *
 * Book metadata is stable and provider searches are the expensive, rate-limited
 * part (Hardcover allows only 60 req/min), so each provider's candidate list is
 * cached by (provider, region, title, author). Caching per-provider — not the
 * whole fan-out — means a provider that errors on one request contributes no
 * cache entry rather than poisoning the combined result for the whole TTL, and a
 * newly added provider is not masked by an old combined entry.
 *
 * Cache keys are shared across users: the same title yields the same book data
 * regardless of whose token authenticated the call, so one user's request warms
 * the cache for everyone on a shared instance. All Redis access is null-safe and
 * errors are swallowed (a cache failure degrades to a live call, never an error),
 * matching the RedisHelper convention.
 */

const KEY_PREFIX = 'incipit:psearch:v1'
// Book metadata rarely changes; a week keeps the rate-limited providers cheap.
const DEFAULT_TTL_SECONDS = 604800

/** Lowercased, alphanumeric-only fragment for a stable cache key. */
function normKey(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export default class ProviderSearchCache {
	private redis: FastifyRedis | null
	private ttl: number
	private logger?: FastifyBaseLogger

	constructor(
		redis: FastifyRedis | null,
		ttlSeconds = DEFAULT_TTL_SECONDS,
		logger?: FastifyBaseLogger
	) {
		this.redis = redis
		this.ttl = ttlSeconds
		this.logger = logger
	}

	private key(providerName: string, query: BookSearchQuery): string {
		const author = query.author ? normKey(query.author) : ''
		return `${KEY_PREFIX}:${providerName}:${query.region}:${normKey(query.title)}:${author}`
	}

	/**
	 * Return the cached candidates for this provider+query, or run `fetch`, cache
	 * its result, and return that. A Redis error at any step falls through to a
	 * live fetch. A `fetch` that throws is NOT cached (the error propagates so the
	 * registry can isolate it).
	 * @param {string} providerName the provider's name
	 * @param {BookSearchQuery} query the search query
	 * @param {() => Promise<ProviderCandidate[]>} fetch the live provider search
	 * @returns {Promise<ProviderCandidate[]>} cached or freshly fetched candidates
	 */
	async wrap(
		providerName: string,
		query: BookSearchQuery,
		fetch: () => Promise<ProviderCandidate[]>
	): Promise<ProviderCandidate[]> {
		if (!this.redis) return fetch()

		const key = this.key(providerName, query)

		try {
			const cached = await this.redis.get(key)
			if (cached) return JSON.parse(cached) as ProviderCandidate[]
		} catch (error) {
			this.logger?.debug({ err: getErrorMessage(error) }, 'provider search cache read failed')
		}

		const result = await fetch()

		// Never cache an empty result. A provider that returns [] because it was
		// skipped for a missing credential (e.g. Hardcover with no token) or hit a
		// transient miss would otherwise poison this shared, credential-independent
		// key for the whole TTL, silently disabling the provider for every user.
		if (result.length > 0) {
			try {
				await this.redis.set(key, JSON.stringify(result))
				await this.redis.expire(key, this.ttl)
			} catch (error) {
				this.logger?.debug({ err: getErrorMessage(error) }, 'provider search cache write failed')
			}
		}

		return result
	}
}

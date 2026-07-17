import type { FastifyBaseLogger } from 'fastify'

import type { BookSearchQueryString } from '#config/types'
import { dedupeCandidates } from '#helpers/providers/dedupe'
import { CONFIDENCE_FLOOR, normalizeTitle, scoreCandidate } from '#helpers/providers/matchScorer'
import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import type { BookSearchQuery, ScoredCandidate } from '#helpers/providers/types'

/**
 * Runs a multi-provider book search: fan out across the registry, score every
 * candidate on one scale (title + author + duration), drop anything below the
 * acceptance floor, and return the survivors ranked best-first.
 *
 * The title is normalized the same way the Gate 0 benchmark normalized Plex
 * ALBUM tags, so the validated thresholds apply unchanged.
 */
export default class BookSearchHelper {
	private registry: ProviderRegistry
	private options: BookSearchQueryString
	private logger?: FastifyBaseLogger
	// Per-request provider credentials (e.g. a user's Hardcover token), sourced
	// from a request header rather than the query string so tokens never land in
	// access logs. Forwarded to providers via the internal BookSearchQuery.
	private credentials?: Record<string, string>
	private cache?: ProviderSearchCache

	constructor(
		registry: ProviderRegistry,
		options: BookSearchQueryString,
		logger?: FastifyBaseLogger,
		credentials?: Record<string, string>,
		cache?: ProviderSearchCache
	) {
		this.registry = registry
		this.options = options
		this.logger = logger
		this.credentials = credentials
		this.cache = cache
	}

	/** The raw search title (title param, or its `query` alias). */
	get rawTitle(): string {
		return this.options.title ?? this.options.query ?? ''
	}

	/**
	 * Execute the search, with a track-title fallback.
	 *
	 * Searches on the album title first. If that clears no candidate above the
	 * floor and a track title was supplied that normalizes to something different,
	 * it searches again on the track title — recovering rips whose ALBUM tag is a
	 * bare series+number but whose track carries the real book title.
	 * @returns {Promise<ScoredCandidate[]>} accepted candidates, ranked best-first
	 */
	async search(): Promise<ScoredCandidate[]> {
		const primary = normalizeTitle(this.rawTitle)
		const accepted = await this.searchWith(primary)
		if (accepted.length) return accepted

		const fallback = normalizeTitle(this.options.trackTitle ?? '')
		if (fallback && fallback.toLowerCase() !== primary.toLowerCase()) {
			this.logger?.debug({ fallback }, 'book search: album title missed, trying track title')
			return this.searchWith(fallback)
		}
		return accepted
	}

	/**
	 * Run one search pass for a given normalized title: fan out, score, filter,
	 * rank.
	 * @param {string} normalizedTitle the title to search and score against
	 * @returns {Promise<ScoredCandidate[]>} accepted candidates, ranked best-first
	 */
	private async searchWith(normalizedTitle: string): Promise<ScoredCandidate[]> {
		if (!normalizedTitle) return []
		const author = this.options.author ?? ''

		const query: BookSearchQuery = {
			title: normalizedTitle,
			author: this.options.author,
			durationMs: this.options.duration,
			region: this.options.region,
			credentials: this.credentials
		}

		const candidates = await this.registry.searchAll(query, this.logger, this.cache)

		const scored: ScoredCandidate[] = candidates.map((c) => {
			const { confidence, durationDeltaPct } = scoreCandidate(
				normalizedTitle,
				author,
				c.title,
				c.authors,
				this.options.duration ?? null,
				c.audioSeconds
			)
			return { ...c, confidence, durationDeltaPct }
		})

		const accepted = scored.filter((c) => c.confidence >= CONFIDENCE_FLOOR)
		return dedupeCandidates(accepted).sort((a, b) => b.confidence - a.confidence)
	}
}

import type { FastifyBaseLogger } from 'fastify'

import type { BookSearchQueryString } from '#config/types'
import { dedupeCandidates } from '#helpers/providers/dedupe'
import {
	CONFIDENCE_FLOOR,
	extractAsinAndClean,
	normalizeTitle,
	scoreCandidate
} from '#helpers/providers/matchScorer'
import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import type { BookSearchQuery, ScoredCandidate } from '#helpers/providers/types'

/**
 * Whether a candidate is an actual audiobook edition (has an audio runtime or a
 * narrator) rather than a book-level record (OpenLibrary / a Hardcover book with
 * no audio edition). Used only as a same-confidence tiebreak.
 * @param {ScoredCandidate} c the candidate
 */
function isAudioEdition(c: ScoredCandidate): boolean {
	return (c.audioSeconds != null && c.audioSeconds > 0) || c.narrators.length > 0
}

// On a genuine tie (same confidence AND same audio-edition status), prefer the
// richer/more-authoritative source so a win never *degrades* metadata: Audible's
// full record beats a coin-flip, but a new provider still wins when it's actually
// a better match (higher confidence). Unknown providers sort last.
const PROVIDER_RANK: Record<string, number> = {
	audible: 0,
	hardcover: 1,
	apple: 2,
	storytel: 2,
	libro: 2,
	openlibrary: 3
}
function providerRank(c: ScoredCandidate): number {
	return PROVIDER_RANK[c.provider] ?? 9
}

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
		return this.options.title ?? this.options.query ?? this.options.keywords ?? ''
	}

	/**
	 * The ASIN to treat as a definitive match: the explicit `asin` param if given,
	 * else one extracted from a bracketed title. Uppercased for comparison.
	 */
	private effectiveAsin(): string | null {
		const explicit = this.options.asin?.trim()
		if (explicit) return explicit.toUpperCase()
		return extractAsinAndClean(this.rawTitle).asin
	}

	/**
	 * Execute the search, with a track-title fallback.
	 *
	 * Searches on the album title first (with any ASIN/bracket noise stripped). If
	 * that clears no candidate above the floor and a track title was supplied that
	 * normalizes to something different, it searches again on the track title —
	 * recovering rips whose ALBUM tag is a bare series+number but whose track
	 * carries the real book title.
	 * @returns {Promise<ScoredCandidate[]>} accepted candidates, ranked best-first
	 */
	async search(): Promise<ScoredCandidate[]> {
		const asin = this.effectiveAsin()
		const primary = normalizeTitle(extractAsinAndClean(this.rawTitle).title)
		const accepted = await this.searchWith(primary, asin)
		if (accepted.length) return accepted

		const fallback = normalizeTitle(extractAsinAndClean(this.options.trackTitle ?? '').title)
		if (fallback && fallback.toLowerCase() !== primary.toLowerCase()) {
			this.logger?.debug({ fallback }, 'book search: album title missed, trying track title')
			return this.searchWith(fallback, asin)
		}
		return accepted
	}

	/**
	 * Run one search pass for a given normalized title: fan out, score, apply the
	 * ASIN override, filter, dedupe, rank.
	 * @param {string} normalizedTitle the title to search and score against
	 * @param {string | null} wantAsin the definitive ASIN to confirm matches against
	 * @returns {Promise<ScoredCandidate[]>} accepted candidates, ranked best-first
	 */
	private async searchWith(
		normalizedTitle: string,
		wantAsin: string | null
	): Promise<ScoredCandidate[]> {
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
			// An exact ASIN match is a definitive identity confirmation — it beats
			// any fuzzy score, so pin it to full confidence.
			const asinMatch = wantAsin != null && c.asin?.toUpperCase() === wantAsin
			return { ...c, confidence: asinMatch ? 1 : confidence, durationDeltaPct }
		})

		const accepted = scored.filter((c) => c.confidence >= CONFIDENCE_FLOOR)
		return dedupeCandidates(accepted).sort((a, b) => {
			const byConfidence = b.confidence - a.confidence
			if (Math.abs(byConfidence) > 1e-9) return byConfidence
			// Equal confidence (e.g. an unanalyzed file gives no duration signal,
			// so an audio edition and a book-level record both sit at the floor):
			// prefer the ACTUAL audiobook edition. Otherwise the winner falls to
			// provider order, and a series can split across sources (half Audible,
			// half OpenLibrary) with inconsistent series/sort metadata.
			const byAudio = Number(isAudioEdition(b)) - Number(isAudioEdition(a))
			if (byAudio !== 0) return byAudio
			// Still tied: prefer the richer/more-authoritative source.
			return providerRank(a) - providerRank(b)
		})
	}
}

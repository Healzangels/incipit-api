import type { FastifyBaseLogger } from 'fastify'

/**
 * Provider abstraction for the multi-provider book search (PLAN §4 / upstream
 * #845). Each provider knows how to turn a search query into a set of normalized
 * candidates; the registry fans out across all of them and the scorer ranks the
 * combined pool on one scale.
 */

export interface BookSearchQuery {
	title: string
	author?: string
	/** Local audio runtime in milliseconds, if Plex supplied it. */
	durationMs?: number
	region: string
	/**
	 * Per-request provider credentials, keyed by provider name (e.g.
	 * `{ hardcover: '<token>' }`). Lets the Plex bundle forward a user's own token
	 * so a shared public instance stays within each provider's per-token rate
	 * limit; a self-hosted instance can rely on env defaults instead.
	 */
	credentials?: Record<string, string>
}

/**
 * A single candidate from one provider, normalized to the fields the scorer and
 * the Plex bundle need. Providers with no audio edition leave audioSeconds null —
 * the scorer treats that as "no duration signal", not a contradiction.
 */
export interface ProviderCandidate {
	/** Provider name, e.g. "audible", "hardcover", "openlibrary". */
	provider: string
	/** Provider-native id (ASIN, hardcover book id, OpenLibrary key). */
	id: string
	/**
	 * Audible ASIN when the candidate has one, else null. Carried explicitly (not
	 * just inside id) because it is the cross-provider identity key: the same ASIN
	 * from Audible and Hardcover is the same edition and dedupes to one.
	 */
	asin: string | null
	title: string
	authors: string[]
	narrators: string[]
	audioSeconds: number | null
	cover: string | null
}

/** A candidate after scoring against the query. */
export interface ScoredCandidate extends ProviderCandidate {
	confidence: number
	durationDeltaPct: number | null
}

export interface ProviderBookSeries {
	name: string
	position?: string
}

/**
 * Full book metadata for the data-lookup route (`GET /books/{id}`), shaped to the
 * fields the Plex bundle's book updater reads. Every field beyond title/authors
 * is optional — the bundle reads each with `if key in response`, so a provider
 * only supplies what it has and the bundle defaults the rest.
 */
export interface ProviderBook {
	asin: string | null
	title: string
	subtitle?: string
	authors: { name: string }[]
	narrators: { name: string }[]
	summary?: string
	image?: string | null
	/** A native square, high-res cover for a square Plex poster, when found. */
	imageSquare?: string | null
	publisherName?: string
	rating?: string
	releaseDate?: string
	seriesPrimary?: ProviderBookSeries
	seriesSecondary?: ProviderBookSeries
}

/** Options for a data-lookup fetch (per-request credentials, region, logger). */
export interface FetchBookOptions {
	region: string
	credentials?: Record<string, string>
	logger?: FastifyBaseLogger
}

/**
 * One data source. Implementations must not throw for an empty result — return
 * []. They may throw on transport failure; the registry isolates that so one bad
 * provider cannot sink the whole search.
 *
 * `fetchBook` resolves a matched non-Audible book to full metadata by its native
 * id (from a decoded candidate id). Providers that can be matched must implement
 * it; the data-lookup route dispatches to the right one.
 */
export interface BookProvider {
	readonly name: string
	search(query: BookSearchQuery, logger?: FastifyBaseLogger): Promise<ProviderCandidate[]>
	fetchBook?(nativeId: string, kind: string, opts: FetchBookOptions): Promise<ProviderBook | null>
}

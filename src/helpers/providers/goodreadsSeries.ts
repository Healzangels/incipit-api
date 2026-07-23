import type { FastifyBaseLogger } from 'fastify'

import { normalizeTitle, titleSim } from '#helpers/providers/matchScorer'
import type { ProviderBookSeries } from '#helpers/providers/types'
import fetch from '#helpers/utils/fetchPlus'

/**
 * Goodreads series lookup, via the public bookinfo.pro mirror.
 *
 * Series is the field our providers are weakest on. Measured across 13,324 live
 * album updates, 23.9% arrived with NO usable provider series, and the Plex
 * agent then fell back to parsing the folder path -- which inherits whatever
 * series the downstream library manager picked, producing entries like
 * "Pocket Potters, Book 1" on Harry Potter and "The Martian, Book 1" on a
 * standalone novel. Goodreads carries the best series data in books, including
 * the POSITION, which is exactly what Hardcover and Audible leave empty.
 *
 * Deliberately an ENRICHMENT and not a search provider: it never competes for
 * the match, it only fills a field the winner is missing. A wrong series is
 * worse than no series -- it mis-shelves a book and looks authoritative doing
 * it -- so every answer is verified against the title we asked about before it
 * is trusted, and anything uncertain returns null.
 */

const BASE = (process.env.GOODREADS_SERIES_URL || 'https://api.bookinfo.pro').replace(/\/+$/, '')
const TIMEOUT_MS = 8000

/**
 * How close the Goodreads work's title must be to ours before its series is
 * trusted. /search is a fuzzy text endpoint and will happily return a different
 * book in the same universe -- the failure mode that would quietly attach the
 * wrong series to a correct match. Set high because a miss costs nothing (we
 * simply keep the empty field we already had) while a false accept is exactly
 * the mis-shelving this is meant to fix.
 */
const TITLE_ACCEPT = 0.9

interface SearchHit {
	bookId?: number
	workId?: number
}

interface WorkSeriesLink {
	ForeignWorkId?: number
	PositionInSeries?: string
	SeriesPosition?: number
	Primary?: boolean
}

interface WorkSeries {
	Title?: string
	LinkItems?: WorkSeriesLink[]
}

interface WorkResponse {
	Title?: string
	FullTitle?: string
	ShortTitle?: string
	Series?: WorkSeries[]
}

export interface GoodreadsSeriesResult {
	primary?: ProviderBookSeries
	secondary?: ProviderBookSeries
}

/** A book that may already carry a series, and the fields a lookup needs. */
interface SeriesEnrichable {
	title?: string
	authors?: Array<{ name?: string }>
	seriesPrimary?: { name?: string } | null
	seriesSecondary?: unknown
}

/** Minimal shape of the redis client the route already holds. */
interface RedisLike {
	get(key: string): Promise<string | null>
	set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>
}

// A day: series membership is effectively immutable, and a miss is worth
// remembering too so a sidecar-less book without a Goodreads hit does not
// re-walk /search + /work on every metadata refresh.
const CACHE_TTL_SECONDS = 86400
const CACHE_PREFIX = 'grseries:v2:'

function cacheKey(title: string, author: string | null): string {
	return CACHE_PREFIX + normalizeTitle(title).toLowerCase() + '|' + (author || '').toLowerCase()
}

/**
 * Fill a book's series from Goodreads when, and only when, the providers left
 * it empty. Cached, best-effort, and it never touches a series the winning
 * record already supplied -- Audible/Hardcover series stays authoritative;
 * Goodreads is the backstop for the ~1 in 4 books that arrive with none.
 *
 * Returns the same object (enriched in place is avoided -- a shallow copy is
 * returned) so it composes with the route's other response wrappers.
 * @param {SeriesEnrichable} book the book response to enrich
 * @param {RedisLike|null} redis the request's redis client, or null
 * @param {FastifyBaseLogger} [logger] optional request logger
 * @returns {Promise<T>} the book, with series filled if one was found
 */
export async function withGoodreadsSeries<T extends SeriesEnrichable>(
	book: T,
	redis: RedisLike | null,
	logger?: FastifyBaseLogger
): Promise<T> {
	// Already has a series, or nothing to look one up by -> leave it exactly as
	// the provider returned it. This is the common path and must be free.
	if (book?.seriesPrimary?.name || !book?.title) return book

	const title = book.title
	const author = book.authors?.[0]?.name ?? null
	const key = cacheKey(title, author)

	let result: GoodreadsSeriesResult | null | undefined
	if (redis) {
		try {
			const cached = await redis.get(key)
			// The sentinel distinguishes a cached MISS from a cache absence, so a
			// known-empty lookup is not repeated every refresh.
			if (cached === 'null') return book
			if (cached) result = JSON.parse(cached) as GoodreadsSeriesResult
		} catch {
			result = undefined
		}
	}

	if (result === undefined) {
		result = await fetchGoodreadsSeries(title, author, logger)
		if (redis) {
			try {
				await redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS)
			} catch {
				// A cache-write failure is not a request failure.
			}
		}
	}

	if (!result?.primary) return book
	logger?.debug(
		{ title, series: result },
		'goodreads series: enriched a book with no provider series'
	)
	return {
		...book,
		seriesPrimary: result.primary,
		seriesSecondary: book.seriesSecondary ?? result.secondary
	}
}

async function getJson<T>(path: string): Promise<T | null> {
	try {
		const res = await fetch(`${BASE}${path}`, { timeout: TIMEOUT_MS })
		return (await res.data) as T
	} catch {
		// Enrichment is strictly best-effort: an outage, a 404 or a rate limit
		// must never fail the request that asked for it.
		return null
	}
}

/**
 * Position for one work inside one series.
 *
 * Prefers the link that names our work explicitly. A Goodreads series carries a
 * LinkItem per member, so reading LinkItems[0] blindly returns some OTHER
 * book's number -- the same "took the first match" mistake that put the wrong
 * poster on the wrong item elsewhere in this stack.
 */
function positionFor(series: WorkSeries, workId: number): string | undefined {
	const links = series.LinkItems ?? []
	const mine =
		links.find((l) => l.ForeignWorkId === workId) ?? (links.length === 1 ? links[0] : null)
	if (!mine) return undefined
	if (typeof mine.PositionInSeries === 'string' && mine.PositionInSeries.trim()) {
		return mine.PositionInSeries.trim()
	}
	if (typeof mine.SeriesPosition === 'number' && Number.isFinite(mine.SeriesPosition)) {
		return String(mine.SeriesPosition)
	}
	return undefined
}

/**
 * Look up Goodreads series for a title, or null when nothing can be trusted.
 * @param {string} title the title to look up
 * @param {string|null} author the author, used only to sharpen the text search
 * @param {FastifyBaseLogger} [logger] optional request logger
 * @returns {Promise<GoodreadsSeriesResult|null>} verified series, or null
 */
export async function fetchGoodreadsSeries(
	title: string,
	author: string | null,
	logger?: FastifyBaseLogger
): Promise<GoodreadsSeriesResult | null> {
	const want = normalizeTitle(title)
	if (!want) return null

	const q = encodeURIComponent([title, author].filter(Boolean).join(' '))
	const hits = await getJson<SearchHit[]>(`/search?q=${q}`)
	if (!Array.isArray(hits) || hits.length === 0) return null

	// Only the first few: /search is relevance-ordered, and walking deeper trades
	// a real risk of a same-universe false accept for a vanishing chance of a hit.
	for (const hit of hits.slice(0, 3)) {
		const workId = hit.workId
		if (typeof workId !== 'number') continue

		const work = await getJson<WorkResponse>(`/work/${workId}`)
		if (!work) continue

		// Verify before trusting. Compare against every title form the work
		// offers, since Goodreads' Title may carry the series suffix our
		// normalizer strips while ShortTitle does not.
		const candidates = [work.Title, work.ShortTitle, work.FullTitle].filter(
			(t): t is string => typeof t === 'string' && t.length > 0
		)
		const best = candidates.reduce((acc, t) => Math.max(acc, titleSim(want, normalizeTitle(t))), 0)
		if (best < TITLE_ACCEPT) {
			logger?.debug(
				{ workId, best, want },
				'goodreads series: work title too far from ours, not trusting its series'
			)
			continue
		}

		const all = (work.Series ?? []).filter(
			(s): s is WorkSeries => !!s && typeof s.Title === 'string' && s.Title.length > 0
		)
		if (all.length === 0) return null

		// Goodreads marks one link Primary; fall back to declaration order, which
		// is what the site itself shows first.
		const ranked = [...all].sort((x, y) => {
			const xp = (x.LinkItems ?? []).some((l) => l.Primary) ? 0 : 1
			const yp = (y.LinkItems ?? []).some((l) => l.Primary) ? 0 : 1
			return xp - yp
		})

		const toSeries = (s: WorkSeries): ProviderBookSeries => {
			const position = positionFor(s, workId)
			return position ? { name: s.Title as string, position } : { name: s.Title as string }
		}

		const result: GoodreadsSeriesResult = { primary: toSeries(ranked[0]) }
		if (ranked[1]) result.secondary = toSeries(ranked[1])
		logger?.debug({ workId, series: result }, 'goodreads series: resolved')
		return result
	}

	return null
}

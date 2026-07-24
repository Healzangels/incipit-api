import type { FastifyBaseLogger } from 'fastify'

import { normalizeTitle, titleSim } from '#helpers/providers/matchScorer'
import type { ProviderBookSeries } from '#helpers/providers/types'
import { isSameAuthor } from '#helpers/utils/authorNameMatch'
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
	author?: { id?: number }
}

interface WorkSeriesLink {
	ForeignWorkId?: number
	PositionInSeries?: string
	SeriesPosition?: number
	Primary?: boolean
}

interface WorkSeries {
	Title?: string
	ForeignId?: number
	LinkItems?: WorkSeriesLink[]
}

interface SeriesResponse {
	LinkItems?: unknown[]
}

// Member counts per Goodreads series id, memoized for the life of the process.
// Series membership is effectively immutable, and the same umbrella series
// (Chronicles of Osreth, The Legend of Drizzt) recurs across every book in it,
// so this collapses N books' worth of /series lookups to one per series.
const seriesCountMemo = new Map<number, number>()

// A Goodreads "series" that is not the one a reader means. Three kinds, all of
// which inflate member count and so would beat the real series on a raw count:
//
//   1. EDITION VARIANTS -- a split-volume or omnibus doubles the entries
//      ("Harry Potter Persian/Farsi Split-Volume Edition" over "Harry Potter").
//   2. FRANCHISE ORDERINGS -- a publication/chronological listing sweeps in the
//      whole universe ("Forgotten Realms - Publication Order").
//   3. FRANCHISE UMBRELLAS -- a "-verse"/"Universe" that BUNDLES several
//      distinct sub-series ("The Enderverse" over "Ender's Saga", "Jack Ryan
//      Universe" over "Jack Ryan"). Detected by name, not size, on purpose: a
//      TIGHT parent can be just as large (The Legend of Drizzt, ~37 books, is
//      the wanted series over its 4-book sub-arc), so a size ratio would wrongly
//      demote it -- but the umbrella carries the tell in its name and the tight
//      parent does not.
//
// Excluded from the ranking, but only when a clean series remains -- never
// leaving a book with no series because every listing happened to be one of
// these.
const SERIES_VARIANT_RE =
	/\b(publication order|chronological|split[\s-]?volume|omnibus|box[\s-]?set|edition)\b|\b\w*verse\b/i

/**
 * Number of members in a Goodreads series, or 0 when it can't be determined.
 *
 * Used to tell a sub-series from its parent: the parent is the container, so it
 * has strictly more members ("Chronicles of Osreth" has 9, "Cemeteries of
 * Amalo" 6). 0 on any failure, so an unreachable count simply sorts last rather
 * than breaking the enrichment.
 */
async function seriesMemberCount(
	foreignId: number | undefined,
	state?: LookupState
): Promise<number> {
	if (typeof foreignId !== 'number') return 0
	const memoized = seriesCountMemo.get(foreignId)
	if (memoized !== undefined) return memoized
	const probe = state ?? newLookupState()
	const series = await getJson<SeriesResponse>(`/series/${foreignId}`, probe)
	const count = Array.isArray(series?.LinkItems) ? series.LinkItems.length : 0
	// Only memoize a count the mirror actually gave us. This memo has NO TTL, so a
	// 0 recorded from a rate-limited or timed-out call would pin that series at
	// "no members" for the life of the process -- and the count is exactly how a
	// parent series is told from its sub-series, so a wrongly-0 parent loses the
	// ranking and books get shelved under the narrower series.
	if (!probe.degraded) seriesCountMemo.set(foreignId, count)
	return count
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
		const probe = newLookupState()
		result = await fetchGoodreadsSeries(title, author, logger, probe)
		// Only cache an answer the mirror actually gave us. A null produced while
		// rate-limited/unreachable would otherwise pin "no series" on this book for
		// the whole TTL -- the exact damage a throttling event during a full-library
		// refresh would do.
		if (redis && !probe.degraded) {
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

// bookinfo.pro is a free community Goodreads mirror, not a sanctioned API, and it
// answers "Server capacity exceeded" (HTTP 429) under load -- observed live while
// enriching authors, after which it refused connections entirely for a while. A
// scan fans this out across the whole library, so the client must pace ITSELF:
// serialize calls and hold a minimum gap between them, then stand down entirely
// for a cooldown once the server does push back. Being throttled is not just
// impolite, it silently costs data -- a 429'd author simply comes back with no
// portrait, exactly as if none existed.
// Read lazily so tests (and an operator running their own mirror, which needs no
// pacing) can set GOODREADS_MIN_GAP_MS=0 without a rebuild.
function minRequestGapMs(): number {
	const raw = Number(process.env.GOODREADS_MIN_GAP_MS)
	return Number.isFinite(raw) && raw >= 0 ? raw : 1100
}
const BACKOFF_MS = 60000

let nextAllowedAt = 0
let backoffUntil = 0

/**
 * Per-lookup degradation flag, threaded through the calls ONE lookup makes.
 *
 * Set when a call failed for TRANSPORT reasons (429/503, a timeout, a refusal)
 * rather than answering "nothing found". A miss produced while degraded is NOT a
 * real miss, and caching it would blank a book's series or an author's portrait
 * for the whole TTL -- precisely the damage a throttling event during a
 * full-library refresh would otherwise do.
 *
 * Deliberately per-lookup rather than a module-wide counter: the scheduler runs
 * several authors concurrently while the pacer serializes calls, so a shared
 * counter let ONE request's failure invalidate every other in-flight request's
 * perfectly good answer -- measured, the cache then barely populates under
 * exactly the scan load it exists to protect.
 */
interface LookupState {
	degraded: boolean
}

/** A fresh degradation scope for one logical lookup. */
function newLookupState(): LookupState {
	return { degraded: false }
}

/**
 * Clear the pacing/backoff state. Exported for tests ONLY: tripping the backoff
 * suppresses every later call for a cooldown, and because this module's state is
 * shared across test files in one process, a backoff test would otherwise blank
 * out unrelated suites depending on file order (observed: 7 sibling failures).
 */
export function resetGoodreadsThrottle(): void {
	nextAllowedAt = 0
	backoffUntil = 0
	requestChain = Promise.resolve()
}
// Serializes the pacing arithmetic: without a shared tail, N concurrent callers
// each read the same nextAllowedAt and all fire at once.
let requestChain: Promise<void> = Promise.resolve()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait for this caller's turn in the paced queue. */
function takeSlot(): Promise<void> {
	const slot = requestChain.then(async () => {
		const gap = minRequestGapMs()
		if (gap <= 0) return
		const now = Date.now()
		const waitUntil = Math.max(nextAllowedAt, now)
		if (waitUntil > now) await sleep(waitUntil - now)
		nextAllowedAt = Math.max(waitUntil, Date.now()) + gap
	})
	// Keep the chain alive even if a link rejects.
	requestChain = slot.catch(() => undefined)
	return slot
}

async function getJson<T>(path: string, state?: LookupState): Promise<T | null> {
	// Standing down after a push-back: skip the call outright rather than adding
	// to the pile. Counts as degraded -- the null we return says nothing about
	// whether the data exists, so it must not be cached as a miss.
	if (Date.now() < backoffUntil) {
		if (state) state.degraded = true
		return null
	}
	await takeSlot()
	try {
		// retries=3 starts fetchPlus at its own retry ceiling, i.e. exactly ONE
		// attempt. Its ladder fires up to 4 requests per call -- so a slot that the
		// pacer budgets as one request became four, roughly 4x the intended rate
		// and worst exactly while the server is pushing back. Retry policy for this
		// mirror is the backoff below, not fetchPlus's.
		const res = await fetch(`${BASE}${path}`, { timeout: TIMEOUT_MS }, 3)
		return (await res.data) as T
	} catch (err) {
		// fetchPlus rejects with FetchError, which carries the status TOP-LEVEL --
		// there is no `.response`, so reading err.response.status found nothing and
		// the stand-down never fired (measured: 12 requests across 3 lookups against
		// an always-429 mirror).
		const status = (err as { status?: number })?.status
		if (status === 429 || status === 503) backoffUntil = Date.now() + BACKOFF_MS
		// A 4xx OTHER than 429 is the mirror ANSWERING: 404 means no such work or
		// author, which is a real miss worth caching. Only transport failures
		// (429/503, timeouts, refusals -- no status at all) are degradation, or a
		// missing record would never be cacheable and would be re-queried forever
		// against the very mirror the pacing protects.
		const answered = status != null && status >= 400 && status < 500 && status !== 429
		if (!answered && state) state.degraded = true
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
		const trimmed = mine.PositionInSeries.trim()
		// "0" is Goodreads' sentinel for "in this series but UNPOSITIONED" --
		// common on whole-franchise "Publication Order" listings. It cannot
		// order the book, so treat it as no position at all.
		if (trimmed !== '0') return trimmed
	}
	if (
		typeof mine.SeriesPosition === 'number' &&
		Number.isFinite(mine.SeriesPosition) &&
		mine.SeriesPosition > 0
	) {
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
	logger?: FastifyBaseLogger,
	state?: LookupState
): Promise<GoodreadsSeriesResult | null> {
	const want = normalizeTitle(title)
	if (!want) return null

	const q = encodeURIComponent([title, author].filter(Boolean).join(' '))
	const hits = await getJson<SearchHit[]>(`/search?q=${q}`, state)
	if (!Array.isArray(hits) || hits.length === 0) return null

	// Only the first few: /search is relevance-ordered, and walking deeper trades
	// a real risk of a same-universe false accept for a vanishing chance of a hit.
	for (const hit of hits.slice(0, 3)) {
		const workId = hit.workId
		if (typeof workId !== 'number') continue

		const work = await getJson<WorkResponse>(`/work/${workId}`, state)
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

		// Rank the series a book belongs to so the PARENT wins.
		//
		// A book legitimately sits in several nested series -- "The Grief of
		// Stones" is Cemeteries of Amalo #2 AND Chronicles of Osreth #3 -- and
		// which one the shelf uses is a preference, not a fact. Measured against
		// how this operator organizes by hand, the consistent choice is the
		// PARENT (Chronicles of Osreth over Cemeteries of Amalo, The Legend of
		// Drizzt over Legacy of the Drow). The parent is the container, so it has
		// strictly more members; ordering by member count descending makes the
		// automatic pick match the manual one. Declaration order breaks a tie,
		// and an unavailable count sorts last rather than winning by accident.
		//
		// Only pay for the counts when there IS a choice -- a single-series book
		// (the common case) skips the /series lookups entirely.
		let ranked = all
		if (all.length > 1) {
			// Drop edition-variants and franchise orderings, but only if a clean
			// series survives -- otherwise keep them, a variant series beats none.
			const clean = all.filter((s) => !SERIES_VARIANT_RE.test(s.Title ?? ''))
			const pool = clean.length ? clean : all
			const counts = new Map<WorkSeries, number>()
			for (const s of pool) {
				counts.set(s, await seriesMemberCount(s.ForeignId, state))
			}
			// A series that cannot POSITION our book is useless for shelving
			// however large, so positioned series rank first; among those the
			// parent (most members) wins, which matched the manual choice on every
			// case tested -- Chronicles of Osreth over Cemeteries of Amalo, The
			// Legend of Drizzt over Legacy of the Drow, plain Harry Potter over the
			// split-volume edition.
			const positioned = (s: WorkSeries) => (positionFor(s, workId) ? 1 : 0)
			ranked = [...pool].sort(
				(x, y) => positioned(y) - positioned(x) || (counts.get(y) ?? 0) - (counts.get(x) ?? 0)
			)
		}

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

// How many relevance-ordered /search hits to consider when resolving an author.
// The hits are books; the top few resolve to the searched author's own id, and a
// name shared by several people surfaces their distinct ids here to be gated.
// Deliberately small: each extra id is another /author call against a rate-limited
// community mirror, and the correct author is essentially always in the first
// couple of hits (measured: every author we resolved matched on the FIRST id).
const AUTHOR_SEARCH_DEPTH = 2

/** Cached author lookups live under their own prefix, same TTL as series. */
const AUTHOR_CACHE_PREFIX = 'grauthor:v1:'

// Goodreads' placeholder for an author with no photo — a real URL, so it must be
// rejected explicitly or it would count as a "found" portrait.
const GOODREADS_NOPHOTO_RE = /\/nophoto\//i

interface GoodreadsAuthorResponse {
	ForeignId?: number
	Name?: string
	Description?: string
	ImageUrl?: string
}

/**
 * Author photo + bio from Goodreads (via the bookinfo.pro mirror).
 *
 * Goodreads carries a portrait for far more authors than Audible (which usually
 * has none) or Hardcover (whose author data is Wikipedia-sourced, so only
 * notable authors have one). Used to FILL a still-missing portrait/bio, never to
 * override a curated source.
 *
 * Two steps mirror the series lookup: /search is fuzzy and returns BOOKS, each
 * carrying its author's id, so we take the ids behind the top hits and confirm
 * each with isSameAuthor before trusting it — /search will happily surface a
 * co-author or a title-word match, and attaching the wrong person's face is the
 * one failure worse than no photo. Best-effort throughout: any outage/404/rate
 * limit degrades to nulls (getJson), never failing the author update.
 * @param {string} name the author name to resolve
 * @param {FastifyBaseLogger} logger optional logger
 * @returns {Promise<{ image: string | null; bio: string | null }>} portrait + bio, or nulls
 */
export async function fetchGoodreadsAuthorInfo(
	name: string,
	logger?: FastifyBaseLogger,
	state?: LookupState
): Promise<{ image: string | null; bio: string | null }> {
	if (!name.trim()) return { image: null, bio: null }

	const hits = await getJson<SearchHit[]>(`/search?q=${encodeURIComponent(name)}`, state)
	if (!hits?.length) return { image: null, bio: null }

	// Distinct author ids from the top hits, in relevance order.
	const ids: number[] = []
	for (const hit of hits.slice(0, AUTHOR_SEARCH_DEPTH)) {
		const id = hit.author?.id
		if (typeof id === 'number' && !ids.includes(id)) ids.push(id)
	}

	for (const id of ids) {
		const author = await getJson<GoodreadsAuthorResponse>(`/author/${id}`, state)
		// FALSE-POSITIVE GATE: only trust a record whose name confirms it is the
		// same person; a shared first name or a title-word hit is rejected here.
		if (!author?.Name || !isSameAuthor(name, author.Name)) continue
		const image =
			author.ImageUrl && !GOODREADS_NOPHOTO_RE.test(author.ImageUrl) ? author.ImageUrl : null
		const rawBio = author.Description?.trim()
		const bio = rawBio && rawBio !== 'N/A' ? rawBio : null
		if (image || bio) {
			logger?.debug({ name, id }, 'goodreads: author info matched')
			return { image, bio }
		}
	}
	return { image: null, bio: null }
}

/**
 * Cached wrapper around fetchGoodreadsAuthorInfo.
 *
 * The uncached path costs a /search plus up to AUTHOR_SEARCH_DEPTH /author calls
 * EVERY time an author is refreshed -- and Plex refreshes authors constantly, so
 * a scan buries a free community mirror (observed live: HTTP 429 "Server capacity
 * exceeded", after which authors silently came back with no portrait). Cache the
 * ANSWER, including a miss: an author no source has a photo for is exactly the
 * one that would otherwise be re-queried forever.
 * @param {string} name the author name to resolve
 * @param {RedisLike|null} redis the request's redis client, or null
 * @param {FastifyBaseLogger} [logger] optional logger
 * @returns {Promise<{ image: string | null; bio: string | null }>} portrait + bio, or nulls
 */
export async function withGoodreadsAuthorInfo(
	name: string,
	redis: RedisLike | null,
	logger?: FastifyBaseLogger
): Promise<{ image: string | null; bio: string | null }> {
	const trimmed = name.trim()
	if (!trimmed) return { image: null, bio: null }
	const key = AUTHOR_CACHE_PREFIX + trimmed.toLowerCase()

	if (redis) {
		try {
			const cached = await redis.get(key)
			if (cached) return JSON.parse(cached) as { image: string | null; bio: string | null }
		} catch {
			// A cache read failure just means we do the lookup.
		}
	}

	const probe = newLookupState()
	const result = await fetchGoodreadsAuthorInfo(trimmed, logger, probe)

	// Only cache an answer the mirror actually gave us -- see withGoodreadsSeries.
	// Caching a rate-limited null would blank this author's portrait for the TTL.
	if (redis && !probe.degraded) {
		try {
			await redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS)
		} catch {
			// A cache-write failure is not a request failure.
		}
	}
	return result
}

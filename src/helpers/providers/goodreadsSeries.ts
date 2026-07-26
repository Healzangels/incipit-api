import type { FastifyBaseLogger } from 'fastify'

import { normalizeTitle, sim } from '#helpers/providers/matchScorer'
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

// The PUBLIC rreading-glasses instances. api.bookinfo.pro is not "the Goodreads
// API" -- it is one person's server running github.com/blampe/rreading-glasses,
// whose README reports ~12k daily users. Every defensive measure in this module
// exists because of that contention, and none of it is warranted against an
// instance you run yourself.
const PUBLIC_GOODREADS_HOSTS = new Set(['api.bookinfo.pro', 'hardcover.bookinfo.pro'])

/** How hard to defend against the source, and how long to trust its answers. */
export interface GoodreadsTuning {
	profile: 'shared' | 'local'
	minGapMs: number
	hitTtlSeconds: number
	missTtlSeconds: number
}

/** A non-negative number from the environment, or null when absent/junk. */
function envNonNegative(name: string): number | null {
	const raw = process.env[name]
	if (raw == null || raw.trim() === '') return null
	const value = Number(raw)
	// Number.isFinite, not `|| default`: 0 is a legitimate value here (it means
	// "no pacing"), and a falsy check would silently restore the 1100ms tax for
	// the operator who explicitly asked for none.
	return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Which posture this deployment should take, derived from who we are calling.
 *
 * Correct by default for both audiences: an install that configures nothing is
 * talking to the shared instance and keeps every guard, while an operator who
 * deliberately pointed GOODREADS_SERIES_URL somewhere else has told us they own
 * the other end. GOODREADS_PROFILE forces either side -- needed by anyone
 * pointing at a DIFFERENT shared mirror, whose host we cannot recognise.
 *
 * An unparseable URL resolves to `shared`, deliberately: guessing "local" from
 * a typo would drop the pacing that protects a public instance.
 * @returns {GoodreadsTuning} the resolved profile and its knobs
 */
export function goodreadsTuning(): GoodreadsTuning {
	const explicit = process.env.GOODREADS_PROFILE?.trim().toLowerCase()
	let profile: 'shared' | 'local'
	if (explicit === 'shared' || explicit === 'local') {
		profile = explicit
	} else {
		const url = process.env.GOODREADS_SERIES_URL?.trim()
		if (!url) {
			profile = 'shared'
		} else {
			try {
				profile = PUBLIC_GOODREADS_HOSTS.has(new URL(url).hostname.toLowerCase())
					? 'shared'
					: 'local'
			} catch {
				profile = 'shared'
			}
		}
	}
	const shared = profile === 'shared'
	return {
		profile,
		// The only guard that costs anything when the source is fast.
		minGapMs: envNonNegative('GOODREADS_MIN_GAP_MS') ?? (shared ? 1100 : 0),
		// Series membership is effectively immutable, so a long TTL is cheap
		// insurance against a rate-limited mirror. Against a local instance the
		// tradeoff inverts: a re-ask costs milliseconds, while a stale answer
		// hides a Goodreads correction for a month.
		hitTtlSeconds: envNonNegative('GOODREADS_HIT_TTL_SECONDS') ?? (shared ? 2592000 : 604800),
		// A miss is NOT immutable -- the mirror gains records -- so this is the
		// window in which a newly released book stays series-less.
		missTtlSeconds: envNonNegative('GOODREADS_MISS_TTL_SECONDS') ?? (shared ? 86400 : 3600)
	}
}

/**
 * One line naming the resolved posture, for the server log at startup.
 *
 * Worth the line: "why is enrichment slow" and "why is this answer stale" are
 * both answered by the profile, and without this an operator has to read the
 * container's environment to find out which one they are running.
 * @returns {string} a human-readable summary of the active tuning
 */
export function goodreadsTuningSummary(): string {
	const t = goodreadsTuning()
	return (
		`Goodreads source: ${BASE} (${t.profile} profile, ` +
		`pacing ${t.minGapMs}ms, cache hit ${t.hitTtlSeconds}s / miss ${t.missTtlSeconds}s)`
	)
}

/**
 * How close the Goodreads work's title must be to ours before its series is
 * trusted. /search is a fuzzy text endpoint and will happily return a different
 * book in the same universe -- the failure mode that would quietly attach the
 * wrong series to a correct match. Set high because a miss costs nothing (we
 * simply keep the empty field we already had) while a false accept is exactly
 * the mis-shelving this is meant to fix.
 */
const TITLE_ACCEPT = 0.9

/**
 * A title that names a specific EDITION rather than just the work.
 *
 * These are different products, not different wording for the same one. A
 * GraphicAudio dramatization has its own Audible series ("Tress of the Emerald
 * Sea: A Cosmere Novel (Dramatized Adaptation)" is Secret Projects #1, asin
 * B0D1BMZVXV) while Goodreads, which does not model audio editions, offers only
 * the PROSE novel's series (Hoid's Travails).
 *
 * Adopting the prose answer would be accurate NAMING at the cost of accurate
 * MATCHING: it erases the one field saying this row is a different edition,
 * which is what someone needs in order to spot and correct a wrong version.
 * When a title says which edition it is, that is signal, not noise to normalize
 * away.
 */
// Collection words (trilogy/anthology/collection/duology) are here because an
// omnibus is an edition too: "Foundation: The Complete Trilogy" stripped to its
// stem retries as "Foundation" and comes back as Foundation #1 -- a confident
// wrong answer for a product that is three books, not book one.
const EDITION_MARKER_RE =
	/\b(dramati[sz]ed|graphic\s?audio|audio\s?drama|adaptation|abridged|graphic\s+novel|omnibus|box(?:ed)?[\s-]?set|edition|trilogy|duology|anthology|collection)\b/i

/**
 * The title with a trailing subtitle removed, or null when there is nothing to
 * remove.
 *
 * Colon only. Providers use " - " as a volume separator at least as often as a
 * subtitle one ("The Black Company - Book 1"), so splitting on it would strip
 * the part that identifies the book rather than the sales copy.
 *
 * The stem must survive on its own -- a bare number or a single short word is
 * not a title, and searching one invites a false accept from an unrelated book.
 * @param {string} title the full title as the provider gave it
 * @returns {string|null} the stem, or null when it is absent or too thin to use
 */
function titleWithoutSubtitle(title: string): string | null {
	// An edition marker anywhere in the title disqualifies the retry: the bare
	// stem is a DIFFERENT product, so a hit would be a confident wrong answer
	// rather than the miss we started with.
	if (EDITION_MARKER_RE.test(title)) return null
	// The LAST colon, not the first. Provider titles stack segments as
	// "Series: Title: Marketing" -- measured on Chaos Seeds, "The Land:
	// Raiders: A LitRPG Saga" cut at the first colon retried as the bare
	// series stem "The Land", which matched book 1's work at 1.0 and shelved
	// three different books at #1. The marketing subtitle is the trailing
	// segment; everything before it is the identity worth keeping.
	const cut = title.lastIndexOf(':')
	if (cut <= 0) return null
	const base = title.slice(0, cut).trim()
	if (base.length < 4 || base === title.trim()) return null
	if (!/[a-z]/i.test(base)) return null
	return base
}

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
	// The series page's own description. For a translated series, Goodreads
	// librarians record the per-language names here as an "Also known as:" list
	// -- which is what lets an English library shelve "Tintenwelt" as "Inkworld"
	// (see preferredSeriesLanguage below).
	Description?: string
}

/** What the memo keeps per series: the member count and the alias source. */
interface SeriesRecordInfo {
	count: number
	description: string | null
}

// Series records per Goodreads series id, memoized for the life of the process.
// Series membership is effectively immutable, and the same umbrella series
// (Chronicles of Osreth, The Legend of Drizzt) recurs across every book in it,
// so this collapses N books' worth of /series lookups to one per series.
const seriesRecordMemo = new Map<number, SeriesRecordInfo>()

/**
 * A series entry with its name whitespace-normalized (collapsed and trimmed),
 * or undefined when there is no entry or the name empties out. Goodreads
 * librarian titles carry stray whitespace ("Six of Crows " -- series 131836,
 * measured live), and a name adopted verbatim leaks into every sort title
 * built from it. Whitespace is never identity.
 * @param {ProviderBookSeries | undefined} entry the series entry
 * @returns {ProviderBookSeries | undefined} the entry with a clean name
 */
function cleanSeriesName(entry?: ProviderBookSeries): ProviderBookSeries | undefined {
	if (!entry?.name) return entry
	const name = entry.name.replace(/\s+/g, ' ').trim()
	if (!name) return undefined
	return name === entry.name ? entry : { ...entry, name }
}

/**
 * The language the SHELF should be named in, or null when the canonical
 * Goodreads name should be kept as-is.
 *
 * Goodreads canonicalizes a translated series under its ORIGINAL name --
 * Cornelia Funke's Inkworld series is canonically "Tintenwelt" (44451) -- so
 * authority mode, doing its job, renamed an English library's shelf into
 * German. The series page itself declares the per-language names, so preferring
 * the library's language is a rename of the DISPLAY name only: same series id,
 * same positions, same ranking, the one-taxonomy guarantee intact.
 *
 * GOODREADS_SERIES_LANGUAGE: unset defaults to English; "0"/"off"/"canonical"
 * disables the rename entirely; any other value names the language to prefer
 * ("Spanish", "French" -- whatever tag the librarians used in the alias list).
 */
function preferredSeriesLanguage(): string | null {
	const raw = process.env.GOODREADS_SERIES_LANGUAGE?.trim()
	if (raw === undefined || raw === '') return 'English'
	const flat = raw.toLowerCase()
	if (flat === '0' || flat === 'off' || flat === 'canonical') return null
	return raw
}

/**
 * The alias declared for a language in a series description, or null.
 *
 * Parses the Goodreads librarian convention, as served by the mirror:
 *   <b>Also known as:</b>\n - Inkworld (English)\n - Mundo de tinta (Spanish)
 * Only a list explicitly headed "Also known as" is read -- a description that
 * merely mentions a language in prose declares nothing.
 * @param {string | null} description the series record's Description
 * @param {string} language the language tag to look for
 * @returns {string | null} the declared alias, or null
 */
export function seriesAliasFor(description: string | null, language: string): string | null {
	if (!description || !/also known as/i.test(description)) return null
	const text = description.replace(/<[^>]*>/g, ' ')
	const tag = language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const match = new RegExp('[-•*]\\s*([^\\n(]+?)\\s*\\(\\s*' + tag + '\\s*\\)', 'i').exec(text)
	const name = match?.[1]?.trim()
	return name && name.length > 1 ? name : null
}

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
//
// Kinds 1 and 2 are held apart from kind 3 because they are demoted for
// different reasons and one of them can earn its way back. An edition variant
// or a publication ordering is never a shelf a reader wants -- "Forgotten
// Realms - Publication Order" has 301 members spanning dozens of authors. A
// franchise umbrella IS a real shelf, just a coarser one than the sub-series,
// so it is the right answer when the sub-series cannot place the book at all.
const SERIES_ORDERING_RE =
	/\b(publication order|chronological|split[\s-]?volume|omnibus|box[\s-]?set|edition)\b/i
const SERIES_UMBRELLA_RE = /\b\w*verse\b/i

/** An edition variant or franchise ordering: demoted, and never rescued. */
function isOrdering(series: WorkSeries): boolean {
	return SERIES_ORDERING_RE.test(series.Title ?? '')
}

/** A franchise umbrella: demoted, but eligible to be rescued. */
function isUmbrella(series: WorkSeries): boolean {
	return !isOrdering(series) && SERIES_UMBRELLA_RE.test(series.Title ?? '')
}

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
	state?: LookupState,
	logger?: FastifyBaseLogger
): Promise<number> {
	return (await seriesRecord(foreignId, state, logger)).count
}

/**
 * The memoized /series record for a series id: member count plus the
 * description the language alias is parsed from. One fetch serves both
 * consumers -- the ranking (counts) and the shelf-language rename (aliases) --
 * so preferring a language costs nothing extra on the multi-series path the
 * ranking already pays for.
 * @param {number | undefined} foreignId the Goodreads series id
 * @param {LookupState | undefined} state shared lookup state; pass it to make a
 *   degraded fetch degrade the WHOLE lookup (the ranking must -- a wrong count
 *   misranks the pool), omit it when losing the answer is acceptable (the alias
 *   rename is cosmetic and must never spoil a sound result)
 * @param {FastifyBaseLogger} logger optional logger
 * @returns {Promise<SeriesRecordInfo>} the record; zeros/nulls when unavailable
 */
async function seriesRecord(
	foreignId: number | undefined,
	state?: LookupState,
	logger?: FastifyBaseLogger
): Promise<SeriesRecordInfo> {
	if (typeof foreignId !== 'number') return { count: 0, description: null }
	const memoized = seriesRecordMemo.get(foreignId)
	if (memoized !== undefined) return memoized
	// A probe of THIS call's own, not the shared lookup state: the shared flag is
	// sticky, so one earlier blip in the same lookup would block memoizing every
	// record fetched healthily after it -- and this memo is the only thing that
	// keeps a 1400-book scan from re-asking /series per book. Degradation still
	// propagates UP (when the caller passed state) so the lookup knows it ran
	// impaired.
	const probe = newLookupState()
	const series = await getJson<SeriesResponse>(`/series/${foreignId}`, probe, logger)
	const info: SeriesRecordInfo = {
		count: Array.isArray(series?.LinkItems) ? series.LinkItems.length : 0,
		description: typeof series?.Description === 'string' ? series.Description : null
	}
	// Only memoize a record the mirror actually gave us. This memo has NO TTL, so
	// a 0 recorded from a rate-limited or timed-out call would pin that series at
	// "no members" for the life of the process -- and the count is exactly how a
	// parent series is told from its sub-series, so a wrongly-0 parent loses the
	// ranking and books get shelved under the narrower series.
	if (probe.degraded) {
		if (state) state.degraded = true
	} else {
		seriesRecordMemo.set(foreignId, info)
	}
	return info
}

interface WorkResponse {
	Title?: string
	FullTitle?: string
	ShortTitle?: string
	Authors?: Array<{ Name?: string }>
	Series?: WorkSeries[]
	// The work's edition records. For a translated work the WORK is titled in
	// its original language while the English titles live only here -- "Die
	// Farbe der Rache" is the work, "The Color of Revenge" its English edition.
	Books?: Array<{ Title?: string }>
}

export interface GoodreadsSeriesResult {
	primary?: ProviderBookSeries
	secondary?: ProviderBookSeries
	// True when EVERY series the work listed was a demoted variant (an edition
	// variant, a publication/chronological ordering, or a franchise umbrella)
	// and the ranking had to fall back to them. Good enough to gap-fill an empty
	// field, not good enough to overwrite a clean provider series -- see the
	// refusal in withGoodreadsSeries.
	variantOnly?: boolean
}

/** A book that may already carry a series, and the fields a lookup needs. */
interface SeriesEnrichable {
	title?: string
	// The edition guard must see this too: Audible stores title and subtitle as
	// SEPARATE fields, so "(Dramatized Adaptation)" can live entirely in the
	// subtitle and present a clean title to a guard that only reads book.title.
	subtitle?: string | null
	authors?: Array<{ name?: string }>
	seriesPrimary?: { name?: string } | null
	seriesSecondary?: unknown
}

/** Minimal shape of the redis client the route already holds. */
interface RedisLike {
	get(key: string): Promise<string | null>
	set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>
}

// The series cache TTLs now come from goodreadsTuning() -- 30d/1d against the
// shared instance (where re-asking is the rate-limit exposure), 7d/1h against a
// self-hosted one (where a re-ask costs milliseconds and a stale answer costs
// more). See GoodreadsTuning for the reasoning; both remain env-overridable.

// ONE DAY, and deliberately NOT the series TTL. This module caches two very
// different things through the same helper shape, and they age differently: a
// book's series membership is immutable, but an author's photo and bio are not
// -- an author with no portrait today may have one next week. Sharing a single
// constant meant raising it for series silently froze author images for a
// month, re-creating a fixed bug where a throttle pinned "no photo" on authors
// whose records were cached before the lookup started working.
const AUTHOR_CACHE_TTL_SECONDS = 86400
// A full miss ({image:null, bio:null}) is not knowledge -- the mirror gains
// records, and a cache-cold mirror can answer incompletely (measured on Roger
// Zelazny: first answer surfaced only a franchise-continuation author, minutes
// later the real record was there). Short enough to self-heal the same day,
// long enough that a truly photo-less author is not re-queried per refresh.
const AUTHOR_MISS_TTL_SECONDS = 3600

// v3: the v2 keys were built from normalizeTitle, which strips ", Book N"
// volume markers -- so every volume of a series titled "Series, Book N"
// collapsed to ONE key and shared one cached result, position included. Those
// entries are wrong at rest; bumping the prefix abandons them rather than
// serving them out for the remainder of their TTL.
// v4: the shelf-language rename (Tintenwelt -> Inkworld) changed what a lookup
// answers, and the hit TTL is a week -- a version bump is how every cached
// canonical-name answer re-resolves now instead of after TTL.
const CACHE_PREFIX = 'grseries:v4:'

/**
 * Whether a Goodreads position can be used as a shelf key.
 *
 * Goodreads positions are free text and are not always a number: measured live,
 * "Konrad Curze: The Night Haunter" comes back at position "The Primarchs Short
 * Story", which adopted verbatim renders as "Book The Primarchs Short Story" in
 * the sort title. Decimals ARE valid and load-bearing -- novellas sit at 1.1 and
 * 1.5, and dropping the fraction collides them with the whole-numbered book.
 * @param {string|null|undefined} position the raw Goodreads position
 * @returns {boolean} true when it is a plain number, optionally with a fraction
 */
function isShelvablePosition(position: string | null | undefined): boolean {
	return position != null && /^\d+(\.\d+)?$/.test(String(position).trim())
}

function cacheKey(title: string, author: string | null): string {
	// The RAW title, not normalizeTitle: the normalizer exists to score matches,
	// and it strips exactly the ", Book N" marker that distinguishes one volume
	// of a series from the next. A cache key only needs to be stable, not fuzzy.
	const flat = title.trim().replace(/\s+/g, ' ').toLowerCase()
	return CACHE_PREFIX + flat + '|' + (author || '').toLowerCase()
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
	if (!book?.title) return book
	const hadSeries = Boolean(book.seriesPrimary?.name)
	// AUTHORITY MODE. A book's series used to come from whichever provider won
	// the TITLE match, and providers have incompatible taxonomies -- measured on
	// one series, three providers produced three different series names and two
	// "Book 1"s on the same shelf. Goodreads answers the whole series in ONE
	// taxonomy, so consulting it for every book (not just the ~24% with none) is
	// what makes a series internally consistent.
	//
	// Off by env for a library-wide behaviour change: this rewrites the sort
	// title of every book where Goodreads and the provider disagree, so there
	// has to be a way back that is not a redeploy.
	const authority = process.env.GOODREADS_SERIES_AUTHORITY !== '0'
	if (hadSeries && !authority) return book

	// A specific EDITION keeps the series its own provider gave it. The provider
	// matched this exact release and has its ASIN; Goodreads does not model audio
	// editions at all, so its answer is the nearest OTHER product -- the prose
	// novel. Overwriting with that is accurate naming at the cost of accurate
	// matching, and it destroys the evidence that this row is a different
	// edition. Gap-filling is still allowed: with no series there is nothing to
	// destroy, and a name beats none.
	// Both fields: Audible splits title and subtitle, so the marker can live in
	// either half.
	const editionMarked =
		EDITION_MARKER_RE.test(book.title) ||
		Boolean(book.subtitle && EDITION_MARKER_RE.test(book.subtitle))
	if (hadSeries && editionMarked) {
		logger?.debug(
			{ title: book.title, subtitle: book.subtitle, keeping: book.seriesPrimary?.name },
			'goodreads series: title names a specific edition, keeping the provider series'
		)
		return book
	}

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
		// Resolved once per lookup rather than per write: the TTLs depend on which
		// instance we are talking to (see goodreadsTuning).
		const tuning = goodreadsTuning()
		// The lookup owns its own cache write, so a budget timeout below can walk
		// away from it while it finishes in the background and still warms the
		// cache for the next refresh -- the answer is only NEEDED then anyway.
		const lookup = (async () => {
			const fetched = await fetchGoodreadsSeries(title, author, logger, probe)
			// Only cache an answer the mirror actually gave us. A null produced
			// while rate-limited/unreachable would otherwise pin "no series" on
			// this book for the whole TTL -- the exact damage a throttling event
			// during a full-library refresh would do. A HIT keeps the long TTL; a
			// MISS gets a much shorter one, because the mirror gaining the record
			// is exactly what a miss does not rule out.
			if (redis && !probe.degraded) {
				try {
					await redis.set(
						key,
						JSON.stringify(fetched),
						'EX',
						fetched ? tuning.hitTtlSeconds : tuning.missTtlSeconds
					)
				} catch {
					// A cache-write failure is not a request failure.
				}
			}
			return fetched
		})()
		// TIME BUDGET. This runs inline in GET /books/{id}, and the mirror is
		// paced at >=1.1s per request module-wide -- so a cache-cold book behind a
		// slow mirror can hold the WHOLE response past the Plex agent's 25s
		// timeout, losing the entire metadata update to enrich one field. Over
		// budget: serve the book as-is; the lookup keeps running above and caches
		// its answer for the next refresh.
		const budget = timeBudgetMs()
		if (budget > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined
			const overBudget = new Promise<typeof TIME_BUDGET_EXCEEDED>((resolve) => {
				timer = setTimeout(() => resolve(TIME_BUDGET_EXCEEDED), budget)
			})
			const winner = await Promise.race([lookup, overBudget])
			clearTimeout(timer)
			if (winner === TIME_BUDGET_EXCEEDED) {
				lookup.catch(() => undefined)
				logger?.warn(
					{ title, budgetMs: budget },
					'goodreads series: over the time budget, serving without enrichment'
				)
				return book
			}
			result = winner
		} else {
			result = await lookup
		}
		// DEGRADED means: do not apply, do not cache. A mid-lookup 429 zeroes the
		// member counts that rank the pool, so the answer in hand may be misranked
		// -- and with no cache record, the next healthy refresh can answer
		// differently, splitting one shelf across two series names. The provider's
		// own series (or the folder fallback) is strictly safer than a guess.
		if (probe.degraded) {
			logger?.debug({ title }, 'goodreads series: lookup degraded, not applying or caching')
			return book
		}
	}

	if (!result?.primary) return book
	// NAME HYGIENE, on the APPLY path so fresh and week-old CACHED answers both
	// pass through it. Goodreads librarian titles carry stray whitespace --
	// series 131836 is literally "Six of Crows " -- and adopted verbatim it
	// built the Plex sort title "Six of Crows , Book 2", splitting the shelf
	// from its clean-named sibling. Whitespace is never identity.
	result = {
		...result,
		primary: cleanSeriesName(result.primary),
		secondary: cleanSeriesName(result.secondary)
	}
	if (!result.primary) return book
	// OVERRIDING an existing series is held to a much higher bar than filling an
	// empty one. As a gap-filler a wrong answer cost nothing -- the field was
	// blank. As authority it overwrites correct data and mis-shelves a book that
	// was already right, so it must bring a COMPLETE answer: a name AND a
	// position we can actually shelve on.
	//
	// Both refusals below are real records, not caution in the abstract:
	//   * "The Emperor's Soul" is in Elantris on Goodreads with NO position,
	//     while the provider has it at Elantris #2. Adopting that would delete
	//     the book's place on the shelf.
	//   * "Konrad Curze" comes back at position "The Primarchs Short Story",
	//     which would render as "Book The Primarchs Short Story".
	// A FALLBACK answer cannot spend a clean provider series. When every listing
	// the work offered was a demoted variant, the ranking kept them so the book
	// would not end up with no shelf at all -- fine when the field is empty,
	// wrong when it means replacing "Foundation #0.5" with "Foundation
	// (Chronological Order) #1", which is exactly the sort of name the demotion
	// list exists to keep off a shelf. Measured live on Prelude to Foundation
	// and Forward the Foundation.
	if (hadSeries && result.variantOnly) {
		logger?.debug(
			{ title, goodreads: result.primary, kept: book.seriesPrimary },
			'goodreads series: every candidate was a variant listing, keeping the provider series'
		)
		return book
	}
	if (hadSeries && !isShelvablePosition(result.primary.position)) {
		logger?.debug(
			{ title, goodreads: result.primary, kept: book.seriesPrimary },
			'goodreads series: answer not shelvable, keeping the provider series'
		)
		return book
	}
	logger?.debug(
		{ title, series: result, replaced: hadSeries ? book.seriesPrimary : null },
		hadSeries
			? 'goodreads series: replaced an inconsistent provider series'
			: 'goodreads series: enriched a book with no provider series'
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
// How long GET /books/{id} will wait on the inline series lookup before serving
// the book without it. Tunable (and disableable with 0) because the right value
// depends on the caller's own timeout -- the Plex agent gives the API 25s total,
// and the square-cover fetch shares that budget.
const TIME_BUDGET_EXCEEDED = Symbol('goodreads-time-budget-exceeded')

function timeBudgetMs(): number {
	const raw = Number(process.env.GOODREADS_TIME_BUDGET_MS)
	if (Number.isFinite(raw) && raw >= 0) return raw
	return 15000
}

function minRequestGapMs(): number {
	return goodreadsTuning().minGapMs
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

async function getJson<T>(
	path: string,
	state?: LookupState,
	logger?: FastifyBaseLogger
): Promise<T | null> {
	// Standing down after a push-back: skip the call outright rather than adding
	// to the pile. Counts as degraded -- the null we return says nothing about
	// whether the data exists, so it must not be cached as a miss.
	if (Date.now() < backoffUntil) {
		if (state) state.degraded = true
		// Logged because this is INVISIBLE otherwise: every enrichment simply
		// returns nothing, which looks identical to "this author has no photo".
		// Diagnosing one such case took five steps precisely because a stand-down
		// left no trace -- so say so, with how long is left on it.
		logger?.debug(
			{ path, backoffMsRemaining: backoffUntil - Date.now() },
			'goodreads: skipped, standing down after a rate-limit push-back'
		)
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
		if (status === 429 || status === 503) {
			backoffUntil = Date.now() + BACKOFF_MS
			// warn, not debug: being pushed back off the mirror degrades enrichment
			// library-wide for the next minute, and it is the one condition an
			// operator would want to see without raising the log level.
			logger?.warn(
				{ path, status, backoffMs: BACKOFF_MS },
				'goodreads: rate-limited, standing down'
			)
		}
		// A 4xx OTHER than 429 is the mirror ANSWERING: 404 means no such work or
		// author, which is a real miss worth caching. Only transport failures
		// (429/503, timeouts, refusals -- no status at all) are degradation, or a
		// missing record would never be cacheable and would be re-queried forever
		// against the very mirror the pacing protects.
		const answered = status != null && status >= 400 && status < 500 && status !== 429
		if (!answered && state) state.degraded = true
		// Distinguish the three outcomes that all return null: the mirror answered
		// "no such record" (cacheable), or the call failed for transport reasons
		// (not cacheable, and not evidence the record is missing).
		logger?.debug(
			{ path, status: status ?? null, answered },
			answered
				? 'goodreads: no record for this lookup'
				: 'goodreads: lookup failed (transport), treating as degraded'
		)
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
	const first = await lookupByTitle(title, author, logger, state)
	if (first) return first

	// A degraded miss is not a miss. A timed-out /work on pass 1 might have been
	// the full-title hit, so retrying the stem now could answer with a DIFFERENT
	// work than a healthy run would -- and during a backoff window the second
	// paced search is pure cost against the very mirror that pushed back. The
	// caller treats degraded as no-answer either way.
	if (state?.degraded) return null

	// Retry without the marketing subtitle. Our providers bake sales copy into
	// the title -- "Esrever Doom: A Fun-Filled Adventure into the Realm of
	// Xanth" -- where Goodreads files the book as "Esrever Doom".
	//
	// The failure is in /search, not in the verification: it returns ZERO hits
	// for the full string, so there is no candidate to check. (titleSim would
	// have accepted the short title against the long one at 1.0, which is why
	// the gates never got a chance to help.)
	//
	// Bounded deliberately. It only spends a second lookup when the title
	// actually has a subtitle AND the first pass found nothing, so the common
	// paths -- a hit, or a miss on a title with no colon -- cost exactly what
	// they did before, and a miss is cached either way. The base title still
	// faces the same title and author gates, which is what keeps a generic stem
	// ("Star Wars", "The Beginning") from adopting a stranger's series.
	const base = titleWithoutSubtitle(title)
	if (!base) return null
	logger?.debug({ title, base }, 'goodreads series: no hit, retrying without the subtitle')
	// strictGate: a stripped stem must match a candidate's FULL title. The
	// relaxed arms exist for full titles ("our subtitle half", "the candidate's
	// stem"); handing them a stem is sibling-matching by construction --
	// "Ahriman" scores 1.0 against every "Ahriman: X" sibling's stem.
	return lookupByTitle(base, author, logger, state, true)
}

/** One search-and-verify pass for exactly the title given. */
async function lookupByTitle(
	title: string,
	author: string | null,
	logger?: FastifyBaseLogger,
	state?: LookupState,
	strictGate = false
): Promise<GoodreadsSeriesResult | null> {
	const want = normalizeTitle(title)
	if (!want) return null
	// The subtitle half of OUR title, compared against candidates in its own
	// right. Audible titles sequels "Series: Title" -- the work we are looking
	// for is titled by the SUBTITLE half ("Carl's Doomsday Scenario"), which a
	// whole-string ratio scores at ~0.7 and rejects. This arm is what lets the
	// correct work pass; the gate below is what stops book 1 from passing.
	const cut = title.indexOf(':')
	const wantSubtitle = cut > 0 ? normalizeTitle(title.slice(cut + 1)) : ''
	// The volume number in OUR OWN title, when it carries one. normalizeTitle
	// strips ", Book 10" for scoring -- which makes the bare series name (book
	// 1's exact title, for many series) a 1.0 match. The number is the one fact
	// we hold about WHICH volume this is; an answer whose position contradicts
	// it is the wrong work, however well the name matched.
	const volumeHint = /\bbook\s+(\d+(?:\.\d+)?)\b/i.exec(title)?.[1]

	const q = encodeURIComponent([title, author].filter(Boolean).join(' '))
	const hits = await getJson<SearchHit[]>(`/search?q=${q}`, state, logger)
	if (!Array.isArray(hits) || hits.length === 0) return null

	// Only the first few: /search is relevance-ordered, and walking deeper trades
	// a real risk of a same-universe false accept for a vanishing chance of a hit.
	for (const hit of hits.slice(0, 3)) {
		const workId = hit.workId
		if (typeof workId !== 'number') continue

		const work = await getJson<WorkResponse>(`/work/${workId}`, state, logger)
		if (!work) continue

		// Verify before trusting. Compare against every title form the work
		// offers, since Goodreads' Title may carry the series suffix our
		// normalizer strips while ShortTitle does not.
		//
		// NOT titleSim: two of its four arms anchor to OUR stem (baseTitle(want)
		// vs the candidate), which scores the series half of a "Series: Title"
		// name against book 1's exact title at 1.0 -- measured: "Dungeon Crawler
		// Carl: Carl's Doomsday Scenario" scored 1.0 against book 1 and 0.687
		// against its own work, so the wrong book passed and the right one never
		// could. The arms kept here only ever RELAX the candidate side (a work
		// title carrying a "(Series)" suffix) or compare our subtitle half, both
		// of which are safe: they cannot make a different book look like ours.
		// The work's EDITION titles verify too. A translated work is titled in its
		// original language at the work level -- "Die Farbe der Rache" with every
		// title form German -- while the English name exists only on its Books[]
		// edition records, so a gate that reads only the work titles rejects the
		// correct work for exactly the books an English library holds (measured:
		// "Inkworld: The Color of Revenge" scored ~0 against the work and 1.0
		// against its English edition). Safe for the same reason the other arms
		// are: an edition title BELONGS to this work, so matching one can only
		// accept the work it names -- and the author gate and volume veto below
		// still stand between an accepted work and its series being adopted.
		// Deduped and capped: a mega-work (Harry Potter) lists hundreds of
		// editions, and 40 unique names is plenty to find a language match.
		const editionTitles = [
			...new Set(
				(work.Books ?? [])
					.map((b) => b?.Title)
					.filter((t): t is string => typeof t === 'string' && t.length > 0)
			)
		].slice(0, 40)
		const candidates = [work.Title, work.ShortTitle, work.FullTitle, ...editionTitles].filter(
			(t): t is string => typeof t === 'string' && t.length > 0
		)
		const gate = (cand: string): number => {
			const c = normalizeTitle(cand)
			// Strict (retry) pass: full-string only. `want` is already a stripped
			// stem there, and the relaxed arms below would let it sibling-match --
			// measured on Chaos Seeds, and reproducible on any "Series: Title"
			// naming, where the stem equals every sibling's stem at 1.0.
			if (strictGate) return sim(want, c)
			const candStem = c.split(/\s*[:(]\s*/)[0].trim()
			return Math.max(sim(want, c), sim(want, candStem), wantSubtitle ? sim(wantSubtitle, c) : 0)
		}
		const best = candidates.reduce((acc, t) => Math.max(acc, gate(t)), 0)
		if (best < TITLE_ACCEPT) {
			logger?.debug(
				{ workId, best, want },
				'goodreads series: work title too far from ours, not trusting its series'
			)
			continue
		}

		// The title gate alone is not enough to reach past hit #1. Goodreads
		// carries summary and companion records that repeat the real title
		// verbatim -- "White Fire (Pendergast)" by "BookBuddy", "Crimson Shore"
		// by "Brief Books" -- so they clear 0.9 comfortably while belonging to a
		// different author and a different series. Reject only on a POSITIVE
		// mismatch: the mirror omits Authors on some works, and reading absent as
		// wrong would discard good answers to guard against a hypothetical one.
		const credited = (work.Authors ?? [])
			.map((a) => a?.Name)
			.filter((n): n is string => typeof n === 'string' && n.length > 0)
		if (author && credited.length > 0 && !credited.some((n) => isSameAuthor(author, n))) {
			logger?.debug(
				{ workId, credited, author },
				'goodreads series: work is credited to someone else, skipping it'
			)
			continue
		}

		const all = (work.Series ?? []).filter(
			(s): s is WorkSeries => !!s && typeof s.Title === 'string' && s.Title.length > 0
		)
		// `continue`, not `return`: a work with no series editions says nothing
		// about the candidates behind it. Returning here meant one series-less
		// hit at the front of /search buried the real work -- and did it
		// silently, since unlike the gates above this path logged nothing.
		// Measured on Pendergast: White Fire and Crimson Shore both came back
		// with no series while Goodreads had them at #13 and #15.
		if (all.length === 0) {
			logger?.debug({ workId }, 'goodreads series: work lists no series, trying the next hit')
			continue
		}

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
		let variantOnly = false
		if (all.length > 1) {
			// Drop edition-variants, franchise orderings and umbrellas, but only if
			// a clean series survives -- otherwise keep them, a variant beats none.
			const clean = all.filter((s) => !isOrdering(s) && !isUmbrella(s))
			const canPlace = (s: WorkSeries) => isShelvablePosition(positionFor(s, workId))
			let pool: WorkSeries[]
			if (!clean.length) {
				// Nothing survived the demotion. Keep them rather than leave the
				// book with no series at all, but remember it: this answer is a
				// fallback, and the caller must not spend a clean provider series
				// on it.
				variantOnly = true
				pool = all
			} else if (clean.some(canPlace)) {
				pool = clean
			} else {
				// Every clean series names this book without NUMBERING it, which is
				// useless for a shelf: the position is what builds the sort title, so
				// the answer gets discarded downstream and the book falls back to its
				// folder path. That is how one shelf ends up half Goodreads-named and
				// half folder-named -- measured on The Emperor's Soul, which Elantris
				// lists with no position while The Cosmere Universe has it at 7.5.
				//
				// So let an umbrella back in when it can actually place the book. Only
				// an umbrella: a publication ordering stays out, because a coarser
				// real shelf is an acceptable answer and a 301-member cross-author
				// listing is not. The sort below still prefers a positioned series, so
				// the rescued umbrella outranks the clean series that could not place
				// it, and nothing changes for a book whose sub-series CAN.
				const rescued = all.filter((s) => isUmbrella(s) && canPlace(s))
				pool = rescued.length ? [...clean, ...rescued] : clean
			}
			const counts = new Map<WorkSeries, number>()
			for (const s of pool) {
				counts.set(s, await seriesMemberCount(s.ForeignId, state, logger))
			}
			// A series that cannot POSITION our book is useless for shelving
			// however large, so positioned series rank first; among those the
			// parent (most members) wins, which matched the manual choice on every
			// case tested -- Chronicles of Osreth over Cemeteries of Amalo, The
			// Legend of Drizzt over Legacy of the Drow, plain Harry Potter over the
			// split-volume edition.
			// The SAME predicate the rescue gate uses. Raw truthiness scored a
			// free-text position ("The Primarchs Short Story") as positioned, so a
			// clean series that cannot actually place the book tied the rescued
			// umbrella and won on declaration order -- defeating the rescue the
			// comment above promises.
			const positioned = (s: WorkSeries) => (isShelvablePosition(positionFor(s, workId)) ? 1 : 0)
			ranked = [...pool].sort(
				(x, y) => positioned(y) - positioned(x) || (counts.get(y) ?? 0) - (counts.get(x) ?? 0)
			)
		}

		const toSeries = (s: WorkSeries): ProviderBookSeries => {
			// A free-text position is not a shelf key -- adopted verbatim it renders
			// as "Book The Primarchs Short Story" AND its truthiness blocks the
			// folder fallback that could have supplied the real number. Keep the
			// NAME (a name beats none, and the folder can number it), drop the junk.
			const position = positionFor(s, workId)
			// Whitespace-normalized: librarian titles carry stray spaces ("Six of
			// Crows " -- series 131836), and this is what gets CACHED, so clean it
			// at the source too, not only on the apply path.
			const name = (s.Title as string).replace(/\s+/g, ' ').trim()
			return isShelvablePosition(position) ? { name, position: position as string } : { name }
		}

		// A single-series work never enters the ranking above, so check it here
		// too: one ordering listing is just as unfit to overwrite a clean
		// provider series as three of them.
		if (all.length === 1 && (isOrdering(all[0]) || isUmbrella(all[0]))) variantOnly = true
		const result: GoodreadsSeriesResult = { primary: toSeries(ranked[0]) }
		if (ranked[1]) result.secondary = toSeries(ranked[1])
		if (variantOnly) result.variantOnly = true
		// The volume-marker veto (see volumeHint above): our own title says which
		// volume this is, and an answer that contradicts it means the name matched
		// but the WORK did not -- for "Series, Book N" titles the bare series name
		// IS book 1's title. Walk on rather than trust it.
		if (
			volumeHint &&
			result.primary?.position &&
			Number(result.primary.position) !== Number(volumeHint)
		) {
			logger?.debug(
				{ workId, position: result.primary.position, volumeHint },
				'goodreads series: answer contradicts the volume in our own title, skipping it'
			)
			continue
		}
		// Shelf-language rename, LAST: identity work is done (the veto above ran
		// against the canonical answer), so this touches display names only. The
		// alias record rides the same memoized /series fetch the ranking uses; on
		// the single-series path it is the one extra call, paid once per series
		// per process. Deliberately no `state`: losing the alias is cosmetic, and
		// a degraded alias fetch must not spoil (or un-cache) a sound answer.
		const language = preferredSeriesLanguage()
		if (language) {
			const renamed = async (
				chosen: WorkSeries | undefined,
				out: ProviderBookSeries | undefined
			): Promise<ProviderBookSeries | undefined> => {
				if (!chosen || !out) return out
				const info = await seriesRecord(chosen.ForeignId, undefined, logger)
				const alias = seriesAliasFor(info.description, language)
				if (!alias || alias === out.name) return out
				logger?.debug(
					{ workId, canonical: out.name, alias, language },
					'goodreads series: renamed to the declared language alias'
				)
				return { ...out, name: alias }
			}
			result.primary = await renamed(ranked[0], result.primary)
			if (result.secondary) result.secondary = await renamed(ranked[1], result.secondary)
		}
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

	const hits = await getJson<SearchHit[]>(`/search?q=${encodeURIComponent(name)}`, state, logger)
	if (!hits?.length) return { image: null, bio: null }

	// Distinct author ids from the top hits, in relevance order.
	const ids: number[] = []
	for (const hit of hits.slice(0, AUTHOR_SEARCH_DEPTH)) {
		const id = hit.author?.id
		if (typeof id === 'number' && !ids.includes(id)) ids.push(id)
	}

	for (const id of ids) {
		const author = await getJson<GoodreadsAuthorResponse>(`/author/${id}`, state, logger)
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
	logger?: FastifyBaseLogger,
	opts?: { bypassCacheRead?: boolean }
): Promise<{ image: string | null; bio: string | null }> {
	const trimmed = name.trim()
	if (!trimmed) return { image: null, bio: null }
	const key = AUTHOR_CACHE_PREFIX + trimmed.toLowerCase()

	// The bypass exists for the operator's explicit ?update=1: measured live on
	// Roger Zelazny, whose FIRST lookup hit the mirror cache-cold -- the only
	// search hit was a Betancourt continuation novel ("Roger Zelazny's ..."), the
	// name gate correctly refused it, and the honest miss was cached. Minutes
	// later the mirror knew the real author, but the cached miss blocked every
	// retry including the forced update. An explicit update pass re-asks and
	// overwrites; ordinary refreshes keep reading the cache, which is what
	// protects the mirror from Plex's constant author refreshes.
	if (redis && !opts?.bypassCacheRead) {
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
	// An answer with CONTENT keeps the day-long TTL; a full miss is not knowledge
	// (the mirror gains records, and a cache-cold mirror can answer incompletely),
	// so it expires quickly instead of pinning "no portrait, no bio" for a day.
	if (redis && !probe.degraded) {
		const isMiss = !result.image && !result.bio
		try {
			await redis.set(
				key,
				JSON.stringify(result),
				'EX',
				isMiss ? AUTHOR_MISS_TTL_SECONDS : AUTHOR_CACHE_TTL_SECONDS
			)
		} catch {
			// A cache-write failure is not a request failure.
		}
	}
	return result
}

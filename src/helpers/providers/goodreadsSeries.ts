import type { FastifyBaseLogger } from 'fastify'

import { normalizeTitle, sim } from '#helpers/providers/matchScorer'
import type { ProviderBookSeries } from '#helpers/providers/types'
import { isSameAuthor } from '#helpers/utils/authorNameMatch'
import fetch from '#helpers/utils/fetchPlus'
import sleep from '#helpers/utils/sleep'

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
 * A short, stable identity for a mirror URL, for the cache keys.
 *
 * The HOST is what selects the backend; scheme and trailing path are noise
 * (http vs https to the same box is the same data). Lowercased so a casing
 * difference cannot split one mirror's cache in two, and non-key characters
 * are folded out so the key stays greppable in redis.
 * @param {string} base the mirror base URL
 * @returns {string} a short key fragment identifying the mirror
 */
export function mirrorKeyFor(base: string): string {
	let host: string
	try {
		host = new URL(base).host
	} catch {
		// Not a parseable URL (an empty env var, a bare host, a typo): fall
		// back to the leading authority so a malformed value still yields a
		// stable key rather than collapsing every mirror into one.
		host = base.replace(/^https?:\/\//i, '').split('/')[0] ?? base
	}
	return host.toLowerCase().replace(/[^a-z0-9.:-]/g, '') || 'unknown'
}

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
	uncacheableTtlSeconds: number
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
		missTtlSeconds: envNonNegative('GOODREADS_MISS_TTL_SECONDS') ?? (shared ? 86400 : 3600),
		// An UNCACHEABLE answer (sound, but its alias fetch failed -- see
		// LookupState) used to be cached NEVER, so a row whose alias leg fails
		// persistently re-paid the whole lookup on every serve, indefinitely.
		// This TTL bounds both damages at once: it is the longest a shelf can
		// stay split across canonical/alias names, and the longest the answer is
		// served without re-asking. Hours, not the 30-day hit TTL.
		uncacheableTtlSeconds:
			envNonNegative('GOODREADS_UNCACHEABLE_TTL_SECONDS') ?? (shared ? 21600 : 3600)
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
		`pacing ${t.minGapMs}ms, cache hit ${t.hitTtlSeconds}s / miss ${t.missTtlSeconds}s` +
		` / uncacheable ${t.uncacheableTtlSeconds}s)`
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
/**
 * The half AFTER a volume prefix, when the provider prepended one.
 *
 * `titleWithoutSubtitle` keeps what precedes the last colon, because providers
 * usually stack "Series: Title: Marketing". Some prepend a VOLUME instead --
 * "Sons of Valor IV: False Flag" -- and then the identity is the half it throws
 * away. Measured: /search "Sons of Valor IV" returns 0 hits while
 * /search "False Flag" returns work 228408706, Sons of Valor #4, which is what
 * every sibling on that shelf already uses.
 *
 * GATE 1 lives here: the text before the numeral must be the series we ALREADY
 * hold. Without that check the shape alone is far too common to trust -- of the
 * 7 library titles matching it, "The 6:20 Man" is a clock time whose pre-colon
 * half is "The", and this is what rejects it. Returns null when there is no
 * provider series to verify against, so a book with no series never takes this
 * path (it has nothing to disagree with).
 *
 * @param {string} title the provider title
 * @param {string|null|undefined} providerSeries the series we already hold
 * @returns {string|null} the post-colon half, or null when the gate fails
 */
function titleAfterVolumePrefix(
	title: string,
	providerSeries: string | null | undefined
): string | null {
	// Crash guard, and the reason a series-less book never takes this path. Its
	// removal is NOT caught by the suite: flat(undefined) throws, the throw is
	// swallowed upstream (enrichment is best-effort), and the outcome is the same
	// null. Documented rather than claimed as covered.
	if (!providerSeries) return null
	if (EDITION_MARKER_RE.test(title)) return null
	// Roman numerals need 2+ characters: a lone I/V/X/L/C is far more likely a
	// middle initial or a real word than a volume. Arabic 1-2 digits covers the
	// rest without matching a year.
	const m = /^(.{2,60}?)\s+(?:[IVXLC]{2,6}|\d{1,2})\s*:\s*(.+)$/.exec(title.trim())
	if (!m) return null
	const [, prefix, rest] = m
	const post = rest.trim()
	if (post.length < 4 || !/[a-z]/i.test(post)) return null
	// Fold articles and the descriptor nouns providers bolt on, so "Sons of Valor"
	// matches "The Sons of Valor Series".
	const a = foldSeriesTitle(prefix)
	const b = foldSeriesTitle(providerSeries)
	if (!a || !b) return null
	if (a !== b && !b.includes(a) && !a.includes(b)) return null
	return post
}

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

/**
 * The mirror's author record, as the SERIES fallback reads it.
 *
 * Separate from GoodreadsAuthorResponse (photo + bio, further down) because
 * these are the only two fields this path cares about and widening that
 * interface would imply the enrichment path reads them.
 */
interface AuthorSeriesRecord {
	Name?: string
	Series?: WorkSeries[]
	Works?: Array<{ ForeignId?: number; Title?: string }>
}

/**
 * A work-shaped record rebuilt from the AUTHOR record, for when /work is broken.
 *
 * Measured live 2026-07-29 on Brian Andrews' Tier One series: /work/249535826
 * ("The Adversary", book 9) answers HTTP 500 persistently while the other nine
 * works return Series ["Tier One"] normally. With no Goodreads answer the book
 * kept Audible's series name, so book 9 shelved as "The Tier One Thrillers,
 * Book 9" beside book 10's "Tier One, Book 10" -- one series, two shelves,
 * unfixable from the UI because re-matching re-derives the same string.
 *
 * The author record closes it by IDENTITY, never by comparing names:
 * /author/5155903 returns Series[] in which id 180345 "Tier One" carries a
 * LinkItems entry naming ForeignWorkId 249535826 at position 9, and Works[]
 * carries that work's Title so the caller's title gate still runs.
 *
 * Returns null unless BOTH facts are present -- a title to verify against and at
 * least one series that names this work. Fails closed: without a title the
 * caller could not tell our book from a sibling, and adopting a series then is
 * exactly the mis-shelving the gates exist to prevent.
 *
 * Frequency: 0 failures across 40 random library books, so this is a rare
 * outlier. It fires ONLY where the work lookup produced nothing, so it cannot
 * change the series of any book that resolves today.
 */
async function workFromAuthorRecord(
	workId: number,
	authorId: number | undefined,
	state?: LookupState,
	logger?: FastifyBaseLogger
): Promise<WorkResponse | null> {
	if (typeof authorId !== 'number') return null
	const record = await getJson<AuthorSeriesRecord>(`/author/${authorId}`, state, logger)
	if (!record) return null

	// Array.isArray, not `?? []`: a mirror under load has been seen answering with
	// a scalar or an object where a list belongs, and `.find`/`.filter`/`.some` on
	// a non-array throws a TypeError straight out of the enrichment -- a 500 for
	// the whole book, from a path whose entire contract is best-effort. This path
	// runs PRECISELY when the mirror is misbehaving, which is when a malformed
	// body is likeliest.
	const works = Array.isArray(record.Works) ? record.Works : []
	const title = works.find((w) => w?.ForeignId === workId)?.Title
	if (typeof title !== 'string' || title.length === 0) {
		logger?.debug(
			{ workId, authorId },
			'goodreads series: author record does not title this work, not trusting its series'
		)
		return null
	}

	// The author gate downstream rejects only on a POSITIVE mismatch, so handing
	// it an empty Authors list disables it outright -- on the one path that has no
	// /work record to be credited from. That is how a summary-publisher record
	// ("Brief Books", "BookBuddy" -- the shapes that gate exists to stop) clears
	// the title gate and overwrites a correct series. If the record cannot name
	// its own author there is nothing to verify against, so decline instead.
	if (typeof record.Name !== 'string' || record.Name.length === 0) {
		logger?.debug(
			{ workId, authorId },
			'goodreads series: author record names no author, cannot verify the credit'
		)
		return null
	}

	const series = (Array.isArray(record.Series) ? record.Series : []).filter(
		(s): s is WorkSeries =>
			!!s &&
			typeof s.Title === 'string' &&
			s.Title.length > 0 &&
			(Array.isArray(s.LinkItems) ? s.LinkItems : []).some((l) => l?.ForeignWorkId === workId)
	)
	if (series.length === 0) {
		logger?.debug(
			{ workId, authorId },
			'goodreads series: author record names no series containing this work'
		)
		return null
	}

	logger?.warn(
		{ workId, authorId, series: series.map((s) => s.Title) },
		'goodreads series: /work was unusable, recovered this series from the author record'
	)
	return {
		Title: title,
		Authors: [{ Name: record.Name }],
		Series: series
	}
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
	if (!description) return null
	const text = description.replace(/<[^>]*>/g, ' ')
	const header = /also known as\s*:?/i.exec(text)
	if (!header) return null
	// Only the contiguous list AFTER the header is the librarian declaration: a
	// run of "- Name (Language)" lines ending at the first paragraph break.
	// Everything outside that window is prose again, and a prose hyphen followed
	// by "(English)" must not rename a shelf -- the match is also anchored to a
	// line-leading bullet for the same reason.
	const list = text.slice(header.index + header[0].length).split(/\n\s*\n/)[0] ?? ''
	const tag = language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const match = new RegExp(
		'(?:^|\\n)\\s*[-•*]\\s*([^\\n(]+?)\\s*\\(\\s*' + tag + '\\s*\\)',
		'i'
	).exec(list)
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
// An ORDER is only an ordering when a qualifier says so. Measured over all 402
// distinct series names in the 1,607-row ledger (2026-08-01): requiring the
// literal "publication order" missed five real ordering listings carrying 26
// rows between them --
//     14  The Horus Heresy - Black Library recommended reading order
//      3  The MaddAddam Trilogy (Published Order)
//      3  Shannara - Terry's Suggested Reading Order for Revisiting Readers
//      3  Malazan Authors' Suggested Reading Order
//      3  The Chronicles of Narnia (Author's Preferred Order)
// -- while correctly catching the Jack Ryan, Redwall, Robot, Foundation,
// Witcher and Narnia (Chronological) listings.
//
// The qualifier list is what keeps this safe. A BARE "order" is an ordinary
// word in real shelf names: "Order of the Centurion" is a genuine Galaxy's Edge
// sub-series sitting in the ledger right now, and a real shelf misread as an
// ordering is demoted out of the pool, so the book keeps the inconsistent
// provider name and can never converge. A false positive is worse than a miss.
const SERIES_ORDERING_RE =
	/\b(?:(?:publication|published|reading|preferred|suggested|recommended|release)\s+order|chronological|split[\s-]?volume|omnibus|box[\s-]?set|edition)\b/i
const SERIES_UMBRELLA_RE = /\b\w*verse\b/gi
// A franchise umbrella names itself with a coined "-verse" compound (Universe,
// Enderverse, the Cosmere Universe). Matching "\w*verse" alone also caught
// ordinary English words that merely end in those letters -- "Reverse Harem
// Chronicles", "Diverse Energies", "Traverse", "Inverse" all tested TRUE -- and a
// real shelf misread as an umbrella is demoted out of the ranking, so the book
// keeps the inconsistent provider name and can never converge. Exclude the closed
// set of common words; a coined franchise name is never one of them.
const SERIES_UMBRELLA_STOPWORDS =
	/^(?:adverse|averse|converse|diverse|inverse|obverse|perverse|reverse|transverse|traverse|verse)$/i

/**
 * Whether a series NAME is an edition variant or a franchise ordering.
 *
 * Exported so the vocabulary is testable on its own, in the same spirit as
 * `isShelvablePosition`: the enclosing `isOrdering` takes a WorkSeries, so
 * every test of the rule would otherwise have to build a provider payload, and
 * the thing that actually decides — which words count — would stay untested.
 * @param {string | null | undefined} name the series title
 * @returns {boolean} true when the name denotes an ordering, not a shelf
 */
export function isSeriesOrdering(name: string | null | undefined): boolean {
	return SERIES_ORDERING_RE.test(name ?? '')
}

// The librarian sections in a series description LINK to the series they name,
// and the href carries the id: ".../series/94020-les-annales-de-la-compagnie-
// noire". Matching on those IDS is exact -- no name normalization, no
// orthography, no language guessing, which is what sank every earlier
// candidate. Two sections matter, and they point in OPPOSITE directions:
//
//   "Also known as:"  -> these are RE-LISTINGS of me (translations, renumberings)
//   "Sub-series:"     -> these are genuine ARCS within me
//
// Reading the text instead of the links is what made round 2 fail: "French
// numbering" appears in the translation's description AND in the canonical
// series' alias list, so prose cannot tell "I am one" from "I link to one".
// The link direction can.
// A trailing edition qualifier, with whatever separator precedes it. Audible
// titles the Narnia readings "The Horse and His Boy: Unabridged"; the mirror
// search is literal, so that word reaches the query and changes which work
// comes back. Anchored to the END, so "The Unabridged Journals of Sylvia Plath"
// is untouched.
const EDITION_QUALIFIER_RE = /[\s:;,–—-]*[([]?(un)?abridged[)\]]?\s*$/i

/**
 * The title as it should be SEARCHED for: the edition qualifier removed.
 *
 * Deliberately not normalizeTitle, which also strips ", Book N" -- that marker
 * is the volume hint, the one fact we hold about which volume this is.
 * @param {string} title the record's title
 * @returns {string} the title to query the mirror with
 */
export function queryTitle(title: string): string {
	const stripped = title.replace(EDITION_QUALIFIER_RE, '').trim()
	// Never query an empty string: a title that is ONLY a qualifier is junk, but
	// the raw form at least carries whatever the record had.
	return stripped || title
}

const SERIES_AKA_HEADING = /also\s+known\s+as\s*:?/i
const SERIES_SUB_HEADING = /sub-?series\s*:?/i

// SCRIPT ONLY -- deliberately not diacritics and not function words.
//
// Every false positive the adversarial pass found was Latin-with-diacritics:
// Bronte, Anais Nin, Deja Dead, Godel Escher Bach, Tolkien's Eowyn, and this
// library's own "Tales from Alagaesia" (a fictional name, not a language). None
// were non-Latin SCRIPT, because an English-language series is never written in
// Hebrew, Cyrillic, Greek, Arabic or CJK. That makes script a narrow, decidable
// signal where orthography was a guess.
//
// It is a backstop, not the mechanism: the librarian declarations above do the
// work. This only stops a foreign re-listing being PROMOTED into the slot when
// removing a better candidate leaves it next in line -- measured on
// B0057POQJE, where the shelf moved to a Hebrew A Song of Ice and Fire.
const NON_LATIN_SCRIPT = /[Ͱ-ϿЀ-ӿ֐-׿؀-ۿ぀-ヿ一-鿿가-힯]/

/**
 * The series ids linked in the section under `heading`, or [].
 * @param {string | null} description the series record's Description
 * @param {RegExp} heading the section heading to read under
 * @returns {number[]} the linked Goodreads series ids
 */
export function linkedSeriesIdsUnder(description: string | null, heading: RegExp): number[] {
	if (!description) return []
	const match = heading.exec(description)
	if (!match) return []
	// Sections are separated by a blank-ish line; stop at the first one so a
	// later paragraph's incidental link cannot join the list.
	const block = description.slice(match.index + match[0].length).split(/\n\s*\n/)[0] ?? ''
	const ids = new Set<number>()
	for (const hit of block.matchAll(/\/series\/(\d+)/g)) ids.add(Number(hit[1]))
	return [...ids]
}

/** An edition variant or franchise ordering: demoted, and never rescued. */
function isOrdering(series: WorkSeries): boolean {
	return isSeriesOrdering(series.Title)
}

/** A franchise umbrella: demoted, but eligible to be rescued. */
function isUmbrella(series: WorkSeries): boolean {
	if (isOrdering(series)) return false
	// A HYPHEN-joined coinage first: \w cannot cross a hyphen, so "Spider-Verse"
	// tokenizes to the bare word "Verse", which the stopword list (rightly) holds
	// as an ordinary English word. Measured on the mirror, 8 titles diverge between
	// this predicate and the plain /\b\w*verse\b/ it replaced, and 4 sit on
	// multi-series works -- where the undetected umbrella entered the pool as CLEAN
	// and won on member count, overwriting a positioned sub-series.
	// The space-separated case is deliberately NOT exempted: a bare "Verse" after a
	// space is genuinely ambiguous, and "Reverse Harem Story" is a real shelf.
	if (/[\w'’]-verse\b/i.test(series.Title ?? '')) return true
	// Every -verse word, not just the first: "Reverse Harem Universe" must still
	// read as an umbrella on the strength of "Universe".
	const words = (series.Title ?? '').match(SERIES_UMBRELLA_RE) ?? []
	return words.some((w) => !SERIES_UMBRELLA_STOPWORDS.test(w))
}

/**
 * Number of members in a Goodreads series, or 0 when it can't be determined.
 *
 * Used to tell a sub-series from its parent: the parent is the container, so it
 * has strictly more members ("Chronicles of Osreth" has 9, "Cemeteries of
 * Amalo" 6). 0 on any failure, so an unreachable count simply sorts last rather
 * than breaking the enrichment.
 */

/**
 * The memoized /series record for a series id: member count plus the
 * description the language alias is parsed from. One fetch serves both
 * consumers -- the ranking (counts) and the shelf-language rename (aliases) --
 * so preferring a language costs nothing extra on the multi-series path the
 * ranking already pays for.
 * @param {number | undefined} foreignId the Goodreads series id
 * @param {LookupState | undefined} state shared lookup state; pass it to make a
 *   degraded fetch degrade the WHOLE lookup (the ranking must -- a wrong count
 *   misranks the pool). The alias rename passes a probe of its own instead and
 *   maps degradation to `uncacheable`: cosmetic loss must not spoil a sound
 *   answer, but it caps the cache write at the short TTL (see LookupState).
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
	//
	// NEVER memoize a ZERO, degraded or not. `getJson` classifies a 4xx as the
	// mirror ANSWERING rather than degrading (correctly -- a 404 on a /work is a
	// real miss worth caching), but that let a 404 on a /series id, or any 200
	// whose body carried no LinkItems, write count: 0 permanently. One such
	// response then demoted that parent for EVERY remaining book in the series
	// until the process restarted: the "one series, two shelves" split this
	// module exists to prevent, produced by the module itself.
	//
	// The cost of refusing is one re-ask per book for a genuinely empty series,
	// which is rare and cheap; an unknown count already sorts last, so the
	// ranking outcome for a real empty series is unchanged.
	if (probe.degraded) {
		if (state) state.degraded = true
	} else if (info.count > 0) {
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
	// The CLEAN series a rescued franchise umbrella stepped over. Set only by the
	// rescue branch in lookupByTitle: every clean listing named this book without
	// numbering it, so an umbrella that CAN number it was re-admitted and won the
	// ranking. That makes the answer a fallback in the same sense variantOnly is,
	// and it must not be spent on the very sub-series it displaced -- see
	// rescueWouldSpendItsOwnSubSeries.
	rescuedOver?: string[]
}

/**
 * Series-name identity for the rescue refusal: fold a leading article, the
 * typographic apostrophes providers mix freely, and whitespace.
 *
 * Deliberately NOT the `flat` helpers elsewhere in this module. Those also strip
 * descriptor nouns (series/saga/chronicles/...) and their callers compare with
 * `includes`, which is right for matching one title against a provider's wordier
 * spelling of the SAME series. It is wrong here: this library keeps "Riyria" and
 * "The Riyria Chronicles" as distinct shelves, and "Jack Ryan" and "Jack Ryan,
 * Jr." as distinct series (census 2026-07-29, rk 155492 and rk 155442). Exact
 * after fold, never substring.
 */
export const foldSeriesName = (value: string): string =>
	value
		// Canonical form FIRST: 'e\u0301' and '\u00e9' render identically but are
		// different strings, so without this an NFD sub-series name never matched its
		// NFC twin and the refusal silently did not fire.
		.normalize('NFC')
		.replace(/[‘’ʼ′´]/g, "'")
		.replace(/^\s*(?:the|a|an)\s+/i, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()

/**
 * "Are these two strings the same series?" — `foldSeriesName` plus the spacing
 * providers put around a colon.
 *
 * Built BESIDE foldSeriesName, never inside it: that function keys
 * SERIES_ALIASES and gates the rescue refusal and the volume-prefix gates, so
 * widening it would change what MATCHES, not just what shelves.
 *
 * The blind spot was live. Baneblade served `Warhammer 40,000: Imperial Guard`
 * #1 as its shelf and `Warhammer 40,000 : Imperial Guard` #1 as its tag — one
 * series in both slots, which is the exact state shelfPolicy's rule 4 exists to
 * prevent — because a bare fold compare reads the spaced colon as a different
 * name. The same identity is used at three sites (the pin echo test, the policy
 * duplicate test, the harness SECONDARY_DUP check), so all three were blind
 * together and the gate scored the row a MATCH while it shipped the duplicate.
 *
 * Deliberately narrow. Measured over the 732 distinct series names in the
 * golden corpus, this merges EXACTLY ONE pair — the Baneblade pair — and
 * nothing else. It must stay that narrow: stripping punctuation wholesale would
 * merge "Jack Ryan" with "Jack Ryan, Jr.", and comparing with `includes` would
 * merge "Riyria Chronicles" with "Riyria Revelations". Both are distinct
 * shelves in this library by operator census.
 */
const foldSeriesIdentity = (value: string): string =>
	foldSeriesName(value).replace(/\s*([:;,])\s*/g, '$1')

/**
 * Whether two series names denote the same series. Exact after folding, never
 * substring.
 * @param {string | null | undefined} a one series name
 * @param {string | null | undefined} b the other
 * @returns {boolean} true when both are present and denote the same series
 */
export const sameSeriesName = (
	a: string | null | undefined,
	b: string | null | undefined
): boolean => Boolean(a && b) && foldSeriesIdentity(String(a)) === foldSeriesIdentity(String(b))

/**
 * The descriptor nouns providers bolt onto a series name. One list, because it
 * was two: the volume-prefix gates each carried their own copy, so widening it
 * in one place silently left the other narrower.
 */
const SERIES_DESCRIPTORS = /\b(series|thrillers?|novels?|saga|sequence|trilogy|chronicles?)\b/gi

/**
 * Series-name identity for the volume-prefix gates: `foldSeriesName` plus the
 * descriptor strip, so "Sons of Valor" matches "The Sons of Valor Series".
 *
 * Built ON foldSeriesName rather than beside it. Two byte-identical local
 * copies of this used to exist (one spelling the apostrophes as literals, one
 * as escapes, which is how they read as different code), and they had ALREADY
 * drifted from it: both folded two apostrophe characters and neither
 * normalized, while foldSeriesName folds five and applies NFC. So a provider
 * spelling with U+02BC — or any NFD-composed accent — was the same series to
 * the rescue refusal and a DIFFERENT series to these two gates. The NFC bug in
 * particular is one this module already found and fixed once; it simply never
 * reached the copies.
 *
 * Unlike foldSeriesName, callers of this compare with `includes`, which is
 * right for matching a title against a provider's wordier spelling of the same
 * series and wrong for the refusal — see foldSeriesName's note.
 * @param {string} value the raw series or title fragment
 * @returns {string} the folded, descriptor-free form
 */
export const foldSeriesTitle = (value: string): string =>
	foldSeriesName(value).replace(SERIES_DESCRIPTORS, '').replace(/\s+/g, ' ').trim()

/**
 * True when applying this answer would replace a provider series with the very
 * franchise umbrella that displaced it.
 *
 * Extracted rather than written inline at the call site on purpose: mutation
 * testing on this project found inline guards go unenforced -- a prune condition
 * replaced wholesale with `true` once left every test green. A named function is
 * something a test can pin.
 */
export function rescueWouldSpendItsOwnSubSeries(
	result: GoodreadsSeriesResult | null | undefined,
	providerSeriesName?: string | null
): boolean {
	if (!result?.rescuedOver?.length || !providerSeriesName) return false
	const want = foldSeriesName(providerSeriesName)
	if (!want) return false
	return result.rescuedOver.some((name) => foldSeriesName(name) === want)
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
export interface RedisLike {
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
// v5: the key gained the volume hint, the folded provider series, and the
// serve language -- every input that changes the ANSWER (v4 keyed only
// title|author, and a hintless row's entry could poison a hinted sibling:
// probe-proven two-books-at-#1 through the cache). A prefix bump is the
// file's convention for "cached answers are wrong at rest"; the v4 entries
// orphan and every row recomputes cold on next request, with the drift
// ledger's review queue as the designed landing net for the turnover.
// ...and the MIRROR ITSELF is an input to the answer. Neither prefix carried
// it, so pointing GOODREADS_SERIES_URL at a different backend kept serving
// the old one's answers for up to the hit TTL (a week local, a month shared)
// — and this deployment has performed exactly that switch, from the shared
// bookinfo.pro to a self-hosted instance, precisely because the two return
// different data. Folding the mirror's identity in makes a switch behave
// like every other answer-changing input the v4/v5 bumps handled: old rows
// orphan and expire, every row recomputes cold against the new backend.
// v6: the SECONDARY shelf is now chosen from the librarian declarations (the
// "Also known as" re-listings are denied, a declared "Sub-series" list is
// required when the winning shelf publishes one), so a cached v5 answer can
// carry a secondary this code would never emit again -- measured on 39 of 146
// books, 19 of which move from a translated shelf to their real sub-arc. The
// hit TTL is a week; without the bump none of that reaches a shelf until the
// entries expire one by one.
const MIRROR_KEY = mirrorKeyFor(BASE)
const CACHE_PREFIX = `grseries:v6:${MIRROR_KEY}:`

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
export function isShelvablePosition(position: string | null | undefined): boolean {
	return position != null && /^\d+(\.\d+)?$/.test(String(position).trim())
}

/**
 * True when the volume marker in OUR OWN title rules this work out.
 *
 * The marker is the one fact we hold about WHICH volume this is, so an answer
 * that contradicts it means the name matched but the work did not -- for
 * "Series, Book N" titles the bare series name IS book 1's title.
 *
 * But the marker numbers whichever series the PROVIDER chose to subtitle with,
 * and that is routinely a sub-arc: "Legend of Drizzt: Legacy of the Drow, Book 2"
 * yields hint 2 while the ranked answer is the parent at #8. Comparing those two
 * numbers as though they named one series threw away 30 correct answers -- 12
 * Legend of Drizzt albums lost their series entirely, because those ASINs carry a
 * null publication_name and there was no provider series to catch the fall.
 *
 * So corroborate against the WORK, not against the ranked series alone: if any
 * series lists this work at the hint's number, the hint and the answer are two
 * true statements about the same book. The guard the veto exists for survives --
 * "Ahriman" + subtitle "Ahriman, Book 3" adopting the sibling work
 * "Ahriman: Exile" is still ruled out, because no series positions THAT work at 3.
 */
export function volumeHintRulesOutWork(
	volumeHint: string | undefined,
	answerPosition: string | null | undefined,
	workPositions: Array<string | null | undefined>
): boolean {
	if (!volumeHint || !answerPosition) return false
	const want = Number(volumeHint)
	// Number('') is 0, so the emptiness check above is load-bearing, not decoration.
	if (!Number.isFinite(want)) return false
	// No `Number(answerPosition) === want` shortcut: the ranked series is itself one
	// of workPositions, so that case is already covered here. Writing it twice would
	// leave a line no test can kill.
	//
	// Number(undefined) and Number('1-2') are both NaN, and NaN never equals want --
	// an unpositioned or free-text listing cannot corroborate a work.
	return !workPositions.some((p) => Number(p) === want)
}

function cacheKey(
	title: string,
	author: string | null,
	subtitle?: string | null,
	providerSeriesName?: string | null
): string {
	// The RAW title, not normalizeTitle: the normalizer exists to score matches,
	// and it strips exactly the ", Book N" marker that distinguishes one volume
	// of a series from the next. A cache key only needs to be stable, not fuzzy.
	const flat = title.trim().replace(/\s+/g, ' ').toLowerCase()
	// Only the DERIVED inputs join the key, not the raw subtitle: two rows whose
	// subtitles differ cosmetically but yield the same volume hint deserve the
	// same entry. The provider series is folded for the same reason.
	const hint =
		VOLUME_HINT_RE.exec(title)?.[1] ?? (subtitle ? VOLUME_HINT_RE.exec(subtitle)?.[1] : undefined)
	return (
		CACHE_PREFIX +
		flat +
		'|' +
		(author || '').toLowerCase() +
		'|' +
		(hint ?? '') +
		'|' +
		(providerSeriesName ? foldSeriesName(providerSeriesName) : '') +
		'|' +
		(preferredSeriesLanguage() ?? '')
	)
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
	// The module's own doctrine, enforced at the boundary rather than trusted:
	// "an outage, a 404 or a rate limit must never fail the request that asked for
	// it". getJson honours it for transport errors, but everything AROUND the
	// fetches can still throw -- a malformed mirror body reaching a `.filter`, or
	// encodeURIComponent on a lone surrogate in a title (URIError) -- and the route
	// calls this with no try of its own, so one bad record 500s a whole book
	// response to enrich one cosmetic field.
	try {
		return await seriesEnriched(book, redis, logger)
	} catch (err) {
		logger?.warn(
			{ title: book?.title, err },
			'goodreads series: enrichment threw, serving the book unenriched'
		)
		return book
	}
}

async function seriesEnriched<T extends SeriesEnrichable>(
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
	const key = cacheKey(title, author, book.subtitle, book.seriesPrimary?.name)

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
		// Standing down after a degraded lookup on THIS row: serve the book as-is
		// without touching the mirror. A degraded null is rightly never cached, so
		// a record the mirror persistently fails on (measured: a /work that
		// answers 500 on every call) would otherwise re-run the whole
		// search + work + author leg on EVERY serve -- seconds per request,
		// indefinitely, invisible except as latency. Logged for the same reason
		// the module-wide backoff logs its skips: an unlogged stand-down is
		// indistinguishable from "this book has no series".
		const retryAt = degradedStandDown.get(key)
		if (retryAt !== undefined) {
			if (Date.now() < retryAt) {
				logger?.debug(
					{ title, standDownMsRemaining: retryAt - Date.now() },
					'goodreads series: recent lookup degraded, standing down and serving without enrichment'
				)
				return book
			}
			degradedStandDown.delete(key)
		}
		const probe = newLookupState()
		// Resolved once per lookup rather than per write: the TTLs depend on which
		// instance we are talking to (see goodreadsTuning).
		const tuning = goodreadsTuning()
		// The lookup owns its own cache write, so a budget timeout below can walk
		// away from it while it finishes in the background and still warms the
		// cache for the next refresh -- the answer is only NEEDED then anyway.
		const lookup = (async () => {
			const fetched = await fetchGoodreadsSeries(
				title,
				author,
				logger,
				probe,
				book.subtitle,
				book.seriesPrimary?.name
			)
			// Only cache an answer the mirror actually gave us. A null produced
			// while rate-limited/unreachable would otherwise pin "no series" on
			// this book for the whole TTL -- the exact damage a throttling event
			// during a full-library refresh would do. A HIT keeps the long TTL; a
			// MISS gets a much shorter one, because the mirror gaining the record
			// is exactly what a miss does not rule out. UNCACHEABLE is the alias
			// middle state (see LookupState): the answer applies, but only under
			// its own SHORT TTL -- "never cache" was the original reading, and it
			// turned one persistently failing alias leg into a full re-lookup on
			// every serve of that row, forever (measured 1.4-1.6s per request on
			// a mirror whose /work record is permanently broken).
			if (probe.degraded) {
				// The null in hand says nothing about the data, so redis must
				// never see it -- but the REPEAT must still be bounded, or a
				// permanently broken record re-runs this whole leg per serve.
				// In-process and short: see degradedStandDown. No delete on the
				// healthy path -- a row only reaches this lookup after the entry
				// check already removed its expired stand-down.
				armDegradedStandDown(key)
			} else if (redis) {
				try {
					await redis.set(
						key,
						JSON.stringify(fetched),
						'EX',
						probe.uncacheable
							? tuning.uncacheableTtlSeconds
							: fetched
								? tuning.hitTtlSeconds
								: tuning.missTtlSeconds
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
			// finally, not a bare call after the race: a throw out of the lookup
			// skipped clearTimeout, leaving the timer armed for the whole budget and
			// holding the resolve closure -- and through it this request's book, logger
			// and redis handle -- alive with it.
			let winner: GoodreadsSeriesResult | null | typeof TIME_BUDGET_EXCEEDED
			try {
				winner = await Promise.race([lookup, overBudget])
			} finally {
				clearTimeout(timer)
			}
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
	// A rescued umbrella cannot spend the sub-series it displaced. Same doctrine as
	// the variantOnly refusal below, for the one fallback path that does not set it:
	// The Emperor's Soul is in Elantris on Goodreads with NO position, so the
	// umbrella was re-admitted to place it -- and applying that answer would swap
	// the provider's clean "Elantris #2" for "The Cosmere Universe #7.5", moving the
	// book off the shelf its own siblings sit on.
	//
	// Narrow on purpose. It refuses ONLY when the umbrella displaced the very series
	// the provider already named; a provider series the rescue did NOT step over is
	// still overwritten, so Goodreads keeps its authority everywhere else. Measured
	// over 1401 resolvable library records: 1 sets rescuedOver.
	if (hadSeries && rescueWouldSpendItsOwnSubSeries(result, book.seriesPrimary?.name)) {
		logger?.debug(
			{
				title,
				goodreads: result.primary,
				kept: book.seriesPrimary,
				rescuedOver: result.rescuedOver
			},
			'goodreads series: a rescued umbrella would displace the provider sub-series, keeping it'
		)
		return book
	}
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
// Overridable for the harness's determinism mode: the backoff window is
// WALL-CLOCK state, and a replayed 429 arming 60s of skips blankets a replay
// arm that finishes in under a second — the two arms then skip different
// rows. GOODREADS_BACKOFF_MS=0 disables it for record/replay runs only; the
// serving default stays 60s.
//
// READ LAZILY, like minRequestGapMs and timeBudgetMs above. As a module-level
// const this was frozen at IMPORT time, and the harness sets the env var in its
// module BODY — which runs after its imports — so the determinism mode never
// actually disabled anything and both arms kept arming independent 60s
// stand-downs. Worse, a backoff-skipped row makes zero fetches, so it consumes
// zero replay entries and produces zero misses: the run reported itself
// faithful while silently nulling rows.
function backoffMs(): number {
	const raw = Number(process.env.GOODREADS_BACKOFF_MS)
	return Number.isFinite(raw) && raw >= 0 ? raw : 60000
}

let nextAllowedAt = 0
let backoffUntil = 0

// Per-ROW stand-down after a degraded lookup, keyed by the series cache key.
// Deliberately separate from `backoffUntil`: that one is module-wide and armed
// only by an explicit 429/503 push-back; this one bounds the row whose OWN
// records the mirror persistently fails on (a /work answering 500 every call),
// where nothing may be cached and the full lookup would otherwise re-run per
// serve. In-process only and short, so a recovered mirror converges without a
// restart -- and a scan is untouched, because a scan serves each row once.
const degradedStandDown = new Map<string, number>()
// A cap, not an LRU: entries are only ever a library's worth of failing rows,
// so this exists to bound a pathological process's memory, not to manage churn.
// Insertion order IS expiry order (one fixed window), so evicting the oldest
// entry evicts the first to expire.
const DEGRADED_STAND_DOWN_MAX_ROWS = 2048

// READ LAZILY like backoffMs, and disableable the same way (=0): the window is
// wall-clock state, so a frozen import-time read would blind the harness's
// determinism mode and any test that needs the window gone.
function degradedStandDownMs(): number {
	const raw = Number(process.env.GOODREADS_DEGRADED_COOLDOWN_MS)
	return Number.isFinite(raw) && raw >= 0 ? raw : 900000
}

/** Stand this row down for the window; a zero window disables arming outright. */
function armDegradedStandDown(key: string): void {
	const ms = degradedStandDownMs()
	if (ms <= 0) return
	if (degradedStandDown.size >= DEGRADED_STAND_DOWN_MAX_ROWS) {
		const oldest = degradedStandDown.keys().next().value
		if (oldest !== undefined) degradedStandDown.delete(oldest)
	}
	degradedStandDown.set(key, Date.now() + ms)
}

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
	// The middle state between sound and degraded: the ANSWER is sound (apply
	// it), but something cosmetic it may be missing -- the shelf-language alias
	// -- failed to fetch, so caching it under the HIT TTL would pin the
	// un-renamed form for a month while a sibling's healthy lookup gets the
	// alias: one shelf split across two names by the cache. Apply now, cache
	// under the short uncacheableTtlSeconds instead -- "never cache" was the
	// original remedy, and against a persistently failing alias leg it meant
	// re-paying the whole lookup on every serve of the row, forever.
	uncacheable?: boolean
	// Set when an answer was ACCEPTED on the strength of the author-record
	// recovery after a failed /work — the forgiveness is conditioned on that
	// answer surviving to the CALLER. A caller that then discards it (gate 2 of
	// the volume-prefix retry) must re-arm the degradation, or a transport blip
	// caches a manufactured miss for the whole miss TTL.
	recoveredOverFailure?: boolean
}

/** A fresh degradation scope for one logical lookup. */
function newLookupState(): LookupState {
	return { degraded: false }
}

/**
 * Restore ALL of this module's shared state to pristine: pacing, backoff, and
 * the series-record memo. Exported for tests ONLY: the state lives for the
 * process and is shared across test files, so anything one test leaves behind
 * changes what a later test exercises depending on run order. The backoff
 * variant was observed directly (7 sibling failures once tripped); the memo
 * variant was subtler and WORSE -- five tests reusing series ids 1 and 2
 * pinned whichever member counts ran first, and four "parent-series
 * preference" tests then passed without ever consuming their own fixtures.
 * One reset restoring everything means there is no "which reset do I need"
 * trap left to fall into.
 */
export function resetGoodreadsThrottle(): void {
	nextAllowedAt = 0
	backoffUntil = 0
	requestChain = Promise.resolve()
	seriesRecordMemo.clear()
	degradedStandDown.clear()
}
// Serializes the pacing arithmetic: without a shared tail, N concurrent callers
// each read the same nextAllowedAt and all fire at once.
let requestChain: Promise<void> = Promise.resolve()

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
			const ms = backoffMs()
			backoffUntil = Date.now() + ms
			// warn, not debug: being pushed back off the mirror degrades enrichment
			// library-wide for the next minute, and it is the one condition an
			// operator would want to see without raising the log level.
			logger?.warn({ path, status, backoffMs: ms }, 'goodreads: rate-limited, standing down')
		}
		// Which statuses are the mirror ANSWERING "no such record"?
		//
		// Only 404 and 410. Those say the work or author does not exist, which is
		// a real miss worth caching -- otherwise a missing record is re-queried
		// forever against the very mirror the pacing protects.
		//
		// Every other 4xx was previously counted as an answer too, and that is a
		// cache-poisoning bug: 401/403/451 are ACCESS DENIAL and 400/422 mean our
		// own request was malformed. None is evidence the record is absent. A
		// mirror that starts refusing with 403 would leave `degraded` false, so
		// the null would be written as a genuine miss (the write is gated on
		// !degraded) and served for missTtlSeconds -- up to a day -- while no
		// backoff armed, because only 429/503 arm one. A brief bot-block during a
		// library refresh would therefore blank series enrichment for the whole
		// library long after the block lifted.
		const answered = status === 404 || status === 410
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
	const links = Array.isArray(series.LinkItems) ? series.LinkItems : []
	// The sole-link fallback covers a record that omits ForeignWorkId, NOT one that
	// names a different work. A single link naming someone else is someone else's
	// number: adopting it published a stranger's position over our own correct one
	// and, worse, made an unpositioned series look shelvable so it won the ranking.
	const sole = links.length === 1 && links[0]?.ForeignWorkId == null ? links[0] : null
	const mine = links.find((l) => l?.ForeignWorkId === workId) ?? sole
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
 * @param {LookupState} [state] shared degradation state for this lookup
 * @param {string|null} [subtitle] the book's subtitle, read ONLY for the volume
 *   marker. Audible splits a title across both halves, so "Book 9" routinely
 *   lives here while the title looks clean; the veto that uses it is blind to
 *   the commonest provider shape without it. It is deliberately NOT part of the
 *   search query or the title gates, which are tuned for the title alone.
 * @returns {Promise<GoodreadsSeriesResult|null>} verified series, or null
 */
export async function fetchGoodreadsSeries(
	title: string,
	author: string | null,
	logger?: FastifyBaseLogger,
	state?: LookupState,
	subtitle?: string | null,
	providerSeries?: string | null
): Promise<GoodreadsSeriesResult | null> {
	const first = await lookupByTitle(title, author, logger, state, false, subtitle)
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
	if (!base) return volumePrefixRetry(title, author, logger, state, subtitle, providerSeries)
	logger?.debug({ title, base }, 'goodreads series: no hit, retrying without the subtitle')
	// strictGate: a stripped stem must match a candidate's FULL title. The
	// relaxed arms exist for full titles ("our subtitle half", "the candidate's
	// stem"); handing them a stem is sibling-matching by construction --
	// "Ahriman" scores 1.0 against every "Ahriman: X" sibling's stem.
	// The subtitle rides along: stripping the marketing subtitle changes which
	// TITLE we search for, not which volume the book is, so the veto must still
	// hold the stem pass to our own volume number.
	const stem = await lookupByTitle(base, author, logger, state, true, subtitle)
	if (stem) {
		markZeroInformationStemMatch(base, title, subtitle, stem, state, logger)
		return stem
	}
	// LAST resort, and only for the volume-prefix shape (see
	// titleAfterVolumePrefix). Reached only when both passes above found nothing,
	// which is what keeps it off every book that resolves today.
	return volumePrefixRetry(title, author, logger, state, subtitle, providerSeries)
}

/**
 * Cap the cache TTL on a stem match that proved nothing but its own name.
 *
 * THE SHAPE: a "Series: Distinct Title" book whose stem IS the series name.
 * Search the stem and the mirror answers with book 1 — whose title equals the
 * series — at position 1, scoring 1.0 through the strict gate. With no volume
 * marker in either half the veto is dark, so the answer looks confident while
 * carrying no evidence at all beyond "a series by this name exists". Measured
 * live 2026-08-08 with a fabricated volume the mirror does not hold: the
 * lookup returned {He Who Fights with Monsters, #1} for a book that is not #1.
 *
 * DELIBERATELY NOT A REFUSAL. For an actual book 1 with a marketing subtitle
 * ("He Who Fights with Monsters: A LitRPG Adventure") this answer is exactly
 * right, and refusing would break the common case to fix the rare one. The
 * honest distinction is not correctness but CONFIDENCE — so the answer is
 * applied and the cache write is capped at the short TTL instead of a week
 * (local) or a month (shared). A mirror that later gains the real work then
 * corrects the row on its next serve rather than holding a wrong #1 on the
 * shelf until the TTL lapses.
 * @param {string} base the stem that was searched
 * @param {string} title the original title
 * @param {string | undefined} subtitle the original subtitle
 * @param {GoodreadsSeriesResult} result the accepted stem answer
 * @param {LookupState | undefined} state the shared lookup state
 * @param {FastifyBaseLogger} [logger] optional logger
 * @returns {void}
 */
function markZeroInformationStemMatch(
	base: string,
	title: string,
	subtitle: string | null | undefined,
	result: GoodreadsSeriesResult,
	state: LookupState | undefined,
	logger?: FastifyBaseLogger
): void {
	if (!state) return
	// A volume marker in either half means the veto was live and did its job —
	// the answer survived a real test, so it keeps the full TTL.
	const hasVolumeHint = Boolean(
		VOLUME_HINT_RE.exec(title)?.[1] ?? (subtitle ? VOLUME_HINT_RE.exec(subtitle)?.[1] : undefined)
	)
	if (hasVolumeHint) return
	const seriesName = result.primary?.name
	if (!seriesName || foldSeriesName(seriesName) !== foldSeriesName(base)) return
	state.uncacheable = true
	logger?.debug(
		{ title, base, series: seriesName },
		'goodreads series: stem match proves only its own name -- applying it, but capping the cache TTL'
	)
}

/**
 * The third pass: search the half after a volume prefix.
 *
 * GATE 1 is titleAfterVolumePrefix (the prefix must be the series we hold).
 * GATE 2 is here: the ANSWER's series must agree with the series we already
 * hold. That verifies the result rather than trusting the query, and it is what
 * rejects a generic post-colon half -- "He Who Fights with Monsters 11: A LitRPG
 * Adventure" searches "A LitRPG Adventure", lands on an unrelated work, and its
 * series does not match, so the provider series stands.
 */
async function volumePrefixRetry(
	title: string,
	author: string | null,
	logger: FastifyBaseLogger | undefined,
	state: LookupState | undefined,
	subtitle: string | null | undefined,
	providerSeries: string | null | undefined
): Promise<GoodreadsSeriesResult | null> {
	if (state?.degraded) return null
	const post = titleAfterVolumePrefix(title, providerSeries)
	if (!post) return null
	logger?.debug(
		{ title, post, providerSeries },
		'goodreads series: no hit, retrying the half after the volume prefix'
	)
	const found = await lookupByTitle(post, author, logger, state, true, subtitle)
	if (!found?.primary?.name) return null
	const got = foldSeriesTitle(found.primary.name)
	const want = foldSeriesTitle(providerSeries ?? '')
	if (!got || !want || (got !== want && !want.includes(got) && !got.includes(want))) {
		logger?.debug(
			{ title, post, found: found.primary.name, providerSeries },
			'goodreads series: volume-prefix retry answered a DIFFERENT series, keeping the provider one'
		)
		// The discarded answer may have been accepted only via the author-record
		// recovery after a failed /work. Discarding it here means the evidence that
		// /work call carried really is lost — re-arm the degradation so this
		// manufactured miss is neither applied nor CACHED.
		if (state?.recoveredOverFailure) state.degraded = true
		return null
	}
	logger?.warn(
		{ title, post, series: found.primary },
		'goodreads series: recovered via the volume-prefix retry'
	)
	return found
}

// Not a /g regex: exec() on a global pattern carries lastIndex between calls, and
// this one is used against two strings in a row.
const VOLUME_HINT_RE = /\bbook\s+(\d+(?:\.\d+)?)\b/i

/** One search-and-verify pass for exactly the title given. */
async function lookupByTitle(
	title: string,
	author: string | null,
	logger?: FastifyBaseLogger,
	state?: LookupState,
	strictGate = false,
	subtitle?: string | null
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
	//
	// BOTH halves, like the edition guard upstream: Audible stores the marker in
	// whichever half it likes, and "Tier One Thrillers, Book 9" as the SUBTITLE of
	// a clean-looking title is the commonest shape there is. Reading only the title
	// left the veto dark for exactly those rows -- measured, "Ahriman" + subtitle
	// "Ahriman, Book 3" adopted the sibling work "Ahriman: Exile" at position 1,
	// putting two books at #1 on one shelf.
	const volumeHint =
		VOLUME_HINT_RE.exec(title)?.[1] ?? (subtitle ? VOLUME_HINT_RE.exec(subtitle)?.[1] : undefined)

	// The QUERY drops a trailing edition qualifier. The scorer below already
	// ignores it (normalizeTitle strips "unabridged"), but the mirror search is
	// literal, so the word went into the query and changed WHICH WORK came back
	// -- which silently changed the answer.
	//
	// Measured on "The Horse and His Boy" against the live mirror:
	//   "...: Unabridged C.S. Lewis" -> 2 hits, correct work 3294501 SECOND
	//   "...          C.S. Lewis"    -> 5 hits, correct work 3294501 FIRST
	// and end to end through this function, the qualifier moved the answer from
	// The Chronicles of Narnia #5 to #3 -- Audible's chronological number for a
	// shelf that is otherwise publication order, putting two books on Book 3.
	//
	// Only the qualifier goes. NOT normalizeTitle, which also strips ", Book N"
	// -- that marker is the volume hint read just above and the one fact we hold
	// about which volume this is.
	const q = encodeURIComponent([queryTitle(title), author].filter(Boolean).join(' '))
	const hits = await getJson<SearchHit[]>(`/search?q=${q}`, state, logger)
	if (!Array.isArray(hits) || hits.length === 0) return null

	// /search returns BOOKS, so two hits can be two editions of ONE work. The
	// author path below already builds "distinct author ids" for exactly this
	// reason; without the same guard here, three editions of one wrong work spend
	// the whole candidate window on one /work record (re-fetched per hit) and the
	// correct work sitting behind them is never examined.
	const seenWorkIds = new Set<number>()
	// This hit's OWN degradation, pending until we know whether the hit becomes the
	// answer. Flushed at the top of the next iteration (this hit was discarded) and
	// after the loop (nothing was adopted); the `return` at the end of the body is
	// the one exit that drops it, and dropping it is the whole forgiveness -- see
	// the /work call below.
	let pendingDegradation = false
	// Only the first few: /search is relevance-ordered, and walking deeper trades
	// a real risk of a same-universe false accept for a vanishing chance of a hit.
	for (const hit of hits.slice(0, 3)) {
		if (pendingDegradation) {
			if (state) state.degraded = true
			pendingDegradation = false
		}
		const workId = hit.workId
		if (typeof workId !== 'number') continue
		if (seenWorkIds.has(workId)) continue
		seenWorkIds.add(workId)

		// A probe of THIS hit's own, following the idiom seriesRecord established:
		// the shared flag is sticky, so a failure the author record routes around
		// must never be written to it in the first place rather than written and
		// then rewound. Rewinding cannot tell "the failure was routed around" from
		// "something else degraded us meanwhile", and it silently launders any call
		// a later change drops into the window.
		//
		// A failed /work marks the whole lookup degraded, and withGoodreadsSeries
		// then refuses to APPLY or CACHE the answer -- rightly, since a call that
		// failed means we cannot be sure we saw the best candidate, and overriding a
		// provider series on partial evidence is the mis-shelving that guard exists
		// to prevent.
		//
		// It does not hold once the author record has resolved this work by IDENTITY
		// AND that work is the one we return: the failure was routed around, not
		// ignored. Measured live -- without the forgiveness the fallback logged
		// "recovered this series from the author record" on every single request while
		// the response kept serving Audible's name and nothing was ever cached: the
		// answer was found and then thrown away, once per request.
		//
		// It is conditioned on RETURNING, not on recovering, because a recovered work
		// is still only a candidate. Every gate below can discard it -- and the
		// recovered record is thinner than a real one (one title form, no edition
		// titles, an author-scoped series list), so it is likelier to be discarded --
		// at which point the evidence the failed call would have carried really is
		// lost. Forgiving at the recovery site instead let a rejected candidate's
		// failure vanish, which applied a wrong series over the provider's and cached
		// a manufactured "no series" verdict.
		const workProbe = newLookupState()
		let work = await getJson<WorkResponse>(`/work/${workId}`, workProbe, logger)
		if (!work) {
			// A dead /work record used to end this hit SILENTLY, which is how one
			// broken record split the Tier One shelf without leaving a trace to
			// diagnose. Log it, then try to rebuild the record from the author.
			logger?.debug(
				{ workId, authorId: hit.author?.id },
				'goodreads series: /work returned nothing, trying the author record'
			)
			work = await workFromAuthorRecord(workId, hit.author?.id, workProbe, logger)
		}
		if (workProbe.degraded) pendingDegradation = true
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
				(Array.isArray(work.Books) ? work.Books : [])
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
		const credited = (Array.isArray(work.Authors) ? work.Authors : [])
			.map((a) => a?.Name)
			.filter((n): n is string => typeof n === 'string' && n.length > 0)
		if (author && credited.length > 0 && !credited.some((n) => isSameAuthor(author, n))) {
			logger?.debug(
				{ workId, credited, author },
				'goodreads series: work is credited to someone else, skipping it'
			)
			continue
		}

		const all = (Array.isArray(work.Series) ? work.Series : []).filter(
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
		let rescuedOver: string[] | undefined
		let countProbe: LookupState | undefined
		let rescuedOverSeries: WorkSeries[] | undefined
		// The declarations are read off the POOL, never off `all`.
		// seriesRecord is memoized and the count probe below already fetches every
		// pool member, so this costs ZERO extra requests -- reading `all` instead
		// added one call per demoted series and broke four fetch-budget pins.
		// Nothing is lost: both declarations live on the winning shelf, which is
		// by construction in the pool.
		const descById = new Map<number, string | null>()
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
				// Remember WHAT the umbrella stepped over. The apply path needs it:
				// replacing a provider "Elantris #2" with the umbrella that displaced
				// Elantris is the one case where this rescue makes a shelf worse
				// rather than better.
				if (rescued.length) {
					rescuedOver = clean.map((s) => String(s.Title))
					rescuedOverSeries = clean
				}
				pool = rescued.length ? [...clean, ...rescued] : clean
			}
			const counts = new Map<WorkSeries, number>()
			// The counts get their own probe, like /work and /author. They are paid
			// BEFORE the volume veto, so a cosmetic count failure on a candidate the
			// veto then discards used to degrade the shared state permanently -- and a
			// later clean hit was refused because of a failure that belonged to a
			// candidate nobody kept. Flushed onto the shared state at the return path
			// instead (a wrong count really does misrank the answer we DO return).
			countProbe = newLookupState()
			for (const s of pool) {
				// ONE record, both readers. seriesMemberCount was a one-line wrapper
				// over this and had exactly this caller; reading the record directly
				// is what makes the description free. Calling BOTH cost a second
				// fetch whenever the first failed -- a failed record is deliberately
				// not memoized, so the retry consumed a response and shifted the
				// whole lookup.
				const record = await seriesRecord(s.ForeignId, countProbe, logger)
				counts.set(s, record.count)
				if (typeof s.ForeignId === 'number') descById.set(s.ForeignId, record.description)
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
		{
			// DENY: any candidate the librarians list as a re-listing of another
			// candidate ("Also known as"). Catches the translated/renumbered
			// shelves whose NAME declares nothing -- Les Annales de la Compagnie
			// Noire is linked from The Chronicles of the Black Company.
			const denied = new Set<number>()
			for (const desc of descById.values()) {
				for (const id of linkedSeriesIdsUnder(desc, SERIES_AKA_HEADING)) denied.add(id)
			}
			// ALLOW: when the winning shelf declares its own arcs, a candidate that
			// is not one of them is not a sub-arc of this shelf. Discworld lists
			// seven; Kolekcja Swiat Dysku is not among them. When no list is
			// declared the filter is inert -- absence of a declaration is not
			// evidence against a candidate.
			const primaryId = typeof ranked[0]?.ForeignId === 'number' ? ranked[0].ForeignId : null
			const arcs = new Set(
				primaryId === null
					? []
					: linkedSeriesIdsUnder(descById.get(primaryId) ?? null, SERIES_SUB_HEADING)
			)
			const fit = ranked.slice(1).find((s) => {
				const id = typeof s.ForeignId === 'number' ? s.ForeignId : null
				if (id !== null && denied.has(id)) return false
				if (arcs.size && (id === null || !arcs.has(id))) return false
				if (NON_LATIN_SCRIPT.test(String(s.Title ?? ''))) return false
				return true
			})
			if (fit) result.secondary = toSeries(fit)
		}
		if (variantOnly) result.variantOnly = true
		if (rescuedOver?.length) result.rescuedOver = rescuedOver
		// The volume-marker veto (see volumeHint above): our own title says which
		// volume this is, and an answer that contradicts it means the name matched
		// but the WORK did not -- for "Series, Book N" titles the bare series name
		// IS book 1's title. Walk on rather than trust it.
		if (
			volumeHintRulesOutWork(
				volumeHint,
				result.primary?.position,
				// Who may vouch for a volume: the ANSWER's own position, plus the
				// listings that could legitimately BE a shelf. Both halves are
				// load-bearing.
				//
				// The demotion filter is the same one the pool uses -- orderings AND
				// umbrellas. A listing the module refuses to shelve on is unfit to
				// vouch for a volume: "Mistborn" + subtitle "Mistborn, Book 2" was
				// accepted as The Mistborn Saga #1 purely because The Cosmere Universe
				// supplies a 2. Measured on the mirror, 15 of 148 sampled works have a
				// corroborating position available ONLY from an umbrella.
				//
				// The answer's own position must be included explicitly. It used to
				// arrive for free as a member of `all`, which is why this function
				// carries no `answerPosition === want` shortcut -- but filtering
				// falsified that: on the variantOnly path the ANSWER is itself an
				// ordering, so filtering removed the very position that vouches for
				// it and the answer was vetoed by a hint it exactly agreed with
				// (three Foundation rows, all self-agreeing, all nulled).
				[
					result.primary?.position,
					...all.filter((s) => !isOrdering(s) && !isUmbrella(s)).map((s) => positionFor(s, workId))
				]
			)
		) {
			logger?.debug(
				{ workId, position: result.primary?.position, volumeHint },
				'goodreads series: no listing of this work sits at the volume in our own title, skipping it'
			)
			continue
		}
		// Shelf-language rename, LAST: identity work is done (the veto above ran
		// against the canonical answer), so this touches display names only. The
		// alias record rides the same memoized /series fetch the ranking uses; on
		// the single-series path it is the one extra call, paid once per series
		// per process. A degraded alias fetch must not spoil the sound answer in
		// hand (it still applies, canonically named) -- but cached under the HIT
		// TTL it would pin the canonical name for a month while a sibling's
		// healthy lookup gets the alias: a shelf split by the cache. Hence the
		// middle state, not `degraded`: uncacheable, cached only under the short
		// uncacheable TTL.
		const language = preferredSeriesLanguage()
		if (language) {
			const renamed = async (
				chosen: WorkSeries | undefined,
				out: ProviderBookSeries | undefined
			): Promise<ProviderBookSeries | undefined> => {
				if (!chosen || !out) return out
				const aliasProbe = newLookupState()
				const info = await seriesRecord(chosen.ForeignId, aliasProbe, logger)
				if (aliasProbe.degraded && state) state.uncacheable = true
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
			// rescuedOver holds CANONICAL titles, but the provider names the shelf in
			// the display language -- the same response can return secondary "Inkworld"
			// while rescuedOver still says "Tintenwelt", so Gate C never matched and
			// the umbrella took the shelf it exists to protect. Record both forms.
			// Free: every entry was in `pool`, so its /series record is already
			// memoized by the member-count pass above.
			if (result.rescuedOver && rescuedOverSeries) {
				const aliases: string[] = []
				for (const chosen of rescuedOverSeries) {
					const aliasProbe = newLookupState()
					const info = await seriesRecord(chosen.ForeignId, aliasProbe, logger)
					if (aliasProbe.degraded && state) state.uncacheable = true
					const alias = seriesAliasFor(info.description, language)
					if (alias && !result.rescuedOver.includes(alias)) aliases.push(alias)
				}
				if (aliases.length) result.rescuedOver = [...result.rescuedOver, ...aliases]
			}
		}
		// This answer SURVIVED the veto, so a failed member count really did rank it.
		// Flush the count probe onto the shared state now -- a discarded candidate's
		// count failure died with it a few lines above.
		if (countProbe?.degraded && state) state.degraded = true
		if (pendingDegradation && state) state.recoveredOverFailure = true
		logger?.debug({ workId, series: result }, 'goodreads series: resolved')
		return result
	}

	// Nothing was adopted, so the last hit's degradation was never forgiven: the
	// evidence its failed /work call would have carried really is lost. Flushing it
	// keeps this miss out of the cache and stops the stem retry paying for a second
	// paced search against a mirror that just failed.
	if (pendingDegradation && state) state.degraded = true
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
const AUTHOR_CACHE_PREFIX = `grauthor:v1:${MIRROR_KEY}:`

// Goodreads' placeholder for an author with no photo — a real URL, so it must be
// rejected explicitly or it would count as a "found" portrait.
//
// EXPORTED, and the only spelling of this rule in the codebase. Goodreads
// serves the silhouette from several hosts (i.gr-assets.com,
// compressed.photo.goodreads.com), so any rule that reaches for the
// "goodreads.com" domain is strictly narrower and lets one through — and a
// survivor is persisted to author.image, where it reads as a real portrait and
// gates the photo backstop for that author forever. Match the PATH segment.
export const GOODREADS_NOPHOTO_RE = /\/nophoto\//i

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
	opts?: { retryCachedMiss?: boolean }
): Promise<{ image: string | null; bio: string | null }> {
	const trimmed = name.trim()
	if (!trimmed) return { image: null, bio: null }
	const key = AUTHOR_CACHE_PREFIX + trimmed.toLowerCase()

	// retryCachedMiss (the operator's ?force=1, and the second chance) re-asks
	// ONLY when the cache holds an INCOMPLETE answer -- a complete HIT is always
	// honored, so even a forced sweep cannot re-hit the mirror for authors that
	// already have both halves. Incomplete covers the full miss (measured live on
	// Roger Zelazny: his FIRST lookup hit the mirror cache-cold, the name gate
	// correctly refused the only hit, and the honest miss was cached -- blocking
	// every retry while the mirror, minutes later, knew the real author) AND the
	// partial (the cache-cold mirror's other common shape: bio without portrait,
	// which as a force-proof "hit" froze the missing half for a day).
	let cachedPartial: { image: string | null; bio: string | null } | null = null
	if (redis) {
		try {
			const cached = await redis.get(key)
			if (cached) {
				const parsed = JSON.parse(cached) as { image: string | null; bio: string | null }
				const isComplete = Boolean(parsed.image && parsed.bio)
				if (isComplete || !opts?.retryCachedMiss) return parsed
				cachedPartial = parsed
			}
		} catch {
			// A cache read failure just means we do the lookup.
		}
	}

	const probe = newLookupState()
	const fetched = await fetchGoodreadsAuthorInfo(trimmed, logger, probe)
	// A forced re-ask can itself hit a degraded mirror; returning its nulls would
	// hand the caller LESS than the cache already knew. Fresh fields win, cached
	// fields fill. (cachedPartial is only ever set on the forced path.)
	const result = {
		image: fetched.image ?? cachedPartial?.image ?? null,
		bio: fetched.bio ?? cachedPartial?.bio ?? null
	}

	// Only cache an answer the mirror actually gave us -- see withGoodreadsSeries.
	// Caching a rate-limited null would blank this author's portrait for the TTL.
	// A COMPLETE answer keeps the day-long TTL; anything less is not knowledge
	// (the mirror gains records, and a cache-cold mirror answers incompletely),
	// so it expires quickly instead of pinning the missing half for a day.
	if (redis && !probe.degraded) {
		const isComplete = Boolean(result.image && result.bio)
		try {
			await redis.set(
				key,
				JSON.stringify(result),
				'EX',
				isComplete ? AUTHOR_CACHE_TTL_SECONDS : AUTHOR_MISS_TTL_SECONDS
			)
		} catch {
			// A cache-write failure is not a request failure.
		}
	}
	return result
}

import type { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import type { ApiGenre } from '#config/types'
import type { GenreContext } from '#helpers/providers/genreNormalize'
import {
	canonicalName,
	dedupeKey,
	isGenericShelf,
	isNoiseShelf,
	isSelfReference,
	normalizeDisplay,
	splitJoinedShelf
} from '#helpers/providers/genreNormalize'
import HardcoverProvider, {
	defaultGql,
	type HardcoverGql
} from '#helpers/providers/HardcoverProvider'
import { sameVolume, sim, titleSim } from '#helpers/providers/matchScorer'
import { decodeProviderId } from '#helpers/providers/providerId'

/**
 * Genre backfill from Hardcover, for books whose record carries none.
 *
 * WHY THIS EXISTS. Audible's catalog API returns an EMPTY category_ladders for
 * some listings (Annihilation B00HYGYN5Q and Absolution B0D33SC327, measured
 * live 2026-08-07), so their records are honestly genre-less and `update=1`
 * can never backfill them from Audible. The bundle's add_genres only clears
 * the album's existing genres when the served record HAS replacements, so for
 * exactly these books the comma-joined junk in the files' ©gen tags survives
 * ("Literary Fiction, Dystopian, Post-Apocalyptic, Horror" as ONE genre) and
 * the artist page rolls it up into mega-tags. Splitting the junk is not an
 * option — real categories contain commas ("Mystery, Thriller & Suspense") —
 * but replacing it is: Hardcover's community `cached_tags.Genre` is
 * addressable by the SAME asin (editions carry it), verified live for both
 * books above. Serve real genres and the bundle's existing clear-and-replace
 * fixes the album, no plugin change needed.
 *
 * The gate is the record's own genres: an Audible record WITH genres is never
 * touched, so this only ever fills a vacuum.
 *
 * Cache discipline copies alternateCoverCache: an empty answer is written too
 * ("looked, found none" ≠ "never asked"), and without redis there is no
 * compute — nowhere to record the answer means every genre-less book would
 * pay a Hardcover query on every refresh, forever.
 */

/** 30 days. Community genre data moves slowly and a miss is free to re-earn. */
const HIT_TTL_SECONDS = 2592000
/** 7 days for an EMPTY answer: Hardcover tags grow over time, so "none yet"
 * deserves a re-ask sooner than a real answer needs one. */
const MISS_TTL_SECONDS = 604800

/** Bumped whenever the mapping rule below changes, so cached answers computed
 * by the old rule retire wholesale instead of serving stale for a month.
 *
 * v2: name cleaning + the sci-fi alias fold. The first live serve (2026-08-08)
 * put "🐙 Weird Fiction" and a "Science Fiction"/"Sci-fi" duplicate pair on
 * real books — community tags carry emoji and synonyms the raw mapper kept.
 *
 * v3: the shelf-noise layer (see genreNormalize). Every answer cached under v2
 * was computed WITHOUT the joined-shelf split and the format/BISAC/foreign
 * drops, so serving them for another 30 days would leak exactly the names this
 * change exists to remove.
 *
 * v4: umbrella shelves are dropped rather than demoted — a v3 answer can still
 * carry "Fiction" at the tail. */
const KEY_VERSION = 'v4'

/** Most genres a backfill will attach. Hardcover lists by tag frequency, so
 * the head of the list is the community's actual verdict and the tail is
 * noise ("Aliens" was #3 on Absolution). */
const MAX_GENRES = 8

const GENRES_BY_ASIN_QUERY = `query IncipitGenresByAsin($asin: String!) {
	editions(where: { asin: { _eq: $asin } }, limit: 1) {
		book { cached_tags }
	}
}`

const GENRES_BY_EDITION_QUERY = `query IncipitGenresByEdition($id: Int!) {
	editions(where: { id: { _eq: $id } }, limit: 1) {
		book { cached_tags }
	}
}`

const GENRES_BY_BOOK_QUERY = `query IncipitGenresByBook($id: Int!) {
	books(where: { id: { _eq: $id } }, limit: 1) {
		cached_tags
	}
}`

/** Cache key: case-folded and region-stripped like alternateCoverKey, because
 * the bundle's metadata.id arrives as `<id>_<region>`. */
export function hardcoverGenreKey(id: string): string {
	const bare = (id ?? '').split('_')[0] ?? ''
	return `incipit:hcgenres:${KEY_VERSION}:${bare.toUpperCase()}`
}

/**
 * A stable, schema-valid genre "asin" for a Hardcover-sourced genre name.
 *
 * GenreAsinSchema demands 10-12 digits (Audible category ids), and the bundle
 * never reads the asin — only the name — so any deterministic digits work.
 * djb2 over the folded name, offset into [1e9, 2e9) so it is always exactly
 * 10 digits. Collisions are harmless: nothing keys on it.
 * @param {string} name the genre name
 * @returns {string} a stable 10-digit id
 */
export function syntheticGenreAsin(name: string): string {
	let h = 5381
	for (const ch of name.toLowerCase()) h = (h * 33 + (ch.codePointAt(0) ?? 0)) >>> 0
	return String((h % 1_000_000_000) + 1_000_000_000)
}

/**
 * Synonym fold, applied after cleaning. The first live serve had "Science
 * Fiction" and "Sci-fi" side by side on one book; folding the well-known alias
 * lets the dedupe below collapse them. Keys are lowercased clean names.
 *
 * A MAP, not an object literal, and that is the whole point: the keys are
 * upstream-controlled free text (Hardcover community tags, and Chaptarr feeds
 * raw Goodreads shelves through the same mapper). Indexing a plain object with
 * `constructor` or `__proto__` resolves an Object.prototype member, `??` does
 * not fall back to the tag, and the next line's `.toLowerCase()` throws a
 * TypeError — which lands BEFORE the redis.set in both callers, so the book
 * loses every genre AND the empty answer is never cached, re-paying a
 * Hardcover GraphQL query plus a Chaptarr work fetch on every refresh forever.
 */
const GENRE_ALIASES = new Map<string, string>([
	['sci-fi', 'Science Fiction'],
	['scifi', 'Science Fiction'],
	// Measured on Demons Don't Dream 2026-08-09: "Humor" and "Humour" arrived on
	// the SAME book. dedupeKey cannot fold these — they differ by a letter, not
	// by case, plural or a suffix — so the synonym table is the right place.
	['humour', 'Humor'],
	['humourous', 'Humorous'],
	['fantacy', 'Fantasy']
])

/**
 * A community tag name reduced to a plain genre name, or '' when nothing
 * survives. Strips emoji/pictographs and their joiners (measured live:
 * "🐙 Weird Fiction"), then collapses whitespace. Deliberately nothing more —
 * only what a real serve has produced gets a rule.
 * @param {string} name the raw tag name
 * @returns {string} the cleaned name, possibly empty
 */
export function cleanGenreName(name: string): string {
	return name
		.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Map Hardcover's cached_tags to ApiGenre[].
 *
 * Only the `Genre` bucket — Moods ("mysterious") and Tags ("Unloveable
 * Characters") are review-vocabulary, not shelf genres. "General" is BISAC
 * filler ("FICTION / General"), not a genre, and is dropped. Names are
 * cleaned and alias-folded first, and the dedupe runs on the RESULT, so
 * "🐙 Weird Fiction" collapses into "Weird Fiction" and "Sci-fi" into an
 * existing "Science Fiction" instead of arriving as siblings.
 * @param {unknown} raw the cached_tags value (object over the wire; a string
 *   is tolerated defensively since it is jsonb upstream)
 * @param {GenreContext} [ctx] the book, so a shelf restating it is dropped
 * @returns {ApiGenre[]} cleaned, deduped, capped, schema-valid genres
 */
export function genresFromCachedTags(raw: unknown, ctx: GenreContext = {}): ApiGenre[] {
	let tags = raw
	if (typeof tags === 'string') {
		try {
			tags = JSON.parse(tags)
		} catch {
			return []
		}
	}
	if (!tags || typeof tags !== 'object') return []
	const bucket = (tags as Record<string, unknown>)['Genre']
	if (!Array.isArray(bucket)) return []
	const names: string[] = []
	for (const entry of bucket) {
		const name =
			typeof entry === 'string' ? entry : ((entry as { tag?: unknown } | null)?.tag ?? null)
		if (typeof name === 'string') names.push(name)
	}
	return namesToGenres(names, ctx)
}

/**
 * Raw genre NAMES to schema-valid ApiGenre[] — the one mapping rule, shared by
 * every community-genre source (Hardcover cached_tags, Chaptarr work genres),
 * so a new source cannot drift from the cleaning/alias/dedupe discipline:
 * cleanGenreName, the alias fold, the "General" drop, case-insensitive dedupe,
 * and the cap, in that order.
 * @param {string[]} names raw names in source order
 * @returns {ApiGenre[]} cleaned, deduped, capped genres
 */
export function namesToGenres(names: string[], ctx: GenreContext = {}): ApiGenre[] {
	const seen = new Set<string>()
	// UMBRELLAS ARE DROPPED, not sorted to the back.
	//
	// They were demoted first, which fixed the case that mattered — Hardcover
	// ranked "Fiction" fourth by tag frequency on Fourth Wing and took eight of
	// ten slots, so "High Fantasy" and "Magic" never got one. But demotion only
	// moves them; where a book has few community genres they still arrive, and
	// Project Hail Mary came back with "Fiction" and "Adult" beside Audible's own
	// "Science Fiction & Fantasy" (measured live 2026-08-10). Neither says
	// anything a reader can browse by, and Audible already covers the umbrella
	// level better than the community does.
	//
	// Dropping is also the SAFE shape: it can only free a slot, never take one
	// from a specific genre. Both regressions in this area came from rules that
	// re-ranked things — a trailing-"fiction" fold that collapsed "Science
	// Fiction" onto "science", and "classic" wrongly marked an umbrella, which
	// pushed "Classics" off The Da Vinci Code and let "Russian" in.
	const out: ApiGenre[] = []
	for (const name of names) {
		// SPLIT FIRST. A joined shelf carries several real genres, and judging the
		// whole string discards all of them: "Fiction / Fantasy / General" is one
		// over-long BISAC path but three usable parts.
		for (const part of splitJoinedShelf(cleanGenreName(name))) {
			const cleaned = cleanGenreName(part)
			if (!cleaned) continue
			const aliased = GENRE_ALIASES.get(cleaned.toLowerCase()) ?? cleaned
			if (isNoiseShelf(aliased)) continue
			if (isSelfReference(aliased, ctx)) continue
			// The canonical spelling is chosen by the FOLD KEY, so every book that
			// reaches this genre by any spelling shows the same tag.
			const rawKey = dedupeKey(aliased)
			const display = canonicalName(rawKey) ?? normalizeDisplay(aliased)
			// Dedupe on the CANONICAL key, so two spellings that resolve to one
			// display name cannot both be kept.
			const key = dedupeKey(display)
			if (!key || seen.has(key)) continue
			seen.add(key)
			if (isGenericShelf(display)) continue
			out.push({ asin: syntheticGenreAsin(display), name: display, type: 'genre' })
			if (out.length >= MAX_GENRES) return out
		}
	}
	return out
}

/** True when every entry looks like a cached ApiGenre. Exported because every
 * community-genre cache re-reads the same shape; a second copy of this guard
 * is a second place for it to drift from ApiGenre. */
export function isGenreArray(v: unknown): v is ApiGenre[] {
	return (
		Array.isArray(v) &&
		v.every(
			(g) =>
				!!g &&
				typeof g === 'object' &&
				typeof (g as ApiGenre).asin === 'string' &&
				typeof (g as ApiGenre).name === 'string' &&
				typeof (g as ApiGenre).type === 'string'
		)
	)
}

interface BackfillOpts {
	/** The REQUESTED id — asin or provider id, exactly as the route was asked. */
	id: string
	redis: FastifyRedis | null
	token?: string
	logger?: FastifyBaseLogger
	/** Test seam, same shape as HardcoverProvider's constructor injection. */
	gql?: HardcoverGql
	/** The book itself, so a shelf that merely restates it can be dropped. */
	ctx?: GenreContext
}

interface CachedTagsEnvelope {
	editions?: { book?: { cached_tags?: unknown } | null }[]
	books?: { cached_tags?: unknown }[]
}

/** Resolve the id form to (query, variables), or null when Hardcover cannot
 * be asked about this id at all (openlibrary/storytel/... natives). */
function queryFor(id: string): { query: string; variables: Record<string, unknown> } | null {
	const decoded = decodeProviderId(id.split('_')[0] ?? '')
	if (decoded === null) {
		// A plain ASIN: Hardcover editions carry asin for dedup, so ask by it.
		return { query: GENRES_BY_ASIN_QUERY, variables: { asin: id.split('_')[0] } }
	}
	if (decoded.provider !== 'hardcover') return null
	const nativeId = Number(decoded.nativeId)
	return decoded.kind === 'edition'
		? { query: GENRES_BY_EDITION_QUERY, variables: { id: nativeId } }
		: { query: GENRES_BY_BOOK_QUERY, variables: { id: nativeId } }
}

/**
 * The genres Hardcover holds for this id, cached, never throwing.
 *
 * Returns [] for every "can't answer" shape — no redis (no compute without a
 * place to record it), no token, a non-Hardcover provider id, an upstream
 * error (uncached: transient failure must not pin "no genres" for a week).
 * @param {BackfillOpts} opts id, redis, token, optional logger/transport
 * @returns {Promise<ApiGenre[]>} genres for the id, possibly empty
 */
export async function backfillHardcoverGenres(opts: BackfillOpts): Promise<ApiGenre[]> {
	const { id, redis, token, logger } = opts
	if (!redis || !id) return []

	try {
		const raw = await redis.get(hardcoverGenreKey(id))
		if (raw) {
			const parsed: unknown = JSON.parse(raw)
			if (isGenreArray(parsed)) return parsed
		}
	} catch {
		// A broken cache has told us nothing; fall through and compute.
	}

	if (!token) return []
	const q = queryFor(id)
	if (!q) return []

	try {
		const gql = opts.gql ?? defaultGql
		const data = await gql<CachedTagsEnvelope>(q.query, q.variables, token)
		const cachedTags = data.editions?.[0]?.book?.cached_tags ?? data.books?.[0]?.cached_tags
		const genres = genresFromCachedTags(cachedTags, opts.ctx ?? {})
		await redis
			.set(
				hardcoverGenreKey(id),
				JSON.stringify(genres),
				'EX',
				genres.length ? HIT_TTL_SECONDS : MISS_TTL_SECONDS
			)
			.catch(() => {})
		return genres
	} catch (err) {
		logger?.warn({ err, id }, 'hardcover genre backfill failed; serving without genres')
		return []
	}
}

/** Same thresholds as the Chaptarr rescue — one confirmation standard. */
const TITLE_CONFIRM = 0.85
const AUTHOR_CONFIRM = 0.9
/** 7 days: a title-matched answer is weaker evidence than an id-keyed one. */
const TITLE_TTL_SECONDS = 604800

/** Cache key for a Hardcover title rescue. */
export function hardcoverTitleGenreKey(title: string, author: string): string {
	const fold = (s: string) =>
		(s ?? '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
	return `incipit:hctgenres:${KEY_VERSION}:${fold(title)}|${fold(author)}`
}

interface TitleRescueOpts {
	title: string
	author: string
	redis: FastifyRedis | null
	token?: string
	logger?: FastifyBaseLogger
	ctx?: GenreContext
	gql?: HardcoverGql
	/** Test seam: the provider whose search finds the book. */
	provider?: {
		search: (
			q: unknown,
			l?: FastifyBaseLogger
		) => Promise<{ id: string; title: string; authors: string[] }[]>
	}
}

/**
 * LAST RESORT: Hardcover genres found by TITLE, for a book its ASIN cannot
 * reach.
 *
 * WHY. backfillHardcoverGenres queries by asin/edition/book id, so an audiobook
 * ASIN that is simply absent from Hardcover's edition table misses a book
 * Hardcover plainly has. Measured 2026-08-10 on the 25 plain-ASIN albums still
 * without genres after the Chaptarr rescue: Chaptarr resolved every one of them
 * to the right work but those works carry NO genres (Neuromancer, Brave New
 * World, The Odyssey, four Vince Flynn thrillers), while Hardcover holds 7-9
 * good genres for the same books under a different edition id. 14 of the 25
 * are recoverable this way.
 *
 * CONFIRMED on title, author AND volume. The volume check is not defensive
 * padding: probing this fallback, "Wreck Jumpers 2" and "Wreck Jumpers 3" both
 * matched the SAME hardcover book, because titleSim treats a trailing volume
 * number as noise.
 * @param {TitleRescueOpts} opts title, author, redis, token, optional seams
 * @returns {Promise<ApiGenre[]>} genres, or [] when nothing confirmed
 */
export async function hardcoverGenresByTitle(opts: TitleRescueOpts): Promise<ApiGenre[]> {
	const { title, author, redis, token, logger } = opts
	if (!redis || !title || !author) return []

	const key = hardcoverTitleGenreKey(title, author)
	try {
		const raw = await redis.get(key)
		if (raw) {
			const parsed: unknown = JSON.parse(raw)
			if (isGenreArray(parsed)) return parsed
		}
	} catch {
		// A broken cache has told us nothing; compute.
	}
	if (!token) return []

	let genres: ApiGenre[] = []
	try {
		// THE PROVIDER'S OWN SEARCH, not a hand-written title query.
		//
		// The first version of this asked `books(where: { title: { _ilike: … } })`
		// and Hardcover answered 403 to every single call — measured in the
		// container log 2026-08-10 on Neuromancer, Brave New World, Count Zero and
		// The Peripheral. That is an unindexed scan of the whole books table, and
		// Hardcover blocks it; its documented entry point is the `search` query,
		// which HardcoverProvider already wraps and which demonstrably works.
		//
		// So: reuse the search to find the book, then hand its id to the id-keyed
		// backfill below. Two proven components instead of one invented query.
		const provider = opts.provider ?? new HardcoverProvider({ token, gql: opts.gql })
		const candidates = await provider.search({ title, author, region: 'us' } as never, logger)
		for (const c of candidates) {
			if (titleSim(title, c.title ?? '') < TITLE_CONFIRM) continue
			// A trailing volume number is noise to titleSim: "Wreck Jumpers 2" and
			// "Wreck Jumpers 3" both matched ONE hardcover book while probing this.
			if (!sameVolume(title, c.title ?? '')) continue
			if (!(c.authors ?? []).some((n) => sim(author, n) >= AUTHOR_CONFIRM)) continue
			const found = await backfillHardcoverGenres({
				id: c.id,
				redis,
				token,
				logger,
				ctx: opts.ctx,
				gql: opts.gql
			})
			if (found.length) {
				genres = found
				break
			}
		}
	} catch (err) {
		logger?.warn({ err, title }, 'hardcover title genre rescue failed; serving without genres')
		return []
	}

	await redis.set(key, JSON.stringify(genres), 'EX', TITLE_TTL_SECONDS).catch(() => {})
	return genres
}

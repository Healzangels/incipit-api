import type { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import type { ApiGenre } from '#config/types'
import { defaultGql, type HardcoverGql } from '#helpers/providers/HardcoverProvider'
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
 * by the old rule retire wholesale instead of serving stale for a month. */
const KEY_VERSION = 'v1'

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
 * Map Hardcover's cached_tags to ApiGenre[].
 *
 * Only the `Genre` bucket — Moods ("mysterious") and Tags ("Unloveable
 * Characters") are review-vocabulary, not shelf genres. "General" is BISAC
 * filler ("FICTION / General"), not a genre, and is dropped.
 * @param {unknown} raw the cached_tags value (object over the wire; a string
 *   is tolerated defensively since it is jsonb upstream)
 * @returns {ApiGenre[]} deduped, capped, schema-valid genres
 */
export function genresFromCachedTags(raw: unknown): ApiGenre[] {
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
	const seen = new Set<string>()
	const out: ApiGenre[] = []
	for (const entry of bucket) {
		const name =
			typeof entry === 'string' ? entry : ((entry as { tag?: unknown } | null)?.tag ?? null)
		if (typeof name !== 'string') continue
		const clean = name.trim()
		if (!clean || /^general$/i.test(clean)) continue
		const key = clean.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push({ asin: syntheticGenreAsin(clean), name: clean, type: 'genre' })
		if (out.length >= MAX_GENRES) break
	}
	return out
}

/** True when every entry looks like a cached ApiGenre. */
function isGenreArray(v: unknown): v is ApiGenre[] {
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
		const genres = genresFromCachedTags(cachedTags)
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

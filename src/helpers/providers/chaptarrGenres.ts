import type { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import type { ApiGenre } from '#config/types'
import {
	chaptarrEnabled,
	type ChaptarrWorkFetch,
	fetchChaptarrWork
} from '#helpers/providers/ChaptarrProvider'
import type { GenreContext } from '#helpers/providers/genreNormalize'
import { cleanGenreName, isGenreArray, namesToGenres } from '#helpers/providers/hardcoverGenres'
import { decodeProviderId } from '#helpers/providers/providerId'

/**
 * Genre backfill from the Chaptarr metadata service — the SECOND source in the
 * genre leg, consulted only when Hardcover answered empty.
 *
 * Its genres are Goodreads-shelf aggregates: broader than Hardcover's curated
 * bucket (Annihilation gets Dystopia/Weird fiction/Thriller that Hardcover
 * lacks) but noisier — the live list also carried "Audiobook", "Book Club" and
 * "General", which are shelving habits, not genres. The SHELF_NOISE filter
 * drops those; everything else goes through the same namesToGenres discipline
 * as Hardcover (clean, alias-fold, dedupe, cap), so the two sources cannot
 * drift.
 *
 * Cache discipline copies hardcoverGenres exactly: empty answers cached (7d)
 * so genre-less books do not re-ask every refresh, hits cached 30d, errors
 * never cached, no redis -> no compute.
 */

/** Goodreads shelving habits that are not genres. Lowercased, post-clean. */
const SHELF_NOISE = new Set([
	'audiobook',
	'audiobooks',
	'audio book',
	'book club',
	'currently reading',
	'to read',
	'owned',
	'favorites',
	'favourites',
	'kindle',
	'library',
	'ebook',
	'e book',
	'dnf',
	'did not finish'
])

const HIT_TTL_SECONDS = 2592000
const MISS_TTL_SECONDS = 604800

/** Bumped whenever the mapping rule changes, exactly like hardcoverGenreKey.
 *
 * v2: the shelf-noise layer and the canonical-spelling table. THIS WAS MISSED
 * when the noise layer shipped — the Hardcover key went v2 -> v3 and this one
 * was left at v1, which would have served pre-normalization answers out of
 * cache for a further 30 days while the code that produced them was gone. Two
 * caches, two versions, one rule change: bump BOTH.
 *
 * v3: umbrella shelves are dropped rather than demoted, so every v2 answer
 * carries a "Fiction"/"Adult" this rule would now remove. */
const KEY_VERSION = 'v3'

export function chaptarrGenreKey(id: string): string {
	const bare = (id ?? '').split('_')[0] ?? ''
	return `incipit:ctgenres:${KEY_VERSION}:${bare.toUpperCase()}`
}

/** Chaptarr work genres -> ApiGenre[], shelf noise removed.
 *
 * CLEAN FIRST, then filter. SHELF_NOISE says "post-clean" and the filter used
 * to test the RAW name, so every shelf whose decoration namesToGenres would
 * strip a moment later escaped it: "📚 Audiobook", "🎧 audiobooks", "Book  Club"
 * and "To  Read" all cleaned into exactly the terms this set exists to drop —
 * and then got cached for 30 days. */
export function genresFromWork(names: unknown, ctx: GenreContext = {}): ApiGenre[] {
	if (!Array.isArray(names)) return []
	const kept = names.filter(
		(n): n is string => typeof n === 'string' && !SHELF_NOISE.has(cleanGenreName(n).toLowerCase())
	)
	// No pre-sort: namesToGenres now DROPS umbrella shelves outright, for every
	// community source, so ordering them here would change nothing. The local
	// GENERIC_SHELVES copy went with it — one vocabulary, in genreNormalize.
	return namesToGenres(kept, ctx)
}

/** The Chaptarr work id for a requested book id, or null when it cannot be
 * asked: plain ASINs map to az:, hardcover-book ids to hc:. Edition-shaped and
 * foreign-provider ids stay with the Hardcover leg. */
export function chaptarrWorkIdFor(id: string): string | null {
	const bare = id.split('_')[0] ?? ''
	const decoded = decodeProviderId(bare)
	if (decoded === null) return bare ? `az:${bare}` : null
	if (decoded.provider === 'hardcover' && decoded.kind === 'book') return `hc:${decoded.nativeId}`
	return null
}

interface BackfillOpts {
	id: string
	redis: FastifyRedis | null
	logger?: FastifyBaseLogger
	/** Test seam, same shape as ChaptarrProvider's constructor injection. */
	workFetch?: ChaptarrWorkFetch
	/** The book itself, so a shelf that merely restates it can be dropped. */
	ctx?: GenreContext
}

/**
 * The genres Chaptarr holds for this id, cached, never throwing. Same
 * "can't answer" contract as the Hardcover leg: [] for no redis, an
 * unaskable id, or an upstream error (uncached).
 * @param {BackfillOpts} opts id, redis, optional logger/transport
 * @returns {Promise<ApiGenre[]>} genres for the id, possibly empty
 */
export async function backfillChaptarrGenres(opts: BackfillOpts): Promise<ApiGenre[]> {
	const { id, redis, logger } = opts
	// The kill-switch governs THIS leg too, not just the registry's provider
	// registration — before the check, CHAPTARR_ENABLED=false still sent every
	// genre-less book's refresh to api2.chaptarr.com.
	if (!chaptarrEnabled()) return []
	if (!redis || !id) return []

	try {
		const raw = await redis.get(chaptarrGenreKey(id))
		if (raw) {
			const parsed: unknown = JSON.parse(raw)
			if (isGenreArray(parsed)) return parsed
		}
	} catch {
		// A broken cache has told us nothing; fall through and compute.
	}

	const workId = chaptarrWorkIdFor(id)
	if (!workId) return []

	try {
		const workFetch = opts.workFetch ?? fetchChaptarrWork
		const response = await workFetch(workId, logger)
		const genres = genresFromWork(response?.work?.genres, opts.ctx ?? {})
		await redis
			.set(
				chaptarrGenreKey(id),
				JSON.stringify(genres),
				'EX',
				genres.length ? HIT_TTL_SECONDS : MISS_TTL_SECONDS
			)
			.catch(() => {})
		return genres
	} catch (err) {
		logger?.warn({ err, id }, 'chaptarr genre backfill failed; serving without genres')
		return []
	}
}

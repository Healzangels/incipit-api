import type { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import type { ApiGenre } from '#config/types'
import { type ChaptarrWorkFetch, fetchChaptarrWork } from '#helpers/providers/ChaptarrProvider'
import { namesToGenres } from '#helpers/providers/hardcoverGenres'
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
const KEY_VERSION = 'v1'

export function chaptarrGenreKey(id: string): string {
	const bare = (id ?? '').split('_')[0] ?? ''
	return `incipit:ctgenres:${KEY_VERSION}:${bare.toUpperCase()}`
}

/** Chaptarr work genres -> ApiGenre[], shelf noise removed. */
export function genresFromWork(names: unknown): ApiGenre[] {
	if (!Array.isArray(names)) return []
	const kept = names.filter(
		(n): n is string => typeof n === 'string' && !SHELF_NOISE.has(n.trim().toLowerCase())
	)
	return namesToGenres(kept)
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
	id: string
	redis: FastifyRedis | null
	logger?: FastifyBaseLogger
	/** Test seam, same shape as ChaptarrProvider's constructor injection. */
	workFetch?: ChaptarrWorkFetch
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
		const genres = genresFromWork(response?.work?.genres)
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

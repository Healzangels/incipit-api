import type { FastifyRedis } from '@fastify/redis'

/**
 * Alternate cover art, cached so the ITEM lookup can serve it.
 *
 * dedupe builds `coverAlternates` from the editions it MERGED, so they exist
 * only where the whole candidate set is visible — on the SEARCH response. The
 * Plex bundle reads `/books/:asin` for posters, and that route never runs
 * dedupe, so without a hand-off the art is computed and then unreachable.
 *
 * WHY SERVER-SIDE AND NOT IN THE PLUGIN. v1.3.183 bridged this with a
 * module-level memo inside the bundle, written at search and read at update.
 * That was wrong in a way only the live path revealed: the memo fills when a
 * SEARCH runs, and a plain "Refresh Metadata" never searches — Plex calls
 * update() alone on an already-matched item. Alternates could therefore appear
 * on a fresh match and never on a refresh, which is the path Plex uses most.
 *
 * Caching here fixes the trigger rather than the symptom: the item endpoint
 * answers whenever it is asked, with no cross-call state, no dependence on a
 * search having happened first, and no plugin-process lifetime involved. It
 * also survives a Plex restart, which the memo could not.
 *
 * Everything here is best-effort. This is SPARE ART: a cache miss, a redis
 * outage or a corrupt entry must cost the caller nothing but the alternates.
 */

/** 30 days. Cover art is close to static, and a miss is free to re-earn. */
const TTL_SECONDS = 2592000

/**
 * The cache key for a book id.
 *
 * Case-folded and region-stripped because the two callers do not agree on the
 * shape: search emits the bare id, while the bundle's `metadata.id` is
 * `<id>_<region>`. Normalising both ends is what makes the cache hit on the
 * very path it exists for — the same trap the plugin-side memo had to handle.
 * @param {string} id a book id, with or without a region suffix
 * @returns {string} the namespaced redis key
 */
export function alternateCoverKey(id: string): string {
	const bare = (id ?? '').split('_')[0] ?? ''
	return `incipit:altcover:${bare.toUpperCase()}`
}

/**
 * Record a candidate's alternate covers for later item lookups.
 *
 * An EMPTY list is deliberately not written: most books have no alternates, and
 * writing a key for each would fill redis with entries that say nothing a miss
 * does not already say.
 * @param {FastifyRedis | null} redis the redis client, or null when unavailable
 * @param {string} id the book id the alternates belong to
 * @param {string[] | undefined} urls the alternate cover urls
 * @returns {Promise<void>}
 */
export async function rememberAlternates(
	redis: FastifyRedis | null,
	id: string,
	urls: string[] | undefined
): Promise<void> {
	if (!redis || !id || !urls?.length) return
	try {
		await redis.set(alternateCoverKey(id), JSON.stringify(urls), 'EX', TTL_SECONDS)
	} catch {
		// Spare art is never worth failing a search for.
	}
}

/**
 * The alternate covers recorded for this id, or an empty list.
 *
 * Never returns null and never throws: every failure mode — no redis, a miss, a
 * redis error, corrupt JSON, a cached value that is not an array — degrades to
 * "no alternates", which is exactly the behaviour before this cache existed.
 * @param {FastifyRedis | null} redis the redis client, or null when unavailable
 * @param {string} id the book id, with or without a region suffix
 * @returns {Promise<string[]>} the cached alternates
 */
export async function recallAlternates(redis: FastifyRedis | null, id: string): Promise<string[]> {
	if (!redis || !id) return []
	try {
		const raw = await redis.get(alternateCoverKey(id))
		if (!raw) return []
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		return parsed.filter((u): u is string => typeof u === 'string' && u.length > 0)
	} catch {
		return []
	}
}

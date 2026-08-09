import type { FastifyBaseLogger } from 'fastify'

import { chaptarrEnabled, chaptarrGet } from '#helpers/providers/ChaptarrProvider'
import { GOODREADS_NOPHOTO_RE, type RedisLike } from '#helpers/providers/goodreadsSeries'

/**
 * Author portrait/bio from the Chaptarr metadata service — the ASIN-KEYED
 * backstop rung in the author enrichment chain.
 *
 * Why it earns a rung of its own: the two existing fallbacks (Hardcover,
 * the Goodreads mirror) both look authors up BY NAME with exact-ish
 * semantics, and the recorded failure mode is a spelling variant missing
 * entirely ("J.R.R. Tolkien" vs "J. R. R. Tolkien"). Chaptarr keys authors
 * by the same Audible author asin this route was asked for, so it answers
 * exactly when the name-keyed rungs go blind. Its photos[] aggregates
 * hardcover + goodreads + audnexus portraits with provider labels, verified
 * live 2026-08-08.
 *
 * Photo preference: goodreads first (the class our mirror would have served,
 * had the name matched), then hardcover, then whatever remains (audnexus
 * last — that is usually Audible's own image, and if Audible had one this
 * rung would not be running). The caller applies its own placeholder guard
 * on top; this module only ranks sources.
 */

const BASE = 'https://api2.chaptarr.com'

/** 24h for an answer, 1h for a miss — the same split the Goodreads author
 * cache uses, and for the same reason: an image-less answer must not freeze
 * an author for a month (the 7-day-throttle lesson). */
const HIT_TTL_SECONDS = 86400
const MISS_TTL_SECONDS = 3600
const KEY_VERSION = 'v1'

export interface ChaptarrAuthorInfo {
	image: string | null
	bio: string | null
}

interface ChaptarrPhoto {
	provider?: string
	url?: string
	isPrimary?: boolean
}

interface ChaptarrAuthorResponse {
	author?: {
		name?: string
		bio?: string | null
		photos?: ChaptarrPhoto[]
	}
}

export type ChaptarrAuthorFetch = (
	asin: string,
	logger?: FastifyBaseLogger
) => Promise<ChaptarrAuthorResponse | null>

const defaultAuthorFetch: ChaptarrAuthorFetch = async (asin) => {
	// chaptarrGet carries the house posture (time-box, one attempt, 404/410 is
	// "no such author") — this leg used to keep its own copy of the 404 rule.
	const data = await chaptarrGet(`${BASE}/api/v5/author?id=${encodeURIComponent(`az:${asin}`)}`)
	return (data as ChaptarrAuthorResponse) ?? null
}

function cacheKey(asin: string): string {
	return `incipit:ctauthor:${KEY_VERSION}:${asin.toUpperCase()}`
}

/** goodreads -> hardcover -> anything else; within a tier, isPrimary first. */
export function pickPhoto(photos: ChaptarrPhoto[] | undefined): string | null {
	if (!photos?.length) return null
	const rank = (p: ChaptarrPhoto): number => {
		const provider = (p.provider ?? '').toLowerCase()
		const tier = provider === 'goodreads' ? 0 : provider === 'hardcover' ? 1 : 2
		return tier * 2 + (p.isPrimary ? 0 : 1)
	}
	// Two upstream quirks, both measured live on one record (Mitchel Scanlon,
	// 2026-08-08): a missing photo arrives as the literal STRING "null", and
	// Goodreads' grey /nophoto/ silhouette arrives as a real-looking URL.
	// Neither is a photo; skipping them HERE keeps the tier fallthrough
	// alive, so the real Amazon portrait in the audnexus tier still wins.
	//
	// GOODREADS_NOPHOTO_RE, not a local spelling. The local one required
	// "goodreads.com" in the host and MISSED the shape this repo's own fixture
	// carries (i.gr-assets.com/images/S/nophoto/user/...) — and a survivor is
	// written to author.image, persisted, and then permanently gates the photo
	// backstop for that author.
	const usable = photos.filter(
		(p) => !!p.url && /^https?:\/\//i.test(p.url) && !GOODREADS_NOPHOTO_RE.test(p.url)
	)
	if (!usable.length) return null
	usable.sort((a, b) => rank(a) - rank(b))
	return usable[0].url ?? null
}

/**
 * The portrait/bio Chaptarr holds for this author asin, cached, never
 * throwing. Empty answers are cached briefly (an author may gain a photo);
 * errors are not cached at all.
 * @param {string} asin the Audible author asin
 * @param {RedisLike | null} redis the request's cache, or null (FastifyRedis
 *   satisfies RedisLike structurally, so route callers pass theirs unchanged)
 * @param {FastifyBaseLogger} [logger] request logger
 * @param {{ authorFetch?: ChaptarrAuthorFetch; retryCachedMiss?: boolean }} [opts]
 *   test seam, plus the operator's ?force=1 re-ask
 * @returns {Promise<ChaptarrAuthorInfo>} image/bio, either possibly null
 */
export async function chaptarrAuthorInfo(
	asin: string,
	redis: RedisLike | null,
	logger?: FastifyBaseLogger,
	opts: { authorFetch?: ChaptarrAuthorFetch; retryCachedMiss?: boolean } = {}
): Promise<ChaptarrAuthorInfo> {
	const empty: ChaptarrAuthorInfo = { image: null, bio: null }
	if (!asin) return empty
	// The kill-switch governs THIS leg too — see chaptarrEnabled.
	if (!chaptarrEnabled()) return empty

	// retryCachedMiss (the operator's ?force=1) re-asks ONLY when the cache
	// holds an INCOMPLETE answer, exactly as the Goodreads rung beside this one
	// does. Without the seam a cached MISS pinned this rung blind for its full
	// hour — and since the automated second chance fires after three MINUTES,
	// it was a guaranteed no-op here, and the operator's own heal was blind too.
	let cachedPartial: ChaptarrAuthorInfo | null = null
	if (redis) {
		try {
			const raw = await redis.get(cacheKey(asin))
			if (raw) {
				const parsed = JSON.parse(raw) as ChaptarrAuthorInfo
				if (parsed && typeof parsed === 'object') {
					const cached: ChaptarrAuthorInfo = {
						image: parsed.image ?? null,
						bio: parsed.bio ?? null
					}
					if (Boolean(cached.image && cached.bio) || !opts.retryCachedMiss) return cached
					cachedPartial = cached
				}
			}
		} catch {
			// A broken cache has told us nothing; fall through and compute.
		}
	}

	try {
		const authorFetch = opts.authorFetch ?? defaultAuthorFetch
		const response = await authorFetch(asin, logger)
		// A forced re-ask can itself come back empty; returning its nulls would
		// hand the caller LESS than the cache already knew. Fresh fields win,
		// cached fields fill. (cachedPartial is only ever set on the forced path.)
		const info: ChaptarrAuthorInfo = {
			image: pickPhoto(response?.author?.photos) ?? cachedPartial?.image ?? null,
			bio: response?.author?.bio?.trim() || cachedPartial?.bio || null
		}
		if (redis) {
			const ttl = info.image || info.bio ? HIT_TTL_SECONDS : MISS_TTL_SECONDS
			await redis.set(cacheKey(asin), JSON.stringify(info), 'EX', ttl).catch(() => {})
		}
		return info
	} catch (err) {
		logger?.warn({ err, asin }, 'chaptarr author lookup failed; serving without it')
		return empty
	}
}

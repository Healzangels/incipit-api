import type { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import fetch from '#helpers/utils/fetchPlus'

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
	try {
		const res = await fetch(`${BASE}/api/v5/author?id=${encodeURIComponent(`az:${asin}`)}`, {
			headers: { Accept: 'application/json' }
		})
		return (res.data as ChaptarrAuthorResponse) ?? null
	} catch (err) {
		const status = (err as { status?: number })?.status
		if (status === 404 || status === 410) return null
		throw err
	}
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
	const usable = photos.filter(
		(p) => !!p.url && /^https?:\/\//i.test(p.url) && !/goodreads\.com\/.*nophoto/i.test(p.url)
	)
	if (!usable.length) return null
	usable.sort((a, b) => rank(a) - rank(b))
	return usable[0].url ?? null
}

interface RedisLike {
	get(key: string): Promise<string | null | undefined>
	set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>
}

/**
 * The portrait/bio Chaptarr holds for this author asin, cached, never
 * throwing. Empty answers are cached briefly (an author may gain a photo);
 * errors are not cached at all.
 * @param {string} asin the Audible author asin
 * @param {RedisLike | FastifyRedis | null} redis the request's cache, or null
 * @param {FastifyBaseLogger} [logger] request logger
 * @param {{ authorFetch?: ChaptarrAuthorFetch }} [opts] test seam
 * @returns {Promise<ChaptarrAuthorInfo>} image/bio, either possibly null
 */
export async function chaptarrAuthorInfo(
	asin: string,
	redis: RedisLike | FastifyRedis | null,
	logger?: FastifyBaseLogger,
	opts: { authorFetch?: ChaptarrAuthorFetch } = {}
): Promise<ChaptarrAuthorInfo> {
	const empty: ChaptarrAuthorInfo = { image: null, bio: null }
	if (!asin) return empty

	if (redis) {
		try {
			const raw = await redis.get(cacheKey(asin))
			if (raw) {
				const parsed = JSON.parse(raw) as ChaptarrAuthorInfo
				if (parsed && typeof parsed === 'object') {
					return { image: parsed.image ?? null, bio: parsed.bio ?? null }
				}
			}
		} catch {
			// A broken cache has told us nothing; fall through and compute.
		}
	}

	try {
		const authorFetch = opts.authorFetch ?? defaultAuthorFetch
		const response = await authorFetch(asin, logger)
		const info: ChaptarrAuthorInfo = {
			image: pickPhoto(response?.author?.photos),
			bio: response?.author?.bio?.trim() || null
		}
		if (redis) {
			const ttl = info.image || info.bio ? HIT_TTL_SECONDS : MISS_TTL_SECONDS
			await (redis as RedisLike)
				.set(cacheKey(asin), JSON.stringify(info), 'EX', ttl)
				.catch(() => {})
		}
		return info
	} catch (err) {
		logger?.warn({ err, asin }, 'chaptarr author lookup failed; serving without it')
		return empty
	}
}

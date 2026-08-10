import type { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import type { ApiGenre } from '#config/types'
import {
	chaptarrEnabled,
	type ChaptarrMatchFetch,
	type ChaptarrWorkFetch,
	defaultMatchFetch,
	fetchChaptarrWork
} from '#helpers/providers/ChaptarrProvider'
import type { GenreContext } from '#helpers/providers/genreNormalize'
import { isGenreArray, namesToGenres } from '#helpers/providers/hardcoverGenres'
import { sameVolume, sim, titleSim } from '#helpers/providers/matchScorer'
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
	// No local noise list: namesToGenres applies isNoiseShelf to EVERY community
	// source, and keeping a second Chaptarr-only vocabulary here is what let
	// "Audio book" through on the Hardcover leg. One set, in genreNormalize.
	const kept = names.filter((n): n is string => typeof n === 'string')
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

/**
 * How close a matched work's title must be before its genres are trusted.
 *
 * titleSim is subtitle-tolerant, which is the whole reason it is used here:
 * Chaptarr routinely carries a series qualifier the record omits ("Night Mare"
 * vs "Night Mare :Xanth 6", "Two to the Fifth" vs "Two to the Fifth (Xanth)").
 * An EXACT fold rejected 17 of 65 probed books, and inspection showed almost
 * all of them were the same book wearing a subtitle. At 0.85 the yield went
 * from 38 to 45 with no wrong book admitted.
 */
const TITLE_CONFIRM = 0.85

/** The author must agree almost exactly — it is the only independent check
 * there is, and a title alone matches far too many books. */
const AUTHOR_CONFIRM = 0.9

/** 7 days. A title-matched answer is weaker evidence than an id-keyed one, so
 * it is re-earned sooner; a miss is cheap to repeat. */
const TITLE_TTL_SECONDS = 604800

/** Cache key for a title+author rescue. Folded so casing and punctuation in the
 * album tag cannot mint a second entry for the same book. */
export function chaptarrTitleGenreKey(title: string, author: string): string {
	const fold = (s: string) =>
		(s ?? '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
	return `incipit:ctgenres-t:${KEY_VERSION}:${fold(title)}|${fold(author)}`
}

interface TitleRescueOpts {
	title: string
	author: string
	redis: FastifyRedis | null
	logger?: FastifyBaseLogger
	ctx?: GenreContext
	matchFetch?: ChaptarrMatchFetch
	workFetch?: ChaptarrWorkFetch
}

/**
 * LAST RESORT: genres for a book whose id Chaptarr cannot be asked about.
 *
 * WHY THIS EXISTS. chaptarrWorkIdFor maps plain ASINs (az:) and hardcover-book
 * ids (hc:) and nothing else, so an album pinned to an `openlibrary-works-…` or
 * `overdrive-…` edition can never reach the work route. Measured on the live
 * library 2026-08-10: 94 albums carried NO genres at all, and 63 of them were
 * exactly those two id shapes — Audible has no record for them either, so every
 * source was mute.
 *
 * The /match endpoint resolves a title+author query to a work identity, which
 * is the one handle those records still offer: they carry a title and an
 * author and nothing else (no asin, no isbn — checked).
 *
 * CONFIRMED, never trusted. A title query matches too many books to accept on
 * faith, so the answer is only used when the returned work agrees on BOTH title
 * and author. Of 65 probed, 45 confirmed and every one had genres; the 20 that
 * did not are left with nothing, which is what they already had.
 * @param {TitleRescueOpts} opts title, author, redis, optional seams
 * @returns {Promise<ApiGenre[]>} genres for the book, or [] when unconfirmed
 */
export async function chaptarrGenresByTitle(opts: TitleRescueOpts): Promise<ApiGenre[]> {
	const { title, author, redis, logger } = opts
	if (!chaptarrEnabled()) return []
	if (!redis || !title || !author) return []

	const key = chaptarrTitleGenreKey(title, author)
	try {
		const raw = await redis.get(key)
		if (raw) {
			const parsed: unknown = JSON.parse(raw)
			if (isGenreArray(parsed)) return parsed
		}
	} catch {
		// A broken cache has told us nothing; compute.
	}

	let genres: ApiGenre[] = []
	try {
		const matchFetch = opts.matchFetch ?? defaultMatchFetch
		const matches = await matchFetch(
			`${title} ${author}`.trim(),
			{ artist: author, album: title },
			logger
		)
		const top = matches?.[0]
		const workId = top?.work_id
		if (
			workId &&
			titleSim(title, top?.work_title ?? '') >= TITLE_CONFIRM &&
			// A trailing volume number is noise to titleSim, so "Wreck Jumpers 2"
			// and "Wreck Jumpers 3" both clear the title bar against "Wreck
			// Jumpers" — demonstrated on the Hardcover probe 2026-08-10, where the
			// two resolved to one id. Same exposure here, same guard.
			sameVolume(title, top?.work_title ?? '') &&
			sim(author, top?.author ?? '') >= AUTHOR_CONFIRM
		) {
			const workFetch = opts.workFetch ?? fetchChaptarrWork
			const work = await workFetch(workId, logger)
			genres = genresFromWork(work?.work?.genres, opts.ctx ?? {})
		} else if (top) {
			logger?.debug(
				{ title, author, saw: top?.work_title },
				'chaptarr title rescue: match did not confirm; serving without genres'
			)
		}
	} catch (err) {
		logger?.warn({ err, title }, 'chaptarr title genre rescue failed; serving without genres')
		return []
	}

	await redis.set(key, JSON.stringify(genres), 'EX', TITLE_TTL_SECONDS).catch(() => {})
	return genres
}

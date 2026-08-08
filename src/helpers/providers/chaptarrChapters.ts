import type { FastifyBaseLogger } from 'fastify'

import { type ApiChapter, ApiChapterSchema } from '#config/types'
import {
	type ChaptarrWorkFetch,
	editionForAsin,
	fetchChaptarrWork
} from '#helpers/providers/ChaptarrProvider'

/**
 * Chapter fallback from the Chaptarr metadata service — consulted only when
 * the Audible chapter API cannot answer (no ADP credentials on this
 * deployment, a delisted/region-locked ASIN, or a listing with no chapter
 * data). Chaptarr's chapter shape is audnexus-derived and maps 1:1 onto
 * ApiSingleChapter ({title, startOffsetMs, startOffsetSec, lengthMs} —
 * verified live on Annihilation, 8 chapters with millisecond offsets).
 *
 * The envelope fields Audible would have supplied are synthesized honestly:
 * brand intro/outro 0 (unknown), isAccurate FALSE — these offsets were not
 * blessed by Audible's own chapter service, and a consumer aligning audio to
 * them deserves to know that — and the runtime from the edition's
 * durationSeconds, falling back to the last chapter's end.
 *
 * No cache layer of its own: the caller is the chapter getNewData path,
 * whose result is persisted by the generic create-or-update flow exactly
 * like an Audible answer, so subsequent requests never reach this module.
 */

interface BackfillOpts {
	logger?: FastifyBaseLogger
	/** Test seam, same shape as ChaptarrProvider's constructor injection. */
	workFetch?: ChaptarrWorkFetch
}

/**
 * The chapters Chaptarr holds for this ASIN as a schema-valid ApiChapter, or
 * null when it cannot answer. Never throws.
 * @param {string} asin the audiobook ASIN
 * @param {string} region the requested region (stamped onto the record)
 * @param {BackfillOpts} [opts] logger/transport
 * @returns {Promise<ApiChapter | null>} the chapter record, or null
 */
export async function chaptarrChapters(
	asin: string,
	region: string,
	opts: BackfillOpts = {}
): Promise<ApiChapter | null> {
	if (!asin) return null
	try {
		const workFetch = opts.workFetch ?? fetchChaptarrWork
		const response = await workFetch(`az:${asin}`, opts.logger)
		if (!response) return null
		const edition = editionForAsin(response.editions, asin)
		const raw = edition?.chapters
		if (!edition || !raw?.length) return null

		const chapters = raw.map((c, i) => ({
			lengthMs: typeof c.lengthMs === 'number' && c.lengthMs >= 0 ? c.lengthMs : 0,
			startOffsetMs:
				typeof c.startOffsetMs === 'number' && c.startOffsetMs >= 0 ? c.startOffsetMs : 0,
			startOffsetSec:
				typeof c.startOffsetSec === 'number' && c.startOffsetSec >= 0
					? c.startOffsetSec
					: Math.floor(
							(typeof c.startOffsetMs === 'number' && c.startOffsetMs >= 0 ? c.startOffsetMs : 0) /
								1000
						),
			title: c.title?.trim() || `Chapter ${i + 1}`
		}))

		const last = chapters[chapters.length - 1]
		const runtimeLengthMs =
			typeof edition.durationSeconds === 'number' && edition.durationSeconds > 0
				? edition.durationSeconds * 1000
				: last.startOffsetMs + last.lengthMs

		const candidate: ApiChapter = {
			asin,
			brandIntroDurationMs: 0,
			brandOutroDurationMs: 0,
			chapters,
			isAccurate: false,
			region,
			runtimeLengthMs,
			runtimeLengthSec: Math.floor(runtimeLengthMs / 1000)
		}
		// Parse, never trust: a malformed upstream row must yield "no chapters",
		// not a stored record the schema-validating serve path can never read.
		const parsed = ApiChapterSchema.safeParse(candidate)
		return parsed.success ? parsed.data : null
	} catch (err) {
		opts.logger?.warn({ err, asin }, 'chaptarr chapter fallback failed; serving without it')
		return null
	}
}

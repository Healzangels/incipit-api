import { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import type { ApiAuthorProfile, ApiBook, ApiChapter } from '#config/types'
import { ApiQueryString } from '#config/types'
import { NotFoundError } from '#helpers/errors/ApiErrors'
import { chaptarrChapters } from '#helpers/providers/chaptarrChapters'
import GenericShowHelper from '#helpers/routes/GenericShowHelper'

/**
 * The two NotFoundError codes GenericShowHelper.updateActions answers by
 * PRESERVING the stored record ("the product is gone from Audible, keep what we
 * have"). Named here because this subclass has to decide whether to let that
 * branch see the error at all.
 */
const PRESERVE_CODES = new Set(['REGION_UNAVAILABLE', 'PRODUCT_DELISTED'])

export default class ChapterShowHelper extends GenericShowHelper {
	constructor(
		asin: string,
		options: ApiQueryString,
		redis: FastifyRedis | null,
		logger?: FastifyBaseLogger
	) {
		super(asin, options, redis, 'chapter', logger)
	}

	/**
	 * Audible first, Chaptarr second — the same fill-only posture as every
	 * other enrichment rung, at the same altitude (the subclass), and the
	 * result rides the generic create-or-update flow so a fallback answer is
	 * persisted and cached exactly like an Audible one.
	 *
	 * The fallback runs for every NO-ANSWER shape the Audible helper has:
	 * an undefined return (the listing has no chapter data), and the
	 * NotFoundError family (no ADP_TOKEN/PRIVATE_KEY on this deployment — the
	 * shared-instance case where chapters were simply OFF — plus delisted and
	 * region-locked ASINs). A non-NotFound failure still throws: that is a
	 * bug or an outage, not a gap to paper over.
	 *
	 * FILL-ONLY MEANS FILL-ONLY, and this is where that is enforced. Catching
	 * the whole NotFoundError family made GenericShowHelper's preserve branch
	 * unreachable: a stored record with `isAccurate: true` and real brand
	 * intro/outro offsets was REPLACED by Chaptarr's `isAccurate: false`,
	 * all-zero-brand record and persisted — permanent loss, on every refresh.
	 * And it is not a rare shape: ChapterHelper.fetchChapter swallows every
	 * failure and returns undefined, so a plain transient Audible 500/429/
	 * timeout arrives here as REGION_UNAVAILABLE too.
	 *
	 * So when the error is one the preserve branch handles AND there is a
	 * stored record to preserve, rethrow and let it win. Substitute only when
	 * there is nothing to lose. The ADP_TOKEN-less case — the reason this
	 * fallback exists on this deployment — is unaffected: ChapterHelper throws
	 * that one from its CONSTRUCTOR with no `details.code`, so it is not a
	 * preserve code and still falls through to Chaptarr, stored record or not.
	 */
	async getNewData(): Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined> {
		let audibleError: NotFoundError | null = null
		try {
			const data = await super.getNewData()
			if (data) return data
		} catch (err) {
			if (!(err instanceof NotFoundError)) throw err
			if (this.originalData && PRESERVE_CODES.has(String(err.details?.code ?? ''))) throw err
			audibleError = err
		}
		const fallback = await chaptarrChapters(this.asin, this.options.region, {
			logger: this.logger
		})
		if (fallback) {
			this.logger?.info({ asin: this.asin }, 'chapters: filled from Chaptarr')
			return fallback
		}
		if (audibleError) throw audibleError
		return undefined
	}
}

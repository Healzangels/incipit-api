import { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import type { ApiAuthorProfile, ApiBook, ApiChapter } from '#config/types'
import { ApiQueryString } from '#config/types'
import { NotFoundError } from '#helpers/errors/ApiErrors'
import { chaptarrChapters } from '#helpers/providers/chaptarrChapters'
import GenericShowHelper from '#helpers/routes/GenericShowHelper'

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
	 */
	async getNewData(): Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined> {
		let audibleError: NotFoundError | null = null
		try {
			const data = await super.getNewData()
			if (data) return data
		} catch (err) {
			if (!(err instanceof NotFoundError)) throw err
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

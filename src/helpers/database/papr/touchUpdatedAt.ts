import type { FastifyBaseLogger } from 'fastify'

import getErrorMessage from '#helpers/utils/getErrorMessage'

/**
 * The narrowest shape of a Papr model this needs. Declared structurally rather
 * than importing the three concrete models so this module stays a leaf and any
 * future collection can use it without editing anything here.
 */
interface TouchableModel {
	updateOne(filter: object, update: object): Promise<unknown>
}

/**
 * Advance ONLY `updatedAt`, leaving the stored data untouched.
 *
 * Called when a re-fetch returned data IDENTICAL to what is stored. Without it
 * an unchanged record keeps its old timestamp forever, so
 * `SharedHelper.isRecentlyUpdated` — which the show helpers consult BEFORE
 * scraping — reports it stale on every pass and the full upstream fetch runs
 * again. The throttle can only ever engage for records that CHANGED, which is
 * the minority; every stable record is re-scraped on every sweep for the life
 * of the deployment.
 *
 * `UpdateScheduler` sends `update=1` for every row in all three collections, so
 * this is the difference between one fetch per record per UPDATE_THRESHOLD
 * window and one per record per sweep, against a ToS-sensitive origin.
 *
 * It lives here, shared, because it did not: the author helper grew this after
 * the every-cycle re-fetch was traced on an image-less author, and books and
 * chapters — same createOrUpdate shape, same scheduler, larger corpus — never
 * received it. `touchUpdatedAtWiring.test.ts` pins that all three call it.
 *
 * Best-effort by construction: a failure here must not fail the request that
 * triggered it, and the fallback is exactly the pre-existing every-cycle
 * behaviour rather than anything worse.
 * @param {TouchableModel} model the Papr model holding the record
 * @param {object} filter the same filter the type's update() uses
 * @param {FastifyBaseLogger} logger optional request logger
 * @returns {Promise<void>} resolves whether or not the write succeeded
 */
export default async function touchUpdatedAt(
	model: TouchableModel,
	filter: object,
	logger?: FastifyBaseLogger
): Promise<void> {
	try {
		await model.updateOne(filter, { $currentDate: { updatedAt: true } })
	} catch (error) {
		logger?.error(getErrorMessage(error))
	}
}

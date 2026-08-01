import Papr from 'papr'

import type { Context } from '#config/context'
import { ensureIndexes } from '#config/indexes'

const papr = new Papr()
/**
 * Bind papr to the database and build the indexes this deployment needs.
 * @param {Context} ctx the mongo context
 * @param {{warn: (msg: string) => void}} [logger] where index-build failures go.
 *   Pass the real server logger: this used to be omitted at the only production
 *   call site, which made every index-build failure completely silent.
 * @returns {Promise<void>}
 */
export async function initialize(ctx: Context, logger?: { warn: (msg: string) => void }) {
	const db = ctx.client.db('audnexus')
	papr.initialize(db)
	await papr.updateSchemas()
	// Every index this deployment needs, declared as data in config/indexes.ts.
	// Includes the authors $text index (a fresh self-hosted Mongo 500s on author
	// search without it) and the {asin, region} lookup index every /books/:asin
	// request hits — that one was missing entirely, so the request Plex makes for
	// every album ran a collection scan, twice per lookup.
	await ensureIndexes(db, logger)
}
export default papr

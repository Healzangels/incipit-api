import Papr from 'papr'

import type { Context } from '#config/context'
import { ensureIndexes } from '#config/indexes'

const papr = new Papr()
export async function initialize(ctx: Context) {
	const db = ctx.client.db('audnexus')
	papr.initialize(db)
	await papr.updateSchemas()
	// Every index this deployment needs, declared as data in config/indexes.ts
	// so the non-unique invariant is testable. Includes the authors $text index
	// (a fresh self-hosted Mongo 500s on author search without it) and the
	// {asin, region} lookup index every /books/:asin request hits — that one was
	// missing entirely, so the request Plex makes for every album ran a
	// collection scan, twice per lookup.
	await ensureIndexes(db)
}
export default papr

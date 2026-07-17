import Papr from 'papr'

import type { Context } from '#config/context'

const papr = new Papr()
export async function initialize(ctx: Context) {
	const db = ctx.client.db('audnexus')
	papr.initialize(db)
	await papr.updateSchemas()
	// Author search runs a MongoDB $text query, which requires a text index. The
	// papr schemas don't declare one, so a fresh self-hosted Mongo 500s on author
	// search ("text index required for $text query") — public audnexus only works
	// because its index was created historically. createIndex is idempotent, so
	// this safely ensures the index exists on every boot.
	await db.collection('authors').createIndex({ name: 'text', aliases: 'text' })
}
export default papr

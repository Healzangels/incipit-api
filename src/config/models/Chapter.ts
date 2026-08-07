import { schema, types } from 'papr'

import papr from '#config/papr'
import { ApiChapterSchema } from '#config/types'
import { sqliteModel } from '#helpers/database/sqlite/SqliteModel'
import { regionRegex, regions } from '#static/regions'

const chapterSchema = schema(
	{
		asin: types.string({ required: true }),
		brandIntroDurationMs: types.number({ required: true }),
		brandOutroDurationMs: types.number({ required: true }),
		chapters: types.array(
			types.object({
				lengthMs: types.number({ required: true }),
				startOffsetMs: types.number({ required: true }),
				startOffsetSec: types.number({ required: true }),
				title: types.string({ required: true })
			}),
			{ required: true }
		),
		isAccurate: types.boolean({ required: true }),
		region: types.string({
			enum: Object.keys(regions),
			pattern: regionRegex,
			required: true
		}),
		runtimeLengthMs: types.number({ required: true }),
		runtimeLengthSec: types.number({ required: true })
	},
	{
		defaults: {
			region: 'us'
		},
		timestamps: true
	}
)

export type ChapterDocument = (typeof chapterSchema)[0]
// THE BACKEND SEAM (migration Phase 2). This default export is the exact
// specifier the unit tests mock and the only thing the four consumers import,
// so the flag lives here and nowhere else (plan #7.2). Default stays mongo;
// nothing flips until Phase 5 sets DB_BACKEND=sqlite.
const paprModel = papr.model('chapters', chapterSchema)
const Chapter =
	process.env.DB_BACKEND === 'sqlite'
		? (sqliteModel('chapters', { schema: ApiChapterSchema }) as unknown as typeof paprModel)
		: paprModel
export default Chapter

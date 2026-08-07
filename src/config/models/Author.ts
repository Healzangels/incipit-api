import { schema, types } from 'papr'

import papr from '#config/papr'
import { ApiAuthorProfileSchema } from '#config/types'
import { sqliteModel } from '#helpers/database/sqlite/SqliteModel'
import { regionRegex, regions } from '#static/regions'

const authorSchema = schema(
	{
		aliases: types.array(types.string({ required: true })),
		asin: types.string({ required: true }),
		birthDate: types.date(),
		books: types.array(types.objectId()),
		description: types.string(),
		genres: types.array(
			types.object({
				asin: types.string({ required: true }),
				name: types.string({ required: true }),
				type: types.string({ required: true })
			})
		),
		image: types.string(),
		imageAlt: types.string(),
		links: types.array(
			types.object({
				link: types.string({ required: true }),
				type: types.string({ required: true })
			})
		),
		location: types.string(),
		name: types.string({ required: true }),
		region: types.string({
			enum: Object.keys(regions),
			pattern: regionRegex,
			required: true
		}),
		series: types.array(types.objectId()),
		similar: types.array(
			types.object({
				asin: types.string(),
				name: types.string({ required: true })
			})
		)
	},
	{
		defaults: {
			region: 'us'
		},
		timestamps: true
	}
)

export type AuthorDocument = (typeof authorSchema)[0]
// THE BACKEND SEAM (migration Phase 2). This default export is the exact
// specifier the unit tests mock and the only thing the four consumers import,
// so the flag lives here and nowhere else (plan #7.2). Default stays mongo;
// nothing flips until Phase 5 sets DB_BACKEND=sqlite.
const paprModel = papr.model('authors', authorSchema)
const Author =
	process.env.DB_BACKEND === 'sqlite'
		? (sqliteModel('authors', { schema: ApiAuthorProfileSchema }) as unknown as typeof paprModel)
		: paprModel
export default Author

import { schema, types } from 'papr'

import papr from '#config/papr'
import { ApiBookSchema } from '#config/types'
import { sqliteModel } from '#helpers/database/sqlite/SqliteModel'
import { regionRegex, regions } from '#static/regions'

const bookSchema = schema(
	{
		asin: types.string({ required: true }),
		authors: types.array(
			types.object({
				asin: types.string(),
				name: types.string({ required: true })
			}),
			{ required: true }
		),
		copyright: types.number(),
		description: types.string({ required: true }),
		formatType: types.string({ required: true }),
		genres: types.array(
			types.object({
				asin: types.string({ required: true }),
				name: types.string({ required: true }),
				type: types.string({ required: true })
			})
		),
		image: types.string(),
		isAdult: types.boolean({ required: true }),
		isbn: types.string(),
		language: types.string({ required: true }),
		literatureType: types.string({ enum: ['fiction', 'nonfiction'] }),
		narrators: types.array(
			types.object({
				asin: types.string(),
				name: types.string({ required: true })
			})
		),
		publisherName: types.string({ required: true }),
		rating: types.string({ required: true }),
		region: types.string({
			enum: Object.keys(regions),
			pattern: regionRegex,
			required: true
		}),
		releaseDate: types.date({ required: true }),
		runtimeLengthMin: types.number({ required: true }),
		seriesPrimary: types.object({
			asin: types.string(),
			name: types.string({ required: true }),
			position: types.string()
		}),
		seriesSecondary: types.object({
			asin: types.string(),
			name: types.string({ required: true }),
			position: types.string()
		}),
		subtitle: types.string(),
		summary: types.string({ required: true }),
		title: types.string({ required: true })
	},
	{
		defaults: {
			isAdult: false,
			isbn: '',
			region: 'us'
		},
		timestamps: true
	}
)

export type BookDocument = (typeof bookSchema)[0]
// THE BACKEND SEAM (migration Phase 2). This default export is the exact
// specifier the unit tests mock and the only thing the four consumers import,
// so the flag lives here and nowhere else (plan #7.2). Default stays mongo;
// nothing flips until Phase 5 sets DB_BACKEND=sqlite.
const paprModel = papr.model('books', bookSchema)
const Book =
	process.env.DB_BACKEND === 'sqlite'
		? (sqliteModel('books', { schema: ApiBookSchema }) as unknown as typeof paprModel)
		: paprModel
export default Book

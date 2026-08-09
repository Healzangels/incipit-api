import { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import type { AuthorDocument } from '#config/models/Author'
import type { BookDocument } from '#config/models/Book'
import type { ChapterDocument } from '#config/models/Chapter'
import { getPerformanceConfig } from '#config/performance'
import {
	ApiAuthorProfile,
	ApiAuthorProfileSchema,
	ApiBook,
	ApiBookSchema,
	ApiChapter,
	ApiChapterSchema,
	ApiQueryString
} from '#config/types'
import ScrapeHelper from '#helpers/authors/audible/ScrapeHelper'
import ChapterHelper from '#helpers/books/audible/ChapterHelper'
import StitchHelper from '#helpers/books/audible/StitchHelper'
import PaprAudibleAuthorHelper from '#helpers/database/papr/audible/PaprAudibleAuthorHelper'
import PaprAudibleBookHelper from '#helpers/database/papr/audible/PaprAudibleBookHelper'
import PaprAudibleChapterHelper from '#helpers/database/papr/audible/PaprAudibleChapterHelper'
import RedisHelper from '#helpers/database/redis/RedisHelper'
import { NotFoundError } from '#helpers/errors/ApiErrors'
import SharedHelper from '#helpers/utils/shared'
import {
	ErrorMessageDataType,
	ErrorMessageMissingOriginal,
	ErrorMessageUpdate
} from '#static/messages'

export default class GenericShowHelper {
	asin: string
	options: ApiQueryString
	originalData: AuthorDocument | BookDocument | ChapterDocument | null = null
	paprHelper: PaprAudibleAuthorHelper | PaprAudibleBookHelper | PaprAudibleChapterHelper
	redisHelper: RedisHelper
	schema: typeof ApiAuthorProfileSchema | typeof ApiBookSchema | typeof ApiChapterSchema
	sharedHelper: SharedHelper
	type: 'author' | 'book' | 'chapter'
	logger?: FastifyBaseLogger
	constructor(
		asin: string,
		options: ApiQueryString,
		redis: FastifyRedis | null,
		type: 'author' | 'book' | 'chapter',
		logger?: FastifyBaseLogger
	) {
		this.asin = asin
		// force=1 IMPLIES update=1. Force is the operator's "heal this NOW", and
		// without the implication a bare ?force=1 was served straight from redis
		// -- the flag looked honored and did nothing. Normalized once, here,
		// before the papr helper is built, so every consumer (the redis gate,
		// updateActions' recency override, the papr create-or-update split) reads
		// one consistent story.
		this.options =
			options.force === '1' && options.update !== '1' ? { ...options, update: '1' } : options
		this.type = type
		this.logger = logger
		this.paprHelper = this.setupPaprHelper()
		this.redisHelper = new RedisHelper(redis, type, asin, options.region, logger)
		this.schema = this.setupSchema()
		this.sharedHelper = new SharedHelper(logger)
	}

	/**
	 * Return the error message for the data type based on the type
	 * @returns {Error}
	 */
	errorMessageDataType(): Error {
		const fullType =
			this.type === 'author' ? 'ApiAuthorProfile' : this.type === 'book' ? 'ApiBook' : 'ApiChapter'
		return new Error(ErrorMessageDataType(this.asin, fullType))
	}

	/**
	 * Run the respective type's process() method
	 * @returns {Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined>}
	 * @throws {Error} Invalid type
	 */
	getNewData(): Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined> {
		if (this.type === 'author') {
			const helper = new ScrapeHelper(this.asin, this.options.region, this.logger)
			return helper.process()
		} else if (this.type === 'book') {
			const helper = new StitchHelper(this.asin, this.options.region, this.logger)
			return helper.process()
		} else {
			const helper = new ChapterHelper(this.asin, this.options.region, this.logger)
			return helper.process()
		}
	}

	/**
	 * Setup the paprHelper based on the type
	 * @returns {PaprAudibleAuthorHelper | PaprAudibleBookHelper | PaprAudibleChapterHelper}
	 * @throws {Error} Invalid type
	 */
	setupPaprHelper(): PaprAudibleAuthorHelper | PaprAudibleBookHelper | PaprAudibleChapterHelper {
		if (this.type === 'author') {
			return new PaprAudibleAuthorHelper(this.asin, this.options, this.logger)
		} else if (this.type === 'book') {
			return new PaprAudibleBookHelper(this.asin, this.options, this.logger)
		} else {
			return new PaprAudibleChapterHelper(this.asin, this.options, this.logger)
		}
	}

	/**
	 * Setup the schema based on the type
	 * @returns {typeof ApiAuthorProfileSchema | typeof ApiBookSchema | typeof ApiChapterSchema}
	 * @throws {Error} Invalid type
	 */
	setupSchema(): typeof ApiAuthorProfileSchema | typeof ApiBookSchema | typeof ApiChapterSchema {
		if (this.type === 'author') {
			return ApiAuthorProfileSchema
		} else if (this.type === 'book') {
			return ApiBookSchema
		} else {
			return ApiChapterSchema
		}
	}

	/**
	 * Get the original data from the database
	 * @returns {Promise<AuthorDocument | BookDocument | ChapterDocument | null>}
	 */
	async getDataFromPapr(): Promise<AuthorDocument | BookDocument | ChapterDocument | null> {
		return (await this.paprHelper.findOne()).data
	}

	/**
	 * Get the data with projections,
	 * making sure the data is the correct type.
	 * Then sort the data and return it.
	 * @returns {Promise<ApiAuthorProfile | ApiBook | ApiChapter>}
	 * @throws {Error} Data is null or not the correct type
	 */
	async getDataWithProjection(): Promise<ApiAuthorProfile | ApiBook | ApiChapter> {
		// 1. Get data with projections
		const data = await this.paprHelper.findOneWithProjection()
		// Make sure data is not null
		if (data.data === null) throw this.errorMessageDataType()
		return this.projectData(data.data)
	}

	/**
	 * The post-read half of {@link getDataWithProjection}: optional key sort,
	 * then the schema parse that guarantees the served shape.
	 *
	 * Split out so a caller that ALREADY HOLDS the projected document can apply
	 * the same treatment without paying for a second round trip.
	 * createOrUpdateData was doing exactly that — every papr createOrUpdate path
	 * returns a findOneWithProjection result, and the caller then threw it away
	 * and re-read it, one wasted query per book on every write (≈1,600 of them
	 * in a from-scratch scan). The sort and the parse are NOT waste, which is
	 * why this is a split rather than a deletion: dropping the second call
	 * outright would have skipped both.
	 *
	 * Typed as the served union rather than `unknown`: both callers already hold
	 * exactly that after their null checks, and sortObjectByKeys(data: object)
	 * accepts it structurally with no cast. The `as never` this replaces would
	 * have swallowed a future caller handing over a raw *Document (model shape,
	 * wider than the Api schema) — which the safeParse below turns into an
	 * errorMessageDataType 500 at runtime instead of a compile error.
	 * @param {ApiAuthorProfile | ApiBook | ApiChapter} doc the projected document
	 * @returns {ApiAuthorProfile | ApiBook | ApiChapter} the parsed, served shape
	 */
	private projectData(
		doc: ApiAuthorProfile | ApiBook | ApiChapter
	): ApiAuthorProfile | ApiBook | ApiChapter {
		// Sort data if feature flag enabled (adds O(n log n) overhead)
		const perfConfig = getPerformanceConfig()
		const dataToParse = perfConfig.USE_SORTED_KEYS ? this.sharedHelper.sortObjectByKeys(doc) : doc
		// Parse the data to make sure it's the correect type
		const parsed = this.schema.safeParse(dataToParse)
		// If the data is not the correct type, throw an error
		if (!parsed.success) throw this.errorMessageDataType()
		return parsed.data
	}

	/**
	 * Get the new data and pass it to the paprHelper to create or update the data
	 * Then, set redis cache and return the data
	 * @returns {Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined>}
	 * @throws {Error} Data is null or not the correct type
	 */
	async createOrUpdateData(): Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined> {
		// 1. Place the new data into the paprHelper
		const newData = await this.getNewData()
		// Special handling for chapter undefined
		if (this.type == 'chapter' && !newData) return undefined

		this.paprHelper.setData(newData as never)

		// 2. Create or update the data
		const dataToReturn = await this.paprHelper.createOrUpdate()
		if (dataToReturn.data === null) throw this.errorMessageDataType()

		// 3. Apply the served-shape treatment to the record createOrUpdate just
		// returned — every one of its paths yields a findOneWithProjection
		// result, so re-reading it here was a wasted query per write.
		const data = this.projectData(dataToReturn.data)

		// 4. Update or create the data in redis
		// Fire-and-forget by design, but MUST swallow: setOne logs and rethrows,
		// and an unhandled rejection exits the process — a Redis blip mid-run
		// would crash-loop the API even though the cache is optional.
		this.redisHelper.setOne(data).catch(() => undefined)

		return data
	}

	/**
	 * Check if the data is updated recently by comparing the timestamps of updatedAt
	 */
	isUpdatedRecently(): boolean {
		if (!this.originalData) {
			return false
		}
		return this.sharedHelper.isRecentlyUpdated(this.originalData)
	}

	/**
	 * Actions to run when an update is requested.
	 * @returns {Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined>}
	 * @throws {Error} Missing original data
	 */
	async updateActions(): Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined> {
		if (!this.originalData) throw new Error(ErrorMessageMissingOriginal(this.asin, this.type))
		// 1. Check if the data is updated recently. The throttle exists for the
		// UpdateScheduler's sweep (it sends update=1 for EVERY record); force=1
		// overrides it -- sent by the operator, and by exactly one automated
		// caller: the author second-chance timer, which replays the operator's
		// heal once (see maybeScheduleSecondChance). Without it a record frozen
		// incomplete inside the window -- Roger Zelazny's bio-less profile,
		// cached off a cache-cold mirror answer -- could not be healed by any
		// operator action until the window lapsed.
		if (this.options.force !== '1' && this.isUpdatedRecently()) {
			return this.getDataWithProjection()
		}

		// 2. Update the data,
		// return undefined for chapters if the data is not updated
		// Return the original data if there is an error
		const dataOnError = this.type === 'chapter' ? undefined : this.originalData
		const data =
			(await this.createOrUpdateData()
				.then((data) => data)
				.catch((err) => {
					// If the product is no longer available on Audible (delisted or
					// region-unavailable) but we have existing data, preserve it.
					// Only swallow NotFoundErrors with specific codes; rethrow others.
					if (err instanceof NotFoundError) {
						const code = err.details?.code
						if (code === 'REGION_UNAVAILABLE' || code === 'PRODUCT_DELISTED') {
							this.logger?.warn(
								`Update failed for ${this.type} ${this.asin}: ${err.message}. Returning existing data.`
							)
							return this.getDataWithProjection()
						}
						throw err
					}
					// Preserve other custom errors with statusCode (ContentTypeMismatchError, BadRequestError)
					if (err instanceof Error && 'statusCode' in err) {
						throw err
					}
					// If err is already an Error instance, rethrow it as-is
					if (err instanceof Error) {
						throw err
					}
					// Otherwise wrap with string conversion
					throw new Error(String(err), { cause: err })
				})) || dataOnError

		// 3. Return the data
		return data
	}

	/**
	 * Main handler for the class
	 * 1. Check redis for data
	 * 2. Check if data exists in DB
	 * 3. If data exists in DB, check if we need to update it
	 * 4. If data does not exist in DB, create it
	 * @returns {Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined>}
	 */
	async handler(): Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined> {
		// 1.
		// Check if the data exists in redis
		const redisData = await this.redisHelper.findOne()

		// If the data exists in redis, return it. Unless we want to update it
		if (redisData && this.options.update !== '1') {
			const parsed = this.schema.safeParse(redisData)
			if (parsed.success) return parsed.data
		}

		// 2.
		this.originalData = await this.getDataFromPapr()

		if (this.originalData) {
			// 3.
			if (this.options.update === '1') {
				// Try to update the data, if it fails, throw an error
				try {
					return await this.updateActions()
				} catch (err) {
					// Preserve custom errors with statusCode (NotFoundError, BadRequestError)
					if (err instanceof Error && 'statusCode' in err) {
						throw err
					}
					throw new Error(ErrorMessageUpdate(this.asin, this.type), { cause: err })
				}
			}

			// 2.
			const data = await this.getDataWithProjection()

			// Re-set the data in redis
			// Fire-and-forget by design, but MUST swallow: setOne logs and rethrows,
			// and an unhandled rejection exits the process — a Redis blip mid-run
			// would crash-loop the API even though the cache is optional.
			this.redisHelper.setOne(data).catch(() => undefined)

			return data
		}

		// 4.
		return this.createOrUpdateData()
	}
}

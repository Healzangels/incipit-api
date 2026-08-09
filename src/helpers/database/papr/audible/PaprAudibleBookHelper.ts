import type { FastifyBaseLogger } from 'fastify'

import BookModel, { BookDocument } from '#config/models/Book'
import { ApiBook, ApiBookSchema, ApiQueryString } from '#config/types'
import { isBookDocument } from '#config/typing/checkers'
import { PaprBookDocumentReturn, PaprBookReturn, PaprDeleteReturn } from '#config/typing/papr'
import touchUpdatedAt from '#helpers/database/papr/touchUpdatedAt'
import getErrorMessage from '#helpers/utils/getErrorMessage'
import SharedHelper from '#helpers/utils/shared'
import {
	ErrorMessageCreate,
	ErrorMessageDelete,
	ErrorMessageNotFoundInDb,
	ErrorMessageUpdate,
	NoticeUpdateAsin
} from '#static/messages'

export default class PaprAudibleBookHelper {
	asin: string
	bookData!: ApiBook
	options: ApiQueryString
	sharedHelper = new SharedHelper()
	logger?: FastifyBaseLogger

	constructor(asin: string, options: ApiQueryString, logger?: FastifyBaseLogger) {
		this.asin = asin
		this.options = options
		this.logger = logger
	}

	/**
	 * Inserts a new book into the DB
	 * using bookData from the constructor
	 */
	async create(): Promise<PaprBookReturn> {
		try {
			await BookModel.insertOne(this.bookData)
			return {
				data: (await this.findOneWithProjection()).data,
				modified: true
			}
		} catch (error) {
			const message = getErrorMessage(error)
			this.logger?.error(message)
			throw new Error(ErrorMessageCreate(this.asin, 'book'), { cause: error })
		}
	}

	/**
	 * Deletes a book from the DB
	 * using asin from the constructor
	 */
	async delete(): Promise<PaprDeleteReturn> {
		try {
			const deletedBook = await BookModel.deleteOne({
				asin: this.asin,
				$or: [{ region: { $exists: false } }, { region: this.options.region }]
			})
			return {
				data: deletedBook,
				modified: true
			}
		} catch (error) {
			const message = getErrorMessage(error)
			this.logger?.error(message)
			throw new Error(ErrorMessageDelete(this.asin, 'book'), { cause: error })
		}
	}

	/**
	 * Finds a book in the DB
	 * using asin from the constructor.
	 * Returns unaltered Document.
	 */
	async findOne(): Promise<PaprBookDocumentReturn> {
		const findOneBook = await BookModel.findOne({
			asin: this.asin,
			$or: [{ region: { $exists: false } }, { region: this.options.region }]
		})

		// Assign type to book data
		const data: BookDocument | null = isBookDocument(findOneBook) ? findOneBook : null

		return {
			data: data,
			modified: false
		}
	}

	/**
	 * Finds a book in the DB
	 * using asin from the constructor.
	 * Returns altered Document using projection.
	 */
	async findOneWithProjection(): Promise<PaprBookReturn> {
		const findOneBook = await BookModel.findOne({
			asin: this.asin,
			$or: [{ region: { $exists: false } }, { region: this.options.region }]
		})

		// Parse data to ensure it's the correct type and remove any extra fields
		const dataParsed = ApiBookSchema.safeParse(findOneBook)
		// Assign data to variable if it's valid, otherwise assign null
		const data = dataParsed.success ? dataParsed.data : null

		return {
			data: data,
			modified: false
		}
	}

	/**
	 * Set bookData in the class object
	 */
	setData(bookData: ApiBook) {
		this.bookData = bookData
	}

	/**
	 * Creates a book if it doesn't exist.
	 *
	 * Updates a existing book if:
	 *
	 * 1. `options.update` is 1 and the book exists
	 * 2. The incoming data is different from the existing data
	 * 3. The incoming data is a real record, not a degraded fetch
	 */
	async createOrUpdate(): Promise<PaprBookReturn> {
		const findInDb = await this.findOneWithProjection()

		// Update
		if (this.options.update === '1' && findInDb.data) {
			const data = findInDb.data
			// If the objects are the exact same return right away
			const isEqual = this.sharedHelper.isEqualData(data, this.bookData)
			if (isEqual) {
				// Unchanged, but we DID re-fetch: advance updatedAt so the staleness
				// throttle re-engages, exactly as the author helper does.
				await this.touchUpdatedAt()
				return {
					data: data,
					modified: false
				}
			}
			// Only update when the new fetch is real, not "nuked". `title` is the
			// signal: ApiBookSchema requires it, so a record carrying one came
			// through the parse rather than from a failed fetch — the same reasoning
			// that made `name` the author's signal.
			//
			// This gate used to be `this.bookData.genres?.length`, which conflated
			// two different things: a degraded fetch, and a book that simply has no
			// genres upstream. Genres reach a book from the API's category_ladders
			// or, only when those are empty, from the HTML scrape — so a book with
			// neither has an empty list as its CORRECT value, and the old gate
			// froze the whole record: a corrected title, narrator list or release
			// date could never land on it, for the life of the deployment. Those
			// are precisely the books the Hardcover/Chaptarr genre backfill exists
			// to serve, so the frozen set is not hypothetical.
			if (this.bookData.title) {
				// The protection the old gate gave incidentally, kept — but scoped to
				// the field it was actually about. A fetch that lost its genres (the
				// scrape leg failed) must not erase the ones we already hold, so carry
				// them forward and let every OTHER corrected field land. Blocking the
				// whole record was never the narrow way to do this.
				if (!this.bookData.genres?.length && data.genres?.length) {
					this.bookData = { ...this.bookData, genres: data.genres }
				}
				this.logger?.info(NoticeUpdateAsin(this.asin, 'book'))
				// Update
				return this.update()
			}
			// No update performed (nuked data), return original
			return findInDb
		}

		// Create
		return this.create()
	}

	/**
	 * Advance only updatedAt, leaving the data untouched. Called when a re-fetch
	 * returned IDENTICAL data so the throttle re-engages (see createOrUpdate).
	 */
	private async touchUpdatedAt(): Promise<void> {
		await touchUpdatedAt(
			BookModel,
			{ asin: this.asin, $or: [{ region: { $exists: false } }, { region: this.options.region }] },
			this.logger
		)
	}

	/**
	 * Updates a book in the DB
	 * using asin from the constructor.
	 * Always sets createdAt and updatedAt fields.
	 * Returns altered Document using findOneWithProjection.
	 */
	async update(): Promise<PaprBookReturn> {
		try {
			const found = await this.findOne()
			if (!found.data) {
				throw new Error(ErrorMessageNotFoundInDb(this.asin, 'Book'))
			}
			await BookModel.updateOne(
				{
					asin: this.asin,
					$or: [{ region: { $exists: false } }, { region: this.options.region }]
				},
				{
					$set: { ...this.bookData, createdAt: found.data._id.getTimestamp() },
					$currentDate: { updatedAt: true }
				}
			)
			// After updating, return with specific projection
			const updatedBook = await this.findOneWithProjection()
			// Set modified to true to indicate that the data has been updated
			updatedBook.modified = true
			return updatedBook
		} catch (error) {
			const message = getErrorMessage(error)
			this.logger?.error(message)
			throw new Error(ErrorMessageUpdate(this.asin, 'book'), { cause: error })
		}
	}
}

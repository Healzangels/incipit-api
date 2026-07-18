import { FastifyInstance } from 'fastify'

import type { ApiBook } from '#config/types'
import { RequestGeneric } from '#config/typing/requests'
import { NotFoundError } from '#helpers/errors/ApiErrors'
import ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import defaultRegistry from '#helpers/providers/registry'
import { bestSquareCover } from '#helpers/providers/squareCover'
import BookDataHelper from '#helpers/routes/BookDataHelper'
import BookShowHelper from '#helpers/routes/BookShowHelper'
import RouteCommonHelper from '#helpers/routes/RouteCommonHelper'
import { MessageNotFoundInDb } from '#static/messages'

async function _show(fastify: FastifyInstance) {
	fastify.get<RequestGeneric>('/books/:asin', async (request, reply) => {
		const asin = request.params.asin

		// Non-Audible book (Hardcover/OpenLibrary): the id decodes to a provider, so
		// re-query it for full metadata instead of the ASIN-based audnexus lookup.
		const region = request.query.region ?? 'us'
		const credentials: Record<string, string> = {}
		const hardcoverToken = request.headers['x-hardcover-token']
		if (typeof hardcoverToken === 'string' && hardcoverToken) {
			credentials.hardcover = hardcoverToken
		}
		// Attach a native square cover (Apple Books) for a square Plex poster. Any
		// object with a title/authors/image works for both response shapes. The
		// Apple lookup is cached (this runs on every book response, refreshes too).
		const squareCache = new ProviderSearchCache(fastify.redis ?? null, undefined, request.log)
		const withSquareCover = async <
			T extends { title?: string; authors?: { name?: string }[]; image?: string | null }
		>(
			book: T
		): Promise<T> => {
			if (!book?.title) return book
			const square = await bestSquareCover(
				defaultRegistry,
				{
					title: book.title,
					author: book.authors?.[0]?.name,
					currentImage: book.image,
					region,
					credentials,
					logger: request.log
				},
				squareCache
			)
			return square ? { ...book, imageSquare: square } : book
		}

		const dataHelper = new BookDataHelper(defaultRegistry, asin, region, credentials, request.log)
		if (dataHelper.isProviderId) {
			const book = await dataHelper.fetch()
			if (!book) throw new NotFoundError(MessageNotFoundInDb(asin))
			return withSquareCover(book)
		}

		// Setup common helper first
		const routeHelper = new RouteCommonHelper(asin, request.query, reply)
		// Run common helper handler
		const handler = routeHelper.handler()
		// If handler reply code is not 200, return error
		if (handler.reply.statusCode !== 200) return handler.reply

		// Setup Helper
		const { redis } = fastify
		const helper = new BookShowHelper(asin, handler.options, redis, request.log)

		// Call helper handler
		const book = await helper.handler()
		return book && 'image' in book ? withSquareCover(book as ApiBook) : book
	})
}

export default _show

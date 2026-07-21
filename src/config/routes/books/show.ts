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
import { languageConflict, regionLanguage } from '#helpers/utils/language'
import { recordLanguageMismatchedLookup } from '#helpers/utils/matchTelemetry'
import { MessageNotFoundInDb } from '#static/messages'

/**
 * Early warning for a stale/wrong pinned ASIN: an item lookup whose record
 * language positively conflicts with the region's expected language is almost
 * always a listing that changed hands (delisted edition, re-released series) --
 * the Dungeon Crawler Carl case served a FRENCH record for a sidecar-pinned
 * ASIN and the first symptom was a foreign album title on a shelf. Warn with
 * the detail and bump the /metrics counter; deliberately NOT an error, because
 * region conflates marketplace with language and a genuinely foreign library
 * must keep working.
 */
function flagLanguageMismatch(
	book: unknown,
	region: string,
	log: { warn: (obj: object, msg: string) => void }
): void {
	if (!book || typeof book !== 'object' || !('language' in book)) return
	const language = (book as { language?: string | null }).language ?? null
	const wantLanguage = regionLanguage(region)
	if (languageConflict(language, wantLanguage)) {
		log.warn(
			{ language, region, wantLanguage },
			'book lookup language conflicts with region -- stale or wrong ASIN?'
		)
		recordLanguageMismatchedLookup()
	}
}

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
		flagLanguageMismatch(book, region, request.log)
		return book && 'image' in book ? withSquareCover(book as ApiBook) : book
	})
}

export default _show

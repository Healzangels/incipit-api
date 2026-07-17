import { FastifyInstance } from 'fastify'

import { BookSearchQueryString, BookSearchQueryStringSchema } from '#config/types'
import { BadRequestError } from '#helpers/errors/ApiErrors'
import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import defaultRegistry from '#helpers/providers/registry'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'
import { ErrorMessageBadQuery, MessageBadRegion, MessageNoSearchTitle } from '#static/messages'

/**
 * GET /books — multi-provider book search.
 *
 * Unlike GET /books/:asin (lookup), this fans out across the provider registry,
 * scores candidates on title + author + duration, and returns them ranked. It is
 * the piece audnexus never had: a way to find a non-Audible book so it can appear
 * in Plex at all.
 *
 * The registry is a parameter (defaulting to the shared one) so tests can inject
 * a hermetic registry instead of mutating global state.
 * @param {ProviderRegistry} registry provider registry to search against
 */
export function makeSearchBookRoute(registry: ProviderRegistry = defaultRegistry) {
	return async function _show(fastify: FastifyInstance) {
		fastify.get<{ Querystring: BookSearchQueryString }>('/books', async (request) => {
			const parsed = BookSearchQueryStringSchema.safeParse(request.query)
			if (!parsed.success) {
				const field = parsed.error.issues[0]?.path[0]
				if (field === 'region') throw new BadRequestError(MessageBadRegion)
				throw new BadRequestError(ErrorMessageBadQuery(String(field ?? 'query')))
			}

			const options = parsed.data
			// Zod makes title/query individually optional; the route requires at least one.
			if (!options.title && !options.query) throw new BadRequestError(MessageNoSearchTitle)

			// Per-user provider tokens arrive as headers, not query params, so they
			// never appear in access logs. The Plex bundle forwards the user's own
			// Hardcover token this way; a self-hosted instance can omit it and rely
			// on the provider's env default.
			const credentials: Record<string, string> = {}
			const hardcoverToken = request.headers['x-hardcover-token']
			if (typeof hardcoverToken === 'string' && hardcoverToken) {
				credentials.hardcover = hardcoverToken
			}

			// Cache provider results in Redis when it is available; degrades to live
			// calls when it is not.
			const { redis } = fastify
			const cache = new ProviderSearchCache(redis, undefined, request.log)

			const helper = new BookSearchHelper(registry, options, request.log, credentials, cache)
			return helper.search()
		})
	}
}

// Default export registers against the shared registry — this is what server.ts uses.
const searchBook = makeSearchBookRoute()
export default searchBook

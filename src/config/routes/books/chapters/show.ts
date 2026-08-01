import { FastifyInstance } from 'fastify'

import { RequestGeneric } from '#config/typing/requests'
import ChapterShowHelper from '#helpers/routes/ChapterShowHelper'
import RouteCommonHelper from '#helpers/routes/RouteCommonHelper'
import { MessageNoChapters } from '#static/messages'

async function _show(fastify: FastifyInstance) {
	fastify.get<RequestGeneric>('/books/:asin/chapters', async (request, reply) => {
		const asin = request.params.asin

		// Setup common helper first
		const routeHelper = new RouteCommonHelper(asin, request.query, reply)
		// Run common helper handler
		const handler = routeHelper.handler()
		// If handler reply code is not 200, return error
		if (handler.reply.statusCode !== 200) return handler.reply

		// NO credential pre-gate here, deliberately. Chapters are OPTIONAL and a
		// deployment without ADP_TOKEN/PRIVATE_KEY must answer 404 rather than the
		// 500 the helper's bare throw used to produce — but that gate belongs to
		// ChapterHelper, the only layer that needs the credentials. handler()
		// below serves stored chapters straight from Redis (step 1) and Mongo
		// (step 2) and never constructs ChapterHelper on those paths, so an
		// unconditional check here 404s chapters that ARE stored and were being
		// served fine. ChapterHelper's constructor now throws a NotFoundError,
		// which the server's setErrorHandler turns into the same honest 404 for
		// the genuine "we cannot fetch this" case.

		// Setup helper
		const { redis } = fastify
		const helper = new ChapterShowHelper(asin, handler.options, redis, request.log)

		// Call helper handler
		const chapters = await helper.handler()

		// Return 404 if no chapters found
		if (!chapters) {
			reply.code(404)
			throw new Error(MessageNoChapters(asin))
		}

		// Return chapters
		return chapters
	})
}

export default _show

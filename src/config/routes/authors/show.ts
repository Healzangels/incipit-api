import { FastifyInstance } from 'fastify'

import { RequestGeneric } from '#config/typing/requests'
import AuthorShowHelper from '#helpers/routes/AuthorShowHelper'
import RouteCommonHelper from '#helpers/routes/RouteCommonHelper'

async function _show(fastify: FastifyInstance) {
	fastify.get<RequestGeneric>('/authors/:asin', async (request, reply) => {
		const asin = request.params.asin

		// NO per-request Hardcover token. Removed 2026-08-12: every deployment
		// self-hosts incipit-api with its own HARDCOVER_TOKEN, so forwarding the
		// operator's personal key from Plex's plaintext prefs on every request
		// bought nothing and widened the blast radius of a mis-set api host pref.
		// `credentials` stays — Audible chapter auth still rides it.
		const credentials: Record<string, string> = {}

		// Setup common helper first
		const routeHelper = new RouteCommonHelper(asin, request.query, reply)
		// Run common helper handler
		const handler = routeHelper.handler()
		// If handler reply code is not 200, return error
		if (handler.reply.statusCode !== 200) return handler.reply

		// Setup Helper
		const { redis } = fastify
		const helper = new AuthorShowHelper(asin, handler.options, redis, request.log, credentials)

		// Call helper handler
		return helper.handler()
	})
}

export default _show

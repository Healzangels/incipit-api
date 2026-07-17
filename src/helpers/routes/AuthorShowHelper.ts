import { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import { ApiQueryString } from '#config/types'
import { searchAudibleAuthors } from '#helpers/authors/audible/AudibleAuthorSearch'
import PaprAudibleAuthorHelper from '#helpers/database/papr/audible/PaprAudibleAuthorHelper'
import GenericShowHelper from '#helpers/routes/GenericShowHelper'

export default class AuthorShowHelper extends GenericShowHelper {
	constructor(
		asin: string,
		options: ApiQueryString,
		redis: FastifyRedis | null,
		logger?: FastifyBaseLogger
	) {
		super(asin, options, redis, 'author', logger)
	}

	/**
	 * Search for an author in the database by name
	 */
	async getAuthorsByName() {
		// Assert this.paprHelper is PaprAudibleAuthorHelper
		const paprHelper = this.paprHelper as PaprAudibleAuthorHelper
		const cached = (await paprHelper.findByName()).data
		if (cached.length) return cached

		// The local author cache is empty (fresh self-hosted instance) or has no
		// match. Fall back to the Audible catalog so authors resolve out of the
		// box. A picked author is then fetched by ASIN and cached, so subsequent
		// searches hit the fast Mongo text index.
		return searchAudibleAuthors(this.options.name ?? '', this.options.region, this.logger)
	}
}

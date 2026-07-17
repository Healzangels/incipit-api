import { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import { ApiQueryString } from '#config/types'
import { searchAudibleAuthors } from '#helpers/authors/audible/AudibleAuthorSearch'
import PaprAudibleAuthorHelper from '#helpers/database/papr/audible/PaprAudibleAuthorHelper'
import { sim } from '#helpers/providers/matchScorer'
import GenericShowHelper from '#helpers/routes/GenericShowHelper'

// Same floor the Audible fallback uses: a Mongo $text hit whose name isn't this
// close to the query is a loose token match, not the author we want.
const NAME_MATCH_FLOOR = 0.7

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
		const name = this.options.name ?? ''
		// Assert this.paprHelper is PaprAudibleAuthorHelper
		const paprHelper = this.paprHelper as PaprAudibleAuthorHelper
		const cached = (await paprHelper.findByName()).data

		// Mongo $text is a loose OR over tokens, so a search for "Adrian
		// Tchaikovsky" can return a cached "Adrian McKinty" on the shared
		// "Adrian". Keep only close name matches — otherwise a wrong cached
		// author both mis-matches AND suppresses the Audible fallback below.
		const close = cached.filter((a) => sim(name, a.name) >= NAME_MATCH_FLOOR)
		if (close.length) return close

		// Cache miss (empty on a fresh instance, or only loose matches): fall back
		// to the Audible catalog so authors resolve out of the box. A picked author
		// is then fetched by ASIN and cached, so later searches hit the text index.
		return searchAudibleAuthors(name, this.options.region, this.logger)
	}
}

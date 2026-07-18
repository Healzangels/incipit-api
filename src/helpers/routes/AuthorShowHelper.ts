import { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import type { ApiAuthorProfile, ApiBook, ApiChapter } from '#config/types'
import { ApiQueryString } from '#config/types'
import { searchAudibleAuthors } from '#helpers/authors/audible/AudibleAuthorSearch'
import PaprAudibleAuthorHelper from '#helpers/database/papr/audible/PaprAudibleAuthorHelper'
import type HardcoverProvider from '#helpers/providers/HardcoverProvider'
import { sim } from '#helpers/providers/matchScorer'
import defaultRegistry from '#helpers/providers/registry'
import GenericShowHelper from '#helpers/routes/GenericShowHelper'

const TOKEN_FLOOR = 0.85
const FULL_NAME_FLOOR = 0.9

/**
 * Whether a Mongo $text cache hit is really the searched author.
 *
 * $text is a loose OR over tokens, so "Andrew Karevik" pulls a cached "Andrew
 * Rowe" and "Adrian Tchaikovsky" pulls "Adrian McKinty" — the shared FIRST name
 * lifts the overall similarity over any single threshold (~0.72). Require the
 * name to be near-identical OR to match on BOTH first and last token, so a
 * shared first name (or a shared surname like Jane/John Smith) is not enough.
 * Anything legitimately rejected here is recovered by the Audible fallback.
 * @param {string} query the searched name
 * @param {string} candidate the cached author name
 */
export function isSameAuthor(query: string, candidate: string): boolean {
	if (sim(query, candidate) >= FULL_NAME_FLOOR) return true
	const toks = (s: string) => s.trim().toLowerCase().split(/\s+/).filter(Boolean)
	const q = toks(query)
	const c = toks(candidate)
	if (!q.length || !c.length) return false
	const firstOk = sim(q[0], c[0]) >= TOKEN_FLOOR
	const lastOk = sim(q[q.length - 1], c[c.length - 1]) >= TOKEN_FLOOR
	return firstOk && lastOk
}

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
	 * Build the author profile, then fill a missing photo from Hardcover.
	 *
	 * Audible is the primary author-image source, but it has no photo for many
	 * authors (the update logs "Error getting square image"). Hardcover carries
	 * author photos for a lot of those, so when Audible returns none we look one
	 * up by name. Apple Books is deliberately not consulted — its author pages
	 * carry no portrait. The lookup is best-effort: any failure leaves the image
	 * empty rather than breaking the update.
	 * @returns {Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined>}
	 */
	async getNewData(): Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined> {
		const data = await super.getNewData()
		if (!data || !('image' in data) || data.image) return data

		const author = data as ApiAuthorProfile
		const hardcover = defaultRegistry.get('hardcover') as HardcoverProvider | undefined
		if (!hardcover?.fetchAuthorImage) return data

		const image = await hardcover.fetchAuthorImage(author.name, {
			region: this.options.region,
			logger: this.logger
		})
		if (image) {
			this.logger?.info({ author: author.name }, 'author image: filled from Hardcover fallback')
			author.image = image
		}
		return author
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
		const close = cached.filter((a) => isSameAuthor(name, a.name))
		if (close.length) return close

		// Cache miss (empty on a fresh instance, or only loose matches): fall back
		// to the Audible catalog so authors resolve out of the box. A picked author
		// is then fetched by ASIN and cached, so later searches hit the text index.
		return searchAudibleAuthors(name, this.options.region, this.logger)
	}
}

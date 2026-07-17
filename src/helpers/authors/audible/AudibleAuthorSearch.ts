import type { FastifyBaseLogger } from 'fastify'

import { sim } from '#helpers/providers/matchScorer'
import fetch from '#helpers/utils/fetchPlus'
import { regions } from '#static/regions'

/**
 * Fallback author search against the Audible catalog.
 *
 * The inherited `/authors?name=` route is a Mongo `$text` search over the local
 * author cache — which is EMPTY on a fresh self-hosted instance, so it returns
 * nothing until an author has been fetched by ASIN at least once. Audible has no
 * public author-search endpoint, but catalog products carry their contributors'
 * name AND ASIN, so we search the catalog by author and collect the distinct
 * contributors whose name matches the query. Keyless, no token, same catalog the
 * bundle already uses for book search.
 */

export interface AuthorSearchResult {
	asin: string
	name: string
}

interface AudibleContributor {
	asin?: string
	name?: string
}
interface AudibleProduct {
	authors?: AudibleContributor[]
}

/** Transport for the catalog query; injectable so tests need no network. */
export type AudibleAuthorFetch = (url: string) => Promise<AudibleProduct[]>

const defaultFetch: AudibleAuthorFetch = async (url: string): Promise<AudibleProduct[]> => {
	const res = await fetch(url, { headers: { Accept: 'application/json' } })
	return res.data?.products ?? []
}

// A catalog query by author returns that author's books, but each book also
// lists co-authors; keep only contributors whose name actually matches so a
// search for "Dan Brown" doesn't surface his co-writers.
const NAME_MATCH_FLOOR = 0.7
const NUM_RESULTS = 20

/** Build the Audible catalog URL for an author-name query. */
function buildUrl(name: string, region: string): string {
	const r = regions[region] ? region : 'us'
	const tld = regions[r].tld
	const params = new URLSearchParams({
		author: name,
		num_results: String(NUM_RESULTS),
		products_sort_by: 'Relevance',
		response_groups: 'contributors'
	})
	return `https://api.audible.${tld}/1.0/catalog/products?${params.toString()}`
}

/**
 * Search the Audible catalog for authors matching a name.
 * @param {string} name the author name to search for
 * @param {string} region the Audible region (tld) to search
 * @param {FastifyBaseLogger} logger optional logger
 * @param {AudibleAuthorFetch} fetchImpl injectable transport
 * @returns {Promise<AuthorSearchResult[]>} distinct matching authors (asin + name)
 */
export async function searchAudibleAuthors(
	name: string,
	region: string,
	logger?: FastifyBaseLogger,
	fetchImpl: AudibleAuthorFetch = defaultFetch
): Promise<AuthorSearchResult[]> {
	if (!name) return []

	let products: AudibleProduct[]
	try {
		products = await fetchImpl(buildUrl(name, region))
	} catch (err) {
		logger?.error({ err }, 'audible author search failed')
		return []
	}

	const byAsin = new Map<string, AuthorSearchResult>()
	for (const product of products) {
		for (const author of product.authors ?? []) {
			if (
				author.asin &&
				author.name &&
				!byAsin.has(author.asin) &&
				sim(name, author.name) >= NAME_MATCH_FLOOR
			) {
				byAsin.set(author.asin, { asin: author.asin, name: author.name })
			}
		}
	}

	const results = Array.from(byAsin.values())
	logger?.debug({ count: results.length, name }, 'audible author search returned')
	return results
}

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

/** Stable key for grouping authors by display name (case/space-insensitive). */
export function normalizeName(name: string): string {
	return name.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Collapse authors that share a display name to the first (best-ranked) one,
 * preserving order. Callers pass a list already ordered best-first (Audible
 * frequency, or Mongo text score) so the survivor is the canonical entry. This
 * stops Fix Match from showing several identical rows for one author.
 * @param {T[]} authors authors ordered best-first
 * @returns {T[]} one author per distinct display name
 */
export function dedupeAuthorsByName<T extends { name: string }>(authors: T[]): T[] {
	const seen = new Set<string>()
	const out: T[] = []
	for (const author of authors) {
		const key = normalizeName(author.name)
		if (seen.has(key)) continue
		seen.add(key)
		out.push(author)
	}
	return out
}

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

	// Count how many catalog products list each contributor ASIN. Audible often
	// has several same-named author entries (e.g. three distinct "David Baldacci"
	// ASINs); the one credited on the most books is the canonical author page.
	const count = new Map<string, number>()
	const nameOf = new Map<string, string>()
	for (const product of products) {
		const seenInProduct = new Set<string>()
		for (const author of product.authors ?? []) {
			if (!author.asin || !author.name) continue
			if (sim(name, author.name) < NAME_MATCH_FLOOR) continue
			if (seenInProduct.has(author.asin)) continue // count each book once
			seenInProduct.add(author.asin)
			count.set(author.asin, (count.get(author.asin) ?? 0) + 1)
			nameOf.set(author.asin, author.name)
		}
	}

	// Collapse authors that share a display name to their most-referenced ASIN, so
	// Fix Match shows one "David Baldacci" (the real one) instead of three
	// indistinguishable rows. Canonical (most books) first.
	const bestByName = new Map<string, { asin: string; name: string; count: number }>()
	for (const [asin, cnt] of count) {
		const authorName = nameOf.get(asin) as string
		const key = normalizeName(authorName)
		const current = bestByName.get(key)
		if (!current || cnt > current.count) bestByName.set(key, { asin, name: authorName, count: cnt })
	}

	const results = Array.from(bestByName.values())
		.sort((a, b) => b.count - a.count)
		.map(({ asin, name: authorName }) => ({ asin, name: authorName }))
	logger?.debug({ count: results.length, name }, 'audible author search returned')
	return results
}

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

/** Middle initials in a name, as a signature: "Stephen R. Lawhead" -> "r". */
function initialsOf(name: string): string {
	return normalizeName(name)
		.split(' ')
		.slice(1, -1)
		.filter((t) => /^[a-z]\.?$/.test(t))
		.map((t) => t[0])
		.join('')
}

/** The name without its middle initials: both Lawheads key to "stephen lawhead". */
function nameWithoutInitials(name: string): string {
	const parts = normalizeName(name).split(' ')
	if (parts.length < 3) return parts.join(' ')
	return [parts[0], ...parts.slice(1, -1).filter((t) => !/^[a-z]\.?$/.test(t)), parts.at(-1)].join(
		' '
	)
}

/** Populated beats empty when choosing which duplicate survives. */
function richness(author: { image?: string | null; description?: string | null }): number {
	return (author.image?.trim() ? 2 : 0) + (author.description?.trim() ? 1 : 0)
}

/**
 * Collapse middle-initial variants of ONE author to the richest record.
 *
 * Audible carries both a populated "Stephen R. Lawhead" and an empty
 * "Stephen Lawhead" stub. dedupeAuthorsByName keys on the exact name, so both
 * survive — and the stub then WINS, because a client scores on name similarity
 * and the library's tag usually omits the initial: the stub is an exact match
 * (100) while the real record scores lower (89). The result is an author with
 * no photo and no bio.
 *
 * Two records collapse only when at most one of them carries middle initials.
 * "John A. Smith" and "John B. Smith" both do, and differ, so they are kept
 * apart — those are two people, not one person's stub.
 * @param {T[]} authors authors ordered best-first
 * @returns {T[]} one author per person, preferring the populated record
 */
export function collapseInitialVariants<
	T extends { name: string; image?: string | null; description?: string | null }
>(authors: T[]): T[] {
	const groups = new Map<string, T[]>()
	for (const author of authors) {
		const key = nameWithoutInitials(author.name)
		const group = groups.get(key)
		if (group) group.push(author)
		else groups.set(key, [author])
	}
	const out: T[] = []
	for (const group of groups.values()) {
		const signatures = new Set(group.map((a) => initialsOf(a.name)).filter(Boolean))
		if (group.length === 1 || signatures.size > 1) {
			out.push(...group)
			continue
		}
		// One person: keep the richest, and the earliest (best-ranked) on a tie.
		out.push(group.reduce((best, a) => (richness(a) > richness(best) ? a : best)))
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

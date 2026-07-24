import type { FastifyBaseLogger } from 'fastify'

import type { BookProvider, BookSearchQuery, ProviderCandidate } from './types'

import fetch from '#helpers/utils/fetchPlus'
import { normalizeLanguage } from '#helpers/utils/language'
import { regions } from '#static/regions'

/**
 * Audible provider — searches Audible's public catalog directly, the same
 * endpoint the Audnexus.bundle uses for book search. No token required.
 *
 * This is the source audnexus was always built around, but only for ASIN lookup;
 * here it becomes one competing provider in the fan-out rather than the sole
 * authority. It carries audio runtimes and narrators like Hardcover, so it fully
 * participates in duration scoring. Its role is coverage of the mainstream
 * Audible catalog; Hardcover and OpenLibrary cover what Audible lacks.
 */

const AUDIBLE_NAME = 'audible'
const NUM_RESULTS = 5
const RESPONSE_GROUPS = 'contributors,product_desc,product_attrs,media,product_details'
const IMAGE_SIZES = '500,1024'

interface AudibleContributor {
	name?: string
}
interface AudibleProduct {
	asin?: string
	title?: string
	runtime_length_min?: number
	authors?: AudibleContributor[]
	narrators?: AudibleContributor[]
	product_images?: Record<string, string>
	/** Edition language, e.g. "english" — supplied by the product_details group. */
	language?: string
}

/** Transport for an Audible catalog search; injectable so tests need no network. */
export type AudibleFetch = (url: string) => Promise<AudibleProduct[]>

/** Default transport: GET the catalog/products endpoint via the retrying fetch. */
const defaultFetch: AudibleFetch = async (url: string): Promise<AudibleProduct[]> => {
	const res = await fetch(url, { headers: { Accept: 'application/json' } })
	return res.data?.products ?? []
}

/** Largest available product image URL, or null. */
function largestImage(images?: Record<string, string>): string | null {
	if (!images) return null
	const sizes = Object.keys(images)
		.map((s) => Number(s))
		.filter((n) => Number.isFinite(n))
	if (!sizes.length) return null
	const largest = Math.max(...sizes)
	return images[String(largest)] ?? null
}

export default class AudibleProvider implements BookProvider {
	readonly name = AUDIBLE_NAME
	private fetchProducts: AudibleFetch

	constructor(opts: { fetchProducts?: AudibleFetch } = {}) {
		this.fetchProducts = opts.fetchProducts ?? defaultFetch
	}

	/** Build the catalog search URL for a region + title/author. */
	private buildUrl(query: BookSearchQuery): string {
		const region = regions[query.region] ? query.region : 'us'
		const tld = regions[region].tld
		const params = new URLSearchParams({
			title: query.title,
			num_results: String(NUM_RESULTS),
			products_sort_by: 'Relevance',
			response_groups: RESPONSE_GROUPS,
			image_sizes: IMAGE_SIZES
		})
		if (query.author) params.set('author', query.author)
		return `https://api.audible.${tld}/1.0/catalog/products?${params.toString()}`
	}

	/**
	 * Fallback search URL: one fuzzy `keywords` query instead of the structured
	 * title+author filter. Audible ranks these by relevance rather than matching
	 * the author string, which is what makes it survive the variance the strict
	 * filter cannot (see the note in search()).
	 */
	private buildKeywordUrl(query: BookSearchQuery): string {
		const region = regions[query.region] ? query.region : 'us'
		const tld = regions[region].tld
		const params = new URLSearchParams({
			keywords: query.author ? `${query.title} ${query.author}` : query.title,
			num_results: String(NUM_RESULTS),
			products_sort_by: 'Relevance',
			response_groups: RESPONSE_GROUPS,
			image_sizes: IMAGE_SIZES
		})
		return `https://api.audible.${tld}/1.0/catalog/products?${params.toString()}`
	}

	/**
	 * Search the Audible catalog for candidates matching the query.
	 * @param {BookSearchQuery} query the search query
	 * @param {FastifyBaseLogger} logger optional logger
	 * @returns {Promise<ProviderCandidate[]>} candidates with runtime and narrator
	 */
	async search(query: BookSearchQuery, logger?: FastifyBaseLogger): Promise<ProviderCandidate[]> {
		if (!query.title) return []

		let products = await this.fetchProducts(this.buildUrl(query))
		logger?.debug({ count: products.length }, 'audible: catalog search returned')
		// The structured `author` filter is EXACT-ish: a single differing middle
		// initial ("Stephen R. Lawhead" against Audible's "Stephen Lawhead") returns
		// ZERO products, so the audiobook edition vanishes and the book falls back to
		// a PRINT record -- which is why those books ended up with a portrait cover
		// and no square. Measured live: 5 of 15 such books return 0 under the filter
		// and are recovered by one fuzzy keyword query.
		//
		// Retried ONLY when the filtered search came back empty. A keyword search is
		// NOT a better default -- it ranks by relevance and buries a precise match
		// (measured: Command Authority and Wintersteel drop out of the top results
		// under keywords while the filter finds them) -- so this is purely additive:
		// searches that already work keep their exact results untouched.
		if (products.length === 0 && query.author) {
			products = await this.fetchProducts(this.buildKeywordUrl(query))
			logger?.debug({ count: products.length }, 'audible: keyword fallback returned')
		}

		return products
			.filter((p) => p.asin)
			.map((p) => ({
				provider: AUDIBLE_NAME,
				id: p.asin as string,
				asin: p.asin as string,
				// product_details reports a language NAME ("english"); normalize so it
				// compares against Storytel's ISO codes and OpenLibrary's MARC codes.
				language: normalizeLanguage(p.language),
				title: p.title ?? '',
				authors: (p.authors ?? []).map((a) => a.name).filter((n): n is string => !!n),
				narrators: (p.narrators ?? []).map((n) => n.name).filter((n): n is string => !!n),
				audioSeconds: typeof p.runtime_length_min === 'number' ? p.runtime_length_min * 60 : null,
				cover: largestImage(p.product_images)
			}))
	}
}

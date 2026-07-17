import type { FastifyBaseLogger } from 'fastify'

import type { BookProvider, BookSearchQuery, ProviderCandidate } from './types'

import fetch from '#helpers/utils/fetchPlus'
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
	 * Search the Audible catalog for candidates matching the query.
	 * @param {BookSearchQuery} query the search query
	 * @param {FastifyBaseLogger} logger optional logger
	 * @returns {Promise<ProviderCandidate[]>} candidates with runtime and narrator
	 */
	async search(query: BookSearchQuery, logger?: FastifyBaseLogger): Promise<ProviderCandidate[]> {
		if (!query.title) return []

		const products = await this.fetchProducts(this.buildUrl(query))
		logger?.debug({ count: products.length }, 'audible: catalog search returned')

		return products
			.filter((p) => p.asin)
			.map((p) => ({
				provider: AUDIBLE_NAME,
				id: p.asin as string,
				title: p.title ?? '',
				authors: (p.authors ?? []).map((a) => a.name).filter((n): n is string => !!n),
				narrators: (p.narrators ?? []).map((n) => n.name).filter((n): n is string => !!n),
				audioSeconds: typeof p.runtime_length_min === 'number' ? p.runtime_length_min * 60 : null,
				cover: largestImage(p.product_images)
			}))
	}
}

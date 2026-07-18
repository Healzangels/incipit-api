import type { FastifyBaseLogger } from 'fastify'

import { encodeAppleAudiobook } from './providerId'
import type {
	BookProvider,
	BookSearchQuery,
	FetchBookOptions,
	ProviderBook,
	ProviderCandidate
} from './types'

import fetch from '#helpers/utils/fetchPlus'

/**
 * Apple Books (iTunes) provider — a large, keyless English-audiobook catalog. It
 * fills the gap where Audible and Hardcover both miss, and its covers are square
 * (what Plex music art wants).
 *
 * Two-step, because the public surface is split:
 *  - SEARCH uses the keyless iTunes Search API. That returns title/author/cover
 *    but NO narrator or runtime, so a search candidate is book-level at ranking
 *    time (it wins a gap outright, but loses the audio tiebreak to a provider that
 *    already carries a narrator). Cheap and robust: one request, no scraping.
 *  - fetchBook enriches the chosen match: an iTunes `lookup` for the base fields
 *    plus a best-effort scrape of the Apple Books page's schema.org JSON-LD, which
 *    carries `readBy` (the narrator) — the one field the Search API omits.
 *
 * Keyless throughout; nothing is tied to the operator. A known caveat: the Search
 * API has no language field, so a US-store query can still surface a foreign
 * edition (an Italian "Project Hail Mary" alongside the English one). The scorer's
 * title/author match keeps those from winning; there is no field to pre-filter on.
 */

const SEARCH_URL = 'https://itunes.apple.com/search'
const LOOKUP_URL = 'https://itunes.apple.com/lookup'
const APPLE_NAME = 'apple'
const LIMIT = 5

// Region -> the iTunes store country to search. Biases toward the right catalog;
// it does not guarantee language (there is no language field to filter on).
const REGION_COUNTRY: Record<string, string> = {
	us: 'US',
	uk: 'GB',
	ca: 'CA',
	au: 'AU',
	in: 'IN',
	de: 'DE',
	es: 'ES',
	fr: 'FR',
	it: 'IT',
	jp: 'JP'
}

/** A raw iTunes audiobook result (the fields we read from search + lookup). */
export interface AppleResult {
	collectionId?: number
	collectionName?: string
	artistName?: string
	artworkUrl100?: string
	collectionViewUrl?: string
	description?: string
	releaseDate?: string
	copyright?: string
}

/** The subset of the Apple Books page's JSON-LD Audiobook we use. */
export interface AppleAudiobookLd {
	readBy?: string | string[]
	description?: string
	datePublished?: string
	image?: string
}

/** Transport for an iTunes search; injectable so tests need no network. */
export type AppleSearchFetch = (term: string, country: string) => Promise<AppleResult[]>
/** Transport for an iTunes lookup-by-id; injectable for tests. */
export type AppleLookupFetch = (
	collectionId: string,
	country: string
) => Promise<AppleResult | null>
/** Transport that returns an Apple Books page's HTML; injectable for tests. */
export type ApplePageFetch = (url: string) => Promise<string>

const defaultSearch: AppleSearchFetch = async (term, country): Promise<AppleResult[]> => {
	const qs = new URLSearchParams({
		media: 'audiobook',
		entity: 'audiobook',
		term,
		country,
		limit: String(LIMIT)
	})
	const res = await fetch(`${SEARCH_URL}?${qs.toString()}`, {
		headers: { Accept: 'application/json' }
	})
	return res.data?.results ?? []
}

const defaultLookup: AppleLookupFetch = async (
	collectionId,
	country
): Promise<AppleResult | null> => {
	const qs = new URLSearchParams({ id: collectionId, country, entity: 'audiobook' })
	const res = await fetch(`${LOOKUP_URL}?${qs.toString()}`, {
		headers: { Accept: 'application/json' }
	})
	return res.data?.results?.[0] ?? null
}

const defaultPage: ApplePageFetch = async (url): Promise<string> => {
	const res = await fetch(url, {
		headers: {
			// Apple serves the JSON-LD only to a browser-like UA.
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
			Accept: 'text/html'
		}
	})
	return typeof res.data === 'string' ? res.data : ''
}

/** Drop Apple's "(Unabridged)"/"(Abridged)" edition suffix from a title. */
export function cleanAppleTitle(name: string): string {
	return name.replace(/\s*\((?:un)?abridged\)\s*$/i, '').trim()
}

/** Upsize an iTunes artwork URL (…/100x100bb.jpg) to a square 600px cover. */
function squareCover(artworkUrl100?: string): string | null {
	if (!artworkUrl100) return null
	return artworkUrl100.replace(/\/\d+x\d+bb\.jpg$/, '/600x600bb.jpg')
}

/** Strip HTML tags and collapse whitespace (iTunes descriptions are HTML). */
function stripHtml(html?: string): string | undefined {
	if (!html) return undefined
	const text = html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&nbsp;/g, ' ')
		.replace(/[ \t]+\n/g, '\n')
		.trim()
	return text || undefined
}

/** Publisher from a "© 2021 Audible Studios" copyright line, sans the leading year. */
function publisherFromCopyright(copyright?: string): string | undefined {
	if (!copyright) return undefined
	const cleaned = copyright.replace(/^[©℗\s]*\d{4}\s*/, '').trim()
	return cleaned || undefined
}

/** First JSON-LD block on the page whose @type is "Audiobook", parsed. */
export function parseAudiobookLd(html: string): AppleAudiobookLd | null {
	const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? []
	for (const block of blocks) {
		const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')
		try {
			const parsed = JSON.parse(json)
			const nodes = Array.isArray(parsed) ? parsed : [parsed]
			// Case-insensitive: Apple emits both "Audiobook" and "AudioBook".
			const audiobook = nodes.find(
				(n) => n && typeof n['@type'] === 'string' && n['@type'].toLowerCase() === 'audiobook'
			)
			if (audiobook) return audiobook as AppleAudiobookLd
		} catch {
			// Not every ld+json block is valid/relevant; keep scanning.
		}
	}
	return null
}

const asArray = (v?: string | string[]): string[] =>
	Array.isArray(v) ? v.filter(Boolean) : v ? [v] : []

export default class AppleBooksProvider implements BookProvider {
	readonly name = APPLE_NAME
	private searchFetch: AppleSearchFetch
	private lookupFetch: AppleLookupFetch
	private pageFetch: ApplePageFetch

	constructor(
		opts: {
			searchFetch?: AppleSearchFetch
			lookupFetch?: AppleLookupFetch
			pageFetch?: ApplePageFetch
		} = {}
	) {
		this.searchFetch = opts.searchFetch ?? defaultSearch
		this.lookupFetch = opts.lookupFetch ?? defaultLookup
		this.pageFetch = opts.pageFetch ?? defaultPage
	}

	/**
	 * Search Apple Books for audiobook candidates. Book-level at ranking time (no
	 * narrator/runtime from the Search API); fetchBook fills the narrator later.
	 * @param {BookSearchQuery} query the search query
	 * @param {FastifyBaseLogger} logger optional logger
	 * @returns {Promise<ProviderCandidate[]>} audiobook candidates
	 */
	async search(query: BookSearchQuery, logger?: FastifyBaseLogger): Promise<ProviderCandidate[]> {
		if (!query.title) return []

		const term = query.author ? `${query.title} ${query.author}` : query.title
		let results: AppleResult[]
		try {
			results = await this.searchFetch(term, REGION_COUNTRY[query.region] ?? 'US')
		} catch (err) {
			logger?.error({ err }, 'apple: search failed')
			return []
		}

		return results
			.filter((r) => r.collectionId != null && r.collectionName)
			.map((r) => ({
				provider: APPLE_NAME,
				id: encodeAppleAudiobook(r.collectionId as number),
				asin: null,
				title: cleanAppleTitle(r.collectionName as string),
				authors: r.artistName ? [r.artistName] : [],
				narrators: [],
				audioSeconds: null,
				cover: squareCover(r.artworkUrl100)
			}))
	}

	/**
	 * Fetch full metadata for a matched Apple audiobook by its collection id: an
	 * iTunes lookup for the base fields, plus a best-effort JSON-LD scrape of the
	 * Apple Books page for the narrator (`readBy`). The scrape is optional — if it
	 * fails, the lookup fields still make a usable record.
	 * @param {string} nativeId the iTunes collectionId
	 * @param {string} _kind unused (always "audiobook")
	 * @param {FetchBookOptions} opts region, credentials, logger
	 * @returns {Promise<ProviderBook | null>} the book, or null if not found
	 */
	async fetchBook(
		nativeId: string,
		_kind: string,
		opts: FetchBookOptions
	): Promise<ProviderBook | null> {
		const country = REGION_COUNTRY[opts.region] ?? 'US'
		let base: AppleResult | null
		try {
			base = await this.lookupFetch(nativeId, country)
		} catch (err) {
			opts.logger?.error({ err }, 'apple: lookup failed')
			return null
		}
		if (!base || !base.collectionName) return null

		// Best-effort enrichment: the narrator (readBy) lives only on the web page.
		let ld: AppleAudiobookLd | null = null
		if (base.collectionViewUrl) {
			try {
				ld = parseAudiobookLd(await this.pageFetch(base.collectionViewUrl))
			} catch (err) {
				opts.logger?.debug({ err }, 'apple: page enrichment failed')
			}
		}

		return {
			asin: null,
			title: cleanAppleTitle(base.collectionName),
			authors: base.artistName ? [{ name: base.artistName }] : [],
			narrators: asArray(ld?.readBy).map((name) => ({ name })),
			summary: stripHtml(ld?.description ?? base.description),
			image: ld?.image ?? squareCover(base.artworkUrl100),
			publisherName: publisherFromCopyright(base.copyright),
			releaseDate: ld?.datePublished ?? base.releaseDate
		}
	}
}

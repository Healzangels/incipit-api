import type { FastifyBaseLogger } from 'fastify'

import { encodeAppleAudiobook } from './providerId'
import type {
	BookProvider,
	BookSearchQuery,
	FetchBookOptions,
	ProviderBook,
	ProviderCandidate
} from './types'

import { abridgedFromTitleSuffix } from '#helpers/providers/abridged'
import detectTextLanguage from '#helpers/utils/detectTextLanguage'
import fetch from '#helpers/utils/fetchPlus'
import { regionLanguage } from '#helpers/utils/language'

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
 * Keyless throughout; nothing is tied to the operator. The Search API has no
 * language field, so a US-store query can still surface a foreign edition (an
 * Italian "Project Hail Mary" alongside the English one) -- and because Apple
 * lists localized editions under the ORIGINAL title, title/author scoring cannot
 * separate them either. The blurb it DOES return is classified instead, so the
 * scorer's existing language demotion has something to act on.
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

/**
 * Upsize an iTunes artwork URL to a square 600px cover.
 *
 * iTunes artwork always ends in a resize segment `/<W>x<H><suffix>.<ext>`
 * (usually `…/100x100bb.jpg`, but the suffix/extension vary — `.png`, a `-75`
 * quality tag, `sr`/`bf` fit modes). Rewrite just that segment. Return `null`
 * when the input is empty OR has no resize segment to rewrite, so the caller
 * falls back rather than serving a raw 100px thumbnail as if it were a cover.
 */
function squareCover(artworkUrl100?: string): string | null {
	if (!artworkUrl100) return null
	const squared = artworkUrl100.replace(/\/\d+x\d+[^/]*$/, '/600x600bb.jpg')
	return squared === artworkUrl100 ? null : squared
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
		const inferLanguage = regionLanguage(query.region) === 'en'
		let results: AppleResult[]
		try {
			results = await this.searchFetch(term, REGION_COUNTRY[query.region] ?? 'US')
		} catch (err) {
			// RETHROW. ProviderRegistry wraps this in breakerFor(name).execute,
			// and a thunk that RESOLVES is recorded as a SUCCESS -- so returning
			// [] here made every transport refusal look like "answered, with
			// nothing" and the circuit breaker could never open. The registry's
			// own comment records the cost, measured on a 1,341-book scan: Apple
			// rate-limited us six minutes in and then refused 942 CONSECUTIVE
			// searches (751x 429, 191x 403), every one a doomed round-trip that
			// also kept Apple unusable for the square-cover lookup running on
			// every book response.
			//
			// A genuinely EMPTY result still resolves to [] below -- only a
			// transport failure propagates. Both consumers already handle it:
			// bestSquareCover catches and returns null, and ProviderSearchCache
			// never caches a fetch that threw.
			logger?.error({ err }, 'apple: search failed')
			throw err
		}

		return results
			.filter((r) => r.collectionId != null && r.collectionName)
			.map((r) => ({
				provider: APPLE_NAME,
				id: encodeAppleAudiobook(r.collectionId as number),
				asin: null,
				// The iTunes Search API exposes no language field, but it DOES
				// return the publisher's blurb -- so infer the language from that
				// rather than passing null. This is the only provider with no
				// language at all, and Apple serves localized editions under the
				// ORIGINAL title (the Spanish "Babel" is titled exactly "Babel"),
				// so without this the foreign edition ties the English one at
				// 0.850 with nothing in the scorer able to separate them.
				// Measured live: "Babel" and "Oryx and Crake" both matched Spanish
				// editions. detectTextLanguage returns null when unsure, which is
				// exactly the old behaviour.
				//
				// ENGLISH REGIONS ONLY, deliberately. regionLanguage conflates
				// marketplace with language (books/show.ts says so), and Apple's
				// DE/FR/IT stores serve ENGLISH blurbs for English audiobooks. In
				// a de region that correct detection reads as a conflict, so every
				// Apple row would lose LANGUAGE_CONFLICT_PENALTY and the ones near
				// the floor would drop out -- taking the square-cover source with
				// them. Apple was structurally immune to that while it reported
				// null; restricting the inference keeps non-English regions
				// exactly as they were rather than trading one library's bug for
				// another's regression.
				language: inferLanguage ? detectTextLanguage(stripHtml(r.description)) : null,
				title: cleanAppleTitle(r.collectionName as string),
				// Read from the RAW collectionName: cleanAppleTitle strips the
				// "(Unabridged)" suffix on the line above, so this is the last
				// point at which the statement still exists.
				abridged: abridgedFromTitleSuffix(r.collectionName as string),
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
			// RETHROW, for the same reason the search path above does. A caught
			// transport failure returned null, and books/show.ts turns null into
			// NotFoundError -> HTTP 404: the API telling Plex the book DOES NOT
			// EXIST because a provider rate-limited us for a moment. The ASIN
			// branch already treats "unavailable" as distinct from "absent" and
			// serves the stored record; the provider-id branch had no such
			// distinction to make, because the distinction was destroyed here.
			//
			// A genuinely absent book still returns null below -- only a
			// transport failure propagates.
			opts.logger?.error({ err }, 'apple: lookup failed')
			throw err
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
			// Use the iTunes SQUARE artwork (matches the search path's `cover`).
			// Deliberately NOT `?? ld?.image`: the page's JSON-LD `image` for an
			// audiobook is a 1200x630 wide social-share banner, never a cover, so a
			// missing square is better left null (the route's imageSquare enrichment
			// still supplies a poster) than filled with the banner.
			image: squareCover(base.artworkUrl100),
			publisherName: publisherFromCopyright(base.copyright),
			releaseDate: ld?.datePublished ?? base.releaseDate
		}
	}
}

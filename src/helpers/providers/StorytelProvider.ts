import type { FastifyBaseLogger } from 'fastify'

import { encodeStorytel } from './providerId'
import type {
	BookProvider,
	BookSearchQuery,
	FetchBookOptions,
	ProviderBook,
	ProviderCandidate
} from './types'

import fetch from '#helpers/utils/fetchPlus'
import { normalizeLanguage, preferLanguage, regionLanguage } from '#helpers/utils/language'

/**
 * Storytel provider — a large subscription audiobook catalog, keyless public
 * search. Unlike OpenLibrary it returns real AUDIO editions (narrator + runtime),
 * so it can win a match and feeds the audio-edition tiebreak; unlike Audible it
 * covers many international and indie titles. No token required.
 *
 * Caveats handled: the catalog mixes ebooks (skipped — no `abook`), foreign
 * languages (filtered to the region's language, keeping untagged results and
 * falling back to all), and
 * dramatized/"Summary & Analysis" editions (left to the scorer — a wrong author
 * or a vetoing duration keeps them from winning).
 */

const STORYTEL_BASE = 'https://www.storytel.com'
const SEARCH_URL = `${STORYTEL_BASE}/api/search.action`
const DETAIL_URL = `${STORYTEL_BASE}/api/getBookInfoForContent.action`
const STORYTEL_NAME = 'storytel'
const LIMIT = 8

interface StorytelName {
	name?: string | null
}
interface StorytelBookObj {
	name?: string | null
	consumableId?: string | number | null
	authors?: StorytelName[] | null
	series?: { name?: string | null }[] | null
	seriesOrder?: number | null
	largeCover?: string | null
	language?: { isoValue?: string | null } | null
}
interface StorytelAbook {
	narrators?: StorytelName[] | null
	length?: number | null // milliseconds
	isbn?: string | null
	publisher?: string | null
	releaseDate?: string | null
	description?: string | null
}
interface StorytelResult {
	book?: StorytelBookObj | null
	abook?: StorytelAbook | null
}

/** Transport for a Storytel search; injectable so tests need no network. */
export type StorytelSearchFetch = (query: string, locale: string) => Promise<StorytelResult[]>
/** Transport for a Storytel detail lookup by consumable id. */
export type StorytelDetailFetch = (consumableId: string) => Promise<StorytelResult | null>

const defaultSearch: StorytelSearchFetch = async (query, locale): Promise<StorytelResult[]> => {
	const qs = new URLSearchParams({ request_locale: locale, q: query })
	const res = await fetch(`${SEARCH_URL}?${qs.toString()}`, {
		headers: { Accept: 'application/json' }
	})
	return res.data?.books ?? []
}

const defaultDetail: StorytelDetailFetch = async (consumableId): Promise<StorytelResult | null> => {
	const qs = new URLSearchParams({ consumableId })
	const res = await fetch(`${DETAIL_URL}?${qs.toString()}`, {
		headers: { Accept: 'application/json' }
	})
	return res.data?.slb ?? null
}

const names = (list?: StorytelName[] | null): string[] =>
	(list ?? []).map((n) => n?.name).filter((n): n is string => !!n)

/** Full cover URL from Storytel's relative path (it 302s to the CDN; Plex follows). */
function coverUrl(largeCover?: string | null): string | null {
	if (!largeCover) return null
	return largeCover.startsWith('http') ? largeCover : `${STORYTEL_BASE}${largeCover}`
}

export default class StorytelProvider implements BookProvider {
	readonly name = STORYTEL_NAME
	private searchFetch: StorytelSearchFetch
	private detailFetch: StorytelDetailFetch

	constructor(opts: { searchFetch?: StorytelSearchFetch; detailFetch?: StorytelDetailFetch } = {}) {
		this.searchFetch = opts.searchFetch ?? defaultSearch
		this.detailFetch = opts.detailFetch ?? defaultDetail
	}

	/**
	 * Search Storytel for audiobook candidates matching the title.
	 * @param {BookSearchQuery} query the search query
	 * @param {FastifyBaseLogger} logger optional logger
	 * @returns {Promise<ProviderCandidate[]>} audio candidates (narrator + runtime)
	 */
	async search(query: BookSearchQuery, logger?: FastifyBaseLogger): Promise<ProviderCandidate[]> {
		if (!query.title) return []

		let results: StorytelResult[]
		try {
			results = await this.searchFetch(query.title, regionLanguage(query.region) ?? 'en')
		} catch (err) {
			logger?.error({ err }, 'storytel: search failed')
			return []
		}

		return (
			preferLanguage(results, query.region, (r) => r.book?.language?.isoValue)
				// Audiobooks only — an ebook-only hit has no `abook`.
				.filter((r) => r.abook && r.book?.consumableId != null && r.book?.name)
				.slice(0, LIMIT)
				.map((r) => {
					const book = r.book as StorytelBookObj
					const abook = r.abook as StorytelAbook
					const lengthMs = typeof abook.length === 'number' ? abook.length : 0
					return {
						provider: STORYTEL_NAME,
						id: encodeStorytel(book.consumableId as string | number),
						asin: null,
						// Storytel reports ISO-639-1 already; normalize anyway so locale
						// tags and casing can't produce a spurious mismatch.
						language: normalizeLanguage(book.language?.isoValue),
						title: book.name ?? '',
						authors: names(book.authors),
						narrators: names(abook.narrators),
						audioSeconds: lengthMs > 0 ? Math.round(lengthMs / 1000) : null,
						cover: coverUrl(book.largeCover)
					}
				})
		)
	}

	/**
	 * Fetch full metadata for a matched Storytel book by its consumable id.
	 * @param {string} nativeId the Storytel consumableId
	 * @param {string} _kind unused (always "book")
	 * @param {FetchBookOptions} opts region, credentials, logger
	 * @returns {Promise<ProviderBook | null>} the book, or null if not found
	 */
	async fetchBook(
		nativeId: string,
		_kind: string,
		opts: FetchBookOptions
	): Promise<ProviderBook | null> {
		let slb: StorytelResult | null
		try {
			slb = await this.detailFetch(nativeId)
		} catch (err) {
			opts.logger?.error({ err }, 'storytel: detail fetch failed')
			return null
		}
		const book = slb?.book
		const abook = slb?.abook
		if (!book || !book.name) return null

		const series = (book.series ?? []).find((s) => s?.name)
		return {
			asin: null,
			title: book.name,
			language: normalizeLanguage(book.language?.isoValue),
			authors: (names(book.authors) || []).map((name) => ({ name })),
			narrators: names(abook?.narrators).map((name) => ({ name })),
			summary: abook?.description ?? undefined,
			image: coverUrl(book.largeCover),
			publisherName: abook?.publisher ?? undefined,
			releaseDate: abook?.releaseDate ?? undefined,
			seriesPrimary: series?.name
				? {
						name: series.name,
						position: book.seriesOrder != null ? String(book.seriesOrder) : undefined
					}
				: undefined
		}
	}
}

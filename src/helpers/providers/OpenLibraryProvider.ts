import type { FastifyBaseLogger } from 'fastify'

import type { BookProvider, BookSearchQuery, ProviderCandidate } from './types'

import fetch from '#helpers/utils/fetchPlus'

/**
 * OpenLibrary provider — the fallback source. No auth, no audio editions (so no
 * runtime and no narrator), but broad book-level coverage and a cover for most
 * titles. In Gate 0 it matched 81% of the unmatched set on its own; its role here
 * is to catch what Hardcover misses and to supply metadata + cover for books that
 * have no audio edition anywhere.
 *
 * Two OpenLibrary quirks are handled:
 *  - `title=` is near-literal: "The Hunt for Red October: A Jack Ryan Novel"
 *    returns nothing while the stem returns results. So a miss is retried on the
 *    pre-subtitle stem before giving up.
 *  - Unbounded responses 500, and OpenLibrary asks callers to set `fields=` and an
 *    identifying User-Agent with a contact. Both are done here.
 */

const SEARCH_URL = 'https://openlibrary.org/search.json'
const OPENLIBRARY_NAME = 'openlibrary'
const FIELDS = 'key,title,author_name,first_publish_year,cover_i'
const LIMIT = 5

export interface OpenLibraryDoc {
	key?: string
	title?: string
	author_name?: string[]
	first_publish_year?: number
	cover_i?: number
}

/** Transport for an OpenLibrary search; injectable so tests need no network. */
export type OpenLibraryFetch = (
	params: { title: string; author?: string },
	contact: string | undefined
) => Promise<OpenLibraryDoc[]>

/** Default transport: GET search.json with fields + an identifying User-Agent. */
const defaultFetch: OpenLibraryFetch = async (params, contact): Promise<OpenLibraryDoc[]> => {
	const qs = new URLSearchParams({ title: params.title, fields: FIELDS, limit: String(LIMIT) })
	if (params.author) qs.set('author', params.author)
	const res = await fetch(`${SEARCH_URL}?${qs.toString()}`, {
		headers: {
			'User-Agent': `incipit-api/0.1 (+${contact || 'no-contact-set'})`,
			Accept: 'application/json'
		}
	})
	return res.data?.docs ?? []
}

/** Text before the first subtitle separator (":" or "(") or " - " suffix. */
function baseTitle(s: string): string {
	if (!s) return ''
	const beforeDash = s.split(/\s+[-–—]\s+/)[0]
	return beforeDash.split(/\s*[:(]\s*/)[0].trim()
}

export default class OpenLibraryProvider implements BookProvider {
	readonly name = OPENLIBRARY_NAME
	private contact?: string
	private fetchDocs: OpenLibraryFetch

	constructor(opts: { contact?: string; fetchDocs?: OpenLibraryFetch } = {}) {
		this.contact = opts.contact
		this.fetchDocs = opts.fetchDocs ?? defaultFetch
	}

	/**
	 * Search OpenLibrary, retrying on the pre-subtitle stem when the full title
	 * misses (their title filter is close to literal).
	 * @param {BookSearchQuery} query the search query
	 * @param {FastifyBaseLogger} logger optional logger
	 * @returns {Promise<ProviderCandidate[]>} book-level candidates (no audio data)
	 */
	async search(query: BookSearchQuery, logger?: FastifyBaseLogger): Promise<ProviderCandidate[]> {
		if (!query.title) return []

		let docs = await this.fetchDocs({ title: query.title, author: query.author }, this.contact)
		if (!docs.length) {
			const stem = baseTitle(query.title)
			if (stem && stem.toLowerCase() !== query.title.toLowerCase()) {
				logger?.debug({ stem }, 'openlibrary: retrying on pre-subtitle stem')
				docs = await this.fetchDocs({ title: stem, author: query.author }, this.contact)
			}
		}

		return docs.map((d) => ({
			provider: OPENLIBRARY_NAME,
			// OpenLibrary work key, e.g. "/works/OL27448W" — always present, namespaced.
			id: d.key ? `openlibrary:${d.key}` : `openlibrary:${d.title ?? 'unknown'}`,
			title: d.title ?? '',
			authors: d.author_name ?? [],
			narrators: [],
			audioSeconds: null,
			cover:
				typeof d.cover_i === 'number'
					? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`
					: null
		}))
	}
}

import type { FastifyBaseLogger } from 'fastify'

import { encodeOpenLibraryWork } from './providerId'
import type {
	BookProvider,
	BookSearchQuery,
	FetchBookOptions,
	ProviderBook,
	ProviderCandidate
} from './types'

import fetch from '#helpers/utils/fetchPlus'
import { normalizeLanguage } from '#helpers/utils/language'

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

const OL_BASE = 'https://openlibrary.org'
const SEARCH_URL = `${OL_BASE}/search.json`
const OPENLIBRARY_NAME = 'openlibrary'
// `language` is requested but NOT used as a query filter: a hard filter would
// drop works whose language OpenLibrary simply hasn't tagged, costing recall.
// Capture the signal and let the matcher weigh it instead.
const FIELDS = 'key,title,author_name,first_publish_year,cover_i,language'
const LIMIT = 5
// Cap author-key resolutions per book lookup (each is a separate request).
const MAX_AUTHORS = 4

export interface OpenLibraryDoc {
	key?: string
	title?: string
	author_name?: string[]
	first_publish_year?: number
	cover_i?: number
	/** ISO-639-2/MARC codes, e.g. ["eng"] — a work can list several. */
	language?: string[]
}

interface OpenLibraryWork {
	title?: string
	description?: string | { value?: string }
	covers?: number[]
	authors?: { author?: { key?: string } }[]
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

// Connecting words kept lowercase inside a title (never first/last word).
const TITLE_SMALL_WORDS = new Set([
	'a',
	'an',
	'and',
	'as',
	'at',
	'but',
	'by',
	'for',
	'from',
	'in',
	'nor',
	'of',
	'on',
	'or',
	'the',
	'to',
	'via',
	'vs',
	'with'
])

/**
 * Title-case a SENTENCE-cased title (OpenLibrary's house style — "Cube route",
 * "Heaven cent") so an OL-matched book reads like every other provider's title.
 * Acts ONLY when the title is genuinely sentence-cased (no capital past the
 * first character), so an already-title-cased title, an acronym, or any
 * intentional casing is returned untouched. Small connecting words stay
 * lowercase unless they are the first or last word.
 * @param {string} title the raw provider title
 * @returns {string} the title-cased title, or the input unchanged
 */
export function titleCaseSentence(title: string): string {
	if (!title || /[A-Z]/.test(title.slice(1))) return title
	const words = title.split(' ')
	return words
		.map((w, i) => {
			if (!w) return w
			const bare = w.replace(/[^a-z]/gi, '').toLowerCase()
			if (i > 0 && i < words.length - 1 && TITLE_SMALL_WORDS.has(bare)) return w
			return w.charAt(0).toUpperCase() + w.slice(1)
		})
		.join(' ')
}

/** Fetches a JSON document; injectable so the data lookup needs no network in tests. */
export type OpenLibraryGetJson = (url: string, contact: string | undefined) => Promise<unknown>

const defaultGetJson: OpenLibraryGetJson = async (url, contact): Promise<unknown> => {
	const res = await fetch(url, {
		headers: {
			'User-Agent': `incipit-api/0.1 (+${contact || 'no-contact-set'})`,
			Accept: 'application/json'
		}
	})
	return res.data
}

export default class OpenLibraryProvider implements BookProvider {
	readonly name = OPENLIBRARY_NAME
	private contact?: string
	private fetchDocs: OpenLibraryFetch
	private getJson: OpenLibraryGetJson

	constructor(
		opts: { contact?: string; fetchDocs?: OpenLibraryFetch; getJson?: OpenLibraryGetJson } = {}
	) {
		this.contact = opts.contact
		this.fetchDocs = opts.fetchDocs ?? defaultFetch
		this.getJson = opts.getJson ?? defaultGetJson
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
			id: d.key ? encodeOpenLibraryWork(d.key) : `openlibrary-works-unknown`,
			asin: null,
			// MARC codes ("eng"); take the first — a multi-language work is
			// ambiguous, and normalizeLanguage returns null for anything unmapped.
			language: normalizeLanguage(d.language?.[0]),
			title: titleCaseSentence(d.title ?? ''),
			authors: d.author_name ?? [],
			narrators: [],
			audioSeconds: null,
			cover:
				typeof d.cover_i === 'number'
					? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`
					: null
		}))
	}

	/**
	 * Fetch full metadata for a matched OpenLibrary work by its native key.
	 * OpenLibrary is book-level only: title, synopsis, cover, and resolved author
	 * names. No narrator, runtime, publisher, or rating.
	 * @param {string} nativeId the work key, e.g. "/works/OL80870W"
	 * @param {string} _kind unused (always "works")
	 * @param {FetchBookOptions} opts region, credentials, logger
	 * @returns {Promise<ProviderBook | null>} the book, or null if not found
	 */
	async fetchBook(
		nativeId: string,
		_kind: string,
		opts: FetchBookOptions
	): Promise<ProviderBook | null> {
		const work = (await this.getJson(`${OL_BASE}${nativeId}.json`, this.contact)) as
			| OpenLibraryWork
			| undefined
		if (!work || !work.title) return null

		const description =
			typeof work.description === 'string' ? work.description : work.description?.value

		// Resolve author keys to names (each is a separate request; capped).
		const authorKeys = (work.authors ?? [])
			.map((a) => a.author?.key)
			.filter((k): k is string => !!k)
			.slice(0, MAX_AUTHORS)
		// Resolve author keys in parallel — sequential awaits cost up to
		// MAX_AUTHORS-1 extra HTTP round trips per lookup for no ordering benefit
		// (order is preserved by Promise.all's result array).
		const authorResults = await Promise.all(
			authorKeys.map(async (key) => {
				try {
					const a = (await this.getJson(`${OL_BASE}${key}.json`, this.contact)) as {
						name?: string
					}
					return a?.name ? { name: a.name } : null
				} catch (err) {
					opts.logger?.debug({ err, key }, 'openlibrary: author resolve failed')
					return null
				}
			})
		)
		const authors = authorResults.filter((a): a is { name: string } => a !== null)

		const coverId = work.covers?.find((c) => c > 0)
		return {
			asin: null,
			title: titleCaseSentence(work.title),
			authors,
			narrators: [],
			summary: description,
			image: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null
		}
	}
}

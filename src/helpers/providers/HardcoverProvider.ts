import type { FastifyBaseLogger } from 'fastify'

import type { BookProvider, BookSearchQuery, ProviderCandidate } from './types'

import fetch from '#helpers/utils/fetchPlus'

/**
 * Hardcover provider — the strongest source in the Gate 0 benchmark (93% of the
 * unmatched set) and the only one carrying audiobook runtimes and square
 * (2400x2400) audio covers.
 *
 * Hardcover has no single search-with-filter endpoint, so it takes two calls:
 *  1. Typesense-backed `search` -> a list of book ids.
 *  2. `books(where: {id: {_in: ids}})` with each book's AUDIO editions
 *     (reading_format_id 2, audio_seconds > 0).
 *
 * A book with audio editions yields one candidate per edition — different
 * editions have different runtimes, and the scorer's duration signal picks the
 * right one. A book with no audio edition (e.g. the Xanth catalog) still yields a
 * book-level candidate: title, author and cover, no narrator — the graceful
 * fallback PLAN §5 describes.
 */

const ENDPOINT = 'https://api.hardcover.app/v1/graphql'
const HARDCOVER_NAME = 'hardcover'
const SEARCH_PER_PAGE = 5
const BOOKS_LIMIT = 10
const EDITIONS_LIMIT = 3

const SEARCH_QUERY = `query IncipitSearch($q: String!, $pp: Int!) {
	search(query: $q, query_type: "book", per_page: $pp) { ids }
}`

const BOOKS_QUERY = `query IncipitBooks($ids: [Int!]) {
	books(where: { id: { _in: $ids } }, limit: ${BOOKS_LIMIT}) {
		id
		title
		cached_image
		contributions { author { name } contribution }
		editions(
			where: { reading_format_id: { _eq: 2 }, audio_seconds: { _gt: 0 } }
			order_by: { users_count: desc }
			limit: ${EDITIONS_LIMIT}
		) {
			id
			asin
			audio_seconds
			cached_image
			contributions { author { name } contribution }
		}
	}
}`

interface HardcoverImage {
	url?: string | null
}
interface HardcoverContribution {
	author?: { name?: string | null } | null
	contribution?: string | null
}
interface HardcoverEdition {
	id: number
	asin?: string | null
	audio_seconds?: number | null
	cached_image?: HardcoverImage | null
	contributions?: HardcoverContribution[] | null
}
interface HardcoverBook {
	id: number
	title?: string | null
	cached_image?: HardcoverImage | null
	contributions?: HardcoverContribution[] | null
	editions?: HardcoverEdition[] | null
}

/** Transport for a GraphQL call; injectable so tests need no network. */
export type HardcoverGql = <T>(
	query: string,
	variables: Record<string, unknown>,
	token: string
) => Promise<T>

/** Default transport: POST to Hardcover via the project's retrying fetch. */
const defaultGql: HardcoverGql = async <T>(
	query: string,
	variables: Record<string, unknown>,
	token: string
): Promise<T> => {
	const res = await fetch(ENDPOINT, {
		method: 'POST',
		headers: {
			// Hardcover hands the token out with a "Bearer " prefix already on it;
			// strip any leading one so we never send "Bearer Bearer ...".
			Authorization: `Bearer ${token.replace(/^\s*[Bb]earer\s+/, '')}`,
			'Content-Type': 'application/json'
		},
		data: { query, variables }
	})
	const body = res.data
	if (body?.errors) throw new Error(JSON.stringify(body.errors))
	return body?.data as T
}

/** True when a contribution role denotes narration. */
function isNarrator(contribution?: string | null): boolean {
	return !!contribution && /narrat/i.test(contribution)
}

/** Author names from a contribution list (author role or unlabelled). */
function authorsOf(contributions?: HardcoverContribution[] | null): string[] {
	if (!contributions) return []
	return contributions
		.filter((c) => !isNarrator(c.contribution))
		.map((c) => c.author?.name)
		.filter((n): n is string => !!n)
}

/** Narrator names from a contribution list. */
function narratorsOf(contributions?: HardcoverContribution[] | null): string[] {
	if (!contributions) return []
	return contributions
		.filter((c) => isNarrator(c.contribution))
		.map((c) => c.author?.name)
		.filter((n): n is string => !!n)
}

export default class HardcoverProvider implements BookProvider {
	readonly name = HARDCOVER_NAME
	private defaultToken?: string
	private gql: HardcoverGql

	constructor(opts: { token?: string; gql?: HardcoverGql } = {}) {
		this.defaultToken = opts.token
		this.gql = opts.gql ?? defaultGql
	}

	/**
	 * Search Hardcover for candidates matching the query.
	 * @param {BookSearchQuery} query the search query (may carry a per-request token)
	 * @param {FastifyBaseLogger} logger optional logger
	 * @returns {Promise<ProviderCandidate[]>} candidates (one per audio edition, or
	 *   one book-level candidate when a book has no audio edition)
	 */
	async search(query: BookSearchQuery, logger?: FastifyBaseLogger): Promise<ProviderCandidate[]> {
		const token = query.credentials?.[HARDCOVER_NAME] ?? this.defaultToken
		if (!token) {
			logger?.debug('hardcover: no token supplied, skipping provider')
			return []
		}
		if (!query.title) return []

		const searchData = await this.gql<{ search?: { ids?: unknown[] } }>(
			SEARCH_QUERY,
			{ q: query.title, pp: SEARCH_PER_PAGE },
			token
		)
		const ids = (searchData?.search?.ids ?? [])
			.map((i) => Number(i))
			.filter((n) => Number.isInteger(n))
		if (!ids.length) return []

		const booksData = await this.gql<{ books?: HardcoverBook[] }>(BOOKS_QUERY, { ids }, token)
		const books = booksData?.books ?? []

		const candidates: ProviderCandidate[] = []
		for (const book of books) {
			const title = book.title ?? ''
			const bookAuthors = authorsOf(book.contributions)
			const bookCover = book.cached_image?.url ?? null
			const editions = book.editions ?? []

			if (editions.length) {
				for (const ed of editions) {
					candidates.push({
						provider: HARDCOVER_NAME,
						// Provider-native, always populated even when there is no ASIN.
						id: ed.asin || `hardcover:edition:${ed.id}`,
						title,
						authors: authorsOf(ed.contributions).length ? authorsOf(ed.contributions) : bookAuthors,
						narrators: narratorsOf(ed.contributions),
						audioSeconds: ed.audio_seconds ?? null,
						cover: ed.cached_image?.url ?? bookCover
					})
				}
			} else {
				// No audio edition (e.g. Xanth): book-level fallback, no narrator.
				candidates.push({
					provider: HARDCOVER_NAME,
					id: `hardcover:book:${book.id}`,
					title,
					authors: bookAuthors,
					narrators: [],
					audioSeconds: null,
					cover: bookCover
				})
			}
		}
		return candidates
	}
}

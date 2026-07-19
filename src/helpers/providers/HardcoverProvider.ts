import type { FastifyBaseLogger } from 'fastify'

import { encodeHardcoverBook, encodeHardcoverEdition } from './providerId'
import type {
	BookProvider,
	BookSearchQuery,
	FetchBookOptions,
	ProviderBook,
	ProviderCandidate
} from './types'

import fetch from '#helpers/utils/fetchPlus'

/**
 * Hardcover provider — the strongest source in the Gate 0 benchmark (93% of the
 * unmatched set) and the only one carrying audiobook runtimes and square
 * (2400x2400) audio covers.
 *
 * Hardcover has no single search-with-filter endpoint, so it takes two calls:
 *  1. Typesense-backed `search` -> a list of book ids.
 *  2. `books(where: {id: {_in: ids}})` with each book's AUDIObook editions
 *     (reading_format_id 2) — including ones with no `audio_seconds`.
 *
 * A book with audio editions yields one candidate per edition. Duration-bearing
 * editions rank higher (the scorer's duration signal picks the right one), but we
 * DON'T require `audio_seconds`: many real audiobook editions (e.g. Tolkien's
 * "The Fall of Gondolin") have it unset, and dropping them lost the square
 * audiobook cover + narrator, falling back to the print book cover. A book with
 * no audiobook edition at all (e.g. the Xanth catalog) still yields a book-level
 * candidate — the graceful fallback PLAN §5 describes.
 */

const ENDPOINT = 'https://api.hardcover.app/v1/graphql'
const HARDCOVER_NAME = 'hardcover'
const SEARCH_PER_PAGE = 5
const BOOKS_LIMIT = 10
// Raised from 3 now that we accept editions without audio_seconds, so a
// duration-bearing edition isn't crowded out of the top slots by no-duration ones.
const EDITIONS_LIMIT = 6

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
			where: { reading_format_id: { _eq: 2 } }
			order_by: [{ audio_seconds: desc_nulls_last }, { users_count: desc }]
			limit: ${EDITIONS_LIMIT}
		) {
			id
			asin
			audio_seconds
			cached_image
			language { language }
			contributions { author { name } contribution }
		}
	}
}`

// Full-book query for the data lookup (GET /books/{id}). Fields verified live.
const BOOK_BY_ID_QUERY = `query IncipitBook($id: Int!) {
	books(where: { id: { _eq: $id } }) {
		id
		title
		subtitle
		description
		rating
		cached_image
		contributions { author { name } contribution }
		book_series { position series { name } }
		editions(order_by: { users_count: desc }, limit: 5) {
			id
			asin
			audio_seconds
			reading_format_id
			release_date
			cached_image
			publisher { name }
			contributions { author { name } contribution }
		}
	}
}`

// Full fields for the SPECIFIC matched edition (GET /books/hardcover-edition-{id}).
// The candidate id points at one exact edition, so the data lookup must return
// THAT edition's asin/runtime/cover/date/publisher/narrators — not a popularity
// re-pick of the book's editions (which could be a different, even print,
// edition). All fields are the ones already selected (and live-verified) in
// BOOKS_QUERY / BOOK_BY_ID_QUERY; book_id threads to the book-level fields.
const EDITION_FULL_QUERY = `query IncipitEditionFull($id: Int!) {
	editions(where: { id: { _eq: $id } }, limit: 1) {
		id
		book_id
		asin
		audio_seconds
		reading_format_id
		release_date
		cached_image
		language { language }
		publisher { name }
		contributions { author { name } contribution }
	}
}`

// Author photo by name. NOTE: unlike books, the authors table's `cached_image`
// is null — the real photo is the `image` object relation, selected as
// `image { url }` (verified live against the schema).
// NOTE: Hardcover's Hasura rejects `_ilike` and related pattern ops ("not
// permitted on this server"), which silently threw and made every author-image
// lookup return null. `_eq` is permitted but EXACT and case/punctuation
// sensitive: it only returns rows whose name string equals `$name` byte-for-byte
// (bar case, which Hasura's text collation folds). So if Audible's stored name
// differs in punctuation/spacing from Hardcover's ("J.R.R. Tolkien" vs
// "J. R. R. Tolkien"), the query returns zero rows and no portrait is found —
// the client-side match below can only pick AMONG returned rows, it cannot
// recover a variant the query never returned. Known limitation; a fuzzy
// author `search()` (like the book path) would close it but needs its own live
// verification. limit: 5 covers exact same-name duplicates.
// Also pulls `bio` for the description backfill (Audible leaves many authors with
// no bio). The bio can live on a DIFFERENT same-name record than the photo — e.g.
// Stephen Fry's portrait is on the 94-book canonical record (bio null) while the
// full bio is on a 1-book duplicate — so image and bio are picked independently.
const AUTHOR_INFO_QUERY = `query IncipitAuthorInfo($name: String!) {
	authors(where: { name: { _eq: $name } }, limit: 5) {
		name
		bio
		image {
			url
		}
	}
}`

// Hardcover bios are Wikipedia-sourced markdown: strip the emphasis markers, the
// reference-style footnotes ("([Source][1])") and their trailing definitions
// ("  [1]: http://…"), and normalize newlines, so Plex shows clean prose.
function cleanHardcoverBio(raw: string): string {
	return raw
		.replace(/\r\n/g, '\n')
		.replace(/^[ \t]*\[\d+\]:\s*\S+.*$/gm, '') // trailing "  [1]: http://…"
		.replace(/\s*\(?\[[^\]]+\]\[\d+\]\)?/g, '') // inline "([Source][1])"
		.replace(/\*/g, '') // markdown italics/bold markers
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

interface HardcoverImage {
	url?: string | null
}
interface HardcoverContribution {
	author?: { name?: string | null } | null
	contribution?: string | null
}
interface HardcoverSeries {
	position?: number | null
	series?: { name?: string | null } | null
}
interface HardcoverEdition {
	id: number
	book_id?: number | null
	asin?: string | null
	audio_seconds?: number | null
	reading_format_id?: number | null
	release_date?: string | null
	cached_image?: HardcoverImage | null
	language?: { language?: string | null } | null
	publisher?: { name?: string | null } | null
	contributions?: HardcoverContribution[] | null
}

// Region → the Hardcover `languages.language` name we prefer. A global catalog
// returns editions in every language; without this, a French or German audio
// edition of "Small Gods" scores as high as the English one on title+author.
// Prefer the region's language, but fall back to all editions so a book only
// available in one language still matches.
const REGION_LANGUAGE: Record<string, string> = {
	us: 'English',
	uk: 'English',
	ca: 'English',
	au: 'English',
	in: 'English',
	de: 'German',
	es: 'Spanish',
	fr: 'French',
	it: 'Italian',
	jp: 'Japanese'
}

/** Keep the preferred language AND untagged editions; fall back to all if none. */
function preferLanguage(editions: HardcoverEdition[], region: string): HardcoverEdition[] {
	const want = REGION_LANGUAGE[region]
	if (!want) return editions
	// Keep the wanted language and editions whose language is UNSET — Hardcover's
	// language data is patchy and a real English audio edition often carries no
	// language tag, so dropping nulls (in favor of a worse tagged edition, or
	// losing the book entirely) regressed matching. Only fall back to ALL editions
	// when nothing matches even this looser filter.
	const inLang = editions.filter((e) => {
		const lang = e.language?.language
		return lang === want || lang == null
	})
	return inLang.length ? inLang : editions
}
interface HardcoverBook {
	id: number
	title?: string | null
	subtitle?: string | null
	description?: string | null
	rating?: number | null
	cached_image?: HardcoverImage | null
	contributions?: HardcoverContribution[] | null
	book_series?: HardcoverSeries[] | null
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

/** Normalized series list from a book's book_series rows. */
function buildSeries(book: HardcoverBook): { name: string; position?: string }[] {
	return (book.book_series ?? [])
		.filter((s) => s.series?.name)
		.map((s) => ({
			name: s.series?.name as string,
			position: s.position != null ? String(s.position) : undefined
		}))
}

/**
 * Build the data-lookup ProviderBook from book-level fields plus ONE specific
 * edition's fields (asin/runtime/cover/date/publisher/narrators). The edition is
 * chosen by the caller — the exact matched edition for an edition id, or the
 * best-audio pick for a book id — so the returned metadata always matches the
 * edition the caller intends.
 */
function providerBook(book: HardcoverBook, edition: HardcoverEdition | undefined): ProviderBook {
	const series = buildSeries(book)
	return {
		asin: edition?.asin ?? null,
		title: book.title ?? '',
		subtitle: book.subtitle ?? undefined,
		authors: authorsOf(book.contributions).map((name) => ({ name })),
		narrators: narratorsOf(edition?.contributions).map((name) => ({ name })),
		summary: book.description ?? undefined,
		image: edition?.cached_image?.url ?? book.cached_image?.url ?? null,
		publisherName: edition?.publisher?.name ?? undefined,
		// Hardcover rates 0-5; the bundle stores rating as a string.
		rating: typeof book.rating === 'number' ? book.rating.toFixed(2) : undefined,
		releaseDate: edition?.release_date ?? undefined,
		seriesPrimary: series[0],
		seriesSecondary: series[1]
	}
}

/**
 * Map a full Hardcover book to a ProviderBook for a BOOK-level match (no specific
 * edition was matched): prefer an audio edition for narrator/publisher/date, else
 * the top edition.
 */
function toProviderBook(book: HardcoverBook): ProviderBook {
	const editions = book.editions ?? []
	const audioEdition = editions.find((e) => e.reading_format_id === 2 && e.audio_seconds)
	return providerBook(book, audioEdition ?? editions[0])
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
			const editions = preferLanguage(book.editions ?? [], query.region)

			if (editions.length) {
				for (const ed of editions) {
					candidates.push({
						provider: HARDCOVER_NAME,
						// The id is the DATA-FETCH key, so it must point back to
						// Hardcover — never the ASIN. An edition's ASIN can be an
						// Amazon/preorder id that resolves to an empty Audible
						// product (404 on /books/:asin); the ASIN still rides along
						// in the `asin` field for dedup + the exact-match pin.
						id: encodeHardcoverEdition(ed.id),
						asin: ed.asin ?? null,
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
					id: encodeHardcoverBook(book.id),
					asin: null,
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

	/**
	 * Fetch full metadata for a matched Hardcover book by its native id.
	 * @param {string} nativeId the Hardcover book or edition id
	 * @param {string} kind "book" or "edition" (from the decoded candidate id)
	 * @param {FetchBookOptions} opts region, credentials, logger
	 * @returns {Promise<ProviderBook | null>} the book, or null if not found
	 */
	async fetchBook(
		nativeId: string,
		kind: string,
		opts: FetchBookOptions
	): Promise<ProviderBook | null> {
		const token = opts.credentials?.[HARDCOVER_NAME] ?? this.defaultToken
		if (!token) {
			opts.logger?.debug('hardcover: no token supplied, cannot fetch book')
			return null
		}

		// An edition id: fetch THAT exact edition's fields, then its parent book for
		// the book-level fields, and combine — so the applied asin/cover/date/
		// publisher/narrators are the edition that was matched, not a popularity
		// re-pick of the book's editions (which could be a different, even print,
		// edition — the bug this path had).
		if (kind === 'edition') {
			const edData = await this.gql<{ editions?: HardcoverEdition[] }>(
				EDITION_FULL_QUERY,
				{ id: Number(nativeId) },
				token
			)
			const edition = edData?.editions?.[0]
			if (!edition?.book_id) return null
			const bookData = await this.gql<{ books?: HardcoverBook[] }>(
				BOOK_BY_ID_QUERY,
				{ id: edition.book_id },
				token
			)
			const book = bookData?.books?.[0]
			return book ? providerBook(book, edition) : null
		}

		// A book id: no specific edition was matched, so let toProviderBook pick one.
		const bookId = Number(nativeId)
		if (!Number.isInteger(bookId)) return null
		const data = await this.gql<{ books?: HardcoverBook[] }>(
			BOOK_BY_ID_QUERY,
			{ id: bookId },
			token
		)
		const book = data?.books?.[0]
		return book ? toProviderBook(book) : null
	}

	/**
	 * Fetch an author's photo URL and bio by name — the fallback used when the
	 * primary (Audible) author page has no image and/or no description. Image and
	 * bio are picked INDEPENDENTLY across same-name matches (they can live on
	 * different records). Returns nulls (never throws) when there is no token, no
	 * match, or the lookup fails, so a miss is a no-op rather than a broken update.
	 * @param {string} name the author name to look up
	 * @param {FetchBookOptions} opts region, credentials, logger
	 * @returns {Promise<{ image: string | null; bio: string | null }>}
	 */
	async fetchAuthorInfo(
		name: string,
		opts: FetchBookOptions
	): Promise<{ image: string | null; bio: string | null }> {
		const token = opts.credentials?.[HARDCOVER_NAME] ?? this.defaultToken
		if (!token || !name) return { image: null, bio: null }
		try {
			const data = await this.gql<{
				authors?: { name?: string | null; bio?: string | null; image?: HardcoverImage | null }[]
			}>(AUTHOR_INFO_QUERY, { name }, token)
			const authors = data?.authors ?? []
			const lc = name.toLowerCase()

			// Image: prefer an exact name match with one; else the first with one.
			const exactImg = authors.find((a) => a.name?.toLowerCase() === lc && a.image?.url)
			const anyImg = authors.find((a) => a.image?.url)
			const image = (exactImg ?? anyImg)?.image?.url ?? null

			// Bio: prefer exact-name matches, then the longest non-empty bio (a
			// fuller record over a stub) — independent of which record had the image.
			const withBio = authors.filter((a) => a.bio && a.bio.trim())
			const exactBios = withBio.filter((a) => a.name?.toLowerCase() === lc)
			const bioPick = (exactBios.length ? exactBios : withBio).sort(
				(a, b) => (b.bio as string).length - (a.bio as string).length
			)[0]
			const bio = bioPick?.bio ? cleanHardcoverBio(bioPick.bio) : null

			return { image, bio }
		} catch (err) {
			opts.logger?.debug({ err, name }, 'hardcover: author info lookup failed')
			return { image: null, bio: null }
		}
	}

	/**
	 * Back-compat convenience: the author photo URL alone.
	 * @param {string} name the author name
	 * @param {FetchBookOptions} opts region, credentials, logger
	 * @returns {Promise<string | null>} an image URL, or null
	 */
	async fetchAuthorImage(name: string, opts: FetchBookOptions): Promise<string | null> {
		return (await this.fetchAuthorInfo(name, opts)).image
	}
}

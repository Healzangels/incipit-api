import type { FastifyBaseLogger } from 'fastify'

import type {
	BookProvider,
	BookSearchQuery,
	FetchBookOptions,
	ProviderBook,
	ProviderCandidate
} from './types'

import { encodeLibrivox } from '#helpers/providers/providerId'
import fetch from '#helpers/utils/fetchPlus'
import { normalizeLanguage } from '#helpers/utils/language'

/**
 * LibriVox provider — the volunteer public-domain audiobook catalogue.
 *
 * Keyless and explicitly built for third-party consumption, which makes it the
 * safest source we can add: no credential to expire, no ToS grey area, and a
 * catalogue nobody else covers. Its value is the classics long tail — books
 * whose only audio edition is a LibriVox recording, where Audible and OverDrive
 * both return nothing and the fan-out otherwise falls back to a print record.
 *
 * A SUPPLEMENT, never primary: public-domain recordings carry no Audible ASIN,
 * and readings are volunteer-produced, so a commercial edition should win
 * whenever one exists. The existing scorer and byAudio tiebreak order it
 * correctly with no special-casing — it wins only when nothing else has audio.
 *
 * Two API quirks shape this client:
 *  - `title` and `author` CANNOT be combined: sending both returns HTTP 500
 *    (verified live), so we search by title and let the scorer judge the author.
 *  - `extended=1` (which is what carries the readers) inflates a 5-result search
 *    from ~1.9KB to ~25KB, so search stays plain and only fetchBook asks for it.
 */

const LIBRIVOX_NAME = 'librivox'
const BASE = 'https://librivox.org/api/feed/audiobooks'
const NUM_RESULTS = 5

interface LibriVoxAuthor {
	first_name?: string
	last_name?: string
}
interface LibriVoxReader {
	display_name?: string
}
interface LibriVoxSection {
	readers?: LibriVoxReader[]
}
interface LibriVoxBook {
	id?: number | string
	title?: string
	description?: string
	language?: string
	copyright_year?: string
	totaltimesecs?: number | string
	url_librivox?: string
	authors?: LibriVoxAuthor[]
	sections?: LibriVoxSection[]
	genres?: { name?: string }[]
}

/** Transport for a LibriVox request; injectable so tests need no network. */
export type LibriVoxFetch = (url: string) => Promise<unknown>

// retries=3 starts fetchPlus at its own retry ceiling, i.e. exactly ONE attempt.
// A LibriVox 404 is a NORMAL miss -- the catalogue is narrow and most titles are
// simply not in it -- but the default ladder treats it as a failure and retries
// four times with exponential backoff, so a routine no-hit cost seconds and the
// article fallback then paid it twice. There is nothing to retry here: the answer
// is not going to change.
const defaultFetch: LibriVoxFetch = async (url) =>
	(await fetch(url, { headers: { Accept: 'application/json' } }, 3)).data

/** "Jane" + "Austen" -> "Jane Austen"; tolerates either half missing. */
function authorName(a: LibriVoxAuthor): string {
	return [a.first_name, a.last_name].filter((p) => p && p.trim()).join(' ')
}

function authorNames(authors: LibriVoxAuthor[] | undefined): string[] {
	return (authors ?? []).map(authorName).filter((n) => n.length > 0)
}

/**
 * Runtime in seconds, or null.
 *
 * `totaltimesecs` is 0 on records where no runtime was ever recorded (verified
 * live on a second "Pride and Prejudice" listing). Zero is ABSENCE, not a
 * zero-length book: passing it through as a real runtime would make the duration
 * veto compare against nothing and reject a correct match.
 */
function audioSecondsOf(book: LibriVoxBook): number | null {
	const raw = Number(book.totaltimesecs)
	return Number.isFinite(raw) && raw > 0 ? raw : null
}

/**
 * Distinct reader names across every section.
 *
 * LibriVox recordings are frequently COLLABORATIVE — Pride and Prejudice has 13
 * readers — so this is a cast list rather than a single narrator. That suits the
 * consumer, which matches on ANY name in the list.
 */
function narratorsOf(book: LibriVoxBook): string[] {
	const seen = new Set<string>()
	for (const section of book.sections ?? []) {
		for (const reader of section.readers ?? []) {
			const name = reader.display_name?.trim()
			if (name) seen.add(name)
		}
	}
	return [...seen]
}

/** LibriVox descriptions are HTML; flatten to plain text for Plex. */
function stripHtml(html?: string): string | undefined {
	if (!html) return undefined
	const text = html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/[ \t]+\n/g, '\n')
		.trim()
	return text || undefined
}

export default class LibriVoxProvider implements BookProvider {
	readonly name = LIBRIVOX_NAME
	private fetchLibriVox: LibriVoxFetch

	constructor(opts: { fetchLibriVox?: LibriVoxFetch } = {}) {
		this.fetchLibriVox = opts.fetchLibriVox ?? defaultFetch
	}

	/** The title with a leading article removed, or null when it has none. */
	private static articleStripped(title: string): string | null {
		const stripped = title.replace(/^\s*(the|a|an)\s+/i, '').trim()
		return stripped && stripped !== title.trim() ? stripped : null
	}

	private searchUrl(query: BookSearchQuery, title: string): string {
		// Title only: sending title AND author together is a 500 from this API.
		// No extended=1 -- the readers it adds cost ~13x the payload, and fetchBook
		// asks for them once, for the one record that actually won.
		const params = new URLSearchParams({
			title,
			format: 'json',
			limit: String(NUM_RESULTS)
		})
		return `${BASE}/?${params.toString()}`
	}

	private booksFrom(data: unknown): LibriVoxBook[] {
		const books = (data as { books?: LibriVoxBook[] })?.books
		return Array.isArray(books) ? books : []
	}

	async search(query: BookSearchQuery, logger?: FastifyBaseLogger): Promise<ProviderCandidate[]> {
		if (!query.title) return []
		// LibriVox stores titles WITHOUT a leading article -- "The Time Machine" is
		// catalogued as "Time Machine", and asking for the former is a hard 404
		// (verified live). So retry once without the article when the exact title
		// finds nothing. Additive, exactly like the Audible keyword fallback: a
		// title that already works is never re-queried, and titles that genuinely
		// begin with an article still match on the first attempt.
		const attempts = [query.title]
		const stripped = LibriVoxProvider.articleStripped(query.title)
		if (stripped) attempts.push(stripped)

		let books: LibriVoxBook[] = []
		for (const attempt of attempts) {
			try {
				books = this.booksFrom(await this.fetchLibriVox(this.searchUrl(query, attempt)))
			} catch (err) {
				// A 404 here means "no such title", which is a normal miss for a
				// catalogue this narrow -- not an outage worth abandoning the retry for.
				logger?.debug({ err, title: attempt }, 'librivox: search attempt failed')
				books = []
			}
			if (books.length) break
		}
		logger?.debug({ count: books.length }, 'librivox: search returned')
		return books
			.filter((b) => b.id != null && b.title)
			.map((b) => ({
				provider: LIBRIVOX_NAME,
				id: encodeLibrivox(b.id as number | string),
				// Public domain: no store listing, so no ASIN. This is why LibriVox is
				// a supplement -- the ASIN-keyed conveniences do not apply to it.
				asin: null,
				title: b.title as string,
				authors: authorNames(b.authors),
				// Readers only come with extended=1; fetchBook fills them in.
				narrators: [],
				audioSeconds: audioSecondsOf(b),
				// The API exposes no artwork at all (verified: no image/cover field on
				// any record), so the square-cover path supplies it from elsewhere.
				cover: null,
				language: normalizeLanguage(b.language)
			}))
	}

	async fetchBook(
		nativeId: string,
		_kind: string,
		opts: FetchBookOptions
	): Promise<ProviderBook | null> {
		const params = new URLSearchParams({
			id: nativeId,
			format: 'json',
			// The readers live under sections, which only extended=1 returns.
			extended: '1'
		})
		let data: unknown
		try {
			data = await this.fetchLibriVox(`${BASE}/?${params.toString()}`)
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
			opts.logger?.debug({ err, nativeId }, 'librivox: fetchBook failed')
			throw err
		}
		const book = this.booksFrom(data)[0]
		if (!book?.title) return null
		return {
			asin: null,
			title: book.title,
			authors: authorNames(book.authors).map((name) => ({ name })),
			narrators: narratorsOf(book).map((name) => ({ name })),
			summary: stripHtml(book.description),
			image: null,
			publisherName: 'LibriVox',
			// The public-domain copyright year is the only date on offer -- not a
			// release date for THIS recording, but it is what the catalogue has.
			releaseDate: book.copyright_year,
			language: normalizeLanguage(book.language)
		}
	}
}

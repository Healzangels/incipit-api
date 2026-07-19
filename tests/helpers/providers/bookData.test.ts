import { describe, expect, test } from 'bun:test'

import HardcoverProvider, { type HardcoverGql } from '#helpers/providers/HardcoverProvider'
import OpenLibraryProvider, {
	type OpenLibraryGetJson
} from '#helpers/providers/OpenLibraryProvider'
import ProviderRegistry from '#helpers/providers/ProviderRegistry'
import BookDataHelper from '#helpers/routes/BookDataHelper'

// Hardcover full-book response, matching the shape verified live.
const hcBook = {
	id: 119295,
	title: 'A Spell for Chameleon',
	subtitle: null,
	description: 'The magical beginning of the Xanth series.',
	rating: 3.5209424,
	cached_image: { url: 'https://assets.hardcover.app/book.jpg' },
	contributions: [{ author: { name: 'Piers Anthony' }, contribution: null }],
	book_series: [{ position: 1, series: { name: 'Xanth' } }],
	editions: [
		{
			id: 13647826,
			asin: null,
			audio_seconds: null,
			reading_format_id: 4,
			release_date: '1977-01-01',
			cached_image: { url: 'https://assets.hardcover.app/edition.jpg' },
			publisher: { name: 'Del Rey' },
			contributions: [{ author: { name: 'Piers Anthony' }, contribution: null }]
		}
	]
}

describe('HardcoverProvider.fetchBook', () => {
	const gql: HardcoverGql = async <T>(query: string): Promise<T> => {
		if (query.includes('IncipitBook')) return { books: [hcBook] } as T
		return { books: [] } as T
	}

	test('maps a book to the ProviderBook shape (Xanth: no audio, no narrator)', async () => {
		const p = new HardcoverProvider({ token: 'tok', gql })
		const book = await p.fetchBook('119295', 'book', { region: 'us' })
		expect(book).toMatchObject({
			asin: null,
			title: 'A Spell for Chameleon',
			authors: [{ name: 'Piers Anthony' }],
			narrators: [],
			summary: 'The magical beginning of the Xanth series.',
			image: 'https://assets.hardcover.app/edition.jpg',
			publisherName: 'Del Rey',
			rating: '3.52',
			releaseDate: '1977-01-01',
			seriesPrimary: { name: 'Xanth', position: '1' }
		})
	})

	test('fetches the exact edition, then its parent book, and combines them', async () => {
		const seen: string[] = []
		const edition = {
			id: 13647826,
			book_id: 119295,
			asin: 'B0EDITIONX',
			audio_seconds: 41000,
			reading_format_id: 2,
			release_date: '2008-05-01',
			cached_image: { url: 'https://assets.hardcover.app/matched-edition.jpg' },
			publisher: { name: 'Recorded Books' },
			contributions: [{ author: { name: 'Traber Burns' }, contribution: 'Narrator' }]
		}
		const trackingGql: HardcoverGql = async <T>(query: string): Promise<T> => {
			if (query.includes('IncipitEditionFull')) {
				seen.push('edition-lookup')
				return { editions: [edition] } as T
			}
			seen.push('book')
			return { books: [hcBook] } as T
		}
		const p = new HardcoverProvider({ token: 'tok', gql: trackingGql })
		const book = await p.fetchBook('13647826', 'edition', { region: 'us' })
		expect(seen).toEqual(['edition-lookup', 'book'])
		// Book-level fields from the book; edition-level fields from the matched edition.
		expect(book?.title).toBe('A Spell for Chameleon')
		expect(book?.asin).toBe('B0EDITIONX')
		expect(book?.releaseDate).toBe('2008-05-01')
		expect(book?.narrators).toEqual([{ name: 'Traber Burns' }])
	})

	test('returns null without a token', async () => {
		const p = new HardcoverProvider({ gql })
		expect(await p.fetchBook('119295', 'book', { region: 'us' })).toBeNull()
	})
})

describe('OpenLibraryProvider.fetchBook', () => {
	const getJson: OpenLibraryGetJson = async (url) => {
		if (url.includes('/works/OL80870W')) {
			return {
				title: 'A Spell for Chameleon',
				description: { value: 'Xanth begins.' },
				covers: [6453925],
				authors: [{ author: { key: '/authors/OL19905A' } }]
			}
		}
		if (url.includes('/authors/OL19905A')) return { name: 'Piers Anthony' }
		return undefined
	}

	test('fetches a work and resolves author names, cover, and description', async () => {
		const p = new OpenLibraryProvider({ getJson })
		const book = await p.fetchBook('/works/OL80870W', 'works', { region: 'us' })
		expect(book).toMatchObject({
			asin: null,
			title: 'A Spell for Chameleon',
			authors: [{ name: 'Piers Anthony' }],
			narrators: [],
			summary: 'Xanth begins.',
			image: 'https://covers.openlibrary.org/b/id/6453925-L.jpg'
		})
	})

	test('returns null for a missing work', async () => {
		const p = new OpenLibraryProvider({ getJson: async () => undefined })
		expect(await p.fetchBook('/works/OLNONEW', 'works', { region: 'us' })).toBeNull()
	})
})

describe('BookDataHelper dispatch', () => {
	const registry = new ProviderRegistry([
		new HardcoverProvider({
			token: 'tok',
			gql: (async () => ({ books: [hcBook] })) as HardcoverGql
		})
	])

	test('recognizes a provider id and dispatches to fetchBook', async () => {
		const helper = new BookDataHelper(registry, 'hardcover-book-119295', 'us')
		expect(helper.isProviderId).toBe(true)
		const book = await helper.fetch()
		expect(book?.title).toBe('A Spell for Chameleon')
	})

	test('a plain ASIN is not a provider id (routes to the audnexus path)', async () => {
		const helper = new BookDataHelper(registry, 'B08G9PRS1K', 'us')
		expect(helper.isProviderId).toBe(false)
		expect(await helper.fetch()).toBeNull()
	})

	test('returns null when the provider is not registered', async () => {
		const helper = new BookDataHelper(new ProviderRegistry(), 'hardcover-book-1', 'us')
		expect(await helper.fetch()).toBeNull()
	})
})

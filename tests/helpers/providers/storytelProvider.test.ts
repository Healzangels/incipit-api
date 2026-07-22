import { describe, expect, test } from 'bun:test'

import StorytelProvider, {
	type StorytelDetailFetch,
	type StorytelSearchFetch
} from '#helpers/providers/StorytelProvider'
import type { BookSearchQuery } from '#helpers/providers/types'

// Mirrors the real search.action shape: books[] of { book, abook }. `length` is
// milliseconds; an ebook-only hit has no `abook`.
const audio = {
	book: {
		name: 'The Final Empire',
		consumableId: 14117566,
		authors: [{ name: 'Brandon Sanderson' }],
		series: [{ name: 'Mistborn' }],
		seriesOrder: 1,
		largeCover: '/images/320x320/0010916617.jpg',
		language: { isoValue: 'en' }
	},
	abook: {
		narrators: [{ name: 'Michael Kramer' }],
		length: 23480000,
		isbn: '9781648817120',
		publisher: 'Recorded Books',
		releaseDate: '2010-08-01',
		description: 'What if the hero of prophecy fails?'
	}
}
const foreign = {
	...audio,
	book: { ...audio.book, consumableId: 999, language: { isoValue: 'de' } }
}
const ebookOnly = { book: { ...audio.book, consumableId: 111 }, abook: null }

const q: BookSearchQuery = { title: 'The Final Empire', region: 'us' }

describe('StorytelProvider', () => {
	test('maps an audio result to a candidate (id, narrator, runtime in seconds, cover)', async () => {
		const searchFetch: StorytelSearchFetch = async () => [audio]
		const out = await new StorytelProvider({ searchFetch }).search(q)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({
			provider: 'storytel',
			id: 'storytel-14117566',
			asin: null,
			title: 'The Final Empire',
			authors: ['Brandon Sanderson'],
			narrators: ['Michael Kramer'],
			audioSeconds: 23480, // 23480000 ms / 1000
			cover: 'https://www.storytel.com/images/320x320/0010916617.jpg'
		})
	})

	test('drops ebook-only hits and prefers the region language (falls back to all)', async () => {
		// English preferred over the German edition.
		const mixed = await new StorytelProvider({
			searchFetch: async () => [foreign, audio, ebookOnly]
		}).search(q)
		expect(mixed.map((c) => c.id)).toEqual(['storytel-14117566'])

		// Only a foreign edition exists -> keep it rather than drop the book.
		const deOnly = await new StorytelProvider({ searchFetch: async () => [foreign] }).search(q)
		expect(deOnly.map((c) => c.id)).toEqual(['storytel-999'])
	})

	test('keeps untagged (null-language) results alongside a tagged match', async () => {
		// Storytel's private preferLanguage copy missed the null-keeping fix that
		// Hardcover got (mirror drift): an untagged result was dropped whenever ANY
		// tagged match existed. Both must survive now that the helper is shared.
		const untagged = {
			...audio,
			book: { ...audio.book, consumableId: 555, language: null }
		}
		const out = await new StorytelProvider({
			searchFetch: async () => [audio, untagged, foreign]
		}).search(q)
		expect(out.map((c) => c.id)).toEqual(['storytel-14117566', 'storytel-555'])
	})

	test('returns [] on an empty title or a search error', async () => {
		const p = new StorytelProvider({
			searchFetch: async () => {
				throw new Error('down')
			}
		})
		expect(await p.search({ title: '', region: 'us' })).toEqual([])
		expect(await p.search(q)).toEqual([])
	})

	test('fetchBook maps the detail record to a ProviderBook with series position', async () => {
		const detailFetch: StorytelDetailFetch = async () => audio
		const book = await new StorytelProvider({ detailFetch }).fetchBook('14117566', 'book', {
			region: 'us'
		})
		expect(book).toMatchObject({
			title: 'The Final Empire',
			authors: [{ name: 'Brandon Sanderson' }],
			narrators: [{ name: 'Michael Kramer' }],
			summary: 'What if the hero of prophecy fails?',
			publisherName: 'Recorded Books',
			seriesPrimary: { name: 'Mistborn', position: '1' }
		})
	})

	test('fetchBook carries the detail record language for the lookup mismatch flag', async () => {
		const detailFetch: StorytelDetailFetch = async () => foreign
		const book = await new StorytelProvider({ detailFetch }).fetchBook('999', 'book', {
			region: 'us'
		})
		expect(book?.language).toBe('de')
	})
})

import { describe, expect, test } from 'bun:test'

import AppleBooksProvider, { type AppleSearchFetch } from '#helpers/providers/AppleBooksProvider'
import AudibleProvider from '#helpers/providers/AudibleProvider'
import HardcoverProvider from '#helpers/providers/HardcoverProvider'
import OpenLibraryProvider from '#helpers/providers/OpenLibraryProvider'
import StorytelProvider from '#helpers/providers/StorytelProvider'
import type { BookSearchQuery } from '#helpers/providers/types'

/**
 * Every provider reports language in a DIFFERENT notation. These tests pin that
 * each one is normalized to the same ISO-639-1 code on the candidate, because a
 * provider that silently stops populating `language` would reopen the
 * foreign-edition hole without failing anything else.
 */

const q: BookSearchQuery = { title: 'Dune', region: 'us' }

describe('providers normalize their native language notation onto the candidate', () => {
	test('audible: a language NAME ("english") -> "en"', async () => {
		const provider = new AudibleProvider({
			fetchProducts: async () => [{ asin: 'B0000001AA', title: 'Dune', language: 'english' }]
		})
		const out = await provider.search(q)
		expect(out[0].language).toBe('en')
	})

	test('audible: a foreign name is preserved as its own code, not coerced to en', async () => {
		const provider = new AudibleProvider({
			fetchProducts: async () => [{ asin: 'B0000002AA', title: 'Dune', language: 'german' }]
		})
		const out = await provider.search(q)
		expect(out[0].language).toBe('de')
	})

	test('openlibrary: MARC codes (["ger"]) -> "de"', async () => {
		const provider = new OpenLibraryProvider({
			fetchDocs: async () => [
				{ key: '/works/OL1W', title: 'Dune', author_name: ['Frank Herbert'], language: ['ger'] }
			]
		})
		const out = await provider.search(q)
		expect(out[0].language).toBe('de')
	})

	test('openlibrary: an untagged work reports null, not a guess', async () => {
		const provider = new OpenLibraryProvider({
			fetchDocs: async () => [{ key: '/works/OL2W', title: 'Dune', author_name: ['Frank Herbert'] }]
		})
		const out = await provider.search(q)
		expect(out[0].language).toBeNull()
	})

	test('storytel: ISO-639-1 ("sv") stays "sv"', async () => {
		const provider = new StorytelProvider({
			searchFetch: async () => [
				{
					book: {
						name: 'Dune',
						consumableId: 'abc',
						authors: [{ name: 'Frank Herbert' }],
						language: { isoValue: 'sv' }
					},
					abook: { narrators: [{ name: 'N' }], length: 3600000 }
				}
			],
			detailFetch: async () => null
		})
		// region 'us' wants 'en'; preferLanguage falls back to ALL results when
		// nothing matches, so the Swedish edition still surfaces -- and now it
		// surfaces WITH its language attached, which is the point.
		const out = await provider.search(q)
		expect(out[0].language).toBe('sv')
	})

	test('apple: no language field in its API -> null ("no signal")', async () => {
		const searchFetch: AppleSearchFetch = async () => [
			{
				collectionId: 1,
				collectionName: 'Dune (Unabridged)',
				artistName: 'Frank Herbert',
				artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg'
			}
		]
		const out = await new AppleBooksProvider({ searchFetch }).search(q)
		expect(out[0].language).toBeNull()
	})

	test('hardcover: an edition language NAME ("Spanish") -> "es"', async () => {
		const provider = new HardcoverProvider({
			token: 't',
			gql: async (query: string) => {
				if (query.includes('search(')) return { search: { ids: [1] } }
				return {
					books: [
						{
							id: 1,
							title: 'Dune',
							contributions: [{ author: { name: 'Frank Herbert' }, contribution: null }],
							editions: [
								{
									id: 10,
									asin: 'B0000003AA',
									audio_seconds: 1000,
									language: { language: 'Spanish' },
									contributions: []
								}
							]
						}
					]
				}
			}
		})
		const out = await provider.search({ title: 'Dune', region: 'es' })
		expect(out[0].language).toBe('es')
	})

	test('hardcover: the book-level fallback (no edition) reports null', async () => {
		const provider = new HardcoverProvider({
			token: 't',
			gql: async (query: string) => {
				if (query.includes('search(')) return { search: { ids: [2] } }
				return {
					books: [
						{
							id: 2,
							title: 'Dune',
							contributions: [{ author: { name: 'Frank Herbert' }, contribution: null }],
							editions: []
						}
					]
				}
			}
		})
		const out = await provider.search(q)
		expect(out[0].language).toBeNull()
	})
})

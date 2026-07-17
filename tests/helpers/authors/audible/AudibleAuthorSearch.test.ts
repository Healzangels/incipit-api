import { describe, expect, test } from 'bun:test'

import {
	type AudibleAuthorFetch,
	searchAudibleAuthors
} from '#helpers/authors/audible/AudibleAuthorSearch'

// Mirrors the real catalog/products shape verified live: each product lists its
// contributors with name + asin under `authors`.
const products = [
	{ authors: [{ name: 'Dan Brown', asin: 'B000AP9DSU' }] },
	{ authors: [{ name: 'Dan Brown', asin: 'B000AP9DSU' }] }, // duplicate asin
	{
		authors: [
			{ name: 'Dan Brown', asin: 'B000AP9DSU' },
			{ name: 'Some Coauthor', asin: 'B0COAUTHOR' } // non-matching name, dropped
		]
	}
]

describe('searchAudibleAuthors', () => {
	test('returns distinct matching authors (asin + name), dropping co-authors', async () => {
		const fetchImpl: AudibleAuthorFetch = async () => products
		const out = await searchAudibleAuthors('Dan Brown', 'us', undefined, fetchImpl)
		expect(out).toEqual([{ asin: 'B000AP9DSU', name: 'Dan Brown' }])
	})

	test('builds a region-specific author catalog URL', async () => {
		let seenUrl = ''
		const fetchImpl: AudibleAuthorFetch = async (url) => {
			seenUrl = url
			return []
		}
		await searchAudibleAuthors('Dan Brown', 'uk', undefined, fetchImpl)
		expect(seenUrl).toContain('https://api.audible.co.uk/1.0/catalog/products')
		expect(seenUrl).toContain('author=Dan+Brown')
		expect(seenUrl).toContain('response_groups=contributors')
	})

	test('returns [] for an empty name without fetching', async () => {
		let called = false
		const fetchImpl: AudibleAuthorFetch = async () => {
			called = true
			return products
		}
		const out = await searchAudibleAuthors('', 'us', undefined, fetchImpl)
		expect(out).toEqual([])
		expect(called).toBe(false)
	})

	test('swallows transport errors and returns []', async () => {
		const fetchImpl: AudibleAuthorFetch = async () => {
			throw new Error('network down')
		}
		const out = await searchAudibleAuthors('Dan Brown', 'us', undefined, fetchImpl)
		expect(out).toEqual([])
	})
})

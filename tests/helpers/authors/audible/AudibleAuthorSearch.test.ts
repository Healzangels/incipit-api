import { describe, expect, test } from 'bun:test'

import {
	type AudibleAuthorFetch,
	dedupeAuthorsByName,
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

	test('collapses several same-name author ASINs to the most-referenced one', async () => {
		// Audible returns three distinct "David Baldacci" ASINs; the one on the most
		// books is the canonical author and the only row Fix Match should show.
		const baldacci: { authors: { name: string; asin: string }[] }[] = [
			{ authors: [{ name: 'David Baldacci', asin: 'B000AQ0STC' }] },
			{ authors: [{ name: 'David Baldacci', asin: 'B0H12WK1DB' }] },
			{ authors: [{ name: 'David Baldacci', asin: 'B0H12WK1DB' }] },
			{ authors: [{ name: 'David Baldacci', asin: 'B0H12WK1DB' }] },
			{ authors: [{ name: 'David Baldacci', asin: 'B0H8QD5X57' }] }
		]
		const out = await searchAudibleAuthors('David Baldacci', 'us', undefined, async () => baldacci)
		expect(out).toEqual([{ asin: 'B0H12WK1DB', name: 'David Baldacci' }])
	})
})

describe('dedupeAuthorsByName', () => {
	test('keeps one author per display name, preserving best-first order', () => {
		const out = dedupeAuthorsByName([
			{ asin: 'A1', name: 'David Baldacci' },
			{ asin: 'A2', name: 'david  baldacci' }, // same name, different case/spacing
			{ asin: 'B1', name: 'Dan Brown' },
			{ asin: 'A3', name: 'David Baldacci' }
		])
		expect(out).toEqual([
			{ asin: 'A1', name: 'David Baldacci' },
			{ asin: 'B1', name: 'Dan Brown' }
		])
	})
})

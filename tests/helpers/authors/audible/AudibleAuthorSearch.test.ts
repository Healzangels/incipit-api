import { describe, expect, test } from 'bun:test'

import {
	type AudibleAuthorFetch,
	collapseInitialVariants,
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

describe('collapseInitialVariants', () => {
	// Audible carries an empty "Stephen Lawhead" stub alongside the populated
	// "Stephen R. Lawhead". A client scores on name similarity against a tag that
	// usually omits the initial, so the stub matches exactly (100) and beats the
	// real record (89) -- the author then shows no photo and no bio.
	test('keeps the populated record over the empty stub for one person', () => {
		const out = collapseInitialVariants([
			{ asin: 'B004MLGWG4', name: 'Stephen Lawhead', image: '', description: '' },
			{ asin: 'B000AQ4NUC', name: 'Stephen R. Lawhead', image: 'photo.jpg', description: 'Bio.' }
		])
		expect(out).toHaveLength(1)
		expect(out[0].asin).toBe('B000AQ4NUC')
	})

	test('keeps distinct people who differ by middle initial', () => {
		const out = collapseInitialVariants([
			{ asin: 'A1', name: 'John A. Smith', image: 'a.jpg', description: '' },
			{ asin: 'B1', name: 'John B. Smith', image: 'b.jpg', description: '' }
		])
		expect(out).toHaveLength(2)
	})

	test('leaves lone authors untouched and preserves order', () => {
		const out = collapseInitialVariants([
			{ asin: 'X', name: 'Trevanian' },
			{ asin: 'Y', name: 'Jessica Townsend' }
		])
		expect(out.map((a) => a.asin)).toEqual(['X', 'Y'])
	})

	test('on a richness tie the earlier (better-ranked) record survives', () => {
		const out = collapseInitialVariants([
			{ asin: 'FIRST', name: 'Iain Banks', image: '', description: '' },
			{ asin: 'SECOND', name: 'Iain M. Banks', image: '', description: '' }
		])
		expect(out).toHaveLength(1)
		expect(out[0].asin).toBe('FIRST')
	})

	test('a description alone is richer than nothing', () => {
		const out = collapseInitialVariants([
			{ asin: 'STUB', name: 'Ursula Le Guin', image: '', description: '' },
			{ asin: 'REAL', name: 'Ursula K. Le Guin', image: '', description: 'Author of Earthsea.' }
		])
		expect(out[0].asin).toBe('REAL')
	})
})

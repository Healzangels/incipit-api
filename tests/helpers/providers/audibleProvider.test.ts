import { describe, expect, test } from 'bun:test'

import AudibleProvider, { type AudibleFetch } from '#helpers/providers/AudibleProvider'
import type { BookSearchQuery } from '#helpers/providers/types'

// Mirrors the real catalog/products shape verified live: asin, title,
// runtime_length_min, authors[], narrators[], product_images keyed by size.
const phmProduct = {
	asin: 'B08G9PRS1K',
	title: 'Project Hail Mary',
	runtime_length_min: 970,
	authors: [{ name: 'Andy Weir' }],
	narrators: [{ name: 'Ray Porter' }],
	product_images: {
		'500': 'https://m.media-amazon.com/x._SL500_.jpg',
		'1024': 'https://m.media-amazon.com/x._SL1024_.jpg'
	}
}

const q: BookSearchQuery = { title: 'Project Hail Mary', author: 'Andy Weir', region: 'us' }

describe('AudibleProvider keyword fallback', () => {
	// The structured author filter is exact-ish: "Stephen R. Lawhead" against
	// Audible's "Stephen Lawhead" returns ZERO and the audiobook edition is lost,
	// leaving the book on a PRINT record with a portrait cover.
	test('retries as a keyword search when the filtered search returns nothing', async () => {
		const urls: string[] = []
		const fetchProducts: AudibleFetch = async (url) => {
			urls.push(url)
			// first call = the strict title+author filter -> empty, as measured live
			return urls.length === 1 ? [] : [phmProduct]
		}
		const out = await new AudibleProvider({ fetchProducts }).search({
			title: 'The Spirit Well',
			author: 'Stephen R. Lawhead',
			region: 'us'
		})
		expect(urls).toHaveLength(2)
		expect(urls[0]).toContain('author=Stephen+R.+Lawhead')
		// the retry drops the filter for one fuzzy keywords query
		expect(urls[1]).toContain('keywords=The+Spirit+Well+Stephen+R.+Lawhead')
		expect(urls[1]).not.toContain('&author=')
		expect(out).toHaveLength(1)
	})

	test('does NOT retry when the filtered search already found something', async () => {
		// Purely additive: keywords ranks by relevance and buries precise matches
		// (Command Authority / Wintersteel drop out), so a working search is left alone.
		const urls: string[] = []
		const fetchProducts: AudibleFetch = async (url) => {
			urls.push(url)
			return [phmProduct]
		}
		await new AudibleProvider({ fetchProducts }).search(q)
		expect(urls).toHaveLength(1)
		expect(urls[0]).toContain('author=Andy+Weir')
	})

	test('does not retry when there is no author to fall back with', async () => {
		const urls: string[] = []
		const fetchProducts: AudibleFetch = async (url) => {
			urls.push(url)
			return []
		}
		await new AudibleProvider({ fetchProducts }).search({ title: 'Dune', region: 'us' })
		expect(urls).toHaveLength(1)
	})
})

describe('AudibleProvider', () => {
	test('maps a product to a candidate with runtime, narrator, and the largest cover', async () => {
		const p = new AudibleProvider({ fetchProducts: async () => [phmProduct] })
		const out = await p.search(q)
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({
			provider: 'audible',
			id: 'B08G9PRS1K',
			title: 'Project Hail Mary',
			authors: ['Andy Weir'],
			narrators: ['Ray Porter'],
			audioSeconds: 58200, // 970 min * 60
			cover: 'https://m.media-amazon.com/x._SL1024_.jpg'
		})
	})

	test('builds the region-specific catalog URL with title and author', async () => {
		// Record only the FIRST url: this asserts the STRUCTURED query, and an empty
		// result now triggers the keyword-fallback retry (a second, different url).
		let seenUrl = ''
		const fetchProducts: AudibleFetch = async (url) => {
			if (!seenUrl) seenUrl = url
			return []
		}
		await new AudibleProvider({ fetchProducts }).search({
			title: 'Dune',
			author: 'Frank Herbert',
			region: 'uk'
		})
		expect(seenUrl).toContain('https://api.audible.co.uk/1.0/catalog/products')
		expect(seenUrl).toContain('title=Dune')
		expect(seenUrl).toContain('author=Frank+Herbert')
		expect(seenUrl).toContain('products_sort_by=Relevance')
	})

	test('falls back to the us tld for an unknown region', async () => {
		let seenUrl = ''
		const fetchProducts: AudibleFetch = async (url) => {
			seenUrl = url
			return []
		}
		await new AudibleProvider({ fetchProducts }).search({ title: 'Dune', region: 'zz' })
		expect(seenUrl).toContain('https://api.audible.com/1.0/catalog/products')
	})

	test('skips products with no asin', async () => {
		const p = new AudibleProvider({
			fetchProducts: async () => [{ title: 'No ASIN', runtime_length_min: 60 }, phmProduct]
		})
		const out = await p.search(q)
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('B08G9PRS1K')
	})

	test('null runtime when the product has none', async () => {
		const p = new AudibleProvider({
			fetchProducts: async () => [{ asin: 'B1', title: 'X', product_images: {} }]
		})
		const out = await p.search(q)
		expect(out[0].audioSeconds).toBeNull()
		expect(out[0].cover).toBeNull()
	})

	test('returns [] for an empty title', async () => {
		const p = new AudibleProvider({ fetchProducts: async () => [phmProduct] })
		expect(await p.search({ title: '', region: 'us' })).toEqual([])
	})
})

describe('AudibleProvider fetchCandidateByAsin', () => {
	test('resolves an asin to a candidate, runtime included', async () => {
		const p = new AudibleProvider({ fetchProducts: async () => [phmProduct] })
		const out = await p.fetchCandidateByAsin!('B08G9PRS1K', { region: 'us' })
		expect(out?.asin).toBe('B08G9PRS1K')
		expect(out?.audioSeconds).toBe(970 * 60)
	})

	test('a title-less catalog stub resolves to null, not a husk', async () => {
		// Measured live on B08WF9JR2P (a dead sidecar ASIN): the catalog answers
		// `asins=` with a stub carrying an asin but NO title. Wrapped into a
		// candidate it scores on nothing, gets floor-held as an injected pin, and
		// reaches Plex as a row with an empty title -- which crashed the bundle's
		// result listing and blanked the whole search. An unusable record is a
		// MISS, so the caller can fall through to its next identifier.
		const husk = { asin: 'B08WF9JR2P' }
		const p = new AudibleProvider({ fetchProducts: async () => [husk] })
		expect(await p.fetchCandidateByAsin!('B08WF9JR2P', { region: 'us' })).toBeNull()
	})

	test('an empty-string title is a husk too', async () => {
		const husk = { asin: 'B08WF9JR2P', title: '   ' }
		const p = new AudibleProvider({ fetchProducts: async () => [husk] })
		expect(await p.fetchCandidateByAsin!('B08WF9JR2P', { region: 'us' })).toBeNull()
	})

	// A PIN must resolve even when it names a pre-order. The search guard exists to
	// stop an unpublished listing WINNING a competition it was never eligible for;
	// it must not stop the caller resolving an ASIN they named outright. Same split
	// ApiHelper.getReleaseDate documents for the fetch path.
	test('still resolves a pre-order when the caller names its ASIN', async () => {
		const preorder = {
			asin: 'B0GD8N9VDJ',
			title: 'Confessions of a Crap Artist',
			runtime_length_min: 450,
			release_date: '2099-01-01'
		}
		const p = new AudibleProvider({ fetchProducts: async () => [preorder] })
		const out = await p.fetchCandidateByAsin!('B0GD8N9VDJ', { region: 'us' })
		expect(out?.asin).toBe('B0GD8N9VDJ')
	})
})

describe('AudibleProvider pre-order exclusion', () => {
	// Prod 2026-08-14: this album sat matched to a record five weeks from release.
	// The bundle's check_if_preorder never fired because the incipit-api candidate
	// path sends no date, so the guard has to live here.
	const preorder = {
		asin: 'B0GD8N9VDJ',
		title: 'Project Hail Mary',
		runtime_length_min: 450,
		authors: [{ name: 'Andy Weir' }],
		narrators: [{ name: 'Someone Else' }],
		release_date: '2099-01-01'
	}

	test('drops a future-dated product from search results', async () => {
		const p = new AudibleProvider({ fetchProducts: async () => [preorder, phmProduct] })
		const out = await p.search(q)
		expect(out.map((c) => c.asin)).toEqual(['B08G9PRS1K'])
	})

	test('keeps a released product', async () => {
		const released = { ...preorder, release_date: '2021-05-04' }
		const p = new AudibleProvider({ fetchProducts: async () => [released] })
		const out = await p.search(q)
		expect(out.map((c) => c.asin)).toEqual(['B0GD8N9VDJ'])
	})

	test('keeps a product with no date at all — the guard fails open', async () => {
		// phmProduct carries no release_date, which is the common case; a missing
		// date must never be read as "future" or the whole catalog disappears.
		const p = new AudibleProvider({ fetchProducts: async () => [phmProduct] })
		expect(await p.search(q)).toHaveLength(1)
	})

	test('falls back to issue_date when release_date is absent', async () => {
		const noRelease = { ...preorder, release_date: undefined, issue_date: '2099-01-01' }
		const p = new AudibleProvider({ fetchProducts: async () => [noRelease] })
		expect(await p.search(q)).toEqual([])
	})

	test('does NOT trigger the keyword retry when the guard emptied the results', async () => {
		// The retry costs a request and exists for a different failure (an author
		// string Audible does not match). Filtering before the fallback check would
		// make every all-pre-order search pay for a second query it cannot use.
		const urls: string[] = []
		const fetchProducts: AudibleFetch = async (url) => {
			urls.push(url)
			return [preorder]
		}
		const out = await new AudibleProvider({ fetchProducts }).search(q)
		expect(urls).toHaveLength(1)
		expect(out).toEqual([])
	})
})

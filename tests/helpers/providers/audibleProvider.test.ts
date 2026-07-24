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

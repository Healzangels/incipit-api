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
		let seenUrl = ''
		const fetchProducts: AudibleFetch = async (url) => {
			seenUrl = url
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

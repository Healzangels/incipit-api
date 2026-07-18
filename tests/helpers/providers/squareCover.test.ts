import { describe, expect, test } from 'bun:test'

import AppleBooksProvider, { type AppleSearchFetch } from '#helpers/providers/AppleBooksProvider'
import ProviderRegistry from '#helpers/providers/ProviderRegistry'
import { bestSquareCover } from '#helpers/providers/squareCover'

// An Apple provider whose search returns the given raw iTunes results.
function appleRegistry(results: unknown[]) {
	const searchFetch: AppleSearchFetch = async () => results as never
	return new ProviderRegistry([new AppleBooksProvider({ searchFetch })])
}

const appleResult = (collectionId: number, name: string) => ({
	collectionId,
	collectionName: name,
	artistName: 'Andy Weir',
	artworkUrl100:
		'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/7b/rm_image.jpg/100x100bb.jpg'
})

describe('bestSquareCover', () => {
	test('hi-res passthrough when the matched cover is already an Apple square', async () => {
		const registry = appleRegistry([])
		const out = await bestSquareCover(registry, {
			title: 'Project Hail Mary',
			currentImage:
				'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/7b/rm_image.jpg/600x600bb.jpg',
			region: 'us'
		})
		// Bumped to 1400, no lookup needed.
		expect(out).toBe(
			'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/7b/rm_image.jpg/1400x1400bb.jpg'
		)
	})

	test('looks up Apple for a portrait cover and returns a hi-res square', async () => {
		const registry = appleRegistry([appleResult(1, 'Project Hail Mary (Unabridged)')])
		const out = await bestSquareCover(registry, {
			title: 'Project Hail Mary',
			currentImage: 'https://m.media-amazon.com/images/I/91gJiaPahBL.jpg',
			region: 'us'
		})
		expect(out).toBe(
			'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/7b/rm_image.jpg/1400x1400bb.jpg'
		)
	})

	test('picks the best title match and rejects a same-author different book', async () => {
		const registry = appleRegistry([
			appleResult(1, 'Artemis'), // same author, wrong book -> below floor
			appleResult(2, 'Project Hail Mary (Unabridged)')
		])
		const out = await bestSquareCover(registry, {
			title: 'Project Hail Mary',
			currentImage: 'https://m.media-amazon.com/images/I/91gJiaPahBL.jpg',
			region: 'us'
		})
		expect(out).toContain('1400x1400bb')

		// Only the wrong book is available -> no square cover rather than a wrong one.
		const wrongOnly = await bestSquareCover(appleRegistry([appleResult(1, 'Artemis')]), {
			title: 'Project Hail Mary',
			currentImage: 'https://m.media-amazon.com/images/I/91gJiaPahBL.jpg',
			region: 'us'
		})
		expect(wrongOnly).toBeNull()
	})

	test('rejects a same-title cover by a different author when an author is given', async () => {
		// Apple term-search can surface a same-title book by another author.
		const registry = appleRegistry([appleResult(1, 'Project Hail Mary (Unabridged)')])
		// appleResult author is "Andy Weir"; asking for a different author -> no cover.
		const wrong = await bestSquareCover(registry, {
			title: 'Project Hail Mary',
			author: 'Someone Else',
			currentImage: 'https://m.media-amazon.com/images/I/91gJiaPahBL.jpg',
			region: 'us'
		})
		expect(wrong).toBeNull()

		// Matching author -> cover returned.
		const right = await bestSquareCover(registry, {
			title: 'Project Hail Mary',
			author: 'Andy Weir',
			currentImage: 'https://m.media-amazon.com/images/I/91gJiaPahBL.jpg',
			region: 'us'
		})
		expect(right).toContain('1400x1400bb')
	})

	test('returns null when Apple is not registered or the lookup throws', async () => {
		expect(
			await bestSquareCover(new ProviderRegistry([]), { title: 'Dune', region: 'us' })
		).toBeNull()

		const throwing = new ProviderRegistry([
			new AppleBooksProvider({
				searchFetch: async () => {
					throw new Error('down')
				}
			})
		])
		expect(
			await bestSquareCover(throwing, {
				title: 'Dune',
				currentImage: 'https://m.media-amazon.com/images/I/x.jpg',
				region: 'us'
			})
		).toBeNull()
	})
})

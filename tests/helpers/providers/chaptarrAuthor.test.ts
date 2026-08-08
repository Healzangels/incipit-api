import { beforeEach, describe, expect, test } from 'bun:test'

import { chaptarrAuthorInfo, pickPhoto } from '#helpers/providers/chaptarrAuthor'

/**
 * ASIN-keyed author backstop. The photos fixture mirrors the live capture for
 * Brandon Sanderson (az:B001IGFHW6, 2026-08-08): one photo per provider with
 * hardcover marked primary.
 */

const PHOTOS = [
	{ isPrimary: true, provider: 'hardcover', url: 'https://assets.hardcover.app/x.jpg' },
	{ isPrimary: false, provider: 'goodreads', url: 'https://i.gr-assets.com/y.jpg' },
	{ isPrimary: false, provider: 'audnexus', url: 'https://m.media-amazon.com/z.jpg' }
]

describe('pickPhoto', () => {
	test('prefers goodreads over hardcover over the rest — the rungs above already cover the others', () => {
		expect(pickPhoto(PHOTOS)).toBe('https://i.gr-assets.com/y.jpg')
	})

	test('falls through tiers when a source is absent', () => {
		expect(pickPhoto(PHOTOS.filter((p) => p.provider !== 'goodreads'))).toBe(
			'https://assets.hardcover.app/x.jpg'
		)
		expect(pickPhoto([PHOTOS[2]])).toBe('https://m.media-amazon.com/z.jpg')
	})

	test("Goodreads' nophoto placeholder is SKIPPED, tiers fall through", () => {
		// The first live run served /nophoto/ silhouettes to all three
		// avatar-only authors — worse than our own avatar, and frozen as a
		// "real" photo. With a real hardcover photo present it must win.
		const withNophoto = [
			{
				isPrimary: false,
				provider: 'goodreads',
				url: 'https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/nophoto/user/u_200x266.png'
			},
			{ isPrimary: true, provider: 'hardcover', url: 'https://assets.hardcover.app/x.jpg' }
		]
		expect(pickPhoto(withNophoto)).toBe('https://assets.hardcover.app/x.jpg')
		// Only nophoto available -> null, so the caller's avatar rung runs.
		expect(pickPhoto([withNophoto[0]])).toBeNull()
	})

	test('the EXACT live Scanlon shape: string-"null" and nophoto lose to the real Amazon photo', () => {
		// Verbatim from api2.chaptarr.com/api/v5/author?id=az:B0034OO0J6 —
		// the record that shipped a literal "null" string as an author image.
		const scanlon = [
			{ isPrimary: true, provider: 'hardcover', url: 'null' },
			{
				isPrimary: false,
				provider: 'goodreads',
				url: 'https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/nophoto/user/u_700x933.png'
			},
			{
				isPrimary: false,
				provider: 'audnexus',
				url: 'https://images-na.ssl-images-amazon.com/images/S/amzn-author-media-prod/ng4nm2ho00g5qc309303log0eb.jpg'
			}
		]
		expect(pickPhoto(scanlon)).toBe(
			'https://images-na.ssl-images-amazon.com/images/S/amzn-author-media-prod/ng4nm2ho00g5qc309303log0eb.jpg'
		)
	})

	test('urlless entries and empty lists return null', () => {
		expect(pickPhoto([{ provider: 'goodreads' }])).toBeNull()
		expect(pickPhoto([])).toBeNull()
		expect(pickPhoto(undefined)).toBeNull()
	})
})

class FakeRedis {
	store = new Map<string, string>()
	writes: { key: string; ttl: number }[] = []
	async get(key: string) {
		return this.store.get(key) ?? null
	}
	async set(key: string, value: string, _mode: 'EX', ttl: number) {
		this.store.set(key, value)
		this.writes.push({ key, ttl })
	}
}

describe('chaptarrAuthorInfo', () => {
	let redis: FakeRedis
	beforeEach(() => {
		redis = new FakeRedis()
	})

	const RESPONSE = { author: { name: 'X', bio: 'A bio.', photos: PHOTOS } }

	test('a MISS fetches, returns goodreads photo + bio, caches 24h', async () => {
		const calls: string[] = []
		const out = await chaptarrAuthorInfo('B001IGFHW6', redis, undefined, {
			authorFetch: async (asin) => {
				calls.push(asin)
				return RESPONSE
			}
		})
		expect(out).toEqual({ image: 'https://i.gr-assets.com/y.jpg', bio: 'A bio.' })
		expect(calls).toEqual(['B001IGFHW6'])
		expect(redis.writes).toEqual([expect.objectContaining({ ttl: 86400 })])
	})

	test('an EMPTY answer caches only 1h — an author may gain a photo', async () => {
		await chaptarrAuthorInfo('B0NOPHOTO0', redis, undefined, {
			authorFetch: async () => ({ author: { name: 'X', bio: '', photos: [] } })
		})
		expect(redis.writes).toEqual([expect.objectContaining({ ttl: 3600 })])
	})

	test('the cache answers without a second fetch', async () => {
		const calls: string[] = []
		const seam = {
			authorFetch: async (asin: string) => {
				calls.push(asin)
				return RESPONSE
			}
		}
		await chaptarrAuthorInfo('B001IGFHW6', redis, undefined, seam)
		const again = await chaptarrAuthorInfo('B001IGFHW6', redis, undefined, seam)
		expect(again.image).toBe('https://i.gr-assets.com/y.jpg')
		expect(calls.length).toBe(1)
	})

	test('an upstream failure returns empty and is NOT cached', async () => {
		const out = await chaptarrAuthorInfo('B001IGFHW6', redis, undefined, {
			authorFetch: async () => {
				throw new Error('down')
			}
		})
		expect(out).toEqual({ image: null, bio: null })
		expect(redis.writes.length).toBe(0)
	})

	test('no asin means no work', async () => {
		const calls: string[] = []
		const out = await chaptarrAuthorInfo('', redis, undefined, {
			authorFetch: async (asin) => {
				calls.push(asin)
				return RESPONSE
			}
		})
		expect(out).toEqual({ image: null, bio: null })
		expect(calls).toEqual([])
	})
})

import { describe, expect, test } from 'bun:test'

import ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import type { BookSearchQuery, ProviderCandidate } from '#helpers/providers/types'

// Minimal in-memory Redis double exposing the get/set/expire surface the cache
// uses. `fail` flips any operation to throw, to exercise graceful degradation.
function fakeRedis(fail = false) {
	const store = new Map<string, string>()
	const expires = new Map<string, number>()
	return {
		store,
		expires,
		async get(k: string) {
			if (fail) throw new Error('redis down')
			return store.get(k) ?? null
		},
		async set(k: string, v: string, mode?: string, ttl?: number) {
			if (fail) throw new Error('redis down')
			store.set(k, v)
			// Atomic SET+EX form records its TTL just like a separate expire would.
			if (mode === 'EX' && ttl != null) expires.set(k, ttl)
			return 'OK'
		},
		async expire(k: string, ttl: number) {
			if (fail) throw new Error('redis down')
			expires.set(k, ttl)
			return 1
		}
	}
}

const query: BookSearchQuery = { title: 'Project Hail Mary', author: 'Andy Weir', region: 'us' }
const candidates: ProviderCandidate[] = [
	{
		provider: 'hardcover',
		id: 'B08GB58KD5',
		asin: 'B08GB58KD5',
		title: 'Project Hail Mary',
		authors: ['Andy Weir'],
		narrators: ['Ray Porter'],
		audioSeconds: 58200,
		cover: 'c.jpg'
	}
]

describe('ProviderSearchCache', () => {
	test('caches a miss then serves the hit without re-fetching', async () => {
		const cache = new ProviderSearchCache(fakeRedis() as never)
		let calls = 0
		const fetch = async () => {
			calls++
			return candidates
		}
		const first = await cache.wrap('hardcover', query, fetch)
		const second = await cache.wrap('hardcover', query, fetch)
		expect(first).toEqual(candidates)
		expect(second).toEqual(candidates)
		expect(calls).toBe(1) // second served from cache
	})

	test('never caches an empty result (credential-gated no-token miss)', async () => {
		const redis = fakeRedis()
		const cache = new ProviderSearchCache(redis as never)
		let calls = 0
		const emptyFetch = async () => {
			calls++
			return [] as ProviderCandidate[]
		}
		await cache.wrap('hardcover', query, emptyFetch)
		await cache.wrap('hardcover', query, emptyFetch)
		expect(redis.store.size).toBe(0) // nothing cached
		expect(calls).toBe(2) // re-fetched, not served a poisoned []
	})

	test('sets a TTL on write', async () => {
		const redis = fakeRedis()
		const cache = new ProviderSearchCache(redis as never, 1234)
		await cache.wrap('hardcover', query, async () => candidates)
		expect([...redis.expires.values()][0]).toBe(1234)
	})

	test('keys separately by provider, region, title, and author', async () => {
		const redis = fakeRedis()
		const cache = new ProviderSearchCache(redis as never)
		const noop = async () => candidates
		await cache.wrap('hardcover', query, noop)
		await cache.wrap('audible', query, noop) // different provider
		await cache.wrap('hardcover', { ...query, region: 'uk' }, noop) // different region
		await cache.wrap('hardcover', { ...query, author: 'Someone' }, noop) // different author
		expect(redis.store.size).toBe(4)
	})

	test('no redis -> always calls through, never caches', async () => {
		const cache = new ProviderSearchCache(null)
		let calls = 0
		const fetch = async () => {
			calls++
			return candidates
		}
		await cache.wrap('hardcover', query, fetch)
		await cache.wrap('hardcover', query, fetch)
		expect(calls).toBe(2)
	})

	test('a redis failure degrades to a live fetch, never throws', async () => {
		const cache = new ProviderSearchCache(fakeRedis(true) as never)
		let calls = 0
		const result = await cache.wrap('hardcover', query, async () => {
			calls++
			return candidates
		})
		expect(result).toEqual(candidates)
		expect(calls).toBe(1)
	})

	test('a throwing fetch is not cached (error propagates)', async () => {
		const redis = fakeRedis()
		const cache = new ProviderSearchCache(redis as never)
		await expect(
			cache.wrap('hardcover', query, async () => {
				throw new Error('provider down')
			})
		).rejects.toThrow('provider down')
		expect(redis.store.size).toBe(0)
	})
})

describe('ProviderSearchCache bypass (?refresh=1)', () => {
	const query: BookSearchQuery = { title: 'Project Hail Mary', author: 'Andy Weir', region: 'us' }
	const hit: ProviderCandidate[] = [
		{
			provider: 'audible',
			id: 'B08G9PRS1K',
			asin: 'B08G9PRS1K',
			title: 'Project Hail Mary',
			authors: ['Andy Weir'],
			narrators: ['Ray Porter'],
			audioSeconds: 58200,
			cover: null,
			language: 'en'
		}
	]

	test('bypass skips the cached READ and refetches live', async () => {
		// The poisoned-entry escape hatch: a bad cached record would otherwise be
		// replayed on every re-match for the whole TTL.
		const redis = fakeRedis()
		const warm = new ProviderSearchCache(redis as never, 600)
		await warm.wrap('audible', query, async () => hit)
		expect(redis.store.size).toBe(1)

		let called = 0
		const bypass = new ProviderSearchCache(redis as never, 600, undefined, true)
		await bypass.wrap('audible', query, async () => {
			called += 1
			return hit
		})
		expect(called).toBe(1)
	})

	test('bypass still WRITES, so one forced pass repairs the entry for everyone', async () => {
		const redis = fakeRedis()
		const bypass = new ProviderSearchCache(redis as never, 600, undefined, true)
		await bypass.wrap('audible', query, async () => hit)
		expect(redis.store.size).toBe(1)
		expect([...redis.expires.values()][0]).toBe(600)

		// A normal (non-bypass) cache now serves the repaired entry without fetching.
		let called = 0
		const normal = new ProviderSearchCache(redis as never, 600)
		const out = await normal.wrap('audible', query, async () => {
			called += 1
			return []
		})
		expect(called).toBe(0)
		expect(out).toEqual(hit)
	})

	test('without bypass the cached value is served (guards the default)', async () => {
		const redis = fakeRedis()
		const cache = new ProviderSearchCache(redis as never, 600)
		await cache.wrap('audible', query, async () => hit)
		let called = 0
		await cache.wrap('audible', query, async () => {
			called += 1
			return []
		})
		expect(called).toBe(0)
	})
})

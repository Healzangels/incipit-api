import { describe, expect, test } from 'bun:test'

import ProviderRegistry from '#helpers/providers/ProviderRegistry'
import ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import type { BookProvider, BookSearchQuery, ProviderCandidate } from '#helpers/providers/types'

/**
 * A provider's cacheVersion keys its search-cache entries.
 *
 * Prod runs Redis with a 7-day TTL. When chaptarr rows started carrying
 * asinAliases (spec-regional-pin-sibling), a cached row from before the deploy
 * had none, and the regional-pin promotion that reads them would have stayed
 * off for a week. Keying by name + version retires exactly that provider's old
 * entries at deploy, and leaves every other provider's warm cache alone.
 */

const QUERY: BookSearchQuery = { title: 'Ninth House', author: 'Leigh Bardugo', region: 'us' }

const row = (id: string): ProviderCandidate => ({
	provider: 'chaptarr',
	id,
	asin: id,
	title: 'Ninth House',
	authors: ['Leigh Bardugo'],
	narrators: [],
	audioSeconds: 58920,
	cover: null,
	language: null
})

function fakeRedis() {
	const store = new Map<string, string>()
	return {
		store,
		async get(k: string) {
			return store.get(k) ?? null
		},
		async set(k: string, v: string) {
			store.set(k, v)
			return 'OK'
		}
	}
}

function counting(name: string, cacheVersion?: number) {
	const state = { calls: 0 }
	const provider: BookProvider = {
		name,
		...(cacheVersion ? { cacheVersion } : {}),
		search: async () => {
			state.calls += 1
			return [row('LIVE')]
		}
	}
	return { state, provider }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('provider search-cache versioning', () => {
	test('a versioned provider is not served its unversioned (old-shape) entry', async () => {
		const redis = fakeRedis()
		const cache = new ProviderSearchCache(redis as never)
		// What the deployed code wrote: the unversioned key, a row with no aliases.
		await cache.set('chaptarr', QUERY, [row('STALE')])
		const { state, provider } = counting('chaptarr', 2)
		const out = await new ProviderRegistry([provider]).searchAll(QUERY, undefined, cache)
		expect(state.calls).toBe(1)
		expect(out.map((c) => c.id)).toEqual(['LIVE'])
	})

	test('...and its own entry lands under the versioned key and is served next time', async () => {
		const redis = fakeRedis()
		const cache = new ProviderSearchCache(redis as never)
		const { state, provider } = counting('chaptarr', 2)
		const registry = new ProviderRegistry([provider])
		await registry.searchAll(QUERY, undefined, cache)
		await settle()
		expect([...redis.store.keys()].some((k) => k.includes(':chaptarr.v2:'))).toBe(true)
		await registry.searchAll(QUERY, undefined, cache)
		expect(state.calls).toBe(1)
	})

	test('an unversioned provider keeps its key, so its warm entries still serve', async () => {
		const redis = fakeRedis()
		const cache = new ProviderSearchCache(redis as never)
		await cache.set('audible', QUERY, [row('WARM')])
		const { state, provider } = counting('audible')
		const out = await new ProviderRegistry([provider]).searchAll(QUERY, undefined, cache)
		expect(state.calls).toBe(0)
		expect(out.map((c) => c.id)).toEqual(['WARM'])
	})
})

import { describe, expect, test } from 'bun:test'

import {
	alternateCoverKey,
	recallAlternates,
	rememberAlternates
} from '#helpers/providers/alternateCoverCache'

/**
 * ALTERNATE COVERS HAVE TO SURVIVE THE TRIP FROM SEARCH TO ITEM LOOKUP.
 *
 * dedupe builds `coverAlternates` from the editions it MERGED, so they exist
 * only where the whole candidate set is visible — on the SEARCH response. The
 * bundle then reads `/books/:asin` for posters, and that route never runs
 * dedupe.
 *
 * v1.3.183 bridged this with a module-level memo inside the plugin, and that
 * was WRONG in a way only the live path revealed: the memo fills when a SEARCH
 * runs, and a plain "Refresh Metadata" never searches — Plex calls update()
 * alone on an already-matched item. So alternates could appear on a fresh match
 * and never on a refresh, which is the path Plex uses most.
 *
 * Caching server-side fixes the trigger properly: the item endpoint can answer
 * whenever it is asked, with no cross-call state, no dependence on a search
 * having happened, and no plugin-process lifetime involved.
 */
describe('alternateCoverKey', () => {
	test('namespaces the key so it cannot collide with other caches', () => {
		expect(alternateCoverKey('B073H9PF2D')).toMatch(/^incipit:altcover:/)
	})

	test('carries a RULE VERSION, so loosening the rule retires stale answers', () => {
		// A cached EMPTY answer means "looked, found none" and suppresses
		// recomputation for the whole TTL -- so when the rule that produced it
		// changes, those entries pin books to the old verdict for 30 days. The
		// version segment is what retires them without touching redis by hand.
		// Asserting the SHAPE, not the current number: pinning 'v2' would just
		// mirror the constant and rewrite itself on the next bump.
		expect(alternateCoverKey('B073H9PF2D')).toMatch(/^incipit:altcover:v\d+:B073H9PF2D$/)
	})

	test('normalises case, because Plex ids arrive both ways', () => {
		expect(alternateCoverKey('b073h9pf2d')).toBe(alternateCoverKey('B073H9PF2D'))
	})

	test('strips the region suffix the bundle appends', () => {
		// Search emits the bare id; the bundle's metadata.id is "<id>_<region>".
		// Without this the cache would never hit on the path it exists for.
		expect(alternateCoverKey('B073H9PF2D_us')).toBe(alternateCoverKey('B073H9PF2D'))
	})
})

/** Minimal redis double: only what the cache actually calls. */
function fakeRedis() {
	const store = new Map<string, string>()
	return {
		store,
		calls: { set: 0, get: 0 },
		// The real call passes ('EX', ttl) after the value; the double accepts and
		// ignores them, but must still ACCEPT them or the cache's own call shape
		// would not typecheck against this stub.
		async set(k: string, v: string, ...rest: unknown[]) {
			this.calls.set += 1
			this.lastArgs = rest
			store.set(k, v)
			return 'OK'
		},
		lastArgs: [] as unknown[],
		async get(k: string) {
			this.calls.get += 1
			return store.get(k) ?? null
		}
	}
}

describe('rememberAlternates / recallAlternates', () => {
	test('round-trips a list', async () => {
		const redis = fakeRedis()
		await rememberAlternates(redis as never, 'B073H9PF2D', ['a.jpg', 'b.jpg'])
		expect(await recallAlternates(redis as never, 'B073H9PF2D')).toEqual(['a.jpg', 'b.jpg'])
	})

	test('writes with an EXPIRY — an immortal cache entry outlives the art', async () => {
		const redis = fakeRedis()
		await rememberAlternates(redis as never, 'B073H9PF2D', ['a.jpg'])
		expect(redis.lastArgs[0]).toBe('EX')
		expect(typeof redis.lastArgs[1]).toBe('number')
	})

	test('recalls under the region-suffixed id the bundle sends', async () => {
		const redis = fakeRedis()
		await rememberAlternates(redis as never, 'B073H9PF2D', ['a.jpg'])
		expect(await recallAlternates(redis as never, 'B073H9PF2D_us')).toEqual(['a.jpg'])
	})

	test('"HAS NONE" and "NEVER ASKED" are different answers', async () => {
		// The whole reason the item route can compute on a miss without re-running
		// a provider search for every alternate-less book on every refresh. Both
		// directions asserted together, because a cache that collapses them looks
		// correct from either side alone.
		const redis = fakeRedis()
		await rememberAlternates(redis as never, 'B0NONE0001', [])
		expect(await recallAlternates(redis as never, 'B0NONE0001')).toEqual([])
		expect(await recallAlternates(redis as never, 'B0NEVER0001')).toBeNull()
	})

	test('an EMPTY list IS written — it records that we LOOKED', async () => {
		const redis = fakeRedis()
		await rememberAlternates(redis as never, 'B0NONE0001', [])
		expect(redis.calls.set).toBe(1)
	})

	test('an UNDEFINED list is not written — that is absence of a result', async () => {
		// `coverAlternates` is optional on a candidate. Undefined means the caller
		// had nothing to say, which is not the same claim as "I looked and found
		// none" — only the latter earns a negative entry.
		const redis = fakeRedis()
		await rememberAlternates(redis as never, 'B0NONE0002', undefined)
		expect(redis.calls.set).toBe(0)
		expect(await recallAlternates(redis as never, 'B0NONE0002')).toBeNull()
	})

	test('a miss recalls NULL', async () => {
		expect(await recallAlternates(fakeRedis() as never, 'B0UNKNOWN1')).toBeNull()
	})

	test('no redis is a silent no-op in both directions', async () => {
		await rememberAlternates(null, 'B073H9PF2D', ['a.jpg'])
		expect(await recallAlternates(null, 'B073H9PF2D')).toBeNull()
	})

	test('a redis failure reports UNKNOWN, never throws — this is spare art', async () => {
		// Null rather than [] on purpose: a broken cache has told us nothing, and
		// reporting "has none" would suppress the compute that could still succeed.
		const broken = {
			async set() {
				throw new Error('redis down')
			},
			async get() {
				throw new Error('redis down')
			}
		}
		await rememberAlternates(broken as never, 'B073H9PF2D', ['a.jpg'])
		expect(await recallAlternates(broken as never, 'B073H9PF2D')).toBeNull()
	})

	test('corrupt cached JSON recalls UNKNOWN rather than throwing', async () => {
		const redis = fakeRedis()
		redis.store.set(alternateCoverKey('B073H9PF2D'), '{not json')
		expect(await recallAlternates(redis as never, 'B073H9PF2D')).toBeNull()
	})

	test('a cached NON-array recalls UNKNOWN', async () => {
		const redis = fakeRedis()
		redis.store.set(alternateCoverKey('B073H9PF2D'), '"a.jpg"')
		expect(await recallAlternates(redis as never, 'B073H9PF2D')).toBeNull()
	})
})

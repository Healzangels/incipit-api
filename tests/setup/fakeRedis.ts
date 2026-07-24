/**
 * In-memory Redis double exposing the get/set/expire surface our caches use.
 *
 * Models the REAL call shape: `set(key, value, 'EX', ttl)`. That matters --
 * hand-rolled two-argument fakes were silently swallowing the `'EX', ttl` pair,
 * so a cache that forgot its TTL (writing entries that never expire) would still
 * have passed. `expires` records what was actually requested so a test can assert
 * the TTL rather than just the value.
 *
 * `fail` flips every operation to throw, for exercising graceful degradation --
 * a cache is optional infrastructure and a Redis outage must never fail the
 * request that used it.
 * @param {boolean} fail when true, every operation rejects
 * @returns the double, plus the `store` and `expires` maps for assertions
 */
export function fakeRedis(fail = false) {
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

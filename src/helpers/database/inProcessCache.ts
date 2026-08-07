/**
 * PHASE 1 OF THE SINGLE-CONTAINER MIGRATION: the in-process cache that
 * replaces the Redis container.
 *
 * Registered as the `fastify.redis` decorator when REDIS_URL is unset, with
 * exactly the surface the four consumers use (plan §7.3): `get`,
 * `set(k, v, 'EX', ttl)`, `del`, `expire`, `ping`. The truthiness of the
 * decorator is itself load-bearing — books/show.ts gates the alternate-cover
 * compute on it — so a redis-less deployment now gets full caching where it
 * previously went without.
 *
 * PARTITIONED BY NAMESPACE, deliberately (§7.3). One shared LRU would evict
 * the tiny long-lived NEGATIVE entries first — `incipit:altcover:` stores []
 * for "asked, found none" precisely so a book with no alternates does not
 * re-run a provider fan-out on every refresh, and the goodreads namespaces
 * cache short-TTL misses for the same reason — under exactly the workload
 * (a scan filling the record cache) that creates them. Each namespace gets
 * its own byte + entry bound, sized from measured data (§6: full records are
 * 5–15 KB × ~1,600 books; altcover/goodreads entries are tens of bytes).
 *
 * LRU is Map insertion order: reads re-insert. TTL is lazy — an expired
 * entry is deleted on read — plus eviction keeps totals bounded, so no
 * sweeper timer exists to leak. Restart loses the cache by design; the cost
 * is one cold scan (the mongo record store, which holds the expensive data,
 * is unaffected).
 */

interface Entry {
	value: string
	expiresAt: number
	bytes: number
}

interface Partition {
	name: string
	prefixes: string[]
	maxBytes: number
	maxEntries: number
	map: Map<string, Entry>
	bytes: number
}

const mkPartition = (name: string, prefixes: string[], maxBytes: number, maxEntries: number) => ({
	name,
	prefixes,
	maxBytes,
	maxEntries,
	map: new Map<string, Entry>(),
	bytes: 0
})

export class InProcessCache {
	private partitions: Partition[]
	private fallback: Partition

	constructor() {
		this.partitions = [
			// Provider search candidate sets: positives only by design, 7-day.
			mkPartition('psearch', ['incipit:psearch:'], 48 * 1024 * 1024, 4000),
			// Alternate covers, INCLUDING the [] negatives. Small and precious.
			mkPartition('altcover', ['incipit:altcover:'], 8 * 1024 * 1024, 20000),
			// Goodreads series + author lookups, including short-TTL misses.
			mkPartition('goodreads', ['grseries:', 'grauthor:'], 8 * 1024 * 1024, 20000)
		]
		// Everything else — chiefly the full serialized records the show routes
		// read before the DB (`${region}-${type}-${asin}`), the largest set.
		this.fallback = mkPartition('records', [], 64 * 1024 * 1024, 6000)
	}

	private partitionFor(key: string): Partition {
		for (const p of this.partitions) {
			if (p.prefixes.some((pre) => key.startsWith(pre))) return p
		}
		return this.fallback
	}

	private evictIfNeeded(p: Partition) {
		while (p.map.size > p.maxEntries || p.bytes > p.maxBytes) {
			const oldest = p.map.keys().next()
			if (oldest.done) break
			const e = p.map.get(oldest.value)
			p.map.delete(oldest.value)
			p.bytes -= e?.bytes ?? 0
		}
	}

	async get(key: string): Promise<string | null> {
		const p = this.partitionFor(key)
		const e = p.map.get(key)
		if (!e) return null
		if (Date.now() >= e.expiresAt) {
			p.map.delete(key)
			p.bytes -= e.bytes
			return null
		}
		// LRU touch: re-insert at the back.
		p.map.delete(key)
		p.map.set(key, e)
		return e.value
	}

	/** ioredis 4-arg form only: SET key value EX seconds. */
	async set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<'OK'> {
		const p = this.partitionFor(key)
		const old = p.map.get(key)
		if (old) p.bytes -= old.bytes
		const ttl =
			mode === 'EX' && typeof ttlSeconds === 'number' && ttlSeconds > 0
				? ttlSeconds * 1000
				: // No TTL stated: bound it anyway. An unbounded entry in a process
					// cache is a leak with a delay; 7 days matches the longest
					// consumer TTL in use.
					7 * 24 * 3600 * 1000
		const bytes = key.length + value.length
		p.map.set(key, { value, expiresAt: Date.now() + ttl, bytes })
		p.bytes += bytes
		this.evictIfNeeded(p)
		return 'OK'
	}

	async del(key: string): Promise<number> {
		const p = this.partitionFor(key)
		const e = p.map.get(key)
		if (!e) return 0
		p.map.delete(key)
		p.bytes -= e.bytes
		return 1
	}

	async expire(key: string, ttlSeconds: number): Promise<number> {
		const p = this.partitionFor(key)
		const e = p.map.get(key)
		if (!e) return 0
		e.expiresAt = Date.now() + ttlSeconds * 1000
		return 1
	}

	async ping(): Promise<'PONG'> {
		return 'PONG'
	}

	/** Introspection for tests and /metrics. */
	stats() {
		const all = [...this.partitions, this.fallback]
		return Object.fromEntries(all.map((p) => [p.name, { entries: p.map.size, bytes: p.bytes }]))
	}
}

/**
 * MODULE-LEVEL SINGLETON — not per-request. ProviderSearchCache is constructed
 * per request around whatever `fastify.redis` holds; per-instance state here
 * would hand every request an empty cache (§7.3).
 */
export const memoryCache = new InProcessCache()

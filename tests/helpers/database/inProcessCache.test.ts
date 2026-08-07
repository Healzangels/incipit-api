/**
 * The in-process cache replacing the Redis container (Phase 1).
 *
 * Every assertion pins a silent failure mode from the plan reviews (§7.3):
 * a shim missing part of the five-method contract disables alternate covers
 * and 503s /health without a single error; a shared LRU evicts the tiny
 * negative altcover entries under record pressure and re-opens the
 * provider-fan-out-per-refresh hole the cache exists to close.
 */
import { describe, expect, test } from 'bun:test'

import { InProcessCache } from '#helpers/database/inProcessCache'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('InProcessCache', () => {
	test('the five-method ioredis contract: set/get/del/expire/ping', async () => {
		const c = new InProcessCache()
		expect(await c.ping()).toBe('PONG')
		expect(await c.get('us-book-B000000000')).toBeNull()
		expect(await c.set('us-book-B000000000', '{"a":1}', 'EX', 60)).toBe('OK')
		expect(await c.get('us-book-B000000000')).toBe('{"a":1}')
		expect(await c.expire('us-book-B000000000', 120)).toBe(1)
		expect(await c.expire('missing', 120)).toBe(0)
		expect(await c.del('us-book-B000000000')).toBe(1)
		expect(await c.del('us-book-B000000000')).toBe(0)
		expect(await c.get('us-book-B000000000')).toBeNull()
	})

	test('EX ttl actually expires', async () => {
		const c = new InProcessCache()
		await c.set('grseries:v5:x', 'answer', 'EX', 0.05 as never as number)
		expect(await c.get('grseries:v5:x')).toBe('answer')
		await sleep(80)
		expect(await c.get('grseries:v5:x')).toBeNull()
	})

	test('an empty-string value round-trips (the altcover "[]" negative is close kin)', async () => {
		const c = new InProcessCache()
		await c.set('incipit:altcover:B0X', '[]', 'EX', 60)
		// "[]" is a real answer, not a miss — get must return it, not null.
		expect(await c.get('incipit:altcover:B0X')).toBe('[]')
	})

	test('PARTITION ISOLATION: record pressure cannot evict altcover negatives', async () => {
		const c = new InProcessCache()
		for (let i = 0; i < 50; i++) await c.set(`incipit:altcover:B${i}`, '[]', 'EX', 3600)
		// Blast the records partition far past its entry cap.
		const fat = 'x'.repeat(20000)
		for (let i = 0; i < 6500; i++) await c.set(`us-book-B${i}`, fat, 'EX', 3600)
		const stats = c.stats() as Record<string, { entries: number; bytes: number }>
		// Records got evicted down to its own bounds...
		expect(stats.records.entries).toBeLessThanOrEqual(6000)
		expect(stats.records.bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
		// ...and every altcover negative survived untouched.
		expect(stats.altcover.entries).toBe(50)
		for (const i of [0, 25, 49]) expect(await c.get(`incipit:altcover:B${i}`)).toBe('[]')
	})

	test('LRU: a recently-read entry outlives an unread one under eviction', async () => {
		const c = new InProcessCache()
		const fat = 'y'.repeat(20000)
		await c.set('us-book-FIRST', fat, 'EX', 3600)
		await c.set('us-book-SECOND', fat, 'EX', 3600)
		// Touch FIRST so SECOND becomes the eviction candidate.
		await c.get('us-book-FIRST')
		for (let i = 0; i < 6000; i++) await c.set(`us-book-B${i}`, fat, 'EX', 3600)
		expect(await c.get('us-book-SECOND')).toBeNull()
	})

	test('overwrite replaces bytes, not accumulates them', async () => {
		const c = new InProcessCache()
		await c.set('us-book-B1', 'x'.repeat(1000), 'EX', 60)
		await c.set('us-book-B1', 'y', 'EX', 60)
		const stats = c.stats() as Record<string, { bytes: number }>
		expect(stats.records.bytes).toBeLessThan(200)
		expect(await c.get('us-book-B1')).toBe('y')
	})
})

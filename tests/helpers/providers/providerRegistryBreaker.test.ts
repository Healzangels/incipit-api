import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'

import { resetPerformanceConfig } from '#config/performance'
import ProviderRegistry from '#helpers/providers/ProviderRegistry'
import ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import type { BookProvider, BookSearchQuery, ProviderCandidate } from '#helpers/providers/types'

/**
 * THE BREAKER MUST ACTUALLY RATION UPSTREAM CALLS.
 *
 * `AppleBooksProvider` propagating a transport failure is only half the claim —
 * the half its own test file already pins. What nothing verified is the other
 * half: that a rejecting provider driven through `ProviderRegistry` opens the
 * circuit, and that an open circuit then costs zero requests. Two measured
 * defects lived in exactly that gap:
 *
 *   1. `bestSquareCover` did `registry.get('apple')` and called `apple.search()`
 *      itself, so it bypassed the breaker in BOTH directions. Measured: 10
 *      failing square-cover lookups left the breaker CLOSED, and with the
 *      circuit OPEN `searchAll` issued 0 calls while `bestSquareCover` still
 *      issued 1 — on every `GET /books/:asin` response.
 *   2. The breaker wrapped the CACHE, so an OPEN circuit threw away a free Redis
 *      hit, and in HALF_OPEN two cache hits "recovered" the circuit without one
 *      upstream probe.
 */

const QUERY: BookSearchQuery = { title: 'Project Hail Mary', author: 'Andy Weir', region: 'us' }
const OTHER: BookSearchQuery = { title: 'Artemis', author: 'Andy Weir', region: 'us' }

const candidate = (id: string): ProviderCandidate => ({
	provider: 'apple',
	id,
	asin: null,
	title: 'Project Hail Mary',
	authors: ['Andy Weir'],
	narrators: [],
	audioSeconds: null,
	cover: 'c.jpg',
	language: null
})

/** A provider that counts upstream calls and can be flipped between outcomes. */
function countingProvider(name = 'apple') {
	const state = { calls: 0, fail: true }
	const provider: BookProvider = {
		name,
		search: async () => {
			state.calls += 1
			if (state.fail) throw new Error('429 Too Many Requests')
			return [candidate('live')]
		}
	}
	return { state, provider }
}

/** Minimal Redis double: the get/set surface ProviderSearchCache uses. */
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

// The registry's breakers use the defaults: 5 failures to open, 60s to
// half-open, 2 successes to close.
const FAILURE_THRESHOLD = 5

describe('ProviderRegistry circuit breaker', () => {
	beforeEach(() => {
		resetPerformanceConfig()
		setSystemTime()
	})
	afterEach(() => {
		setSystemTime()
	})

	test('searchAll: a rejecting provider opens the circuit and then costs no requests', async () => {
		const { state, provider } = countingProvider()
		const registry = new ProviderRegistry([provider])

		for (let i = 0; i < FAILURE_THRESHOLD; i++) {
			expect(await registry.searchAll(QUERY)).toEqual([])
		}
		expect(state.calls).toBe(FAILURE_THRESHOLD)

		// Circuit is open: the next search must not reach the provider at all.
		expect(await registry.searchAll(QUERY)).toEqual([])
		expect(state.calls).toBe(FAILURE_THRESHOLD)
	})

	test('searchOne: its failures open the SAME breaker, and an open circuit stops it', async () => {
		const { state, provider } = countingProvider()
		const registry = new ProviderRegistry([provider])

		for (let i = 0; i < FAILURE_THRESHOLD; i++) {
			await expect(registry.searchOne('apple', QUERY)).rejects.toThrow(/429/)
		}
		expect(state.calls).toBe(FAILURE_THRESHOLD)

		// The failures were recorded on Apple's breaker, so the fan-out is now
		// skipping it too — a direct caller and the fan-out share one circuit.
		expect(await registry.searchAll(QUERY)).toEqual([])
		expect(state.calls).toBe(FAILURE_THRESHOLD)

		// ...and the direct caller is refused without a request.
		await expect(registry.searchOne('apple', QUERY)).rejects.toThrow(/Circuit breaker is OPEN/)
		expect(state.calls).toBe(FAILURE_THRESHOLD)
	})

	test('searchOne returns [] for a provider that is not registered', async () => {
		const registry = new ProviderRegistry([])
		expect(await registry.searchOne('apple', QUERY)).toEqual([])
	})

	test('an OPEN circuit still serves an already-cached result', async () => {
		// The entry is paid for and costs the provider nothing; refusing to read it
		// is pure loss. Warm the cache, then open the circuit on a DIFFERENT query.
		const { state, provider } = countingProvider()
		const registry = new ProviderRegistry([provider])
		const cache = new ProviderSearchCache(fakeRedis() as never)

		state.fail = false
		expect(await registry.searchAll(QUERY, undefined, cache)).toHaveLength(1)
		state.fail = true
		for (let i = 0; i < FAILURE_THRESHOLD; i++) {
			expect(await registry.searchAll(OTHER, undefined, cache)).toEqual([])
		}
		const callsWhenOpen = state.calls

		// Open circuit, warm key: served from cache, no request.
		const served = await registry.searchAll(QUERY, undefined, cache)
		expect(served).toHaveLength(1)
		expect(state.calls).toBe(callsWhenOpen)

		// Same for the direct single-provider path.
		expect(await registry.searchOne('apple', QUERY, undefined, cache)).toHaveLength(1)
		expect(state.calls).toBe(callsWhenOpen)
	})

	test('cache hits in HALF_OPEN do not close the circuit — only a real probe can', async () => {
		const { state, provider } = countingProvider()
		const registry = new ProviderRegistry([provider])
		const cache = new ProviderSearchCache(fakeRedis() as never)

		// Warm one key, then open the circuit with failures on another.
		state.fail = false
		await registry.searchAll(QUERY, undefined, cache)
		state.fail = true
		for (let i = 0; i < FAILURE_THRESHOLD; i++) await registry.searchAll(OTHER, undefined, cache)

		// Past the 60s reset window: the breaker is HALF_OPEN and owes upstream two
		// successful probes before it may close.
		setSystemTime(new Date(Date.now() + 61_000))

		// Two cache hits — successThreshold is 2, so under the old ordering these
		// alone closed the circuit.
		await registry.searchAll(QUERY, undefined, cache)
		await registry.searchAll(QUERY, undefined, cache)

		// The one real probe still fails, which must send a HALF_OPEN circuit
		// straight back to OPEN. Had the cache hits closed it, this would merely be
		// failure 1 of 5 in CLOSED and the next call would hit the provider again.
		const before = state.calls
		await registry.searchAll(OTHER, undefined, cache)
		expect(state.calls).toBe(before + 1)

		await registry.searchAll(OTHER, undefined, cache)
		expect(state.calls).toBe(before + 1)
	})
})

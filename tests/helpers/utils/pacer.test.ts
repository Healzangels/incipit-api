import { describe, expect, test } from 'bun:test'

import { createPacer } from '#helpers/utils/pacer'

/**
 * Self-pacing for a provider that pushes back. Written against an INJECTED
 * clock, not real time: a test that actually sleeps 1.1s per call would be too
 * slow to keep, and a test that shortens the gap to keep itself fast stops
 * exercising the arithmetic that matters.
 *
 * Measured motivation (Hardcover, 2026-08-12): 142 of 349 calls 429'd during a
 * library sweep, the breaker opened and skipped 3,028 more, and every book
 * served in those windows came back with no genres — indistinguishable from a
 * book that has none.
 */
const harness = (gap = 1000, cooldown = 60_000, onPushBack?: 'wait' | 'shed') => {
	let clock = 1_000_000
	const waits: number[] = []
	const pacer = createPacer({
		minGapMs: () => gap,
		cooldownMs: () => cooldown,
		onPushBack,
		now: () => clock,
		// Advance the fake clock instead of sleeping, so the pacer's own
		// re-read-the-clock logic is exercised exactly as in production.
		wait: async (ms) => {
			waits.push(ms)
			clock += ms
		}
	})
	return { pacer, waits, advance: (ms: number) => (clock += ms), at: () => clock }
}

describe('createPacer', () => {
	test('the first call goes straight through', async () => {
		const h = harness()
		await h.pacer.take()
		expect(h.waits).toEqual([])
	})

	test('a second call waits the full gap', async () => {
		const h = harness(1000)
		await h.pacer.take()
		await h.pacer.take()
		expect(h.waits).toEqual([1000])
	})

	test('CONCURRENT callers queue instead of bursting', async () => {
		// The failure this exists to prevent: without a serialized chain, N
		// callers all read the same nextAllowedAt and fire together — which is
		// precisely the burst that earns a 429.
		const h = harness(1000)
		await Promise.all([h.pacer.take(), h.pacer.take(), h.pacer.take(), h.pacer.take()])
		expect(h.waits).toEqual([1000, 1000, 1000])
	})

	test('time already elapsed counts toward the gap', async () => {
		const h = harness(1000)
		await h.pacer.take()
		h.advance(1000)
		await h.pacer.take()
		expect(h.waits).toEqual([])
	})

	test('a partial wait is credited, not restarted', async () => {
		const h = harness(1000)
		await h.pacer.take()
		h.advance(600)
		await h.pacer.take()
		expect(h.waits).toEqual([400])
	})

	test('a gap of 0 disables pacing entirely', async () => {
		const h = harness(0)
		await h.pacer.take()
		await h.pacer.take()
		await h.pacer.take()
		expect(h.waits).toEqual([])
	})

	describe('push-back', () => {
		test('a 429 makes the NEXT caller wait the cooldown, not the gap', async () => {
			const h = harness(1000, 60_000)
			await h.pacer.take()
			h.pacer.pushBack()
			await h.pacer.take()
			// The cooldown outranks the gap: waiting only 1000ms and firing again is
			// how one 429 becomes the run that opens the circuit breaker.
			expect(h.waits).toEqual([60_000])
		})

		test('the cooldown applies to every caller, not just the one that saw it', async () => {
			const h = harness(1000, 60_000)
			h.pacer.pushBack()
			await Promise.all([h.pacer.take(), h.pacer.take()])
			expect(h.waits[0]).toBe(60_000)
			expect(h.pacer.standingDown()).toBe(false)
		})

		test('standingDown reports the cooldown while it is in force', async () => {
			const h = harness(1000, 60_000)
			expect(h.pacer.standingDown()).toBe(false)
			h.pacer.pushBack()
			expect(h.pacer.standingDown()).toBe(true)
			expect(h.pacer.standDownRemainingMs()).toBe(60_000)
			h.advance(59_999)
			expect(h.pacer.standingDown()).toBe(true)
			h.advance(1)
			expect(h.pacer.standingDown()).toBe(false)
			expect(h.pacer.standDownRemainingMs()).toBe(0)
		})

		// The Math.max in pushBack is UNTESTABLE with a fixed cooldown -- now()
		// only moves forward, so `now + cooldown` is always later than the value
		// it replaces and the guard never changes the answer. It earns its keep
		// only when the cooldown SHRINKS between push-backs, which an operator
		// retuning HARDCOVER_COOLDOWN_MS can do at runtime.
		test('a shorter later cooldown never CUTS SHORT one already in force', async () => {
			let clock = 1_000_000
			let cooldown = 60_000
			const pacer = createPacer({
				minGapMs: () => 1000,
				cooldownMs: () => cooldown,
				now: () => clock,
				wait: async (ms) => {
					clock += ms
				}
			})
			pacer.pushBack()
			expect(pacer.standDownRemainingMs()).toBe(60_000)
			cooldown = 1000
			pacer.pushBack()
			// Still the original stand-down, not a fresh 1s one.
			expect(pacer.standDownRemainingMs()).toBe(60_000)
		})
	})

	// The chain is kept alive with .catch. A rejection AFTER take() resolves
	// cannot test that -- the slot itself already fulfilled -- so this makes the
	// slot's own work throw, which is the only thing that can poison the chain.
	test('a slot that REJECTS does not stall every later caller', async () => {
		let clock = 1_000_000
		let failNext = true
		const waits: number[] = []
		const pacer = createPacer({
			minGapMs: () => 1000,
			cooldownMs: () => 60_000,
			now: () => clock,
			wait: async (ms) => {
				if (failNext) {
					failNext = false
					throw new Error('clock exploded')
				}
				waits.push(ms)
				clock += ms
			}
		})
		await pacer.take() // first call: no wait, so it succeeds
		await expect(pacer.take()).rejects.toThrow('clock exploded')
		// Without the .catch keeping the chain alive, this never settles.
		await pacer.take()
		expect(waits).toEqual([1000])
	})

	// The Goodreads policy. Its getJson declines at standingDown() and returns
	// null-degraded instead of queueing, so a cooldown honoured inside take()
	// would only punish the callers that got through the guard first -- on a
	// serve path with a time budget, up to a full 60s each.
	describe("onPushBack: 'shed'", () => {
		test('take() does NOT wait out a cooldown', async () => {
			const h = harness(1000, 60_000, 'shed')
			await h.pacer.take()
			h.pacer.pushBack()
			// Advance past the GAP, so the only thing that could still hold this
			// caller is the cooldown. Under the default 'wait' this waits 59s.
			h.advance(1000)
			await h.pacer.take()
			expect(h.waits).toEqual([])
		})

		test('the cooldown is still RECORDED, or the caller has nothing to shed on', async () => {
			// Shedding is a caller-side decision; the pacer must still tell it that a
			// push-back happened. A pacer that simply forgot 429s would pass the test
			// above and silently disable the stand-down entirely.
			const h = harness(1000, 60_000, 'shed')
			h.pacer.pushBack()
			expect(h.pacer.standingDown()).toBe(true)
			expect(h.pacer.standDownRemainingMs()).toBe(60_000)
		})

		test('the gap is still enforced while standing down', async () => {
			// Shed drops the COOLDOWN from take(), not the pacing. A caller that
			// proceeds anyway must still be spaced off the previous one.
			const h = harness(1000, 60_000, 'shed')
			await h.pacer.take()
			h.pacer.pushBack()
			await h.pacer.take()
			expect(h.waits).toEqual([1000])
		})
	})

	test('reset clears BOTH the gap and the cooldown', async () => {
		// A pacer is module-level, so a suite that arms a 429 stands down every
		// suite that follows it in the same process. Half a reset is its own trap:
		// clearing only the cooldown leaves the next caller paying a stale gap.
		const h = harness(1000, 60_000)
		await h.pacer.take()
		h.pacer.pushBack()
		expect(h.pacer.standingDown()).toBe(true)
		h.pacer.reset()
		expect(h.pacer.standingDown()).toBe(false)
		expect(h.pacer.standDownRemainingMs()).toBe(0)
		await h.pacer.take()
		expect(h.waits).toEqual([])
	})

	test('two pacers are independent — a slow provider cannot throttle a healthy one', async () => {
		const a = harness(1000)
		const b = harness(1000)
		a.pacer.pushBack()
		await b.pacer.take()
		expect(b.waits).toEqual([])
		expect(b.pacer.standingDown()).toBe(false)
	})
})

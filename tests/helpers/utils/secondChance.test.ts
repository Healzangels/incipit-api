import { describe, expect, test } from 'bun:test'

import { pendingSecondChances, scheduleSecondChance } from '#helpers/utils/secondChance'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('scheduleSecondChance', () => {
	test('runs the task once after the delay', async () => {
		let runs = 0
		expect(
			scheduleSecondChance('author:AAA', 10, async () => {
				runs += 1
			})
		).toBe(true)
		expect(runs).toBe(0) // not synchronous
		await tick(30)
		expect(runs).toBe(1)
	})

	test('dedupes by key while one is pending, and frees the key after it ran', async () => {
		let runs = 0
		const task = async () => {
			runs += 1
		}
		expect(scheduleSecondChance('author:BBB', 10, task)).toBe(true)
		expect(scheduleSecondChance('author:BBB', 10, task)).toBe(false)
		await tick(30)
		expect(runs).toBe(1)
		// A later gap can be retried again -- the dedupe is per-flight, not forever.
		expect(scheduleSecondChance('author:BBB', 10, task)).toBe(true)
		await tick(30)
		expect(runs).toBe(2)
	})

	test('a task that rejects never throws out of the timer, and frees the key', async () => {
		expect(
			scheduleSecondChance('author:CCC', 10, async () => {
				throw new Error('mirror down')
			})
		).toBe(true)
		await tick(30)
		expect(pendingSecondChances()).not.toContain('author:CCC')
	})

	test('a task that throws SYNCHRONOUSLY is contained too, and frees the key', async () => {
		// task() is () => Promise, but a closure can throw before it ever builds
		// its promise (a constructor in the closure body). A sync throw inside a
		// timer callback escapes .catch() -- it becomes an uncaughtException,
		// which server.ts treats as fatal -- and the key would leak, wedging this
		// author's retries for the process lifetime.
		expect(
			scheduleSecondChance('author:DDD', 10, () => {
				throw new Error('thrown before the promise exists')
			})
		).toBe(true)
		await tick(30)
		expect(pendingSecondChances()).not.toContain('author:DDD')
	})
})

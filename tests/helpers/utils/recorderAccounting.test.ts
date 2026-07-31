import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import fetchRouted, { replayStats, resetRecorderForTests } from '#helpers/utils/fetchPlus'

/**
 * The recorder is the foundation the corpus gate's determinism rests on, so its
 * accounting has to be honest about two things it previously was not.
 *
 * 1. RE-RECORDING APPENDED. Recording to a path that already held a recording
 *    doubled the file, and the per-URL FIFO then served the FIRST run's stale
 *    bodies — the operation whose entire purpose is refreshing the baseline
 *    silently froze it. The over-long queue also made over-consumption unable
 *    to produce a miss.
 *
 * 2. UNDER-CONSUMPTION WAS INVISIBLE. `served`/`misses` alone cannot distinguish
 *    a faithful replay from one that short-circuited: measured 2026-07-31, a run
 *    reported `served 1, misses 0` with 3 of 4 recorded exchanges never consumed
 *    and the row silently nulled. Zero misses is not proof; zero misses AND zero
 *    remaining is.
 */

const dir = mkdtempSync(join(tmpdir(), 'incipit-recorder-'))

afterEach(() => {
	delete process.env.GOODREADS_RECORD_PATH
	delete process.env.GOODREADS_REPLAY_PATH
	resetRecorderForTests()
})

const line = (url: string, data: unknown) => JSON.stringify({ url, ok: true, data }) + '\n'

describe('replay accounting', () => {
	test('remaining counts entries the run never consumed', async () => {
		const file = join(dir, 'leftovers.jsonl')
		writeFileSync(file, line('http://m/a', { v: 1 }) + line('http://m/b', { v: 2 }))
		process.env.GOODREADS_REPLAY_PATH = file
		resetRecorderForTests()

		await fetchRouted('http://blackhole/a')
		const stats = replayStats()
		expect(stats.served).toBe(1)
		expect(stats.misses).toBe(0)
		// The whole point: misses is 0, yet the run was NOT faithful.
		expect(stats.remaining).toBe(1)
	})

	test('a fully consumed replay reports zero remaining', async () => {
		const file = join(dir, 'exact.jsonl')
		writeFileSync(file, line('http://m/a', { v: 1 }) + line('http://m/b', { v: 2 }))
		process.env.GOODREADS_REPLAY_PATH = file
		resetRecorderForTests()

		await fetchRouted('http://blackhole/a')
		await fetchRouted('http://blackhole/b')
		const stats = replayStats()
		expect(stats).toEqual({ served: 2, misses: 0, remaining: 0 })
	})

	test('a miss is still counted, and still leaves remaining accurate', async () => {
		const file = join(dir, 'miss.jsonl')
		writeFileSync(file, line('http://m/a', { v: 1 }))
		process.env.GOODREADS_REPLAY_PATH = file
		resetRecorderForTests()

		await expect(fetchRouted('http://blackhole/never-recorded')).rejects.toThrow(/REPLAY MISS/)
		const stats = replayStats()
		expect(stats.misses).toBe(1)
		expect(stats.remaining).toBe(1)
	})
})

describe('recording', () => {
	test('re-recording to the same path TRUNCATES rather than appending', async () => {
		const file = join(dir, 'rerecord.jsonl')
		writeFileSync(file, line('http://m/stale', { v: 'STALE' }))

		process.env.GOODREADS_RECORD_PATH = file
		resetRecorderForTests()
		// Recording passes through to the live pool, which has nowhere to go here;
		// the failure is recorded too, which is the behaviour we want to observe.
		await fetchRouted('http://127.0.0.1:9/fresh').catch(() => undefined)

		const written = readFileSync(file, 'utf8').trim().split('\n')
		expect(written.length).toBe(1)
		expect(written[0]).not.toContain('STALE')
		expect(written[0]).toContain('/fresh')
	})

	test('subsequent writes in the same run APPEND rather than truncating', async () => {
		const file = join(dir, 'append.jsonl')
		process.env.GOODREADS_RECORD_PATH = file
		resetRecorderForTests()

		await fetchRouted('http://127.0.0.1:9/one').catch(() => undefined)
		await fetchRouted('http://127.0.0.1:9/two').catch(() => undefined)

		const written = readFileSync(file, 'utf8').trim().split('\n')
		expect(written.length).toBe(2)
		expect(written[0]).toContain('/one')
		expect(written[1]).toContain('/two')
	})
})

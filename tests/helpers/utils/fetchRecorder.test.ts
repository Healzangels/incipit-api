import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Control the "live" side: fetchPlus dispatches through the pooled axios.
const getMock = mock()
const postMock = mock()
mock.module('#helpers/utils/connectionPool', () => ({
	default: { get: getMock, post: postMock }
}))

const {
	default: fetchPlus,
	replayStats,
	resetRecorderForTests
} = await import('#helpers/utils/fetchPlus')

const dir = mkdtempSync(join(tmpdir(), 'rec-'))

// The recorder is ENV-GATED at call time: record mode appends every exchange
// (success AND failure — degraded paths are behavior too) to a JSONL; replay
// mode serves exchanges back per-URL FIFO and treats a miss as a hard error
// that also counts in replayStats(), because a miss surfacing as "degraded"
// would silently corrupt an A/B arm — the exhausted-mock trap at system scale.
describe('fetchPlus record/replay', () => {
	afterEach(() => {
		delete process.env.GOODREADS_RECORD_PATH
		delete process.env.GOODREADS_REPLAY_PATH
		getMock.mockReset()
		postMock.mockReset()
		resetRecorderForTests()
	})

	test('envs unset: passes through to the live pool untouched', async () => {
		getMock.mockResolvedValueOnce({ status: 200, data: { ok: 1 } })
		const r = await fetchPlus('http://m/x')
		expect(r.data).toEqual({ ok: 1 })
		expect(getMock).toHaveBeenCalledTimes(1)
	})

	test('record mode appends the success exchange and still returns it', async () => {
		const f = join(dir, 'a.jsonl')
		process.env.GOODREADS_RECORD_PATH = f
		getMock.mockResolvedValueOnce({ status: 200, data: { hello: 'world' } })
		const r = await fetchPlus('http://m/work/1')
		expect(r.data).toEqual({ hello: 'world' })
		const lines = readFileSync(f, 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l))
		expect(lines).toEqual([{ url: 'http://m/work/1', ok: true, data: { hello: 'world' } }])
	})

	test('record mode captures a FAILURE and still rejects to the caller', async () => {
		const f = join(dir, 'b.jsonl')
		process.env.GOODREADS_RECORD_PATH = f
		// status 500 four times: fetchPlus retries then rejects FetchError
		getMock.mockResolvedValue({ status: 500, data: null })
		await expect(fetchPlus('http://m/work/500')).rejects.toThrow('status 500')
		const lines = readFileSync(f, 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l))
		expect(lines.length).toBe(1)
		expect(lines[0].ok).toBe(false)
		expect(lines[0].status).toBe(500)
	})

	test('replay serves the recording per-URL FIFO with zero live calls', async () => {
		const f = join(dir, 'c.jsonl')
		writeFileSync(
			f,
			[
				JSON.stringify({ url: 'http://m/s', ok: true, data: { n: 1 } }),
				JSON.stringify({ url: 'http://m/s', ok: true, data: { n: 2 } })
			].join('\n') + '\n'
		)
		process.env.GOODREADS_REPLAY_PATH = f
		const a = await fetchPlus('http://m/s')
		const b = await fetchPlus('http://m/s')
		expect(a.data).toEqual({ n: 1 })
		expect(b.data).toEqual({ n: 2 })
		expect(getMock).not.toHaveBeenCalled()
	})

	test('replay reproduces a recorded FAILURE as a FetchError', async () => {
		const f = join(dir, 'd.jsonl')
		writeFileSync(
			f,
			JSON.stringify({
				url: 'http://m/dead',
				ok: false,
				status: 500,
				message: 'Request failed with status 500'
			}) + '\n'
		)
		process.env.GOODREADS_REPLAY_PATH = f
		await expect(fetchPlus('http://m/dead')).rejects.toMatchObject({ status: 500 })
		expect(getMock).not.toHaveBeenCalled()
	})

	test('replay matches by PATH, so a different base (blackhole canary) still hits', () => {
		const f = join(dir, 'g.jsonl')
		writeFileSync(
			f,
			JSON.stringify({ url: 'http://mirror.test:8788/work/7', ok: true, data: { w: 7 } }) + '\n'
		)
		process.env.GOODREADS_REPLAY_PATH = f
		return fetchPlus('http://127.0.0.1:9/work/7').then((r) => {
			expect(r.data).toEqual({ w: 7 })
			expect(getMock).not.toHaveBeenCalled()
		})
	})

	test('a replay MISS throws loudly, never touches the network, and counts', async () => {
		const f = join(dir, 'e.jsonl')
		writeFileSync(f, JSON.stringify({ url: 'http://m/other', ok: true, data: {} }) + '\n')
		process.env.GOODREADS_REPLAY_PATH = f
		await expect(fetchPlus('http://m/never-recorded')).rejects.toThrow('REPLAY MISS')
		expect(getMock).not.toHaveBeenCalled()
		expect(replayStats().misses).toBe(1)
	})

	test('an exhausted per-URL queue is also a MISS, not a silent repeat', async () => {
		const f = join(dir, 'f.jsonl')
		writeFileSync(f, JSON.stringify({ url: 'http://m/once', ok: true, data: { n: 1 } }) + '\n')
		process.env.GOODREADS_REPLAY_PATH = f
		await fetchPlus('http://m/once')
		await expect(fetchPlus('http://m/once')).rejects.toThrow('REPLAY MISS')
		expect(replayStats().misses).toBe(1)
	})
})

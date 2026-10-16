import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { baseFile, edition } from './fixtures'

import { BookOverlayStore, bookOverlayTable } from '#helpers/overlay/overlayStore'

const dir = mkdtempSync(join(tmpdir(), 'overlay-store-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Every log line, so "refused and logged" is an assertion, not a hope. */
let lines: { level: string; msg: string; obj: Record<string, unknown> }[] = []
const log = {
	info: (obj: object, msg: string) =>
		lines.push({ level: 'info', msg, obj: obj as Record<string, unknown> }),
	error: (obj: object, msg: string) =>
		lines.push({ level: 'error', msg, obj: obj as Record<string, unknown> })
}

let n = 0
/** A fresh path per test, so stores never share a file. */
const freshPath = () => join(dir, `overlay-${(n += 1)}.json`)

/** Write and push the mtime forward, so a rewrite within one clock tick still
 *  reads as a change (the store keys on inode, size and mtime). */
const write = (path: string, body: unknown, bump = 0) => {
	writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
	const t = new Date(Date.now() + bump * 1000)
	utimesSync(path, t, t)
}

beforeEach(() => {
	lines = []
})

describe('BookOverlayStore — the runtime file', () => {
	test('no file means no overlay, and that is said once', () => {
		const store = new BookOverlayStore(freshPath())
		expect(store.current(log)).toBeNull()
		expect(store.current(log)).toBeNull()
		expect(lines.filter((l) => l.msg.includes('no book overlay file'))).toHaveLength(1)
	})

	test('a valid file is served', () => {
		const path = freshPath()
		write(path, baseFile())
		const t = new BookOverlayStore(path).current(log)
		expect(t?.byId.has('B0SYNTH001')).toBe(true)
		expect(lines.some((l) => l.level === 'info' && l.msg === 'book overlay loaded')).toBe(true)
	})

	test('a BAD file is refused, logged with its reasons, and the last good table keeps serving', () => {
		const path = freshPath()
		const store = new BookOverlayStore(path)
		write(path, baseFile())
		const good = store.current(log)
		expect(good?.byId.size).toBe(4)

		// A genre outside the vocabulary: the whole file must be refused.
		const bad = baseFile() as { works: Record<string, { genres: string[] }> }
		bad.works['lantern-road'].genres = ['Fantasy', 'Epic Fantasy', 'Adventure', 'Not A Genre']
		write(path, bad, 10)
		lines = []
		expect(store.current(log)).toBe(good)
		const refused = lines.find((l) => l.level === 'error')
		expect(refused?.msg).toContain('REFUSED by the load gate')
		expect(String(refused?.obj.errors)).toContain('Not A Genre')

		// Logged ONCE: the next requests see the same bad file and stay quiet.
		lines = []
		expect(store.current(log)).toBe(good)
		expect(lines).toHaveLength(0)
	})

	test('unparseable JSON (a half-written file) keeps the last good table too', () => {
		const path = freshPath()
		const store = new BookOverlayStore(path)
		write(path, baseFile())
		const good = store.current(log)
		write(path, '{"schema": 1, "works": {', 10)
		expect(store.current(log)).toBe(good)
		expect(lines.some((l) => l.msg.includes('not valid JSON'))).toBe(true)
	})

	test('a CHANGED file is picked up without a restart', () => {
		const path = freshPath()
		const store = new BookOverlayStore(path)
		write(path, baseFile())
		expect(store.current(log)?.byId.has('B0SYNTH777')).toBe(false)
		const next = baseFile() as { editions: Record<string, unknown> }
		next.editions.B0SYNTH777 = edition('glass-orchard', {
			title: 'A New Edition',
			author: 'Fen Writer',
			narrator: 'New Voice'
		})
		write(path, next, 10)
		expect(store.current(log)?.byId.has('B0SYNTH777')).toBe(true)
	})

	test('deleting the file is a complete rollback: no overlay at all', () => {
		const path = freshPath()
		const store = new BookOverlayStore(path)
		write(path, baseFile())
		expect(store.current(log)).not.toBeNull()
		unlinkSync(path)
		expect(store.current(log)).toBeNull()
		expect(lines.some((l) => l.msg.includes('removed'))).toBe(true)
	})

	test('bookOverlayTable follows BOOK_OVERLAY_PATH', () => {
		const before = process.env.BOOK_OVERLAY_PATH
		try {
			const path = freshPath()
			write(path, baseFile())
			process.env.BOOK_OVERLAY_PATH = path
			expect(bookOverlayTable()?.byId.has('B0SYNTH001')).toBe(true)
			process.env.BOOK_OVERLAY_PATH = freshPath()
			expect(bookOverlayTable()).toBeNull()
		} finally {
			if (before === undefined) delete process.env.BOOK_OVERLAY_PATH
			else process.env.BOOK_OVERLAY_PATH = before
		}
	})
})

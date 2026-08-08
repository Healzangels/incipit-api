import { describe, expect, test } from 'bun:test'

import { ApiChapterSchema } from '#config/types'
import { chaptarrChapters } from '#helpers/providers/chaptarrChapters'
import type { ChaptarrWorkResponse } from '#helpers/providers/ChaptarrProvider'
import fixture from '#tests/fixtures/chaptarr-work-annihilation.json'

/**
 * Chapter fallback mapper. The fixture's audiobook edition carries the first
 * three live-captured Annihilation chapters (Opening Credits / Introduction /
 * 1: Initiation) plus durationSeconds — the real envelope the mapper builds
 * from.
 */

const work = fixture as unknown as ChaptarrWorkResponse

function seam(response: ChaptarrWorkResponse | null) {
	return { workFetch: async () => response }
}

describe('chaptarrChapters', () => {
	test('maps the live shape to a schema-valid ApiChapter', async () => {
		const out = await chaptarrChapters('B00HYGYN5Q', 'us', seam(work))
		expect(out).not.toBeNull()
		expect(() => ApiChapterSchema.parse(out)).not.toThrow()
		expect(out?.asin).toBe('B00HYGYN5Q')
		expect(out?.region).toBe('us')
		expect(out?.chapters.length).toBe(3)
		expect(out?.chapters[0]).toEqual({
			lengthMs: 13432,
			startOffsetMs: 0,
			startOffsetSec: 0,
			title: 'Opening Credits'
		})
		// Runtime from the edition's durationSeconds (22260s), not the chapters.
		expect(out?.runtimeLengthMs).toBe(22260000)
		expect(out?.runtimeLengthSec).toBe(22260)
		// These offsets were never blessed by Audible's chapter service.
		expect(out?.isAccurate).toBe(false)
		expect(out?.brandIntroDurationMs).toBe(0)
	})

	test('no edition, no chapters, or no response all return null', async () => {
		expect(await chaptarrChapters('B0ABSENT99', 'us', seam(work))).toBeNull()
		const chapterless = {
			...work,
			editions: (work.editions ?? []).map((e) => ({ ...e, chapters: [] }))
		}
		expect(await chaptarrChapters('B00HYGYN5Q', 'us', seam(chapterless))).toBeNull()
		expect(await chaptarrChapters('B00HYGYN5Q', 'us', seam(null))).toBeNull()
	})

	test('junk numbers coerce to 0, blank titles get a stable name, runtime falls back to the last chapter end', async () => {
		const junk: ChaptarrWorkResponse = {
			work: { title: 'X' },
			authors: [],
			editions: [
				{
					asin: 'B0JUNK0001',
					formatType: 'audiobook',
					durationSeconds: null,
					chapters: [
						{ title: '  ', startOffsetMs: -5, startOffsetSec: undefined, lengthMs: 1000 },
						{ title: 'End', startOffsetMs: 1000, startOffsetSec: 1, lengthMs: 2000 }
					]
				}
			]
		}
		const out = await chaptarrChapters('B0JUNK0001', 'us', seam(junk))
		expect(out).not.toBeNull()
		expect(out?.chapters[0]).toEqual({
			lengthMs: 1000,
			startOffsetMs: 0,
			startOffsetSec: 0,
			title: 'Chapter 1'
		})
		expect(out?.runtimeLengthMs).toBe(3000)
		expect(out?.runtimeLengthSec).toBe(3)
	})

	test('a candidate the SCHEMA refuses yields null, never a malformed record', async () => {
		// The parse-never-trust line: feed a shape whose mapped candidate still
		// violates ApiChapterSchema (an asin the AsinSchema regex rejects). A
		// mutant that returns the candidate unparsed serves the malformed
		// record here — and would persist it where the schema-validating serve
		// path could never read it back.
		const bad: ChaptarrWorkResponse = {
			work: { title: 'X' },
			authors: [],
			editions: [
				{
					asin: 'not-a-real-asin',
					formatType: 'audiobook',
					durationSeconds: 60,
					chapters: [{ title: 'One', startOffsetMs: 0, startOffsetSec: 0, lengthMs: 1000 }]
				}
			]
		}
		expect(await chaptarrChapters('not-a-real-asin', 'us', seam(bad))).toBeNull()
	})

	test('a throwing transport serves null, never an exception', async () => {
		const out = await chaptarrChapters('B00HYGYN5Q', 'us', {
			workFetch: async () => {
				throw new Error('down')
			}
		})
		expect(out).toBeNull()
	})
})

import { describe, expect, test } from 'bun:test'

import type { ChaptarrWorkResponse } from '#helpers/providers/ChaptarrProvider'
import { REFERENCE, runChaptarrWireCheck } from '#helpers/providers/chaptarrWireCheck'
import liveFixture from '#tests/fixtures/chaptarr-work-ninth-house-live.json'

/**
 * The Chaptarr wire canary must say WHICH field moved. Fed the 2026-09-25 live
 * capture it passes; fed the same capture with one field renamed the way the
 * service renamed them between 2026-08-08 and 2026-09-25, exactly that field's
 * checks fail -- the raw one naming the field, and the parsed one proving our
 * reading of it broke.
 */

const live = liveFixture as unknown as ChaptarrWorkResponse

function deps(body: ChaptarrWorkResponse | null | Error) {
	return {
		matchFetch: async () => [{ work_id: REFERENCE.work }],
		workFetch: async (id: string) => {
			if (body instanceof Error) throw body
			return id === REFERENCE.work || id === `az:${REFERENCE.storeListing}` ? body : null
		}
	}
}

/** The capture with every edition rewritten by `edit`. */
function drifted(
	edit: (e: Record<string, unknown>) => Record<string, unknown>
): ChaptarrWorkResponse {
	const copy = JSON.parse(JSON.stringify(live)) as ChaptarrWorkResponse
	copy.editions = (copy.editions ?? []).map((e) => edit(e as Record<string, unknown>)) as never
	return copy
}

const rename = (from: string[], to: string) => (e: Record<string, unknown>) => {
	const out = { ...e }
	for (const k of from) {
		if (k in out) out[to] = out[k]
		delete out[k]
	}
	return out
}

const failed = async (body: ChaptarrWorkResponse) =>
	(await runChaptarrWireCheck(deps(body))).checks.filter((c) => !c.ok).map((c) => c.name)

describe('the Chaptarr wire canary', () => {
	test('the 2026-09-25 live capture passes every check', async () => {
		const report = await runChaptarrWireCheck(deps(live))
		expect(report.checks.filter((c) => !c.ok)).toEqual([])
		expect(report.ok).toBe(true)
		expect(report.unreachable).toBe(false)
	})

	test('a renamed audiobook marker is named, and the parser loses the edition', async () => {
		const out = await failed(drifted(rename(['format', 'formatType', 'readingFormatId'], 'kind')))
		expect(out).toContain('audiobook format marker')
		expect(out).toContain('search finds the reference edition')
	})

	test('renamed store ids are named, and the parsed aliases lose the store listing', async () => {
		const out = await failed(
			drifted(rename(['provider_ids_all', 'asins', 'providerIdsAll'], 'storeIds'))
		)
		// ...and serving a regional id breaks with them: the 404s the 2026-09-25 drift caused.
		expect(out).toEqual([
			'store ids',
			'parsed store ids name the store listing',
			'a regional id is served'
		])
	})

	test('a renamed language is named, and the parsed row goes language-unknown', async () => {
		const out = await failed(drifted(rename(['languageCode', 'language'], 'lang')))
		expect(out).toEqual(['edition language', 'parsed language'])
	})

	test('runtimes gone to 0 are named on the wire and in the parsed row', async () => {
		const out = await failed(drifted((e) => ({ ...e, durationSeconds: 0 })))
		expect(out).toEqual(['runtime', 'parsed runtime'])
	})

	test('renamed narrators are named on the wire and in the parsed row', async () => {
		const out = await failed(drifted(rename(['narratorNames'], 'narrators')))
		expect(out).toEqual(['narrators', 'parsed narrators'])
	})

	test('a service that throws is unreachable, not drifted', async () => {
		const report = await runChaptarrWireCheck(deps(new Error('ECONNREFUSED')))
		expect(report.unreachable).toBe(true)
		expect(report.ok).toBe(false)
	})

	test('a reference work that answers nothing is unreachable too', async () => {
		const report = await runChaptarrWireCheck(deps(null))
		expect(report.unreachable).toBe(true)
	})
})

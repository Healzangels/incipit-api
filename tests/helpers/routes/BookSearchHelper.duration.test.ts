import { beforeEach, describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'
import { getMatchMetrics, resetMatchMetrics } from '#helpers/utils/matchTelemetry'

/**
 * The graded duration dead zone.
 *
 * Regression origin: "Demons Don't Dream" matched an edition 14% off the file's
 * runtime — narrated by James Fouhey against a Bruce Huntey recording, i.e. the
 * WRONG EDITION, confirmed by listening. Three candidates were accepted, the top
 * two tied at 0.85 because neither had duration corroboration, and the tie fell
 * through to providerRank. The 14% gap was the one signal that could have broken
 * that tie correctly and it carried zero weight.
 */

function candidate(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
	return {
		provider: 'hardcover',
		id: 'x',
		asin: null,
		title: "Demons Don't Dream",
		authors: ['Piers Anthony'],
		narrators: [],
		audioSeconds: null,
		cover: null,
		language: null,
		...over
	}
}

/** durationMs that sits `pct` above a candidate's audioSeconds. */
function msForDelta(candAudioSeconds: number, pct: number): number {
	return candAudioSeconds * (1 + pct) * 1000
}

function helperFor(candidates: ProviderCandidate[], options: Record<string, unknown> = {}) {
	const registry = { searchAll: async () => candidates } as unknown as ProviderRegistry
	return new BookSearchHelper(registry, {
		title: "Demons Don't Dream",
		author: 'Piers Anthony',
		region: 'us',
		...options
	} as never)
}

const BASE = 10000 // candidate runtime in seconds

describe('graded duration dead zone', () => {
	beforeEach(() => resetMatchMetrics())

	test('REGRESSION: a 14%-off edition no longer ties with — and beats — a better candidate', async () => {
		// Exactly the Demons Don't Dream shape: the wrong-runtime candidate comes
		// from the higher-ranked provider, so under the old flat dead zone both sat
		// at 0.85 and providerRank handed it the win.
		const out = await helperFor(
			[
				candidate({ provider: 'audible', id: 'wrong-edition', audioSeconds: BASE }),
				candidate({ provider: 'hardcover', id: 'no-duration', audioSeconds: null })
			],
			{ duration: msForDelta(BASE, 0.14) }
		).search()

		expect(out[0].id).toBe('no-duration')
		// 0.85 - ((0.14-0.05)/0.20)*0.3 = 0.85 - 0.135
		const wrong = out.find((c) => c.id === 'wrong-edition')
		expect(wrong?.confidence).toBeCloseTo(0.715, 5)
	})

	test('the penalty scales with how wrong the runtime is', async () => {
		const at = async (pct: number) => {
			const out = await helperFor([candidate({ audioSeconds: BASE })], {
				duration: msForDelta(BASE, pct)
			}).search()
			return out[0]?.confidence ?? 0
		}
		const near = await at(0.06) // just outside tolerance — barely touched
		const mid = await at(0.15)
		const far = await at(0.24) // nearly a contradiction

		expect(near).toBeGreaterThan(mid)
		expect(mid).toBeGreaterThan(far)
		expect(near).toBeCloseTo(0.835, 3)
	})

	test('a corroborating runtime (<=5%) is untouched and still reaches full confidence', async () => {
		const out = await helperFor([candidate({ audioSeconds: BASE })], {
			duration: msForDelta(BASE, 0.01)
		}).search()
		// +0.15 corroboration on top of the 0.85 title+author ceiling.
		expect(out[0].confidence).toBeCloseTo(1, 5)
		expect(getMatchMetrics().durationDeadzonedSearches).toBe(0)
	})

	test('a candidate with no runtime at all is not penalized', async () => {
		const out = await helperFor([candidate({ audioSeconds: null })], {
			duration: msForDelta(BASE, 0.14)
		}).search()
		expect(out[0].confidence).toBeCloseTo(0.85, 5)
		expect(getMatchMetrics().durationDeadzonedSearches).toBe(0)
	})

	test('an explicit ASIN pin is exempt', async () => {
		const out = await helperFor(
			[candidate({ id: 'pinned', asin: 'B0CJRV5S7M', audioSeconds: BASE })],
			{ duration: msForDelta(BASE, 0.14), asin: 'B0CJRV5S7M' }
		).search()
		expect(out[0].confidence).toBe(1)
	})

	test('telemetry records the dead zone firing', async () => {
		await helperFor([candidate({ audioSeconds: BASE })], {
			duration: msForDelta(BASE, 0.14)
		}).search()
		expect(getMatchMetrics().durationDeadzonedSearches).toBe(1)
		expect(getMatchMetrics().recent[0].durationDeadzoned).toBe(1)
	})

	test('EXACTLY 25% off pays the full veto — the boundary is not a free pass', async () => {
		// The dead zone used to stop strictly below 0.25 and the scorer's veto
		// starts strictly above it, so a candidate at exactly 25% paid nothing and
		// sat at 0.85 while one at 24.9% paid ~0.3. At the boundary the ramp now
		// evaluates to the full veto magnitude: 0.85 - 0.3 = 0.55, below the
		// acceptance floor — same fate as a 26% contradiction.
		const out = await helperFor([candidate({ audioSeconds: BASE })], {
			duration: msForDelta(BASE, 0.25)
		}).search()
		expect(out).toHaveLength(0)
	})
})

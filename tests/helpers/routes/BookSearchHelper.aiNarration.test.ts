import { beforeEach, describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'
import { getMatchMetrics, resetMatchMetrics } from '#helpers/utils/matchTelemetry'

/**
 * AI-narration ("Virtual Voice") demotion.
 *
 * Amazon auto-generates synthetic-narration Audible listings for real books with
 * a plausible title, author, and runtime, so one clears the confidence floor and
 * can even duration-corroborate to 1.0 — and if a stale sidecar ASIN points at it,
 * pins to 1.0 and out-ranks a real human-narrated edition from another provider.
 * The demotion keys off the narrator string ("Virtual Voice"), applies even to an
 * ASIN pin, and strips the pinned-first status, so the human edition wins while a
 * junk-only book still matches (offered, not auto-applied).
 */

const WANT_SECONDS = 10000
const WANT_MS = WANT_SECONDS * 1000

function candidate(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
	return {
		provider: 'audible',
		id: 'x',
		asin: null,
		title: 'Dead I Well May Be',
		authors: ['Adrian McKinty'],
		narrators: ['Virtual Voice'],
		audioSeconds: WANT_SECONDS,
		cover: null,
		language: null,
		...over
	}
}

function helperFor(candidates: ProviderCandidate[], options: Record<string, unknown> = {}) {
	const registry = { searchAll: async () => candidates } as unknown as ProviderRegistry
	return new BookSearchHelper(registry, {
		title: 'Dead I Well May Be',
		author: 'Adrian McKinty',
		region: 'us',
		duration: WANT_MS,
		...options
	} as never)
}

// A real human-narrated edition from another provider, same book and (near-)runtime.
const human = (over: Partial<ProviderCandidate> = {}): ProviderCandidate =>
	candidate({
		provider: 'overdrive',
		id: 'human',
		asin: null,
		narrators: ['Gerard Doyle'],
		audioSeconds: 9700, // 3% off — still a duration corroboration, different bucket
		...over
	})

describe('AI-narration (Virtual Voice) demotion', () => {
	beforeEach(() => resetMatchMetrics())

	test('a human-narrated edition out-ranks a Virtual Voice one of the same book', async () => {
		const out = await helperFor([candidate({ id: 'junk', asin: 'B0JUNK00000' }), human()]).search()

		expect(out[0].id).toBe('human')
		expect(out.find((c) => c.id === 'junk')?.confidence ?? 0).toBeLessThan(out[0].confidence)
	})

	test('a stale junk ASIN pin does NOT force the Virtual Voice edition to win', async () => {
		// The crux: the query pins the junk edition's ASIN (a stale sidecar), which
		// would normally force confidence 1.0. The demotion applies even to the pin
		// and strips pinned-first, so the real human edition still wins.
		const out = await helperFor([candidate({ id: 'junk', asin: 'B0JUNK00000' }), human()], {
			asin: 'B0JUNK00000'
		}).search()

		expect(out[0].id).toBe('human')
		expect(out.find((c) => c.id === 'junk')?.confidence ?? 0).toBeLessThan(out[0].confidence)
	})

	test('a Virtual Voice edition still matches when it is the only one, but is not auto-applied', async () => {
		const out = await helperFor([candidate({ id: 'junk', asin: 'B0JUNK00000' })]).search()

		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('junk')
		expect(out[0].confidence).toBeGreaterThanOrEqual(0.65) // above the acceptance floor
		expect(out[0].confidence).toBeLessThan(0.9) // below auto-apply — offered, not applied
	})

	test('a human-narrated candidate is never demoted', async () => {
		await helperFor([human({ id: 'plain' })]).search()
		expect(getMatchMetrics().recent[0].aiNarrationDemoted).toBe(0)
	})

	test('telemetry records the AI-narration demotion firing', async () => {
		await helperFor([candidate({ id: 'junk', asin: 'B0JUNK00000' }), human()]).search()
		expect(getMatchMetrics().aiNarrationDemotedSearches).toBe(1)
		expect(getMatchMetrics().recent[0].aiNarrationDemoted).toBe(1)
	})
})

import { beforeEach, describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'
import { getMatchMetrics, resetMatchMetrics } from '#helpers/utils/matchTelemetry'

/**
 * The wrong-language gate. The scenario it exists for: a foreign edition of a
 * book whose title does not translate scores IDENTICALLY to the correct one
 * (author names don't translate either), so the winner used to fall to
 * providerRank — i.e. which SOURCE returned it decided which language you got.
 */

function candidate(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
	return {
		provider: 'hardcover',
		id: 'x',
		asin: null,
		title: 'Dune',
		authors: ['Frank Herbert'],
		narrators: [],
		audioSeconds: null,
		cover: null,
		language: null,
		...over
	}
}

function helperFor(candidates: ProviderCandidate[], options: Record<string, unknown> = {}) {
	const registry = { searchAll: async () => candidates } as unknown as ProviderRegistry
	return new BookSearchHelper(registry, {
		title: 'Dune',
		author: 'Frank Herbert',
		region: 'us',
		...options
	} as never)
}

describe('wrong-language demotion', () => {
	beforeEach(() => resetMatchMetrics())

	test('the English edition beats a German one even when German came from a HIGHER-ranked provider', async () => {
		// audible outranks hardcover in PROVIDER_RANK, so before this gate the
		// German edition won the tie purely on provider order.
		const out = await helperFor([
			candidate({ provider: 'audible', id: 'de', language: 'de' }),
			candidate({ provider: 'hardcover', id: 'en', language: 'en' })
		]).search()

		expect(out[0].id).toBe('en')
		expect(out[0].language).toBe('en')
	})

	test('a conflicting edition is demoted but NOT deleted — a foreign-only book still matches', async () => {
		const out = await helperFor([candidate({ id: 'de-only', language: 'de' })]).search()
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('de-only')
		// 0.85 title+author ceiling minus the 0.15 penalty = 0.70, still above the
		// 0.65 acceptance floor. This is the regression 0.25 would have caused.
		expect(out[0].confidence).toBeCloseTo(0.7, 5)
	})

	test('UNKNOWN language is never demoted', async () => {
		const untagged = await helperFor([candidate({ id: 'untagged', language: null })]).search()
		const tagged = await helperFor([candidate({ id: 'tagged', language: 'en' })]).search()
		expect(untagged[0].confidence).toBeCloseTo(tagged[0].confidence, 5)
		expect(getMatchMetrics().languageDemotedCandidates).toBe(0)
	})

	test('an untagged edition is preferred over a positively-conflicting one', async () => {
		const out = await helperFor([
			candidate({ provider: 'audible', id: 'de', language: 'de' }),
			candidate({ provider: 'openlibrary', id: 'unknown', language: null })
		]).search()
		expect(out[0].id).toBe('unknown')
	})

	test('an explicit ASIN pin is exempt — the caller asked for that exact edition', async () => {
		const out = await helperFor([candidate({ id: 'de', asin: 'B0ASINDE01', language: 'de' })], {
			asin: 'B0ASINDE01'
		}).search()
		expect(out[0].asin).toBe('B0ASINDE01')
		expect(out[0].confidence).toBe(1)
		expect(getMatchMetrics().languageDemotedCandidates).toBe(0)
	})

	test('no demotion when the region gives no language expectation', async () => {
		// An unmapped region -> wantLanguage null -> nothing to conflict with.
		const out = await helperFor([candidate({ id: 'de', language: 'de' })], {
			region: 'zz'
		}).search()
		expect(out[0].confidence).toBeCloseTo(0.85, 5)
		expect(getMatchMetrics().languageDemotedCandidates).toBe(0)
	})

	test('telemetry records the gate firing, so its real effect is measurable', async () => {
		await helperFor([
			candidate({ provider: 'audible', id: 'de', language: 'de' }),
			candidate({ provider: 'storytel', id: 'fr', language: 'fr' }),
			candidate({ provider: 'hardcover', id: 'en', language: 'en' })
		]).search()

		const m = getMatchMetrics()
		expect(m.languageDemotedSearches).toBe(1)
		expect(m.languageDemotedCandidates).toBe(2)
		expect(m.recent[0].wantLanguage).toBe('en')
		expect(m.recent[0].matchedLanguage).toBe('en')
	})
})

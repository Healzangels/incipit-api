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

/**
 * The TITLE-MARKED foreign edition, at the TIEBREAK rather than the score.
 *
 * The demotion above and the ranking's language tiebreak used to read different
 * evidence: the demotion tests the title marker, the tiebreak tested only
 * `c.language`. A translated edition whose language field is null — the exact
 * case the marker exists for — is therefore demoted and then INVISIBLE to the
 * arm meant to settle the tie it lands in.
 *
 * The arithmetic makes that fatal rather than cosmetic: -0.15 for the language
 * conflict exactly cancels the +0.15 duration corroboration, so the foreign row
 * ties the correct one at 0.85. The residual gap is ~1e-16, far inside
 * AUDIO_EDITION_CONFIDENCE_TOLERANCE, so confidence does not decide — and the
 * next arm that speaks is byAudio, which prefers the foreign row precisely
 * because it IS the catalogued audio edition while the correct English row is a
 * runtime-less book record.
 *
 * Both Everfound and Babel persisted into the live library this way.
 */
describe('a foreign edition detected only by its title marker', () => {
	beforeEach(() => resetMatchMetrics())

	test('loses the tie to the correct-language row, even as the only audio edition', async () => {
		const out = await helperFor(
			[
				candidate({
					provider: 'audible',
					id: 'spanish',
					asin: 'B0CN3SPD12',
					title: 'Dune (Spanish Edition)',
					audioSeconds: 40000,
					language: null // mislabeled at source: only the title betrays it
				}),
				candidate({ provider: 'hardcover', id: 'english', audioSeconds: null, language: 'en' })
			],
			{ duration: 40000 * 1000 }
		).search()

		expect(out[0].id).toBe('english')
		// Both really are at 0.85 — this is a TIEBREAK fix, not a scoring one. If
		// the demotion ever stops cancelling the bonus this assertion says so
		// rather than letting the test pass for a new reason.
		expect(out[0].confidence).toBeCloseTo(0.85, 5)
		expect(out[1].confidence).toBeCloseTo(0.85, 5)
	})

	test('the marker is REGION-AWARE: a German edition is what a German-region query wants', async () => {
		// The marker leg used to fire on the marker's PRESENCE alone, with no
		// reference to wantLanguage — so for region=de the CORRECT German edition
		// was flagged wrong-language while an untagged English row (language:
		// null, so nothing flagged it) was not. Measured end-to-end: the marker is
		// the sole differing input between these two runs, and it flipped the
		// winner, seating the correct German audio edition LAST.
		//
		// Same candidates both times; only the region changes.
		const rows = () => [
			candidate({
				provider: 'audible',
				id: 'german',
				asin: 'B0CN3GRD12',
				title: 'Dune (German Edition)',
				audioSeconds: 40000,
				language: null // mislabeled at source: only the title says so
			}),
			candidate({ provider: 'hardcover', id: 'english', audioSeconds: null, language: null })
		]

		const de = await helperFor(rows(), { region: 'de', duration: 40000 * 1000 }).search()
		expect(de[0].id).toBe('german')
		// Not merely first — never penalized at all: it corroborates on runtime and
		// keeps the full bonus.
		expect(de[0].confidence).toBeCloseTo(1, 5)
		expect(getMatchMetrics().languageDemotedCandidates).toBe(0)

		// The same marker against an ENGLISH-region query is still evidence of a
		// mismatch, so the leg has not simply been switched off.
		resetMatchMetrics()
		const us = await helperFor(rows(), { region: 'us', duration: 40000 * 1000 }).search()
		expect(us[0].id).toBe('english')
		expect(getMatchMetrics().languageDemotedCandidates).toBe(1)
	})

	test('a native-language marker ("Ausgabe") is read the same way', async () => {
		// The named-language branch ("German Edition") and the native branch
		// ("Ausgabe") are two spellings of one fact and must not disagree.
		const out = await helperFor(
			[
				candidate({
					provider: 'audible',
					id: 'german',
					asin: 'B0CN3GRD13',
					title: 'Dune: Ungekürzte Ausgabe',
					audioSeconds: 40000,
					language: null
				}),
				candidate({ provider: 'hardcover', id: 'english', audioSeconds: null, language: null })
			],
			{ region: 'de', duration: 40000 * 1000 }
		).search()
		expect(out[0].id).toBe('german')
		expect(getMatchMetrics().languageDemotedCandidates).toBe(0)
	})

	test('but the marker never counts against a query that ASKED for that edition', async () => {
		// primaryTitle carries the marker too, so it is not evidence of a mismatch
		// — otherwise the caller who explicitly wants a translation gets their own
		// edition pushed below the English one.
		//
		// BOTH rows carry the same runtime so both corroborate and land on the same
		// confidence: that is what forces the tiebreaks to run at all. An earlier
		// version of this test gave only the Spanish row a runtime, which put the
		// pair 0.15 apart — byConfidence decided, no tiebreak executed, and the
		// test passed against a build with the guard REMOVED.
		const out = await helperFor(
			[
				candidate({ provider: 'hardcover', id: 'plain', audioSeconds: 40000 }),
				candidate({
					provider: 'audible',
					id: 'spanish',
					asin: 'B0CN3SPD12',
					title: 'Dune (Spanish Edition)',
					audioSeconds: 40000
				})
			],
			{ title: 'Dune (Spanish Edition)', duration: 40000 * 1000 }
		).search()

		// Tied on confidence, so byLanguage gets to speak. With the guard it stays
		// silent and byAudio awards the catalogued audio edition; without it the
		// requested Spanish row is demoted for being what was asked for.
		expect(out[0].confidence).toBeCloseTo(out[1].confidence, 5)
		expect(out[0].id).toBe('spanish')
	})
})

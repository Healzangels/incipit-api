import { beforeEach, describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'
import { resetMatchMetrics } from '#helpers/utils/matchTelemetry'

/**
 * Tiebreak precedence in the final ranking.
 *
 * Confidence alone cannot always decide: a perfect title+author+duration
 * candidate reaches 1.0 just like an ASIN pin, and demotions/bonuses can land
 * two very different candidates on the same score. What breaks those ties is a
 * precedence order — pin, then language, then audio-edition, then provider —
 * and each step exists because the one below it decided wrongly at least once.
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

const BASE = 10000 // candidate runtime in seconds

describe('ranking tiebreaks', () => {
	// Every search() records into the module-global telemetry store; without
	// this reset the file leaks phantom decisions into later tests (the sibling
	// duration/language files reset for the same reason).
	beforeEach(() => resetMatchMetrics())

	test('an explicitly-hinted ASIN beats a non-pinned candidate that also reaches 1.0', async () => {
		// The rival: perfect title+author (0.85) + duration corroboration (+0.15)
		// = 1.0, from the highest-ranked provider — so before the pin tiebreak it
		// won the 1.0 tie on providerRank. Different runtime bucket and ASIN, so
		// dedupe keeps both.
		const out = await helperFor(
			[
				candidate({
					provider: 'audible',
					id: 'rival',
					asin: 'B0RIVAL001',
					audioSeconds: BASE
				}),
				candidate({
					provider: 'openlibrary',
					id: 'pinned',
					asin: 'B0PINNED01',
					audioSeconds: BASE + 120 // different minute bucket
				})
			],
			{ duration: BASE * 1000, asin: 'B0PINNED01' }
		).search()

		expect(out[0].id).toBe('pinned')
		expect(out[0].asin).toBe('B0PINNED01')
	})

	test('on a confidence tie, the wanted LANGUAGE beats being an audio edition', async () => {
		// A duration-corroborated foreign audio edition (+0.15 corroboration,
		// -0.15 language demotion = net 0.85) ties an uncorroborated correct-
		// language book-level record (0.85). When byAudio ran before byLanguage
		// the foreign audio edition took the tie and the language preference
		// never executed — the wrong-language book is the wrong BOOK, so language
		// ranks first.
		const out = await helperFor(
			[
				candidate({
					provider: 'audible',
					id: 'de-audio',
					language: 'de',
					audioSeconds: BASE,
					narrators: ['Jemand Anderes']
				}),
				candidate({
					provider: 'openlibrary',
					id: 'en-book',
					language: 'en',
					audioSeconds: null
				})
			],
			{ duration: BASE * 1000 }
		).search()

		expect(out[0].id).toBe('en-book')
	})

	test('language settled or moot, an audio edition still beats a book-level record', async () => {
		// The byAudio tiebreak keeps its job when language does not differentiate.
		const out = await helperFor([
			candidate({ provider: 'openlibrary', id: 'book-record', audioSeconds: null }),
			candidate({
				provider: 'openlibrary',
				id: 'audio-edition',
				narrators: ['Someone'],
				audioSeconds: BASE
			})
		]).search()

		expect(out[0].id).toBe('audio-edition')
	})

	test('an audio edition wins a SMALL confidence deficit against a print-only record', async () => {
		// The reporting case (Davis Ashura, "A Warrior's Knowledge"): an
		// OpenLibrary work with no ASIN, no narrators and no runtime scored 0.85,
		// while the Audible edition scored 0.768 -- lower precisely BECAUSE it is
		// the audiobook, since audiobook titles carry the series suffix the
		// catalogue entry omits. The print record won and took the match with it:
		// no narrator, no runtime for the duration veto to check, and a portrait
		// print-scan cover on an audiobook.
		//
		// Reproduced here through the author term (0.819 vs 0.850, a 0.031 gap)
		// rather than a title suffix, because a comma-suffixed title falls below
		// CONFIDENCE_FLOOR outright and never reaches the ranking at all.
		const out = await helperFor(
			[
				candidate({ provider: 'openlibrary', id: 'print', title: 'Dune' }),
				candidate({
					provider: 'audible',
					id: 'audio',
					asin: 'B0AUDIO001',
					title: 'Dune',
					authors: ['Frank Herbert Jr'],
					narrators: ['Scott Brick'],
					audioSeconds: BASE
				})
			],
			{}
		).search()

		expect(out[0].id).toBe('audio')
	})

	test('a confidence gap WIDER than the band still beats the audio preference', async () => {
		// The band is bounded, not a blanket override. At 0.74 against 0.85 the
		// gap is 0.11 -- outside the tolerance -- so confidence decides and a
		// genuinely worse-matching audio edition cannot drag the match away from
		// the right book.
		const out = await helperFor(
			[
				candidate({ provider: 'openlibrary', id: 'print', title: 'Dune' }),
				candidate({
					provider: 'audible',
					id: 'audio',
					asin: 'B0AUDIO002',
					title: 'Dune I',
					narrators: ['Scott Brick'],
					audioSeconds: BASE
				})
			],
			{}
		).search()

		expect(out[0].id).toBe('print')
	})

	test('a comma-suffixed audio title is scored, not discarded', async () => {
		// titleSim's baseTitle() splits on ":" and "(", so "Dune: Book One" and
		// "Dune (Unabridged)" both reach 1.000 against "Dune" -- but nothing
		// handled the trailing COMMA form. "Dune, Book 1" scored 0.533 and the
		// real case, "A Warrior's Knowledge, Book 2", fell below CONFIDENCE_FLOOR
		// and was filtered out BEFORE ranking. For one of the commonest audiobook
		// title conventions there is, the audio edition was not out-ranked by the
		// print record, it was thrown away -- narrators, runtime and cover with
		// it. Scoring the candidate through the same normalizer the want title
		// already passes through makes the comparison symmetric.
		const out = await helperFor(
			[
				candidate({ provider: 'openlibrary', id: 'print', title: 'Dune' }),
				candidate({
					provider: 'audible',
					id: 'audio',
					asin: 'B0COMMA001',
					title: 'Dune, Book 1',
					narrators: ['Scott Brick'],
					audioSeconds: BASE
				})
			],
			{}
		).search()

		// It must SURVIVE at all -- this returned a single result before.
		expect(out).toHaveLength(2)
		expect(out[0].id).toBe('audio')
	})

	test('among duration-corroborated candidates, the CLOSEST runtime wins', async () => {
		// Harry Potter, Chamber of Secrets, against a 34,968s file. Two Audible
		// editions both clear the 5% DURATION_TOLERANCE -- Stephen Fry at 34,980s
		// (0.03% off) and Full-Cast at 34,620s (1.0% off) -- so both took the same
		// corroboration bonus, tied, and the tie fell through to provider order,
		// picking an edition with the wrong narrator while the evidence to choose
		// correctly was already in hand. Tolerance decides whether a candidate is
		// the same BOOK; it is far too wide to separate narrations of it.
		const WANT_MS = 34968 * 1000
		const out = await helperFor(
			[
				candidate({
					provider: 'audible',
					id: 'fullcast',
					asin: 'B0FULLCAST',
					narrators: ['Hugh Laurie'],
					audioSeconds: 34620
				}),
				candidate({
					provider: 'audible',
					id: 'fry',
					asin: 'B0STEPHENF',
					narrators: ['Stephen Fry'],
					audioSeconds: 34980
				})
			],
			{ duration: WANT_MS }
		).search()

		expect(out[0].id).toBe('fry')
	})
})

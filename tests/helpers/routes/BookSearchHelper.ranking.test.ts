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

	const HP = () => [
		candidate({
			provider: 'audible',
			id: 'dale',
			asin: 'B0JIMDALE1',
			narrators: ['Jim Dale'],
			audioSeconds: 32520
		}),
		candidate({
			provider: 'audible',
			id: 'fullcast',
			asin: 'B0FULLCAST',
			narrators: ['Hugh Laurie', 'Matthew Macfadyen'],
			audioSeconds: 34620
		}),
		candidate({
			provider: 'audible',
			id: 'fry',
			asin: 'B0STEPHENF',
			narrators: ['Stephen Fry'],
			audioSeconds: 34980
		})
	]

	test('the NARRATOR picks the edition when title and author cannot', async () => {
		// Harry Potter: every edition carries the same title and author, so
		// title/author scoring ties them all and the winner fell to provider
		// order -- picking a different narrator's recording at random. The
		// narrator is the only field that says which one is actually on disk.
		const out = await helperFor(HP(), { narrator: 'Stephen Fry' }).search()
		expect(out[0].id).toBe('fry')
	})

	test('a cast credit still matches the individual narrator', async () => {
		// A sidecar credits a cast as one string while providers list members
		// separately, so matching ANY name is the useful test.
		const out = await helperFor(HP(), { narrator: 'Hugh Laurie & full cast' }).search()
		expect(out[0].id).toBe('fullcast')
	})

	test('a narrator matching nothing DISCARDS nothing', async () => {
		// Ranking signal, never a filter -- the same rule the ASIN pin follows.
		// A misspelt or differently-credited narrator must cost nothing beyond
		// the tiebreak it declines to decide.
		const out = await helperFor(HP(), { narrator: 'Nobody At All' }).search()
		expect(out).toHaveLength(3)
	})
})

describe('exact-title tiebreak (same recording, different provider titling)', () => {
	beforeEach(() => resetMatchMetrics())

	/**
	 * Measured live on Seth Ring's "Apex" (2026-07-26, fresh scan, file
	 * unanalyzed so no duration signal): Audible titles the edition "Apex: A
	 * Fantasy LitRPG Adventure" while OverDrive titles the SAME recording
	 * (same narrator, Pavi Proczko) plain "Apex" -- the query title. Both
	 * scored 0.85, every tiebreak through narrator tied, and provider order
	 * handed the match to Audible -- so the album displayed the marketing
	 * subtitle its five series siblings don't carry. Five minutes later the
	 * analyzed duration re-ranked the same search the other way, but the
	 * scan-time match had already stuck.
	 *
	 * When nothing else separates two candidates, prefer the one whose TITLE
	 * IS what the library calls the book. Cosmetic-only by construction: it
	 * runs after every identity tiebreak (pin, language, audio, narrator,
	 * runtime delta, residual confidence), so it can only decide between
	 * rows the evidence genuinely cannot tell apart.
	 */

	test('on a full tie, the candidate titled EXACTLY as the query outranks a marketing-subtitled sibling', async () => {
		const out = await helperFor(
			[
				candidate({
					provider: 'audible',
					id: 'B0DXQDSQ6T',
					asin: 'B0DXQDSQ6T',
					title: 'Apex: A Fantasy LitRPG Adventure',
					authors: ['Seth Ring'],
					narrators: ['Pavi Proczko'],
					audioSeconds: BASE
				}),
				candidate({
					provider: 'overdrive',
					id: 'overdrive-11641672',
					title: 'Apex',
					authors: ['Seth Ring'],
					narrators: ['Pavi Proczko'],
					// Different runtime bucket so dedupe keeps both rows, like live.
					audioSeconds: BASE + 600
				})
			],
			{ title: 'Apex', author: 'Seth Ring', narrator: 'Pavi Proczko' }
		).search()
		expect(out[0]?.title).toBe('Apex')
	})

	test('a duration signal still outranks title exactness', async () => {
		// The arm is LAST before provider order: when the file's runtime
		// corroborates one row more closely, that evidence decides, exactness
		// notwithstanding.
		const out = await helperFor(
			[
				candidate({
					provider: 'audible',
					id: 'long',
					asin: 'B000000001',
					title: 'Apex: A Fantasy LitRPG Adventure',
					authors: ['Seth Ring'],
					narrators: ['Pavi Proczko'],
					audioSeconds: BASE
				}),
				candidate({
					provider: 'overdrive',
					id: 'exact',
					title: 'Apex',
					authors: ['Seth Ring'],
					narrators: ['Pavi Proczko'],
					audioSeconds: BASE + 600
				})
			],
			{
				title: 'Apex',
				author: 'Seth Ring',
				narrator: 'Pavi Proczko',
				duration: BASE * 1000
			}
		).search()
		expect(out[0]?.id).toBe('long')
	})
})

/**
 * THE HINTED ASIN MUST NOT LOSE A COIN FLIP.
 *
 * Measured on a live fresh scan (2026-08-01, .99 rebuild): of 342 books whose
 * sidecar named a B0 ASIN, 215 — 63% — matched to a DIFFERENT record.
 *
 * Why the existing guards all decline. `isPinned()` deliberately returns false
 * for the row fetched BY the hinted ASIN, so it earns no confidence override
 * and no pinned-first: a stale sidecar ASIN must not be able to force a wrong
 * edition, and that is right. It is supposed to win on MERITS instead. But on a
 * fresh scan nothing is analyzed, every candidate comes back with a null
 * runtime, so no row corroborates and they all sit on the same confidence
 * (0.8500000000000001 live). Every evidence arm then declines in turn, and
 * `providerRank` has no entry for either `pinned` or `overdrive` — both fall to
 * the `?? 9` default — so the decision reaches `byCandidateIdentity`, which is
 * documented as deliberately ARBITRARY.
 *
 * Arbitrary is fine between rows nothing distinguishes. It is not fine when one
 * of them is the edition the caller named by identity. This asks only for the
 * last coin flip to be settled by the hint, which cannot resurrect a candidate
 * or outrank a single piece of real evidence.
 */
describe('a tie that reaches the arbitrary tiebreak', () => {
	beforeEach(() => resetMatchMetrics())

	test('prefers the edition the caller actually named', async () => {
		// Both audio, same title, same author, NO runtime anywhere — the live
		// fresh-scan shape. Distinct asins + providers so dedupe keeps both.
		const out = await helperFor(
			[
				candidate({ provider: 'overdrive', id: 'rival', asin: 'B0OTHER001', audioSeconds: null }),
				// provider 'pinned' is what withPinnedEdition stamps on the row it
				// fetched BY the hint — and precisely what makes isPinned() return
				// false, so this row gets NO confidence override and NO pinned-first.
				// Giving it a normal provider instead tests the opposite code path:
				// it scores 1.0 and wins everything, including over real evidence.
				candidate({ provider: 'pinned', id: 'named', asin: 'B0NAMED001', audioSeconds: null })
			],
			{ asin: 'B0NAMED001' }
		).search()

		expect(out.length).toBeGreaterThan(1)
		expect(out[0].asin).toBe('B0NAMED001')
	})

	test('but it never outranks real evidence — a corroborated rival still wins', async () => {
		// The hint must remain a LAST-RESORT tiebreak. Here the un-hinted row
		// corroborates on duration; the hinted one does not.
		const out = await helperFor(
			[
				candidate({ provider: 'audible', id: 'corroborated', asin: 'B0OTHER001', audioSeconds: 40000 }),
				candidate({ provider: 'pinned', id: 'named', asin: 'B0NAMED001', audioSeconds: null })
			],
			{ asin: 'B0NAMED001', duration: 40000 * 1000 }
		).search()

		expect(out[0].asin).toBe('B0OTHER001')
	})
})

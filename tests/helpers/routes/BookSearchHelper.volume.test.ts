import { beforeEach, describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'
import { getMatchMetrics, resetMatchMetrics } from '#helpers/utils/matchTelemetry'

/**
 * Volume/part disambiguation.
 *
 * Regression origin: a library folder "KTF Part 2" matched "KTF Part 1" — two
 * genuinely different books. normalizeTitle strips "Part N"/"Book N"/"Vol N" as
 * series noise (right for "A Warrior's Knowledge, Book 2" against a bare print
 * record), which also deletes the ONLY difference between the two KTF volumes:
 * both reduced to "KTF", both scored 0.85, and the tie fell through to provider
 * order — returning Part 1 for a Part 2 query. The fix reads the numbers from the
 * RAW titles and demotes a candidate whose volume conflicts with the query's.
 */

function candidate(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
	return {
		provider: 'hardcover',
		id: 'x',
		asin: null,
		title: 'KTF Part 2',
		authors: ['Jason Anspach'],
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
		title: 'KTF Part 2',
		author: 'Jason Anspach',
		region: 'us',
		...options
	} as never)
}

describe('volume/part disambiguation', () => {
	beforeEach(() => resetMatchMetrics())

	test('REGRESSION: a query for Part 2 ranks Part 2 over Part 1', async () => {
		// Part 1 comes from the higher-ranked provider (audible), so under the old
		// behaviour it won the 0.85 tie on provider order and was returned instead.
		const out = await helperFor([
			candidate({ provider: 'audible', id: 'part1', asin: 'B0B8LDB4W3', title: 'KTF Part 1' }),
			candidate({ provider: 'hardcover', id: 'part2', asin: 'B0BMSRGPQW', title: 'KTF Part 2' })
		]).search()

		expect(out[0].id).toBe('part2')
		// The wrong sibling is demoted below the right one (0.85 - 0.2 sits at/under
		// the acceptance floor, so it is either ranked last or dropped entirely).
		expect(out.find((c) => c.id === 'part1')?.confidence ?? 0).toBeLessThan(out[0].confidence)
	})

	test('the bare print record (no volume marker) is never demoted', async () => {
		// The commonest safe case: the query echoes the series position in its tag
		// but the provider edition carries no number. Sharing no marker must NOT be
		// read as a conflict — that would throw away the correct match.
		const out = await helperFor(
			[candidate({ id: 'plain', title: "A Warrior's Knowledge", authors: ['David Farland'] })],
			{ title: "A Warrior's Knowledge, Book 2", author: 'David Farland' }
		).search()

		expect(out[0].id).toBe('plain')
		expect(out[0].confidence).toBeCloseTo(0.85, 5)
		expect(getMatchMetrics().recent[0].volumeDemoted).toBe(0)
	})

	test('a shared number across marker WORDS is not a conflict', async () => {
		// "Book 2" and "Part 2" name the same volume. Comparing the NUMBERS, not the
		// marker word, keeps such a candidate at full score.
		const out = await helperFor([candidate({ id: 'same', title: 'Something Part 2' })], {
			title: 'Something, Book 2',
			author: 'Jason Anspach'
		}).search()

		expect(out[0].id).toBe('same')
		expect(out[0].confidence).toBeCloseTo(0.85, 5)
		expect(getMatchMetrics().recent[0].volumeDemoted).toBe(0)
	})

	test('an explicit ASIN pin is exempt from the volume penalty', async () => {
		// The caller named this edition by identity; honour it even if its printed
		// part number reads oddly against the query tag.
		const out = await helperFor(
			[candidate({ id: 'pinned', asin: 'B0B8LDB4W3', title: 'KTF Part 1' })],
			{ asin: 'B0B8LDB4W3' }
		).search()
		expect(out[0].confidence).toBe(1)
	})

	test('telemetry records the volume demotion firing', async () => {
		await helperFor([
			candidate({ provider: 'audible', id: 'part1', title: 'KTF Part 1' }),
			candidate({ provider: 'hardcover', id: 'part2', title: 'KTF Part 2' })
		]).search()
		expect(getMatchMetrics().volumeDemotedSearches).toBe(1)
		expect(getMatchMetrics().recent[0].volumeDemoted).toBe(1)
	})
})

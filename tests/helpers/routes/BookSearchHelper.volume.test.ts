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

	test('REGRESSION: a BARE trailing number counts as a volume', async () => {
		// Providers list a numbered series as "Defiance of the Fall 7" as often as
		// "Book 7", and the marker-based regex cannot see the bare form -- so a
		// query for Book 10 found no conflict and the wrong sibling won on score.
		const out = await helperFor(
			[
				candidate({
					provider: 'audible',
					id: 'v1',
					title: 'Defiance of the Fall 1',
					authors: ['TheFirstDefier']
				}),
				candidate({
					provider: 'hardcover',
					id: 'v10',
					title: 'Defiance of the Fall, Book 10',
					authors: ['TheFirstDefier']
				})
			],
			{
				title: 'Defiance of the Fall',
				author: 'TheFirstDefier',
				trackTitle: 'Defiance of the Fall, Book 10'
			}
		).search()

		expect(out[0].id).toBe('v10')
		// THE assertion that discriminates. Mutation-testing the previous version
		// showed the whole bare-volume fallback could be deleted and this test
		// stayed green: the correct candidate is given in MARKER form, which
		// normalizeTitle reduces to exactly the query title, so it won on title
		// score alone. Only volumeDemoted proves the fallback fired.
		expect(getMatchMetrics().recent[0].volumeDemoted).toBe(1)
		// `.find()` on a dropped candidate is undefined, and `?? 0` made "below
		// the floor" and "present but lower" the same pass -- i.e. unfailable.
		const v1 = out.find((c) => c.id === 'v1')
		if (v1) expect(v1.confidence).toBeLessThan(out[0].confidence)
	})

	test('REGRESSION: bare on BOTH sides -- the convention the fix was written for', async () => {
		// The live shape: an ABS/folder library tags the album AND the track as
		// "Defiance of the Fall 10", with no "Book N" marker anywhere. wantVolumes
		// was built from marker form only, so the candidate-side fallback was
		// gated off and the wrong sibling won (measured: v1 0.838 over v10 0.812).
		// Only the tag punctuation decided whether the bug was fixed.
		const out = await helperFor(
			[
				candidate({
					provider: 'audible',
					id: 'v1',
					title: 'Defiance of the Fall 1',
					authors: ['TheFirstDefier']
				}),
				candidate({
					provider: 'hardcover',
					id: 'v10',
					title: 'Defiance of the Fall 10',
					authors: ['TheFirstDefier']
				})
			],
			{
				title: 'Defiance of the Fall 10',
				author: 'TheFirstDefier',
				trackTitle: 'Defiance of the Fall 10'
			}
		).search()

		expect(getMatchMetrics().recent[0].volumeDemoted).toBe(1)
		expect(out[0].id).toBe('v10')
	})

	test('REGRESSION: the fallback survives a missing album tag', async () => {
		// scoreAndRank checks everything else against BOTH titles; the stem check
		// used primaryTitle alone, so with no album tag normalizeTitle('') gave a
		// similarity of 0, the 0.9 bar failed, and the wrong sibling stayed
		// accepted at 0.824 -- on exactly the badly-tagged books the widening
		// pass exists to rescue.
		const out = await helperFor(
			[
				candidate({
					provider: 'audible',
					id: 'v1',
					title: 'Defiance of the Fall 1',
					authors: ['TheFirstDefier']
				}),
				candidate({
					provider: 'hardcover',
					id: 'v10',
					title: 'Defiance of the Fall 10',
					authors: ['TheFirstDefier']
				})
			],
			{ title: '', author: 'TheFirstDefier', trackTitle: 'Defiance of the Fall, Book 10' }
		).search()

		expect(getMatchMetrics().recent[0].volumeDemoted).toBe(1)
		expect(out[0].id).toBe('v10')
	})

	test('the 3-digit cap keeps a year out of the volume namespace', async () => {
		// Pins BARE_TRAILING_VOLUME_RE's {1,3}. Widening it to {1,6} previously
		// left the suite green, so a year-suffixed edition could be read as
		// volume 1984 and demote the correct match.
		const out = await helperFor(
			[candidate({ id: 'year', title: 'Foundation 1984', authors: ['Isaac Asimov'] })],
			{ title: 'Foundation, Book 2', author: 'Isaac Asimov' }
		).search()

		expect(getMatchMetrics().recent[0].volumeDemoted).toBe(0)
		expect(out[0].id).toBe('year')
	})

	test('the stem check keeps an unrelated numbered title out', async () => {
		// Pins the titleSim(...) < 0.9 guard, which deleting previously left the
		// suite green. "Dune 2" is not a sibling of "Defiance of the Fall".
		await helperFor([candidate({ id: 'dune', title: 'Dune 2', authors: ['TheFirstDefier'] })], {
			title: 'Defiance of the Fall',
			author: 'TheFirstDefier',
			trackTitle: 'Defiance of the Fall, Book 10'
		}).search()

		expect(getMatchMetrics().recent[0].volumeDemoted).toBe(0)
	})

	test('a title that merely ENDS in a number is not read as a volume', async () => {
		// The guard that keeps "Fahrenheit 451" and "1984" out of this: the bare
		// form is only consulted when the QUERY carries a volume, the number is at
		// most 3 digits, and the stem must still match the title we searched for.
		const out = await helperFor(
			[candidate({ id: 'f451', title: 'Fahrenheit 451', authors: ['Ray Bradbury'] })],
			{
				title: 'Fahrenheit 451',
				author: 'Ray Bradbury',
				trackTitle: 'Fahrenheit 451'
			}
		).search()

		expect(out[0].id).toBe('f451')
		expect(getMatchMetrics().recent[0].volumeDemoted).toBe(0)
	})

	test('a DISC suffix is a media part, so Book 1 keeps the agreeing-volume tiebreak', async () => {
		// A Book-1 rip split across discs tags "The Wandering Inn - Disc 2".
		// Neither VOLUME_MARKER_RE nor PART_MARKER_RE covers "disc", so the
		// bare-trailing fallback read the 2 as a WANTED volume — which does not
		// demote anything (Book 1 states no volume, so nothing conflicts) but
		// hands "Book 2" the agreeing-volume tiebreak and the win.
		//
		// A/B measured against the unpatched code: the two candidates tie at
		// 0.850 either way and volumeDemoted is 0 either way; the ONE
		// observable difference is which of them comes first, and it flipped.
		// That ordering is what the bundle takes, so it is the whole bug.
		const out = await helperFor(
			[
				candidate({ id: 'book1', title: 'The Wandering Inn', authors: ['Pirateaba'] }),
				candidate({ id: 'book2', title: 'The Wandering Inn, Book 2', authors: ['Pirateaba'] })
			],
			{ title: 'The Wandering Inn - Disc 2', author: 'Pirateaba' }
		).search()

		expect(out[0].id).toBe('book1')
		expect(getMatchMetrics().recent[0].volumeDemoted).toBe(0)
	})

	test('a REAL bare trailing volume still counts', async () => {
		// The fallback must keep working for the shape it exists for — the
		// stem check may only remove media-part suffixes.
		const out = await helperFor(
			[
				candidate({ id: 'v1', title: 'Dungeon Crawler Carl', authors: ['Matt Dinniman'] }),
				candidate({ id: 'v3', title: 'Dungeon Crawler Carl 3', authors: ['Matt Dinniman'] })
			],
			{ title: 'Dungeon Crawler Carl 3', author: 'Matt Dinniman' }
		).search()
		expect(out[0].id).toBe('v3')
	})

	test('an unrelated title ending in a number is never a sibling', async () => {
		// Stem check: "Slaughterhouse 5" must not be read as volume 5 of a
		// different series just because the query happens to carry a volume.
		const out = await helperFor(
			[candidate({ id: 'sh5', title: 'Slaughterhouse 5', authors: ['Kurt Vonnegut'] })],
			{
				title: 'Slaughterhouse 5',
				author: 'Kurt Vonnegut',
				trackTitle: 'Slaughterhouse 5, Book 1'
			}
		).search()

		expect(getMatchMetrics().recent[0].volumeDemoted).toBe(0)
		expect(out[0].id).toBe('sh5')
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

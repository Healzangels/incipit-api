import { describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper, { runtimeGapSeconds } from '#helpers/routes/BookSearchHelper'

/**
 * Closest runtime reads Audible's runtime as the truncated minute it is
 * (docs/design/spec-runtime-precision.md).
 *
 * Audible lists runtime_length_min, and measured 2026-09-26 it TRUNCATES: a
 * listing's own chapter runtime sits in [m, m+1) minutes. Ranked as the point
 * m*60, every Audible listing paid ~30s of truncation on average, so an
 * OverDrive copy of the same recording -- to the second, hence closer -- took
 * #1 whenever the file sat in the upper half of Audible's minute (the lower
 * half dedupes into one group by the rounded minute). Live shapes below are
 * from the 2026-09-25 search recording.
 */

function row(over: Partial<ProviderCandidate>): ProviderCandidate {
	return {
		provider: 'audible',
		id: 'x',
		asin: null,
		title: 'x',
		authors: [],
		narrators: [],
		audioSeconds: null,
		cover: null,
		language: null,
		...over
	}
}

function search(pool: ProviderCandidate[], title: string, author: string, durationMs: number) {
	const registry = {
		searchAll: async () => pool,
		fetchCandidateByAsin: async () => null
	} as unknown as ProviderRegistry
	return new BookSearchHelper(registry, {
		title,
		author,
		region: 'us',
		duration: durationMs
	} as never).search()
}

describe('runtimeGapSeconds', () => {
	test('a precise runtime is a point', () => {
		expect(runtimeGapSeconds(1000, 990, false)).toBe(10)
		expect(runtimeGapSeconds(1000, 1010, false)).toBe(10)
		expect(runtimeGapSeconds(1000, 1000, false)).toBe(0)
	})

	test('a truncated minute is the span [s, s + 60]', () => {
		expect(runtimeGapSeconds(1230, 1200, true)).toBe(0)
		expect(runtimeGapSeconds(1200, 1200, true)).toBe(0)
		expect(runtimeGapSeconds(1260, 1200, true)).toBe(0)
		expect(runtimeGapSeconds(1261, 1200, true)).toBe(1)
		expect(runtimeGapSeconds(1300, 1200, true)).toBe(40)
	})

	test('a file below the minute is measured to its start', () => {
		expect(runtimeGapSeconds(1199, 1200, true)).toBe(1)
		expect(runtimeGapSeconds(1150, 1200, true)).toBe(50)
	})
})

describe('closest runtime reads an Audible minute as truncated', () => {
	test("Wind and Truth: Audible's listing beats an OverDrive row 0.8s from the file", async () => {
		// File 226,112.842s. OverDrive 62:48:32 = 226,112s; Audible 3,768 min =
		// 226,080s, 32.8s under the file -- inside its own minute. Same narrators.
		const narrators = ['Kate Reading', 'Michael Kramer']
		const ranked = await search(
			[
				row({
					provider: 'overdrive',
					id: 'overdrive-10346070',
					title: 'Wind and Truth',
					authors: ['Brandon Sanderson'],
					narrators,
					audioSeconds: 226_112
				}),
				row({
					id: 'B0CQ3759C3',
					asin: 'B0CQ3759C3',
					title: 'Wind and Truth',
					authors: ['Brandon Sanderson'],
					narrators,
					audioSeconds: 3768 * 60
				})
			],
			'Wind and Truth',
			'Brandon Sanderson',
			226_112_842
		)
		expect(ranked[0]?.asin).toBe('B0CQ3759C3')
		// Both stay offered: a ranking change, never a filter.
		expect(ranked.map((c) => c.id)).toContain('overdrive-10346070')
	})

	test("The Mime Order: Audible's listing beats an OverDrive row 0.5s from the file", async () => {
		// File 67,377.506s, 57.5s above Audible's 1,122 min; OverDrive 18:42:58.
		const narrators = ['Alana Kerr Collins']
		const ranked = await search(
			[
				row({
					provider: 'overdrive',
					id: 'overdrive-10704063',
					title: 'The Mime Order',
					authors: ['Samantha Shannon'],
					narrators,
					audioSeconds: 67_378
				}),
				row({
					id: 'B0D333ZKCC',
					asin: 'B0D333ZKCC',
					title: 'The Mime Order',
					authors: ['Samantha Shannon'],
					narrators,
					audioSeconds: 1122 * 60
				})
			],
			'The Mime Order',
			'Samantha Shannon',
			67_377_506
		)
		expect(ranked[0]?.asin).toBe('B0D333ZKCC')
	})

	test('the span ends a minute on: past it, a closer row still wins', async () => {
		// Audible 600 min; the file 70s above it is 10s past the span.
		const audible = row({
			id: 'B0SPANEND1',
			asin: 'B0SPANEND1',
			title: 'Span',
			authors: ['A. Writer'],
			audioSeconds: 36_000
		})
		const od = (s: number) =>
			row({
				provider: 'overdrive',
				id: `od-${s}`,
				title: 'Span',
				authors: ['A. Writer'],
				audioSeconds: s
			})
		expect((await search([od(36_082), audible], 'Span', 'A. Writer', 36_070_000))[0]?.id).toBe(
			'B0SPANEND1'
		)
		expect((await search([od(36_078), audible], 'Span', 'A. Writer', 36_070_000))[0]?.id).toBe(
			'od-36078'
		)
	})

	test("a file below Audible's minute is measured to the minute's start", async () => {
		// Audible 601 min = 36,060s; the file 20s under it.
		const audible = row({
			id: 'B0BELOW001',
			asin: 'B0BELOW001',
			title: 'Below',
			authors: ['A. Writer'],
			audioSeconds: 36_060
		})
		const od = (s: number) =>
			row({
				provider: 'overdrive',
				id: `od-${s}`,
				title: 'Below',
				authors: ['A. Writer'],
				audioSeconds: s
			})
		expect((await search([od(36_025), audible], 'Below', 'A. Writer', 36_040_000))[0]?.id).toBe(
			'od-36025'
		)
		expect((await search([od(36_015), audible], 'Below', 'A. Writer', 36_040_000))[0]?.id).toBe(
			'B0BELOW001'
		)
	})

	test('the 2026-07-28 lesson holds: a row 0s off beats a listing 88s away', async () => {
		// 88s above Audible's minute is still 28s past its span, so the
		// byte-exact row keeps closest-runtime; the span never discards evidence.
		const ranked = await search(
			[
				row({
					id: 'B0OFF88000',
					asin: 'B0OFF88000',
					title: 'Exact',
					authors: ['A. Writer'],
					audioSeconds: 36_000
				}),
				row({
					provider: 'overdrive',
					id: 'od-exact',
					title: 'Exact',
					authors: ['A. Writer'],
					audioSeconds: 36_088
				})
			],
			'Exact',
			'A. Writer',
			36_088_000
		)
		expect(ranked[0]?.id).toBe('od-exact')
	})

	test('two Audible listings a minute apart: the one whose minute holds the file wins', async () => {
		// File 36,030s. Read as points both sit 30s off and the longer listing
		// won on the fraction's larger denominator; only 600 min can contain it.
		const ranked = await search(
			[
				row({
					id: 'B0AAAAAAA1',
					asin: 'B0AAAAAAA1',
					title: 'Twins',
					authors: ['A. Writer'],
					audioSeconds: 36_060
				}),
				row({
					id: 'B0ZZZZZZZ9',
					asin: 'B0ZZZZZZZ9',
					title: 'Twins',
					authors: ['A. Writer'],
					audioSeconds: 36_000
				})
			],
			'Twins',
			'A. Writer',
			36_030_000
		)
		expect(ranked[0]?.id).toBe('B0ZZZZZZZ9')
	})

	test("rows that are not Audible's still order by the scorer's own delta", async () => {
		// The change is invisible off Audible: same key, same unit (a fraction of
		// the row's runtime), so even equidistant rows keep their old order.
		const od = (s: number) =>
			row({
				provider: 'overdrive',
				id: `od-${s}`,
				title: 'Point',
				authors: ['A. Writer'],
				audioSeconds: s
			})
		const ranked = await search(
			[od(36_010), od(36_050), od(36_120)],
			'Point',
			'A. Writer',
			36_030_000
		)
		expect(ranked).toHaveLength(3)
		const byDelta = [...ranked].sort(
			(a, b) => (a.durationDeltaPct ?? 0) - (b.durationDeltaPct ?? 0)
		)
		expect(ranked.map((c) => c.id)).toEqual(byDelta.map((c) => c.id))
	})

	test("only Audible's minutes are spans: a Chaptarr whole minute stays a point", async () => {
		// Chaptarr's 600 min would hold the file as a span; read as a point it
		// is 40s off, and the OverDrive row 5s off keeps closest-runtime.
		const ranked = await search(
			[
				row({
					provider: 'chaptarr',
					id: 'B0CHAPTARR',
					asin: 'B0CHAPTARR',
					title: 'Copy',
					authors: ['A. Writer'],
					audioSeconds: 36_000
				}),
				row({
					provider: 'overdrive',
					id: 'od-copy',
					title: 'Copy',
					authors: ['A. Writer'],
					audioSeconds: 36_045
				})
			],
			'Copy',
			'A. Writer',
			36_040_000
		)
		expect(ranked[0]?.id).toBe('od-copy')
	})
})

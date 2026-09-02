import { describe, expect, test } from 'bun:test'

import { durationVerdict } from '#helpers/providers/chaptarrDuration'
import type { ChaptarrEdition } from '#helpers/providers/ChaptarrProvider'

// The two real incidents this exists to prevent, used as controls.
//
// Soldiers Live sat in the library as a 6.56h file of a 19.53h book and nothing
// detected it. Shadows Linger was FINE at 10.59h against an expected 10.55h, and
// was deleted on my advice because I read a wrong `mvhd` as real.
//
// The NEGATIVE control is the more important of the two: an oracle that cries
// wolf on a good file is worse than no oracle, because that is the failure that
// actually cost a file.
const ed = (o: Partial<ChaptarrEdition> = {}): ChaptarrEdition => ({
	asin: 'B0041HJKKY',
	durationSeconds: 1000,
	...o
})
const hours = (h: number) => h * 3600 * 1000

describe('durationVerdict', () => {
	describe('the real incidents', () => {
		test('Soldiers Live: 6.56h of a 19.53h three-part title is FLAGGED and diagnosed', () => {
			const got = durationVerdict(
				hours(6.56),
				ed({
					durationSeconds: 19.53 * 3600,
					isAudibleExpectedMultipart: true,
					audibleParts: [{ asin: 'a' }, { asin: 'b' }, { asin: 'c' }]
				}),
				'B0041HJKKY'
			)
			expect(got.band).toBe('flag')
			expect(Math.round(got.driftPct as number)).toBe(66)
			// The whole point: not "short by 66%" but "part 1 of 3".
			expect(got.diagnosis).toBe('looks like 1 of 3 part(s)')
		})

		test('Shadows Linger: 10.59h against an expected 10.55h AGREES', () => {
			// The negative control. A flag here is what deleted a good file.
			const got = durationVerdict(
				hours(10.59),
				ed({ asin: 'B003XX5CCM', durationSeconds: 10.55 * 3600 }),
				'B003XX5CCM'
			)
			expect(got.band).toBe('agree')
			expect(got.driftPct as number).toBeLessThan(1)
			expect(got.diagnosis).toBeUndefined()
		})
	})

	describe('banding at the boundaries', () => {
		// SHORT values throughout: since the flag band is short-only, a long
		// boundary table would silently test nothing but the report path.
		// Per the spec: `< 2%` agrees (so exactly 2% reports), `> 10%` flags (so
		// exactly 10% reports). Decided on cross-multiplied integers, because
		// (a / b) * 100 lands either side of 2 depending on b.
		test.each([
			[981, 'agree'],
			[980, 'report'],
			[900, 'report'],
			[899, 'flag']
		])('%ds against 1000s expected -> %s', (plexSec, band) => {
			expect(durationVerdict((plexSec as number) * 1000, ed(), 'B0041HJKKY').band).toBe(band)
		})
	})

	test('the boundary holds for an awkward denominator, not just 1000', () => {
		// 60s and 70308s (Soldiers Live's own length) both put (a/b)*100 a hair off
		// 2 and 10; integer cross-multiplication does not.
		for (const expected of [60, 70308, 12345]) {
			expect(
				durationVerdict(expected * 0.98 * 1000, ed({ durationSeconds: expected }), 'B0041HJKKY')
					.band
			).toBe('report')
			expect(
				durationVerdict(expected * 0.9 * 1000, ed({ durationSeconds: expected }), 'B0041HJKKY').band
			).toBe('report')
			expect(
				durationVerdict(expected * 0.899 * 1000, ed({ durationSeconds: expected }), 'B0041HJKKY')
					.band
			).toBe('flag')
		}
	})

	describe('what must never produce an alarm', () => {
		test('a missing durationSeconds is a SKIP, not 100% drift', () => {
			// Absent is not zero. Reading it as zero builds an alarm out of missing
			// data and would flag every edition Chaptarr has not measured.
			for (const bad of [undefined, null, 0]) {
				const got = durationVerdict(hours(10), ed({ durationSeconds: bad }), 'B0041HJKKY')
				expect(got.band).toBe('skip')
				expect(got.driftPct).toBeNull()
			}
		})

		test('no edition at all is a SKIP', () => {
			expect(durationVerdict(hours(10), null, 'B0041HJKKY').band).toBe('skip')
		})

		test('a file with no analysed duration is a SKIP', () => {
			expect(durationVerdict(0, ed(), 'B0041HJKKY').band).toBe('skip')
		})

		test('a VARIANT match never flags, however far it drifts', () => {
			// editionForAsin resolves through providerIdsAll.az, so a regional asin
			// can return the PARENT edition whose duration legitimately differs.
			// This is the main false-positive source and is capped at report.
			// Must drift SHORT, or it never reaches the flag band this cap exists to
			// intercept and the test passes without exercising anything.
			const got = durationVerdict(100_000, ed({ asin: 'B00PARENT1' }), 'B00HYG9KMC')
			expect(got.exactAsin).toBe(false)
			expect(got.band).toBe('report')
			expect(got.reason).toContain('variant')
		})
	})

	describe('direction matters: only SHORT means missing content', () => {
		// Measured on the first live run: a pirateaba Wandering Inn volume came back
		// 42.38h against an expected 38.25h -- 10.8% LONG -- while Chaptarr's own
		// record was internally inconsistent about it. Over-length is an edition
		// difference or bonus material, not damage. Flagging it trains the operator
		// to ignore flags, and an ignored flag is the same as no oracle.
		test('a file 10.8% LONGER reports, never flags', () => {
			const got = durationVerdict(hours(42.38), ed({ durationSeconds: 38.25 * 3600 }), 'B0041HJKKY')
			expect(got.direction).toBe('long')
			expect(got.band).toBe('report')
			expect(got.reason).toContain('not damage')
		})

		test('the SAME drift the other way FLAGS', () => {
			// Identical magnitude, opposite verdict -- 892s and 1108s are both 10.8%
			// off 1000s. My first attempt at this compared 38.25h to 42.38h and
			// called it "the same drift", which is 9.7% and under the threshold:
			// the percentage depends on which side is the denominator.
			const long = durationVerdict(1108 * 1000, ed(), 'B0041HJKKY')
			const short = durationVerdict(892 * 1000, ed(), 'B0041HJKKY')
			expect(long.driftPct?.toFixed(1)).toBe(short.driftPct?.toFixed(1))
			expect(long.band).toBe('report')
			expect(short.band).toBe('flag')
		})

		test('a hugely LONG file still only reports', () => {
			// Even two books merged into one file is not the failure this catches, and
			// a truncation oracle that shouts about over-length is a worse oracle.
			expect(
				durationVerdict(hours(40), ed({ durationSeconds: 10 * 3600 }), 'B0041HJKKY').band
			).toBe('report')
		})
	})

	describe('the multipart diagnosis', () => {
		test('does not fire when the title is not expected to be multipart', () => {
			const got = durationVerdict(
				hours(1),
				ed({ durationSeconds: 3 * 3600, isAudibleExpectedMultipart: false, audibleParts: [] }),
				'B0041HJKKY'
			)
			expect(got.band).toBe('flag')
			expect(got.diagnosis).toBeUndefined()
		})

		test('does not fire when the shortfall is not a clean k/N', () => {
			// 40% of a 3-part title is neither 1/3 nor 2/3 -- something else is wrong
			// and guessing a part count would be worse than saying nothing.
			const got = durationVerdict(
				3 * 3600 * 0.4 * 1000,
				ed({
					durationSeconds: 3 * 3600,
					isAudibleExpectedMultipart: true,
					audibleParts: [{ asin: 'a' }, { asin: 'b' }, { asin: 'c' }]
				}),
				'B0041HJKKY'
			)
			expect(got.band).toBe('flag')
			expect(got.diagnosis).toBeUndefined()
		})

		test('names the NEAREST k, measured in part units', () => {
			// 19.6h of a 24h six-part title: 0.4h from the 5-of-6 boundary (20h),
			// inside a 0.15-part (0.6h) window.
			const six = Array.from({ length: 6 }, (_, i) => ({ asin: String(i) }))
			const got = durationVerdict(
				hours(19.6),
				ed({ durationSeconds: 24 * 3600, isAudibleExpectedMultipart: true, audibleParts: six }),
				'B0041HJKKY'
			)
			expect(got.diagnosis).toBe('looks like 5 of 6 part(s)')
		})

		test('the first-fit trap: a value inside the OLD k=4 window gets NO diagnosis now', () => {
			// 18.24h of 24h across 6 parts. A tolerance relative to k*part put this
			// inside the k=4 window [13.6h, 18.4h] and printed "4 of 6", though 5 of 6
			// (20h) is nearer. In part units it is 1.76h from the nearest boundary
			// against a 0.6h window: ambiguous, so say nothing rather than name a
			// wrong number of missing parts.
			const six = Array.from({ length: 6 }, (_, i) => ({ asin: String(i) }))
			const got = durationVerdict(
				hours(18.24),
				ed({ durationSeconds: 24 * 3600, isAudibleExpectedMultipart: true, audibleParts: six }),
				'B0041HJKKY'
			)
			expect(got.band).toBe('flag')
			expect(got.diagnosis).toBeUndefined()
		})

		test('an ambiguous shortfall between two k yields NO diagnosis', () => {
			// 570 of 1000 across 8 parts (125 each) is 4.56 parts -- nearer 5 (625)
			// but 55s off it, past a 0.15-part window of 18.75s. Say nothing rather
			// than name a wrong number of missing parts.
			const got = durationVerdict(
				570 * 1000,
				ed({
					durationSeconds: 1000,
					isAudibleExpectedMultipart: true,
					audibleParts: Array.from({ length: 8 }, (_, i) => ({ asin: String(i) }))
				}),
				'B0041HJKKY'
			)
			expect(got.band).toBe('flag')
			expect(got.diagnosis).toBeUndefined()
		})

		test('reports 2 of 3 when two parts survived the merge', () => {
			const got = durationVerdict(
				2 * 3600 * 1000,
				ed({
					durationSeconds: 3 * 3600,
					isAudibleExpectedMultipart: true,
					audibleParts: [{ asin: 'a' }, { asin: 'b' }, { asin: 'c' }]
				}),
				'B0041HJKKY'
			)
			expect(got.diagnosis).toBe('looks like 2 of 3 part(s)')
		})
	})
})

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
		test.each([
			[1020, 'agree'],
			[1021, 'report'],
			[1100, 'report'],
			[1101, 'flag']
		])('%ds against 1000s expected -> %s', (plexSec, band) => {
			expect(durationVerdict((plexSec as number) * 1000, ed(), 'B0041HJKKY').band).toBe(band)
		})
	})

	describe('what must never produce an alarm', () => {
		test('a missing durationSeconds is a SKIP, not 100% drift', () => {
			// Absent is not zero. Reading it as zero builds an alarm out of missing
			// data and would flag every edition Chaptarr has not measured.
			for (const bad of [undefined, null, 0]) {
				const got = durationVerdict(hours(10), ed({ durationSeconds: bad as never }), 'B0041HJKKY')
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
			const got = durationVerdict(hours(2), ed({ asin: 'B00PARENT1' }), 'B00HYG9KMC')
			expect(got.exactAsin).toBe(false)
			expect(got.band).toBe('report')
			expect(got.reason).toContain('variant')
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

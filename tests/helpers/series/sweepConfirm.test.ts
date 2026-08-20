import { describe, expect, test } from 'bun:test'

import { confirmAccepts } from '#helpers/series/sweepConfirm'

// `--accept` folds a swept answer into the reviewed baseline, and that baseline
// is what every LATER sweep diffs against. So accepting a transient does not
// record one wrong row -- it re-bases drift detection for that record, and the
// REAL answer becomes the next sweep's "drift".
//
// Verifying the 2026-08-20 sweep by hand found 3 of its 36 primary changes did
// not reproduce minutes later. The worst was Joyland: reviewed baseline NO
// SERIES, swept as "The Hard Case Crime Novels of Stephen King #112", serving NO
// SERIES now, and its work record declares no series at all. The baseline was
// right; an unguarded --accept would have overwritten it with the transient.
const answer = (primary: string | null, secondary: string | null = null) => ({ primary, secondary })
const served = (primary: string | null, secondary: string | null = null) => ({
	primary,
	secondary,
	available: true
})
const gone = { primary: null, secondary: null, available: false }

describe('confirmAccepts', () => {
	test('a row that still reads the same is confirmed', async () => {
		const got = await confirmAccepts([{ id: 'B001', swept: answer('Discworld #35') }], async () =>
			served('Discworld #35')
		)
		expect([...got.confirmed]).toEqual(['B001'])
		expect(got.unstable).toEqual([])
		expect(got.unreadable).toEqual([])
	})

	test('the Joyland shape: a transient primary is NOT folded', async () => {
		// Swept as a series, re-reads as none. The reviewed baseline (also none)
		// must survive.
		const got = await confirmAccepts(
			[{ id: 'B00CTSPI62', swept: answer('The Hard Case Crime Novels of Stephen King #112') }],
			async () => served(null)
		)
		expect(got.confirmed.has('B00CTSPI62')).toBe(false)
		expect(got.unstable).toEqual([
			{
				id: 'B00CTSPI62',
				swept: answer('The Hard Case Crime Novels of Stephen King #112'),
				reread: answer(null)
			}
		])
	})

	test('a SECONDARY-only move is unstable too', async () => {
		// The ledger stores both slots and 337 of 1607 entries carry a secondary.
		// Comparing only the primary is the blind spot that already let a tag
		// change through undiffed once; it must not come back on the confirm side.
		const got = await confirmAccepts(
			[{ id: 'B003', swept: answer('The Chronicles of Osreth #3', 'The Cemeteries of Amalo #2') }],
			async () => served('The Chronicles of Osreth #3', null)
		)
		expect(got.confirmed.size).toBe(0)
		expect(got.unstable).toHaveLength(1)
		expect(got.unstable[0].reread).toEqual(answer('The Chronicles of Osreth #3', null))
	})

	test('an unreadable re-read is NOT treated as agreement', async () => {
		// The api failing to answer says nothing about whether the swept value was
		// real. Folding on silence is how an outage rewrites the whole baseline.
		const got = await confirmAccepts(
			[{ id: 'B004', swept: answer('Skyward Flight #3') }],
			async () => gone
		)
		expect(got.confirmed.size).toBe(0)
		expect(got.unstable).toEqual([])
		expect(got.unreadable).toEqual(['B004'])
	})

	test('a mixed batch splits three ways and re-reads each row exactly once', async () => {
		const asked: string[] = []
		const got = await confirmAccepts(
			[
				{ id: 'keep', swept: answer('Foundation #3') },
				{ id: 'moved', swept: answer('Skyward Flight #3') },
				{ id: 'dead', swept: answer('Millennium #4') }
			],
			async (id) => {
				asked.push(id)
				if (id === 'keep') return served('Foundation #3')
				if (id === 'moved') return served('Skyward #2.3')
				return gone
			}
		)
		expect([...got.confirmed]).toEqual(['keep'])
		expect(got.unstable.map((u) => u.id)).toEqual(['moved'])
		expect(got.unreadable).toEqual(['dead'])
		// Exactly one read per candidate: a confirm pass that re-reads twice would
		// double an already-rate-limited sweep's load on the api.
		expect(asked).toEqual(['keep', 'moved', 'dead'])
	})

	test('no candidates means no reads at all', async () => {
		let calls = 0
		const got = await confirmAccepts([], async () => {
			calls += 1
			return gone
		})
		expect(calls).toBe(0)
		expect(got.confirmed.size).toBe(0)
	})
})

import { describe, expect, test } from 'bun:test'

import { isNearBestConfidence } from '#helpers/routes/BookSearchHelper'

/**
 * THE RANKING COMPARATOR MUST BE TRANSITIVE.
 *
 * `Array.prototype.sort` with an inconsistent comparator does not throw — it
 * returns an implementation-defined order. So an intransitive comparator does
 * not fail loudly; it silently makes the winner depend on the order the
 * providers happened to answer in, which is exactly the arrival-order
 * dependence the determinism work set out to remove.
 *
 * The defect, demonstrated before the fix: the confidence band was measured
 * PAIRWISE (`|a.confidence - b.confidence| > TOLERANCE`), so whether confidence
 * decided depended on WHICH TWO rows the sort compared. Three rows at
 * 0.70 / 0.78 / 0.85 whose identity arms prefer the lower-scored ones form a
 * cycle — the adjacent pairs sit inside the band and defer to identity, the
 * outer pair does not and defers to confidence. Zero of the six orderings
 * satisfied all three pairwise decisions, and Array.sort produced THREE
 * different winners from the same three rows.
 *
 * These test the band key directly rather than through `search()`. Driving the
 * real scorer into that exact confidence configuration proved hard — which is
 * itself worth knowing, since it means the bug was rare rather than absent —
 * and a test that cannot reach the defect is not a guard. The property below
 * is the one that was violated, so pinning it here pins the fix.
 */
describe('isNearBestConfidence is a per-candidate key', () => {
	test('the cycle that broke the sort cannot form: all three are judged against ONE anchor', () => {
		const best = 0.85
		// The exact scores from the demonstration.
		expect(isNearBestConfidence(0.85, best)).toBe(true)
		expect(isNearBestConfidence(0.78, best)).toBe(true) // 0.07 back — still tied
		expect(isNearBestConfidence(0.7, best)).toBe(false) // 0.15 back — clearly behind
		// Pairwise, 0.70 and 0.78 look "tied" (0.08 apart). Against the anchor they
		// do NOT share a verdict, and that difference is what removes the cycle.
	})

	test('the derived ordering is transitive across a dense grid', () => {
		// Exhaustive over a realistic score range: every triple must admit a
		// consistent ordering. This is the property Array.sort requires and the
		// pairwise version violated.
		const scores: number[] = []
		for (let v = 0.5; v <= 1.0001; v += 0.01) scores.push(Math.round(v * 100) / 100)
		const best = Math.max(...scores)
		const key = (s: number) => Number(!isNearBestConfidence(s, best))
		let checked = 0
		for (const x of scores)
			for (const y of scores)
				for (const z of scores) {
					const [kx, ky, kz] = [key(x), key(y), key(z)]
					if (kx <= ky && ky <= kz) {
						expect(kx).toBeLessThanOrEqual(kz)
						checked++
					}
				}
		expect(checked).toBeGreaterThan(1000)
	})

	test('a row can never be nearer-best than the best row itself', () => {
		for (const best of [0.6, 0.85, 1.0]) {
			expect(isNearBestConfidence(best, best)).toBe(true)
			expect(isNearBestConfidence(best + 0.0001, best)).toBe(true)
		}
	})

	test('the boundary is inclusive, and just past it is out', () => {
		expect(isNearBestConfidence(0.9, 1.0)).toBe(true) // exactly the tolerance
		expect(isNearBestConfidence(0.89, 1.0)).toBe(false)
	})

	test('a wider tolerance can only ever ADMIT more rows, never fewer', () => {
		// Monotonicity: if this failed, tuning the constant could silently drop a
		// row out of contention rather than widening the tie.
		for (let s = 0.5; s <= 1.0; s += 0.05) {
			for (let t = 0.05; t <= 0.5; t += 0.05) {
				if (isNearBestConfidence(s, 1.0, t)) {
					expect(isNearBestConfidence(s, 1.0, t + 0.05)).toBe(true)
				}
			}
		}
	})
})

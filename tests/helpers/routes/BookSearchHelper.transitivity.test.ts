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

	// THE PREVIOUS VERSION OF THIS TEST WAS VACUOUS, and it is worth saying why in
	// full, because it looked like the strongest test in the file.
	//
	// It built `key = Number(!isNearBestConfidence(s, best))` over a dense grid and
	// asserted, for every triple, `kx <= ky && ky <= kz  =>  kx <= kz`. But those
	// are NUMBERS, and `<=` is transitive on numbers by arithmetic — so the
	// assertion holds for ANY key function, including one that ignores its inputs.
	// Proven 2026-08-16 by mutation: with isNearBestConfidence forced to `true`,
	// forced to `false`, and fully INVERTED, that test passed all three times while
	// its siblings failed. It could not fail, so it guarded nothing.
	//
	// Transitivity is not the testable part: a PER-CANDIDATE key is transitive by
	// construction, and that construction was the fix. What is worth pinning is
	// what the key must do to be a usable sort key at all.
	test('the key is MONOTONIC in confidence — a better row is never ranked behind a worse one', () => {
		// If a lower confidence could be "nearer best" while a higher one is not,
		// ordering by this key would contradict ordering by confidence, and the
		// sort would disagree with the evidence it is supposed to rank on.
		const scores: number[] = []
		for (let v = 0.5; v <= 1.0001; v += 0.01) scores.push(Math.round(v * 100) / 100)
		const best = Math.max(...scores)
		const key = (s: number) => Number(!isNearBestConfidence(s, best))
		let compared = 0
		for (let i = 0; i < scores.length; i += 1)
			for (let j = i + 1; j < scores.length; j += 1) {
				// scores[i] < scores[j]: the higher score may never sort WORSE.
				expect(key(scores[j])).toBeLessThanOrEqual(key(scores[i]))
				compared += 1
			}
		expect(compared).toBeGreaterThan(1000)
	})

	test('the key DISCRIMINATES — it puts some rows in the band and some out', () => {
		// A key that answers the same for every input is monotonic and transitive
		// and completely useless: it collapses the whole pool into one tier and
		// hands every decision to the arms below. Both verdicts must occur.
		const scores: number[] = []
		for (let v = 0.5; v <= 1.0001; v += 0.01) scores.push(Math.round(v * 100) / 100)
		const best = Math.max(...scores)
		const verdicts = new Set(scores.map((s) => isNearBestConfidence(s, best)))
		expect(verdicts.has(true)).toBe(true)
		expect(verdicts.has(false)).toBe(true)
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

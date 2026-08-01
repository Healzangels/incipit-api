import { describe, expect, test } from 'bun:test'

import { withNearTieAlternates } from '#helpers/providers/nearTieCovers'
import type { ScoredCandidate } from '#helpers/providers/types'

/**
 * BORROWING ART BETWEEN NEAR-TIED CANDIDATES.
 *
 * dedupe merges only what it can prove is one record, so a search routinely
 * ends with two rows a point apart — "The Testaments (TV Tie-in)" at 100 and
 * "The Testaments" at 99 — obviously the same recording in different packaging,
 * each carrying its own art. Match either and you see only its own cover.
 *
 * Measured across 30 real library books before this was built: 29 had a near-tie
 * inside two points, and 21 of those shared a narrator set.
 *
 * Of the pairs that did NOT share narrators, almost all were ABSENT rather than
 * conflicting — a Hardcover print row lists none — and exactly one was a real
 * conflict: "The Restaurant at the End of the Universe" offering Zannie Adams
 * beside Martin Freeman. That single row is the reason absence cannot count as
 * a match.
 */
function scored(over: Partial<ScoredCandidate>): ScoredCandidate {
	return {
		provider: 'audible',
		id: 'x',
		asin: null,
		title: 'The Testaments',
		authors: ['Margaret Atwood'],
		narrators: ['Ann Dowd'],
		audioSeconds: 47000,
		cover: null,
		confidence: 1,
		durationDeltaPct: null,
		...over
	}
}

describe('withNearTieAlternates', () => {
	test('a near-tie with the same narrators lends its cover', () => {
		const out = withNearTieAlternates([
			scored({ id: 'a', confidence: 1, cover: 'tie-in.jpg' }),
			scored({ id: 'b', confidence: 0.99, cover: 'plain.jpg' })
		])
		expect(out[0].coverAlternates).toEqual(['plain.jpg'])
	})

	test('the borrow is SYMMETRIC — either row may be the one matched', () => {
		const out = withNearTieAlternates([
			scored({ id: 'a', confidence: 1, cover: 'tie-in.jpg' }),
			scored({ id: 'b', confidence: 0.99, cover: 'plain.jpg' })
		])
		expect(out[1].coverAlternates).toEqual(['tie-in.jpg'])
	})

	test('a candidate outside the band lends nothing', () => {
		const out = withNearTieAlternates([
			scored({ id: 'a', confidence: 1, cover: 'win.jpg' }),
			scored({ id: 'b', confidence: 0.9, cover: 'far.jpg' })
		])
		expect(out[0].coverAlternates).toBeUndefined()
	})

	test('a DIFFERENT narrator lends nothing — the Zannie Adams case', () => {
		// The one real conflict in the measured sample: a different recording of
		// the same title. Borrowing its art puts the wrong edition's cover up.
		const out = withNearTieAlternates([
			scored({ id: 'a', confidence: 1, cover: 'freeman.jpg', narrators: ['Martin Freeman'] }),
			scored({ id: 'b', confidence: 0.99, cover: 'adams.jpg', narrators: ['Zannie Adams'] })
		])
		expect(out[0].coverAlternates).toBeUndefined()
		expect(out[1].coverAlternates).toBeUndefined()
	})

	test('ABSENT narrators lend nothing — absence is not a match', () => {
		// Where the print rows live. This is the majority of non-matching pairs,
		// and treating it as a match is how print jackets would get in.
		const out = withNearTieAlternates([
			scored({ id: 'a', confidence: 1, cover: 'win.jpg' }),
			scored({ id: 'b', confidence: 0.99, cover: 'noname.jpg', narrators: [] })
		])
		expect(out[0].coverAlternates).toBeUndefined()
		expect(out[1].coverAlternates).toBeUndefined()
	})

	test('TWO narrator-less rows do not borrow from each other', () => {
		// The gap M2 exposed: guarding only the OTHER side lets two rows with no
		// narrators match on '' == '' and swap art with nothing corroborating it.
		const out = withNearTieAlternates([
			scored({ id: 'a', confidence: 1, cover: 'a.jpg', narrators: [] }),
			scored({ id: 'b', confidence: 0.99, cover: 'b.jpg', narrators: [] })
		])
		expect(out[0].coverAlternates).toBeUndefined()
		expect(out[1].coverAlternates).toBeUndefined()
	})

	test('WHITESPACE in a narrator name still matches', () => {
		// Measured live: the same book returned "Martin Freeman" and
		// "Martin  Freeman". Without collapsing, this rule rejects a genuine
		// match and silently halves the yield.
		const out = withNearTieAlternates([
			scored({ id: 'a', confidence: 1, cover: 'a.jpg', narrators: ['Martin Freeman'] }),
			scored({ id: 'b', confidence: 0.99, cover: 'b.jpg', narrators: ['Martin  Freeman'] })
		])
		expect(out[0].coverAlternates).toEqual(['b.jpg'])
	})

	test('narrator order and case do not matter', () => {
		const out = withNearTieAlternates([
			scored({ id: 'a', confidence: 1, cover: 'a.jpg', narrators: ['Ann Dowd', 'Mae Whitman'] }),
			scored({ id: 'b', confidence: 0.99, cover: 'b.jpg', narrators: ['MAE WHITMAN', 'ann dowd'] })
		])
		expect(out[0].coverAlternates).toEqual(['b.jpg'])
	})

	test('a PRINT row neither lends nor borrows', () => {
		const out = withNearTieAlternates([
			scored({ id: 'a', confidence: 1, cover: 'audio.jpg' }),
			scored({
				id: 'p',
				provider: 'hardcover',
				confidence: 0.99,
				cover: 'jacket.jpg',
				audioSeconds: null
			})
		])
		expect(out[0].coverAlternates).toBeUndefined()
		expect(out[1].coverAlternates).toBeUndefined()
	})

	test('the same asset at a different size is not offered twice', () => {
		const out = withNearTieAlternates([
			scored({ id: 'a', confidence: 1, cover: 'https://m.media-amazon.com/images/I/51A._SL500_.jpg' }),
			scored({
				id: 'b',
				confidence: 0.99,
				cover: 'https://m.media-amazon.com/images/I/51A._SX450_.jpg'
			})
		])
		expect(out[0].coverAlternates).toBeUndefined()
	})

	test('existing alternates are kept, not replaced', () => {
		const out = withNearTieAlternates([
			scored({ id: 'a', confidence: 1, cover: 'a.jpg', coverAlternates: ['from-dedupe.jpg'] }),
			scored({ id: 'b', confidence: 0.99, cover: 'b.jpg' })
		])
		expect(out[0].coverAlternates).toEqual(['from-dedupe.jpg', 'b.jpg'])
	})

	test('a lone candidate is returned untouched', () => {
		const one = [scored({ id: 'a', cover: 'a.jpg' })]
		expect(withNearTieAlternates(one)).toEqual(one)
		expect(withNearTieAlternates([])).toEqual([])
	})
})

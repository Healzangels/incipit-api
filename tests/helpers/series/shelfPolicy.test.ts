import { describe, expect, test } from 'bun:test'

import { applyShelfPolicy, CONTAINER_SHELF_NAMES } from '#helpers/series/shelfPolicy'

// Q2, decided 2026-07-30 (tests/fixtures/series-decisions.json): a positionless
// primary never ships as the shelf. A positioned secondary is PROMOTED; a real
// sub-series name demotes to the tag slot; a cross-author franchise container
// is dropped entirely; an omnibus range ("1-3") is not a position. Applied at
// serve time so warm cache entries obey it too — no invalidation required.
describe('applyShelfPolicy', () => {
	test('a positioned primary passes through untouched', () => {
		const book = {
			title: 'Starless Night',
			seriesPrimary: { name: 'The Legend of Drizzt', position: '8' },
			seriesSecondary: { name: 'Legacy of the Drow', position: '2' }
		}
		expect(applyShelfPolicy(book)).toEqual(book)
	})

	test('a positionless primary with a POSITIONED secondary promotes it', () => {
		// Baneblade: primary "Warhammer 40,000" (no position), secondary
		// "Warhammer 40,000 : Imperial Guard" #1 — the shelf was behind it all along.
		const out = applyShelfPolicy({
			title: 'Baneblade',
			seriesPrimary: { name: 'Warhammer 40,000' },
			seriesSecondary: { name: 'Warhammer 40,000 : Imperial Guard', position: '1' }
		})
		expect(out.seriesPrimary).toEqual({ name: 'Warhammer 40,000 : Imperial Guard', position: '1' })
		// The vacated container name is NOT retained as a tag.
		expect(out.seriesSecondary).toBeUndefined()
	})

	test('a vacated NON-container primary name is kept as the tag', () => {
		const out = applyShelfPolicy({
			title: 'Some Book',
			seriesPrimary: { name: 'Real Series' },
			seriesSecondary: { name: 'Sub Arc', position: '2' }
		})
		expect(out.seriesPrimary).toEqual({ name: 'Sub Arc', position: '2' })
		expect(out.seriesSecondary).toEqual({ name: 'Real Series' })
	})

	test('a positionless sub-series name demotes to the tag slot', () => {
		// Garro: Oath of Moment — The Horus Heresy names it but cannot place it.
		const out = applyShelfPolicy({
			title: 'Garro: Oath of Moment',
			seriesPrimary: { name: 'The Horus Heresy' }
		})
		expect(out.seriesPrimary).toBeUndefined()
		expect(out.seriesSecondary).toEqual({ name: 'The Horus Heresy' })
	})

	test('a positionless CONTAINER name is dropped entirely', () => {
		// Brothers of the Snake — "Warhammer 40,000" is a cross-author franchise
		// container: never a shelf, and under the split policy not even a tag.
		const out = applyShelfPolicy({
			title: 'Brothers of the Snake',
			seriesPrimary: { name: 'Warhammer 40,000' }
		})
		expect(out.seriesPrimary).toBeUndefined()
		expect(out.seriesSecondary).toBeUndefined()
	})

	test('an omnibus RANGE is not a position', () => {
		// The Society of the Sword Trilogy — "#1-3" must never shelve (and never
		// resolve to range-start); the name survives as a tag.
		const out = applyShelfPolicy({
			title: 'The Society of the Sword Trilogy',
			seriesPrimary: { name: 'Society of the Sword', position: '1-3' }
		})
		expect(out.seriesPrimary).toBeUndefined()
		expect(out.seriesSecondary).toEqual({ name: 'Society of the Sword', position: '1-3' })
	})

	test('demotion never overwrites an existing positionless secondary', () => {
		const out = applyShelfPolicy({
			title: 'Some Book',
			seriesPrimary: { name: 'Primary Name' },
			seriesSecondary: { name: 'Existing Tag' }
		})
		expect(out.seriesPrimary).toBeUndefined()
		expect(out.seriesSecondary).toEqual({ name: 'Existing Tag' })
	})

	test('promotion never creates a duplicate pair', () => {
		// Same series in both slots (the fb058d2 class): promote and clear.
		const out = applyShelfPolicy({
			title: 'Nemesis',
			seriesPrimary: { name: 'Orphan X' },
			seriesSecondary: { name: 'Orphan X', position: '10' }
		})
		expect(out.seriesPrimary).toEqual({ name: 'Orphan X', position: '10' })
		expect(out.seriesSecondary).toBeUndefined()
	})

	test('a POSITIONED primary with a same-series echo clears the echo', () => {
		// The other half of the dup class: primary already positioned, secondary
		// repeats it (Atlee Pine / Exlian Syndrome shape at the apply layer).
		const out = applyShelfPolicy({
			title: 'Daylight',
			seriesPrimary: { name: 'Atlee Pine', position: '3' },
			seriesSecondary: { name: 'Atlee Pine', position: '3' }
		})
		expect(out.seriesPrimary).toEqual({ name: 'Atlee Pine', position: '3' })
		expect(out.seriesSecondary).toBeUndefined()
	})

	test('a book with no series at all is untouched', () => {
		const book = { title: 'Standalone' }
		expect(applyShelfPolicy(book)).toEqual(book)
	})

	test('the container list is folded-exact, not substring', () => {
		// "The Xenos: Warhammer 40,000" CONTAINS a container name but is not one —
		// R5: identity is narrow, never substring.
		expect(CONTAINER_SHELF_NAMES.has('warhammer 40,000')).toBe(true)
		const out = applyShelfPolicy({
			title: 'Hand of Darkness',
			seriesPrimary: { name: 'The Xenos: Warhammer 40,000' }
		})
		expect(out.seriesSecondary).toEqual({ name: 'The Xenos: Warhammer 40,000' })
	})
})

/**
 * R2: an umbrella / franchise CONTAINER never shelves — even when the provider
 * hands it a position.
 *
 * The module header has always said so, but `isContainer` was consulted ONLY
 * inside the demote-to-tag branch, so a container arriving POSITIONED returned
 * from the early `positioned(primary)` guard untouched. Live on both boxes
 * 2026-07-31: The Sunlit Man served `The Cosmere #32` while `Secret Projects
 * #4` — the real positioned publishing series — sat in the secondary slot, and
 * the golden corpus requires exactly that. A number from an umbrella is still
 * an umbrella; it is a coordinate in a franchise, not a place on a shelf.
 */
describe('a POSITIONED container still never shelves', () => {
	test('The Sunlit Man: the container yields to the real series beside it', () => {
		const out = applyShelfPolicy({
			title: 'The Sunlit Man',
			seriesPrimary: { name: 'The Cosmere', position: '32' },
			seriesSecondary: { name: 'Secret Projects', position: '4' }
		})
		expect(out.seriesPrimary).toEqual({ name: 'Secret Projects', position: '4' })
		// The VACATED container does not become a tag here. Note this is not
		// the same question as the operator's 2026-07-31 containerTagPolicy
		// decision, which was about the 39 rows where a container ARRIVES as
		// the secondary — those are untouched. Making the two paths uniform is
		// a separate, unmeasured change: it would newly ADD tags to rows that
		// have none today, which is why it is deliberately not made here.
		expect(out.seriesSecondary).toBeUndefined()
	})

	test('a positioned container with NO alternative shelves nothing', () => {
		const out = applyShelfPolicy({
			title: 'Some Warhammer Book',
			seriesPrimary: { name: 'Warhammer 40,000', position: '55' }
		})
		expect(out.seriesPrimary).toBeUndefined()
	})

	test('a NON-container positioned primary is still untouched', () => {
		// The guard must stay narrow: this is the overwhelmingly common path.
		const book = {
			title: 'Starless Night',
			seriesPrimary: { name: 'The Legend of Drizzt', position: '8' },
			seriesSecondary: { name: 'Legacy of the Drow', position: '2' }
		}
		expect(applyShelfPolicy(book)).toEqual(book)
	})

	test('a name that merely CONTAINS a container name is not one', () => {
		// R5, folded-exact never substring.
		const book = {
			title: 'Hand of Darkness',
			seriesPrimary: { name: 'The Xenos: Warhammer 40,000', position: '1' }
		}
		expect(applyShelfPolicy(book)).toEqual(book)
	})
})

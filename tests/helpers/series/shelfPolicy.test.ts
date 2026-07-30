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

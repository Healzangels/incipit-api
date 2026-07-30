import { describe, expect, test } from 'bun:test'

import { applyPins, type ShelfPin } from '#helpers/series/shelfPins'

// Answer-level pins: operator-stated shelves for records the resolver cannot
// derive (mirror 500s, name-form drift, search recall) or derives wrongly.
// A pin is DATA minted from the golden corpus — the operator's stated truth —
// never a number the system invents (R4).
describe('applyPins', () => {
	const pins: Record<string, ShelfPin> = {
		B00FRILVJ1: { series: 'The Riyria Chronicles', position: '1', source: 'census-verdict' },
		B0UNFETTER: { none: true, source: 'operator-stated' },
		B0TAGKEEP1: { none: true, keepTag: true, source: 'operator-stated' }
	}

	test('an unpinned record passes through untouched', () => {
		const book = { title: 'X', seriesPrimary: { name: 'Whatever', position: '9' } }
		expect(applyPins(book, 'B000000000', pins)).toEqual(book)
	})

	test('a pin REPLACES the resolved primary', () => {
		const out = applyPins(
			{ title: 'The Crown Tower', seriesPrimary: { name: 'Riyria', position: '1' } },
			'B00FRILVJ1',
			pins
		)
		expect(out.seriesPrimary).toEqual({ name: 'The Riyria Chronicles', position: '1' })
	})

	test('a pin applies when the resolver produced NOTHING', () => {
		const out = applyPins({ title: 'The Crown Tower' }, 'B00FRILVJ1', pins)
		expect(out.seriesPrimary).toEqual({ name: 'The Riyria Chronicles', position: '1' })
	})

	test('a NONE-pin suppresses the shelf and the tag', () => {
		const out = applyPins(
			{
				title: 'Unfettered',
				seriesPrimary: { name: 'Tales by Masters of Fantasy', position: '1' }
			},
			'B0UNFETTER',
			pins
		)
		expect(out.seriesPrimary).toBeUndefined()
		expect(out.seriesSecondary).toBeUndefined()
	})

	test('a NONE-pin with keepTag demotes the name instead of erasing it', () => {
		const out = applyPins(
			{ title: 'Y', seriesPrimary: { name: 'Some Real Series', position: '4' } },
			'B0TAGKEEP1',
			pins
		)
		expect(out.seriesPrimary).toBeUndefined()
		expect(out.seriesSecondary).toEqual({ name: 'Some Real Series', position: '4' })
	})

	test('a pin clears a secondary that would echo it', () => {
		const out = applyPins(
			{
				title: 'The Crown Tower',
				seriesPrimary: { name: 'Riyria', position: '1' },
				seriesSecondary: { name: 'The Riyria Chronicles', position: '1' }
			},
			'B00FRILVJ1',
			pins
		)
		expect(out.seriesPrimary).toEqual({ name: 'The Riyria Chronicles', position: '1' })
		expect(out.seriesSecondary).toBeUndefined()
	})

	test('a displaced non-echo resolver answer survives as the tag', () => {
		const out = applyPins(
			{ title: 'The Crown Tower', seriesPrimary: { name: 'Riyria', position: '1' } },
			'B00FRILVJ1',
			pins
		)
		expect(out.seriesSecondary).toEqual({ name: 'Riyria', position: '1' })
	})
})

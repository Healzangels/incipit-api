import { describe, expect, test } from 'bun:test'

import { applyPins, type ShelfPin } from '#helpers/series/shelfPins'
import { SHELF_PINS } from '#helpers/series/shelfPins.data'
import { applyShelfPolicy,SERIES_ALIASES } from '#helpers/series/shelfPolicy'

// Answer-level pins: operator-stated shelves for records the resolver cannot
// derive (mirror 500s, name-form drift, search recall) or derives wrongly.
// A pin is DATA minted from the golden corpus — the operator's stated truth —
// never a number the system invents (R4).
//
// Several assertions below use toStrictEqual deliberately: toEqual ignores keys
// whose value is undefined, and "position is ABSENT, not undefined" is exactly
// what applyShelfPolicy branches on.
describe('applyPins', () => {
	const pins: Record<string, ShelfPin> = {
		B00FRILVJ1: { series: 'The Riyria Chronicles', position: '1', source: 'census-verdict' },
		B0LONGNAME: {
			series: 'The Legend of Drizzt',
			position: '12',
			displayTitle: 'The Spine of the World',
			source: 'operator-stated'
		},
		B0UNFETTER: { none: true, source: 'operator-stated' },
		B0TAGKEEP1: { none: true, keepTag: true, source: 'operator-stated' },
		B0HODGES01: { series: 'Bill Hodges', position: '1', source: 'operator-stated' },
		B0NOPOSITN: { series: 'Bill Hodges', source: 'operator-stated' },
		B0GUARDCTR: { series: 'Eisenhorn', position: '1', source: 'operator-stated' },
		B0FORERUNR: { series: 'The Forerunner Saga', position: '1', source: 'operator-stated' },
		B0BANEBLAD: { series: 'Warhammer 40,000: Imperial Guard', position: '1', source: 'operator-stated' },
		B0NOSERIES: { position: '3', source: 'operator-stated' } as ShelfPin,
		B0TITLEONL: { displayTitle: 'Just The Title', source: 'operator-stated' } as ShelfPin
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

	// T11 — the input carries a secondary on purpose. Without one, the
	// `delete out.seriesSecondary` in the none branch is unkillable: every
	// mutation of it leaves this test green.
	test('a NONE-pin suppresses the shelf AND an existing tag', () => {
		const out = applyPins(
			{
				title: 'Unfettered',
				seriesPrimary: { name: 'Tales by Masters of Fantasy', position: '1' },
				seriesSecondary: { name: 'Some Other Arc', position: '2' }
			},
			'B0UNFETTER',
			pins
		)
		expect(out.seriesPrimary).toBeUndefined()
		expect(out.seriesSecondary).toBeUndefined()
	})

	// T9 — POSITIONLESS. A positioned tag beside a vacant primary is promoted
	// straight back onto the shelf by applyShelfPolicy, which would hand the
	// shelf back to the answer the none-pin exists to suppress.
	test('a NONE-pin with keepTag demotes the name WITHOUT its position', () => {
		const book = { title: 'Y', seriesPrimary: { name: 'Some Real Series', position: '4' } }
		const out = applyPins(book, 'B0TAGKEEP1', pins)
		expect(out.seriesSecondary).toStrictEqual({ name: 'Some Real Series' })
		// ...and the suppression actually survives the policy.
		const served = applyShelfPolicy(out)
		expect(served.seriesPrimary).toBeUndefined()
		expect(served.seriesSecondary).toStrictEqual({ name: 'Some Real Series' })
	})

	// T10 — a tag the resolver placed outranks the name the pin displaced,
	// mirroring the vacancy rule in applyShelfPolicy.
	test('a NONE-pin with keepTag prefers the existing tag over the displaced name', () => {
		const out = applyPins(
			{
				title: 'Y',
				seriesPrimary: { name: 'Displaced Primary', position: '4' },
				seriesSecondary: { name: 'Existing Tag', position: '9' }
			},
			'B0TAGKEEP1',
			pins
		)
		expect(out.seriesSecondary).toStrictEqual({ name: 'Existing Tag' })
	})

	test('a displayTitle pin overrides the served title', () => {
		// The record bakes ": Legend of Drizzt: Paths of Darkness, Book 2" into
		// its TITLE (subtitle empty) while every sibling uses the short name.
		// Re-matching cannot fix it — the correct record IS the long-titled one —
		// so the operator states the display title, same R4 shape as a number.
		const out = applyPins(
			{ title: 'The Spine of the World: Legend of Drizzt: Paths of Darkness, Book 2' },
			'B0LONGNAME',
			pins
		)
		expect(out.title).toBe('The Spine of the World')
		expect(out.seriesPrimary).toEqual({ name: 'The Legend of Drizzt', position: '12' })
	})

	test('a pin without displayTitle leaves the title untouched', () => {
		const out = applyPins({ title: 'The Crown Tower' }, 'B00FRILVJ1', pins)
		expect(out.title).toBe('The Crown Tower')
	})

	test('a pin clears a secondary that would echo it', () => {
		const out = applyPins(
			{
				title: 'The Crown Tower',
				seriesPrimary: { name: 'The Riyria Chronicles', position: '4' },
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

	// T1 — the Mr. Mercedes shape, and the defect this change exists to fix.
	// The old code branched on whether a secondary EXISTED rather than on whether
	// the slot was FREE afterwards, so deleting the echoing secondary also threw
	// away the genuinely different answer the pin had displaced.
	test('the displaced answer takes the slot freed by an echoing secondary', () => {
		const out = applyPins(
			{
				title: 'Mr. Mercedes',
				seriesPrimary: { name: 'Holly Gibney', position: '0.1' },
				seriesSecondary: { name: 'Bill Hodges', position: '1' }
			},
			'B0HODGES01',
			pins
		)
		expect(out.seriesPrimary).toStrictEqual({ name: 'Bill Hodges', position: '1' })
		expect(out.seriesSecondary).toStrictEqual({ name: 'Holly Gibney', position: '0.1' })
	})

	// T2 — one occupant, and a tag the resolver placed owns it.
	test('an existing non-echo tag is never evicted for the displaced answer', () => {
		const out = applyPins(
			{
				title: 'X',
				seriesPrimary: { name: 'Riyria', position: '1' },
				seriesSecondary: { name: 'Some Other Arc', position: '2' }
			},
			'B00FRILVJ1',
			pins
		)
		expect(out.seriesSecondary).toStrictEqual({ name: 'Some Other Arc', position: '2' })
	})

	// T3 — a franchise umbrella is not a tag when WE are the one placing it.
	test('a displaced CONTAINER is not re-seated as the tag', () => {
		const out = applyPins(
			{ title: 'Xenos', seriesPrimary: { name: 'Warhammer 40,000', position: '1' } },
			'B0GUARDCTR',
			pins
		)
		expect(out.seriesPrimary).toStrictEqual({ name: 'Eisenhorn', position: '1' })
		expect(out.seriesSecondary).toBeUndefined()
	})

	// T3b — the mirror image, and the trap: the container refusal must apply ONLY
	// to a tag applyPins itself creates. Applying it to the existing-secondary arm
	// strips "Warhammer 40,000" from rows the operator's container-tag policy
	// deliberately keeps.
	test('an existing CONTAINER tag survives a pin', () => {
		const out = applyPins(
			{
				title: 'Master Imus',
				seriesPrimary: { name: 'Eisenhorn/Ravenor/Bequin', position: '0.2' },
				seriesSecondary: { name: 'Warhammer 40,000', position: null }
			},
			'B0GUARDCTR',
			pins
		)
		expect(out.seriesSecondary).toStrictEqual({ name: 'Warhammer 40,000', position: null })
	})

	// T4 — a positionless pin states a NAME, not a shelf. It must not emit
	// `position: undefined` (which reads differently to applyShelfPolicy than an
	// absent key), and it must not hand the policy a positioned tag to promote
	// over it — that would hand the shelf back to the answer being overridden.
	test('a positionless pin emits no position key and re-seats no tag', () => {
		const book = { title: 'Mr. Mercedes', seriesPrimary: { name: 'Mr. Mercedes Trilogy', position: '1' } }
		const out = applyPins(book, 'B0NOPOSITN', pins)
		expect(out.seriesPrimary).toStrictEqual({ name: 'Bill Hodges' })
		expect(out.seriesSecondary).toBeUndefined()
		const served = applyShelfPolicy(out)
		expect(served.seriesPrimary).toBeUndefined()
		expect(served.seriesSecondary).toStrictEqual({ name: 'Bill Hodges' })
	})

	// T5 — when the pin only re-states the series the resolver already found,
	// sibling fields survive the rename.
	test('a re-stating pin carries the resolved series asin', () => {
		const out = applyPins(
			{ title: 'The Crown Tower', seriesPrimary: { name: 'Riyria Chronicles', position: null, asin: 'B07MJTWRBW' } },
			'B00FRILVJ1',
			pins
		)
		expect(out.seriesPrimary).toStrictEqual({
			asin: 'B07MJTWRBW',
			name: 'The Riyria Chronicles',
			position: '1'
		})
	})

	// T5b — and does NOT leak them onto a DIFFERENT series. Without this the asin
	// carry is a new defect rather than a fix.
	test('a pin naming a different series does not carry the old asin', () => {
		const out = applyPins(
			{ title: 'Mr. Mercedes', seriesPrimary: { name: 'Holly Gibney', position: '0.1', asin: 'B0AAA' } },
			'B0HODGES01',
			pins
		)
		expect(out.seriesPrimary).toStrictEqual({ name: 'Bill Hodges', position: '1' })
	})

	// T5c — the carry must not smuggle the resolver's position past a positionless
	// pin.
	test('a positionless re-stating pin drops the resolved position', () => {
		const out = applyPins(
			{ title: 'Mr. Mercedes', seriesPrimary: { name: 'Bill Hodges', position: '5', asin: 'B0AAA' } },
			'B0NOPOSITN',
			pins
		)
		expect(out.seriesPrimary).toStrictEqual({ asin: 'B0AAA', name: 'Bill Hodges' })
	})

	// T6 — the shipped Baneblade bug: one series in both slots, because a bare
	// fold reads the spaced colon as a different name.
	test('a spaced colon is the same series to the echo test', () => {
		const out = applyPins(
			{
				title: 'Baneblade',
				seriesPrimary: { name: 'Warhammer 40,000', position: null },
				seriesSecondary: { name: 'Warhammer 40,000 : Imperial Guard', position: '1' }
			},
			'B0BANEBLAD',
			pins
		)
		expect(out.seriesSecondary).toBeUndefined()
		expect(applyShelfPolicy(out).seriesSecondary).toBeUndefined()
	})

	// T7 — every key on Object.prototype is a truthy non-pin. Unreachable while
	// record ids are 10-character ASINs; reachable the moment they are not. Also
	// pins the no-clone contract, which the route depends on.
	test.each(['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'])(
		'a record id of %p is not a pin',
		(key) => {
			const book = { title: 'X', seriesPrimary: { name: 'Real Series', position: '3' } }
			expect(applyPins(book, key)).toBe(book)
		}
	)

	// T8 — a pin with no series states no shelf. Without the guard it installs
	// {name: undefined} over a good answer and the policy then strips the shelf.
	test('a pin with no series leaves both slots alone', () => {
		const out = applyPins(
			{
				title: 'X',
				seriesPrimary: { name: 'Real Series', position: '3' },
				seriesSecondary: { name: 'Real Tag', position: '1' }
			},
			'B0NOSERIES',
			pins
		)
		expect(out.seriesPrimary).toStrictEqual({ name: 'Real Series', position: '3' })
		expect(out.seriesSecondary).toStrictEqual({ name: 'Real Tag', position: '1' })
	})

	test('a displayTitle-only pin changes the title and nothing else', () => {
		const out = applyPins(
			{ title: 'X', seriesPrimary: { name: 'Real Series', position: '3' } },
			'B0TITLEONL',
			pins
		)
		expect(out.title).toBe('Just The Title')
		expect(out.seriesPrimary).toStrictEqual({ name: 'Real Series', position: '3' })
	})

	// T12 — the route composes applyShelfPolicy(applyPins(...)). Asserting on
	// applyPins alone lets the policy mask a change; this asserts the SERVED
	// payload, which is what makes "changes served output" a fact.
	describe('through the full serve pipeline', () => {
		test('the Mr. Mercedes shape serves the pinned shelf and the umbrella tag', () => {
			const served = applyShelfPolicy(
				applyPins(
					{
						title: 'Mr. Mercedes',
						seriesPrimary: { name: 'Holly Gibney', position: '0.1' },
						seriesSecondary: { name: 'Bill Hodges', position: '1' }
					},
					'B0HODGES01',
					pins
				)
			)
			expect(served.seriesPrimary).toStrictEqual({ name: 'Bill Hodges', position: '1' })
			expect(served.seriesSecondary).toStrictEqual({ name: 'Holly Gibney', position: '0.1' })
		})

		test('a pinned Halo book serves the sub-series with no umbrella tag', () => {
			const served = applyShelfPolicy(
				applyPins(
					{ title: 'Halo: Cryptum', seriesPrimary: { name: 'Halo', position: '8' } },
					'B0FORERUNR',
					pins
				)
			)
			expect(served.seriesPrimary).toStrictEqual({ name: 'The Forerunner Saga', position: '1' })
			expect(served.seriesSecondary).toBeUndefined()
		})
	})
})

// T13 — a DATA gate, not a code test: no mutation of shelfPins.ts can break it.
// It exists because a pin spelling a series differently from the alias table is
// invisible to every code path and produces the one failure that costs the most
// trust — a SPLIT SHELF. Live on 2026-08-11: six pins said "The Riyria
// Chronicles" while their unpinned siblings canonicalised to "Riyria
// Chronicles", so the same series sorted in two places.
describe('the pin table agrees with the alias table', () => {
	const aliasTargets = [...SERIES_ALIASES.values()]

	test('no pin states a spelling an alias would rewrite', () => {
		const offenders = Object.entries(SHELF_PINS).flatMap(([id, pin]) => {
			const canonical = SERIES_ALIASES.get(foldForAlias(pin.series))
			return canonical && canonical !== pin.series ? [`${id}: ${pin.series} -> ${canonical}`] : []
		})
		expect(offenders).toEqual([])
	})

	test('no pin uses a variant spelling of a canonical alias target', () => {
		const offenders = Object.entries(SHELF_PINS).flatMap(([id, pin]) => {
			if (!pin.series) return []
			const twin = aliasTargets.find((t) => t !== pin.series && foldForAlias(t) === foldForAlias(pin.series))
			return twin ? [`${id}: ${pin.series} vs ${twin}`] : []
		})
		expect(offenders).toEqual([])
	})

	test('no alias target is itself an alias key', () => {
		const chained = aliasTargets.filter((t) => SERIES_ALIASES.has(foldForAlias(t)))
		expect(chained).toEqual([])
	})
})

/** The same fold SERIES_ALIASES is keyed on. */
function foldForAlias(name: string | undefined): string {
	return String(name ?? '')
		.normalize('NFC')
		.replace(/[‘’ʼ′´]/g, "'")
		.replace(/^\s*(?:the|a|an)\s+/i, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
}

import { describe, expect, test } from 'bun:test'

import { pinKey, pinKeyAliases } from '#helpers/series/pinKey'
import { applyPins, type ShelfPin } from '#helpers/series/shelfPins'
import { SHELF_PIN_KEYS, SHELF_PINS, SHELF_PINS_BY_KEY } from '#helpers/series/shelfPins.data'
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

// The portable key. A pin is keyed on the matched EDITION id, and two libraries
// that matched the same collection independently agree on only 58% of those, so
// the shipped table reaches 90/90 pins on one server and 49/90 on the other —
// and ~0 for anyone else. These tests pin the fold that makes one table serve
// them all, and the boundaries that stop it merging two different books.
describe('pinKey', () => {
	test('a title and an author fold to one key', () => {
		expect(pinKey('The Crown Tower', 'Michael J. Sullivan')).toBe('thecrowntower|michaeljsullivan')
	})

	test.each([
		['Slaughterhouse-Five: Unabridged', 'Slaughterhouse-Five'],
		['Slaughterhouse-Five (Unabridged)', 'Slaughterhouse-Five'],
		['Slaughterhouse-Five, Abridged', 'Slaughterhouse-Five']
	])('%p keys the same as %p', (a, b) => {
		expect(pinKey(a, 'Kurt Vonnegut')).toBe(pinKey(b, 'Kurt Vonnegut'))
	})

	test.each([
		['Kurt Vonnegut Jr.', 'Kurt Vonnegut'],
		['Kurt Vonnegut Jr', 'Kurt Vonnegut'],
		['Martin Luther King, Jr.', 'Martin Luther King']
	])('author %p keys the same as %p', (a, b) => {
		expect(pinKey('T', a)).toBe(pinKey('T', b))
	})

	test('diacritics, case and punctuation do not split a key', () => {
		expect(pinKey('Éclair: A Tale', 'Émile Zola')).toBe(pinKey('eclair a tale', 'emile zola'))
	})

	// The property that separates this from foldSeriesName, which folds a leading
	// article. That is right for a SERIES (one shelf under either spelling) and
	// wrong for a TITLE.
	test('a leading article is NOT folded — "The Stand" is not "Stand"', () => {
		expect(pinKey('The Stand', 'Stephen King')).not.toBe(pinKey('Stand', 'Stephen King'))
	})

	test.each([
		['', 'Author'],
		['Title', ''],
		[null, 'Author'],
		['Title', undefined],
		['!!!', 'Author'],
		['Title', '???']
	])('pinKey(%p, %p) is empty, never a half-key', (t, a) => {
		expect(pinKey(t as string, a as string)).toBe('')
	})
})

describe('pinKeyAliases', () => {
	// The shape it exists for: prod matched these to editions titled plainly,
	// while the pin was minted from a record that bakes the series in.
	test.each([
		['Gauntlgrym: Legend of Drizzt', 'gauntlgrym'],
		['Neverwinter: Legend of Drizzt', 'neverwinter'],
		['Rise of the King: Legend of Drizzt: Companions Codex', 'riseoftheking'],
		['Night of the Hunter: Legend of Drizzt: Companions Codex', 'nightofthehunter']
	])('%p also keys as the plain title', (title, head) => {
		expect(pinKeyAliases(title, 'R.A. Salvatore', 'The Legend of Drizzt')).toEqual([
			`${head}|rasalvatore`
		])
	})

	// The shape a blanket "cut at the first colon" would destroy. Measured, that
	// fallback collapsed three Ahriman volumes onto one key and handed the
	// correctly-unpinned #5 whichever pin won.
	test.each([
		['Ahriman: Sorcerer', 'Ahriman'],
		['Ahriman: Unchanged', 'Ahriman'],
		['Ahriman: Undying', 'Ahriman'],
		['The Twice Dead King: Ruin', 'The Twice Dead King'],
		['Halo: Cryptum', 'The Forerunner Saga']
	])('%p keeps its volume — no alias', (title, series) => {
		expect(pinKeyAliases(title, 'Some Author', series)).toEqual([])
	})

	test('a leading article does not stop the series being recognised', () => {
		expect(pinKeyAliases('Archmage: The Legend of Drizzt', 'R.A. Salvatore', 'Legend of Drizzt')).toEqual([
			'archmage|rasalvatore'
		])
	})

	test.each([
		['No Colon Here', 'S'],
		['Head: Something Else', 'Other Series'],
		[': Legend of Drizzt', 'The Legend of Drizzt']
	])('%p with series %p produces no alias', (title, series) => {
		expect(pinKeyAliases(title, 'A', series)).toEqual([])
	})

	test('a missing half produces no alias', () => {
		expect(pinKeyAliases('X: Y', null, 'Y')).toEqual([])
		expect(pinKeyAliases(null, 'A', 'Y')).toEqual([])
		expect(pinKeyAliases('X: Y', 'A', null)).toEqual([])
	})
})

describe('applyPins by portable key', () => {
	const pin: ShelfPin = { series: 'Discworld', position: '9', source: 'operator-stated' }
	const keyed: Record<string, ShelfPin> = { [pinKey('Eric', 'Terry Pratchett')]: pin }
	const book = () => ({ title: 'Eric', authors: [{ name: 'Terry Pratchett' }] })

	test('a pin reaches a record id it was never minted for', () => {
		const out = applyPins(book(), 'B0NEVERSEEN', {}, keyed)
		expect(out.seriesPrimary).toStrictEqual({ name: 'Discworld', position: '9' })
	})

	test('the EDITION id wins over the key', () => {
		const byId: Record<string, ShelfPin> = {
			B0EXACTEDIT: { series: 'Rincewind', position: '4', source: 'operator-stated' }
		}
		const out = applyPins(book(), 'B0EXACTEDIT', byId, keyed)
		expect(out.seriesPrimary).toStrictEqual({ name: 'Rincewind', position: '4' })
	})

	test('the edition qualifier does not stop the key matching', () => {
		const out = applyPins(
			{ title: 'Eric (Unabridged)', authors: [{ name: 'Terry Pratchett' }] },
			null,
			{},
			keyed
		)
		expect(out.seriesPrimary).toStrictEqual({ name: 'Discworld', position: '9' })
	})

	// Two editions of one book do not reliably list their authors in the same
	// order, so every author is tried, not just authors[0].
	test('a co-author listed second still finds the pin', () => {
		const out = applyPins(
			{ title: 'Eric', authors: [{ name: 'Some Illustrator' }, { name: 'Terry Pratchett' }] },
			null,
			{},
			keyed
		)
		expect(out.seriesPrimary).toStrictEqual({ name: 'Discworld', position: '9' })
	})

	test('a DIFFERENT author does not collect the pin', () => {
		const out = applyPins({ title: 'Eric', authors: [{ name: 'Neil Gaiman' }] }, null, {}, keyed)
		expect(out.seriesPrimary).toBeUndefined()
	})

	test('a different title by the same author does not collect the pin', () => {
		const out = applyPins({ title: 'Mort', authors: [{ name: 'Terry Pratchett' }] }, null, {}, keyed)
		expect(out.seriesPrimary).toBeUndefined()
	})

	test.each([[undefined], [[]], [[{ name: '' }]], [null]])(
		'a book whose authors are %p matches nothing',
		(authors) => {
			const table: Record<string, ShelfPin> = { '': pin, 'eric|': pin }
			const b = { title: 'Eric', authors: authors as { name?: string }[] }
			expect(applyPins(b, null, {}, table)).toBe(b)
		}
	)

	// An author that is present but folds away leaves an EMPTY key. Nothing may
	// be stored under it and nothing may match it — an empty key would otherwise
	// collect every other book whose author also folds away.
	test('an author that folds to nothing cannot collect a pin filed under ""', () => {
		const table: Record<string, ShelfPin> = { '': pin, '|': pin, 'eric|': pin }
		const b = { title: 'Eric', authors: [{ name: '???' }, { name: '...' }] }
		expect(applyPins(b, null, {}, table)).toBe(b)
	})

	// The key table is a plain object literal too, so it carries the same
	// prototype-chain hazard as the id table — and a title/author pair CAN fold
	// to one of these where a 10-character ASIN never could.
	test.each(['constructor', 'toString', 'valueOf'])('a key of %p is not a pin', (word) => {
		const b = { title: word, authors: [{ name: '' }] }
		expect(applyPins(b, null, {}, {})).toBe(b)
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

// The shipped key table. mintPins refuses to emit a colliding one, but the data
// file is what actually ships, so the guarantee is asserted on the artifact.
describe('the shipped portable key table', () => {
	test('every key is well-formed — no empty side, no bare separator', () => {
		const bad = Object.keys(SHELF_PINS_BY_KEY).filter((k) => !k || k.startsWith('|') || k.endsWith('|'))
		expect(bad).toEqual([])
	})

	test('every keyed pin is a pin that also ships by edition id', () => {
		const byId = new Set(Object.values(SHELF_PINS).map((p) => JSON.stringify(p)))
		const orphans = Object.entries(SHELF_PINS_BY_KEY)
			.filter(([, p]) => !byId.has(JSON.stringify(p)))
			.map(([k]) => k)
		expect(orphans).toEqual([])
	})

	// A key claimed by two different answers would apply a pin to a book it was
	// never stated for — the failure mode an edition id could not have, because
	// an edition id names exactly one record.
	test('no two DIFFERENT answers share one key', () => {
		const seen = new Map<string, string>()
		const clashes: string[] = []
		for (const [k, p] of Object.entries(SHELF_PINS_BY_KEY)) {
			const answer = `${p.series} #${p.position ?? '-'}`
			const prior = seen.get(k)
			if (prior && prior !== answer) clashes.push(`${k}: ${prior} vs ${answer}`)
			seen.set(k, answer)
		}
		expect(clashes).toEqual([])
	})

	test('most pins are portable — a table that only reaches one library is the bug', () => {
		// Counted over RECORDS, not keys: a pin may also be filed under a
		// baked-in-series alias, so counting keys would read over 100%.
		const total = Object.keys(SHELF_PINS).length
		expect(Object.keys(SHELF_PIN_KEYS).length).toBeGreaterThanOrEqual(Math.floor(total * 0.9))
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

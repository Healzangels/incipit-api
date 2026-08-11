import { describe, expect, test } from 'bun:test'

import { pinLiveness } from '#helpers/series/pinLiveness'

/**
 * A pin is keyed on the matched EDITION's record id, so a re-match changes the
 * key and `pins[recordId]` silently misses -- the book reverts to the resolver's
 * answer with no error and no log line. Measured on the .99 library 2026-08-11:
 * 34 of 84 pins (40%) matched no album, including the three "Jack Ryan"
 * collisions being chased at the time (never a resolver bug, just pins that had
 * stopped applying) and a "Hannibal Lecter #3" pin killed hours earlier by a
 * re-match in the same session.
 */
const pins = {
	B002UZL4ZI: { series: 'Hannibal Lecter', position: '3' },
	B0083WD9HS: { series: 'Hannibal Lecter', position: '3' },
	'1789994462': { series: 'The Horus Heresy: Primarchs', position: '12' }
}

describe('pinLiveness', () => {
	test('a pin the library cannot reach is reported DEAD', () => {
		// B002UZL4ZI is the abridged edition this album was re-matched away from.
		const out = pinLiveness(pins, ['B0083WD9HS', '1789994462'])
		expect(out.dead).toEqual(['B002UZL4ZI'])
		expect(out.live).toEqual(['1789994462', 'B0083WD9HS'])
		expect(out.total).toBe(3)
	})

	test('every pin reachable means no dead keys', () => {
		expect(pinLiveness(pins, ['B002UZL4ZI', 'B0083WD9HS', '1789994462']).dead).toEqual([])
	})

	test('an empty library makes EVERY pin dead, not zero', () => {
		// The failure mode is silence; a checker that reports nothing when it can
		// see nothing would reproduce exactly the bug it exists to catch.
		expect(pinLiveness(pins, []).dead.length).toBe(3)
	})

	test('matching is EXACT, because the lookup is', () => {
		// A near-miss key must NOT count as live: pins[recordId] will never find
		// it, so reporting it live would be a false all-clear.
		expect(pinLiveness(pins, ['b002uzl4zi', 'B0083WD9HS_us']).dead).toEqual([
			'1789994462',
			'B002UZL4ZI',
			'B0083WD9HS'
		])
	})

	test('extra library ids are irrelevant', () => {
		expect(
			pinLiveness(pins, ['B002UZL4ZI', 'B0083WD9HS', '1789994462', 'B0OTHER123']).dead
		).toEqual([])
	})

	test('no pins is vacuously healthy', () => {
		expect(pinLiveness({}, ['B0083WD9HS'])).toEqual({
			total: 0,
			live: [],
			dead: [],
			byKeyOnly: [],
			ambiguous: []
		})
	})

	// applyPins tries the edition id and THEN the portable (title, author) key,
	// so a check that only looks at ids reports pins dead whose decisions are in
	// force. That is not hypothetical: id-only reported 34 of 84 pins dead on
	// .99 while the library was serving them.
	describe('the portable key', () => {
		// recordId -> key, exactly as mintPins emits it.
		const keyed = { B002UZL4ZI: ['thecrowntower|michaeljsullivan'] }

		test('a pin the library cannot reach by id is live when its key matches', () => {
			const out = pinLiveness(pins, [], keyed, new Map([['thecrowntower|michaeljsullivan', ['B0OTHER']]]))
			expect(out.live).toContain('B002UZL4ZI')
			expect(out.byKeyOnly).toEqual(['B002UZL4ZI'])
		})

		test('a key that matches NO album does not rescue the pin', () => {
			const out = pinLiveness(pins, [], keyed, new Map())
			expect(out.live).toEqual([])
			expect(out.dead).toContain('B002UZL4ZI')
			expect(out.byKeyOnly).toEqual([])
		})

		test('an id hit is not counted as key-rescued', () => {
			const out = pinLiveness(
				pins,
				['B002UZL4ZI'],
				keyed,
				new Map([['thecrowntower|michaeljsullivan', ['B002UZL4ZI']]])
			)
			expect(out.byKeyOnly).toEqual([])
		})

		// The failure mode an edition id could not have: one key, two books.
		test('a key matching two albums is reported ambiguous', () => {
			const out = pinLiveness(
				pins,
				[],
				keyed,
				new Map([['thecrowntower|michaeljsullivan', ['B0FIRST', 'B0SECOND']]])
			)
			expect(out.ambiguous).toEqual([
				{ key: 'thecrowntower|michaeljsullivan', albums: ['B0FIRST', 'B0SECOND'] }
			])
		})

		// A pin filed under BOTH its own title and a baked-in-series alias is live
		// if either reaches. Storing only the primary key reported five
		// alias-reachable Drizzt pins dead on prod while the lookup found them.
		test('a pin reachable only by its ALIAS key is live', () => {
			const two = { B002UZL4ZI: ['gauntlgrymlegendofdrizzt|rasalvatore', 'gauntlgrym|rasalvatore'] }
			const out = pinLiveness(pins, [], two, new Map([['gauntlgrym|rasalvatore', ['B0OTHER']]]))
			expect(out.live).toContain('B002UZL4ZI')
			expect(out.byKeyOnly).toEqual(['B002UZL4ZI'])
		})

		test('a pin whose keys ALL reach nothing stays dead', () => {
			const two = { B002UZL4ZI: ['a|b', 'c|d'] }
			expect(pinLiveness(pins, [], two, new Map([['e|f', ['B0OTHER']]])).dead).toContain('B002UZL4ZI')
		})

		test('an ALIAS key matching two albums is reported ambiguous', () => {
			const two = { B002UZL4ZI: ['primary|a', 'alias|a'] }
			const out = pinLiveness(pins, [], two, new Map([['alias|a', ['B0ONE', 'B0TWO']]]))
			expect(out.ambiguous).toEqual([{ key: 'alias|a', albums: ['B0ONE', 'B0TWO'] }])
		})

		test('a key matching exactly one album is not ambiguous', () => {
			const out = pinLiveness(pins, [], keyed, new Map([['thecrowntower|michaeljsullivan', ['B0ONE']]]))
			expect(out.ambiguous).toEqual([])
		})
	})
})

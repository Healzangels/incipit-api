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
		expect(pinLiveness({}, ['B0083WD9HS'])).toEqual({ total: 0, live: [], dead: [] })
	})
})

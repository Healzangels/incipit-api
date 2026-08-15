import { describe, expect, test } from 'bun:test'

import { isUnreleased } from '#helpers/providers/released'

// Fixed instant so these never depend on the day they run.
const NOW = new Date('2026-08-14T12:00:00Z')

describe('isUnreleased', () => {
	test('a future date is unreleased', () => {
		// Prod 2026-08-14: Confessions of a Crap Artist, matched five weeks early.
		expect(isUnreleased('2026-09-22', NOW)).toBe(true)
	})

	test('a past date is released', () => {
		expect(isUnreleased('2025-08-05', NOW)).toBe(false)
	})

	test('a book released TODAY is released, whatever the hour', () => {
		// Calendar-day comparison, not instants: comparing timestamps would make a
		// release-day listing appear or vanish depending on when the scan ran.
		expect(isUnreleased('2026-08-14', NOW)).toBe(false)
		expect(isUnreleased('2026-08-14T23:59:59Z', NOW)).toBe(false)
		expect(isUnreleased('2026-08-14T00:00:00Z', new Date('2026-08-14T00:00:01Z'))).toBe(false)
	})

	test('tomorrow is unreleased even by one day', () => {
		expect(isUnreleased('2026-08-15', NOW)).toBe(true)
	})

	test('fails OPEN on anything it cannot read', () => {
		// Absence is "unknown", never "future" — a provider that stops sending dates
		// must lose the guard, not have its whole catalog filtered away.
		expect(isUnreleased(undefined, NOW)).toBe(false)
		expect(isUnreleased(null, NOW)).toBe(false)
		expect(isUnreleased('', NOW)).toBe(false)
		expect(isUnreleased('   ', NOW)).toBe(false)
		expect(isUnreleased('not a date', NOW)).toBe(false)
		expect(isUnreleased('0000-00-00', NOW)).toBe(false)
	})

	test('reads a full ISO timestamp, not only a bare date', () => {
		expect(isUnreleased('2026-10-27T00:00:00.000Z', NOW)).toBe(true)
	})
})

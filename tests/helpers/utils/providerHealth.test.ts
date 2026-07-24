import { beforeEach, describe, expect, test } from 'bun:test'

import {
	getProviderHealth,
	recordProviderFailure,
	recordProviderResult,
	resetProviderHealth
} from '#helpers/utils/providerHealth'

/**
 * The signal this exists for: a provider that ANSWERS but returns nothing.
 * The circuit breaker only sees providers that error, so an expired credential
 * -- Hardcover tokens expire every Jan 1, after which the provider skips itself
 * and returns [] -- degrades match quality library-wide with no error, no
 * breaker trip, and nothing to grep for.
 */
describe('provider health', () => {
	beforeEach(() => resetProviderHealth())

	test('a deauthenticated provider shows healthy calls with a 1.0 empty rate', async () => {
		for (let i = 0; i < 20; i++) recordProviderResult('hardcover', 0)
		const hc = getProviderHealth().hardcover
		expect(hc.ok).toBe(20)
		expect(hc.failed).toBe(0) // nothing errored -- the breaker sees nothing wrong
		expect(hc.candidates).toBe(0)
		expect(hc.emptyRate).toBe(1) // the tell
	})

	test('a working provider has a low empty rate and real candidates', async () => {
		recordProviderResult('audible', 5)
		recordProviderResult('audible', 3)
		recordProviderResult('audible', 0) // a genuine no-hit search
		const a = getProviderHealth().audible
		expect(a.ok).toBe(3)
		expect(a.candidates).toBe(8)
		expect(a.emptyRate).toBeCloseTo(1 / 3, 5)
	})

	test('failures are counted separately from empties', async () => {
		recordProviderFailure('openlibrary', false)
		recordProviderFailure('openlibrary', false)
		recordProviderResult('openlibrary', 2)
		const ol = getProviderHealth().openlibrary
		expect(ol.calls).toBe(3)
		expect(ol.failed).toBe(2)
		expect(ol.ok).toBe(1)
		expect(ol.emptyRate).toBe(0)
	})

	test('an open circuit counts as SKIPPED, not as a failure', async () => {
		// One outage must not read as thousands of individual failures -- the
		// breaker already made that call, and inflating `failed` would bury the one
		// real failure that tripped it.
		for (let i = 0; i < 100; i++) recordProviderFailure('apple', true)
		const apple = getProviderHealth().apple
		expect(apple.skipped).toBe(100)
		expect(apple.failed).toBe(0)
		expect(apple.calls).toBe(0)
	})

	test('emptyRate is null before anything has resolved', async () => {
		recordProviderFailure('storytel', false)
		expect(getProviderHealth().storytel.emptyRate).toBeNull()
	})

	test('providers are tracked independently and reset cleanly', async () => {
		recordProviderResult('audible', 1)
		recordProviderResult('hardcover', 0)
		expect(Object.keys(getProviderHealth()).sort()).toEqual(['audible', 'hardcover'])
		resetProviderHealth()
		expect(getProviderHealth()).toEqual({})
	})
})

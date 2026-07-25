import { afterEach, describe, expect, test } from 'bun:test'

import { goodreadsTuning } from '#helpers/providers/goodreadsSeries'

/**
 * How hard the Goodreads client defends itself, decided by WHO it is talking to.
 *
 * api.bookinfo.pro is a PUBLIC, shared instance of rreading-glasses serving
 * thousands of daily users off one box -- every guard in this module (pacing,
 * backoff, long cache TTLs) exists because of that contention. Pointed at a
 * SELF-HOSTED instance those same guards are pure cost: measured 2026-07-25,
 * the same lookups went from ~9s average to 13-577ms once the URL moved to a
 * local container.
 *
 * So the posture is derived, not hardcoded: someone who never touches config
 * keeps every protection, and someone who deliberately set a URL gets the
 * performance and freshness their own hardware affords. Every individual knob
 * still wins over the profile, so an operator pointing at a DIFFERENT shared
 * mirror can force the conservative side.
 *
 * Only the knobs that cost something differ. Backoff, the request time budget
 * and the degraded-lookup refusal are identical in both profiles: they are free
 * when the source is healthy and are the difference between graceful and broken
 * when it is not.
 */

const ENV_KEYS = [
	'GOODREADS_PROFILE',
	'GOODREADS_SERIES_URL',
	'GOODREADS_MIN_GAP_MS',
	'GOODREADS_HIT_TTL_SECONDS',
	'GOODREADS_MISS_TTL_SECONDS'
]

afterEach(() => {
	for (const key of ENV_KEYS) delete process.env[key]
})

describe('goodreads tuning profile', () => {
	test('no configuration at all is the SHARED profile', () => {
		// The default install talks to the public instance, so it must get every
		// protection without being asked to configure anything.
		const t = goodreadsTuning()
		expect(t.profile).toBe('shared')
		expect(t.minGapMs).toBe(1100)
		expect(t.hitTtlSeconds).toBe(2592000) // 30 days
		expect(t.missTtlSeconds).toBe(86400) // 1 day
	})

	test('the public host stays SHARED even when named explicitly', () => {
		process.env.GOODREADS_SERIES_URL = 'https://api.bookinfo.pro'
		expect(goodreadsTuning().profile).toBe('shared')
		// ...including the Hardcover-backed public instance.
		process.env.GOODREADS_SERIES_URL = 'https://hardcover.bookinfo.pro'
		expect(goodreadsTuning().profile).toBe('shared')
	})

	test('any other host is LOCAL: faster and fresher', () => {
		process.env.GOODREADS_SERIES_URL = 'http://10.0.1.99:8788'
		const t = goodreadsTuning()
		expect(t.profile).toBe('local')
		expect(t.minGapMs).toBe(0)
		// Shorter than shared on purpose. These TTLs were sized when re-asking was
		// expensive; against your own box a stale answer costs more than a refetch,
		// so a Goodreads correction reaches the library in days not a month, and a
		// not-yet-indexed new release recovers within the hour.
		expect(t.hitTtlSeconds).toBe(604800) // 7 days
		expect(t.missTtlSeconds).toBe(3600) // 1 hour
	})

	test('an explicit profile overrides the URL in BOTH directions', () => {
		// Someone pointed at a different SHARED mirror wants the guards back.
		process.env.GOODREADS_SERIES_URL = 'https://someone-elses-mirror.example'
		process.env.GOODREADS_PROFILE = 'shared'
		expect(goodreadsTuning().minGapMs).toBe(1100)
		// ...and someone who trusts the public instance can opt out. Their call.
		process.env.GOODREADS_SERIES_URL = 'https://api.bookinfo.pro'
		process.env.GOODREADS_PROFILE = 'local'
		expect(goodreadsTuning().minGapMs).toBe(0)
	})

	test('an individual knob beats the profile it belongs to', () => {
		process.env.GOODREADS_SERIES_URL = 'http://10.0.1.99:8788'
		process.env.GOODREADS_MIN_GAP_MS = '250'
		process.env.GOODREADS_MISS_TTL_SECONDS = '60'
		const t = goodreadsTuning()
		expect(t.profile).toBe('local')
		expect(t.minGapMs).toBe(250)
		expect(t.missTtlSeconds).toBe(60)
		expect(t.hitTtlSeconds).toBe(604800) // untouched knob keeps the profile's
	})

	test('zero is a real value, not "unset"', () => {
		// The falsy-zero trap: `Number(x) || default` would silently restore
		// pacing for the operator who explicitly asked for none.
		process.env.GOODREADS_MIN_GAP_MS = '0'
		expect(goodreadsTuning().minGapMs).toBe(0)
	})

	test('junk configuration falls back to the profile rather than NaN', () => {
		process.env.GOODREADS_MIN_GAP_MS = 'fast please'
		process.env.GOODREADS_SERIES_URL = 'not-a-url'
		const t = goodreadsTuning()
		// An unparseable URL is treated as SHARED: guessing "local" off a typo
		// would silently drop the pacing that protects the public instance.
		expect(t.profile).toBe('shared')
		expect(t.minGapMs).toBe(1100)
	})

	test('a negative gap cannot be used to disable pacing by accident', () => {
		process.env.GOODREADS_MIN_GAP_MS = '-5000'
		expect(goodreadsTuning().minGapMs).toBe(1100)
	})
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { secureEquals } from '#helpers/utils/secureCompare'

/**
 * Secret comparison that does not leak LENGTH.
 *
 * timingSafeEqual throws on unequal-length buffers, so both token checks
 * guarded it with a length test first — and that guard is itself observable:
 * a wrong-length token returned immediately while a right-length one paid for
 * the compare. Hashing both sides to a fixed 32-byte digest removes the
 * branch by construction.
 */
describe('secureEquals', () => {
	test('accepts only an exact match', () => {
		expect(secureEquals('correct-horse', 'correct-horse')).toBe(true)
		expect(secureEquals('correct-horse', 'correct-horsf')).toBe(false)
		expect(secureEquals('Correct-Horse', 'correct-horse')).toBe(false)
	})

	test('a length mismatch is just a mismatch — never a throw', () => {
		// The raw timingSafeEqual this replaces throws here, which is why the
		// callers needed the leaky guard in the first place.
		expect(() => secureEquals('short', 'a-much-longer-secret')).not.toThrow()
		expect(secureEquals('short', 'a-much-longer-secret')).toBe(false)
		expect(secureEquals('a-much-longer-candidate', 'short')).toBe(false)
	})

	test('an absent secret is never satisfiable, and an absent candidate never matches', () => {
		// A deployment that never set the token must not be openable by
		// sending an empty header — that is a configuration fact, not a
		// timing one.
		expect(secureEquals('anything', undefined)).toBe(false)
		expect(secureEquals('anything', '')).toBe(false)
		expect(secureEquals('anything', null)).toBe(false)
		expect(secureEquals(undefined, 'the-secret')).toBe(false)
		expect(secureEquals('', '')).toBe(false)
	})

	test('unicode and long secrets compare correctly', () => {
		const long = 'x'.repeat(4096)
		expect(secureEquals(long, long)).toBe(true)
		expect(secureEquals(long, long + 'y')).toBe(false)
		expect(secureEquals('päßwörd-🔐', 'päßwörd-🔐')).toBe(true)
		expect(secureEquals('päßwörd-🔐', 'passwörd-🔐')).toBe(false)
	})

	test('BOTH token call sites use it — the shared-rule guard', () => {
		// Two copies of a secret compare is how one of them keeps the leaky
		// form after the other is fixed. Pin that they route through here.
		const read = (p: string) =>
			readFileSync(join(import.meta.dir, '..', '..', '..', 'src', 'config', 'routes', p), 'utf8')
		for (const file of ['writeAuth.ts', 'metrics.ts']) {
			const src = read(file)
			expect(src).toContain('secureEquals(')
			// The CALL, not the word — both files legitimately name
			// timingSafeEqual in the comment explaining why they stopped
			// calling it directly.
			expect(src).not.toContain('crypto.timingSafeEqual(')
		}
	})
})

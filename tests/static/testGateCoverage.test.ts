import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The gate must not be able to lose a directory silently.
 *
 * `bun run test` (what CI runs, .github/workflows/bun.yml) enumerates test
 * directories explicitly rather than sweeping `tests/`, because `tests/live`
 * hits real provider APIs and must stay out of the default gate. The cost of
 * that design is that a NEW directory is excluded by default and nothing says
 * so: `tests/helpers/series` — the shelf-policy, pins and sweep layer, and the
 * repo's most active area — sat outside the gate from the day it was created.
 * Four mutations proved the consequence: dropping the container check, ignoring
 * `pin.keepTag`, ignoring `pin.displayTitle` and dropping the positioned-primary
 * guard ALL survived `bun run test` and were ALL killed by the excluded suite.
 * The tests were good; they simply never ran, in CI or locally.
 *
 * This is the additive-lint remedy rather than a restructure: keep the explicit
 * list (it earns its keep by holding `tests/live` out) and fail loudly the
 * moment a directory of tests exists that neither the gate nor this allowlist
 * names.
 */

const ROOT = join(import.meta.dir, '..', '..')

/** Directories deliberately outside the default gate, each with its reason. */
const INTENTIONALLY_UNGATED: Record<string, string> = {
	'tests/live': 'hits real provider APIs; runs via `bun run test:live`, not the default gate'
}

function directoriesContainingTests(dir: string, found = new Set<string>()): Set<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) {
			directoriesContainingTests(full, found)
		} else if (entry.name.endsWith('.test.ts')) {
			found.add(relative(ROOT, dir).split('\\').join('/'))
		}
	}
	return found
}

describe('the test gate covers every test directory', () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
		scripts: Record<string, string>
	}
	const gated = pkg.scripts.test
		.split(/\s+/)
		.filter((token) => token.startsWith('tests/'))
		.map((token) => token.replace(/\/$/, ''))

	test('the gate names at least the directories it always has', () => {
		// Guards against the list being emptied or the script being rewritten into
		// a bare sweep, either of which would make the assertion below vacuous.
		expect(gated.length).toBeGreaterThanOrEqual(12)
		expect(gated).toContain('tests/helpers/series')
	})

	test('every directory holding a *.test.ts is gated or explicitly allowlisted', () => {
		const withTests = [...directoriesContainingTests(join(ROOT, 'tests'))].sort()
		// A directory is covered when the gate names it or names an ancestor of it.
		const covered = (d: string) => gated.some((g) => d === g || d.startsWith(`${g}/`))
		const ungoverned = withTests.filter(
			(d) =>
				!covered(d) &&
				!Object.keys(INTENTIONALLY_UNGATED).some((a) => d === a || d.startsWith(`${a}/`))
		)
		expect({ ungoverned, hint: 'add to package.json "test" or to INTENTIONALLY_UNGATED' }).toEqual({
			ungoverned: [],
			hint: 'add to package.json "test" or to INTENTIONALLY_UNGATED'
		})
	})

	test('every allowlisted exclusion still exists and carries a reason', () => {
		for (const [dir, reason] of Object.entries(INTENTIONALLY_UNGATED)) {
			expect(reason.length).toBeGreaterThan(20)
			// A stale exclusion is its own hazard: it reads as a considered decision.
			expect(() => readdirSync(join(ROOT, dir))).not.toThrow()
		}
	})
})

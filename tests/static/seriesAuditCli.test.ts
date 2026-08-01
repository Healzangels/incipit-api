import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `scripts/series_audit.py --help` must PRINT USAGE, not die.
 *
 * The privacy scrub made `INCIPIT_API` a module-level hard requirement,
 * evaluated at import — before argparse ever saw the command line. So the one
 * invocation a stranger to the script tries first exited non-zero with an
 * environment complaint instead of documentation, and the module could not be
 * imported at all (`FOLDER_POS_RE` is worth reading on its own, and is
 * deliberately character-for-character identical to the agent's).
 *
 * Asserted STRUCTURALLY rather than by executing python: the bun gate must not
 * grow a python3 dependency, and a test that silently skips when the
 * interpreter is missing is a test that passes for the wrong reason. The
 * requirement is positional and checkable — the guard must live inside main(),
 * after parse_args().
 */
const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'series_audit.py')
const source = readFileSync(SCRIPT, 'utf8')

/**
 * The lines python executes at IMPORT: module level only, with function and
 * class bodies removed (an exit inside `die()` is fine — it only runs when
 * called) and comments stripped (a comment ABOUT an exit is not one).
 */
function moduleLevelCode(py: string): string {
	const out: string[] = []
	let inBody = false
	for (const raw of py.split('\n')) {
		const line = raw.split('#')[0]
		if (!line.trim()) continue
		const indented = /^\s/.test(line)
		if (inBody && indented) continue
		inBody = /^(def |class |async def )/.test(line)
		if (!inBody) out.push(line)
	}
	return out.join('\n')
}

describe('scripts/series_audit.py argument handling', () => {
	test('nothing exits at IMPORT time — argparse must get the first word', () => {
		// Any module-level exit runs before `--help` is ever parsed. This is not a
		// grep for the string: it looks only at the statements python runs on
		// import, so `die()`'s own `sys.exit(1)` and this file's own prose do not
		// count.
		const top = moduleLevelCode(source)
		// The guard the scrub added lived exactly here, inside a top-level
		// `if not API:` — before argparse existed.
		expect(top).not.toContain('SystemExit')
		expect(top).not.toContain('sys.exit')
		// ...and the check itself is real: the helper must actually be seeing the
		// module-level code, not an empty string.
		expect(top).toContain("PLEX = os.environ.get('PLEX_URL'")
	})

	test('the INCIPIT_API requirement is enforced INSIDE main, after parse_args', () => {
		// Still required — this is not "drop the check", it is "check it where a
		// --help run does not reach".
		const guardAt = source.indexOf('INCIPIT_API must be set')
		const parseAt = source.indexOf('args = parser.parse_args()')
		expect(guardAt).toBeGreaterThan(-1)
		expect(parseAt).toBeGreaterThan(-1)
		expect(guardAt).toBeGreaterThan(parseAt)
	})
})

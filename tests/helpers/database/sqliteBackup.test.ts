import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
	backupPathFor,
	DEFAULT_MIN_FRACTION,
	parseMinFraction,
	pruneBackups
} from '#helpers/database/sqlite/backup'

/**
 * A BACKUP NOBODY RUNS IS NOT A BACKUP.
 *
 * Under DB_BACKEND=sqlite the entire datastore is one file on one volume.
 * `bun run backup` had existed for days and never run unattended: on the live
 * deployment 2026-08-09 the newest snapshot was a day old and sat in the same
 * directory as the database it was protecting, on a server whose array has no
 * parity and had just dropped a disk.
 *
 * The snapshot logic itself is exercised by the two-backend integration oracle;
 * what is pinned here is the surrounding policy — retention, path shape, and
 * the env-parsing guard that has been lost to an empty string before.
 */

const DIR = '/tmp/incipit-backup-test'

describe('backupPathFor', () => {
	test('lands a dated sibling next to the live database', () => {
		expect(backupPathFor('/data/incipit.db', new Date('2026-08-09T12:00:00Z'))).toBe(
			'/data/incipit-backup-20260809.db'
		)
	})

	test('the name matches what pruneBackups will later recognise', () => {
		// If these two ever disagree, retention silently stops finding its own
		// files and the volume fills instead.
		const p = backupPathFor('/data/incipit.db', new Date('2026-01-02T00:00:00Z'))
		expect(/\/incipit-backup-\d{8}\.db$/.test(p)).toBe(true)
	})
})

describe('parseMinFraction', () => {
	test('an EMPTY value falls back instead of coercing to zero', () => {
		// `BACKUP_MIN_FRACTION=` in a compose file is Number('') -> 0, which would
		// disable the size floor entirely. This project has lost a guard exactly
		// that way before (UPDATE_THRESHOLD), so it is pinned here.
		expect(parseMinFraction('')).toBe(DEFAULT_MIN_FRACTION)
		expect(parseMinFraction('   ')).toBe(DEFAULT_MIN_FRACTION)
		expect(parseMinFraction(undefined)).toBe(DEFAULT_MIN_FRACTION)
	})

	test('junk and out-of-range values fall back too', () => {
		for (const v of ['abc', '-0.5', '1.5', 'NaN', 'Infinity']) {
			expect(parseMinFraction(v)).toBe(DEFAULT_MIN_FRACTION)
		}
	})

	test('a deliberate override is honoured, including 0', () => {
		// 0 disables the floor — legitimate for a one-off after a bulk delete,
		// but only when explicitly typed, never as a parsing accident.
		expect(parseMinFraction('0')).toBe(0)
		expect(parseMinFraction('0.25')).toBe(0.25)
		expect(parseMinFraction('1')).toBe(1)
	})
})

describe('pruneBackups', () => {
	beforeEach(() => {
		rmSync(DIR, { recursive: true, force: true })
		mkdirSync(DIR, { recursive: true })
	})
	afterEach(() => rmSync(DIR, { recursive: true, force: true }))

	const make = (name: string) => writeFileSync(`${DIR}/${name}`, 'x')

	test('keeps the newest N and removes the rest', () => {
		for (const d of ['20260801', '20260802', '20260803', '20260804', '20260805']) {
			make(`incipit-backup-${d}.db`)
		}
		const removed = pruneBackups(`${DIR}/incipit.db`, 2)
		expect(removed).toHaveLength(3)
		expect(existsSync(`${DIR}/incipit-backup-20260805.db`)).toBe(true)
		expect(existsSync(`${DIR}/incipit-backup-20260804.db`)).toBe(true)
		expect(existsSync(`${DIR}/incipit-backup-20260803.db`)).toBe(false)
	})

	test('NEVER touches the live database or anything it did not write', () => {
		// The pattern is deliberately narrow: an operator's own copy sitting in
		// the same directory must survive, and deleting incipit.db would be
		// catastrophic rather than merely wrong.
		make('incipit.db')
		make('incipit.db-wal')
		make('incipit-backup-20260808-prerebuild.db')
		make('my-own-copy.db')
		for (const d of ['20260801', '20260802']) make(`incipit-backup-${d}.db`)

		pruneBackups(`${DIR}/incipit.db`, 1)

		expect(existsSync(`${DIR}/incipit.db`)).toBe(true)
		expect(existsSync(`${DIR}/incipit.db-wal`)).toBe(true)
		expect(existsSync(`${DIR}/my-own-copy.db`)).toBe(true)
		// The operator's hand-named prerebuild snapshot is not date-shaped, so it
		// is not ours to delete.
		expect(existsSync(`${DIR}/incipit-backup-20260808-prerebuild.db`)).toBe(true)
	})

	test('nothing to do when there are fewer than N', () => {
		make('incipit-backup-20260801.db')
		expect(pruneBackups(`${DIR}/incipit.db`, 7)).toEqual([])
		expect(existsSync(`${DIR}/incipit-backup-20260801.db`)).toBe(true)
	})

	test('keep < 1 is refused rather than deleting everything', () => {
		make('incipit-backup-20260801.db')
		expect(pruneBackups(`${DIR}/incipit.db`, 0)).toEqual([])
		expect(existsSync(`${DIR}/incipit-backup-20260801.db`)).toBe(true)
	})

	test('an unreadable directory is survived, not thrown', () => {
		// A failed prune must never fail the backup that just succeeded.
		expect(pruneBackups('/nonexistent-dir-xyz/incipit.db', 3)).toEqual([])
	})
})

describe('the scheduled job is actually wired', () => {
	test('server.ts starts it, gated on the sqlite backend', () => {
		// A backup module nobody calls is the state this whole change exists to
		// leave behind. Pin the wiring at source.
		const src = readFileSync(join(import.meta.dir, '..', '..', '..', 'src', 'server.ts'), 'utf8')
		// The CALL, not merely the name: `toContain('startBackupJob()')` also
		// matches the function DEFINITION, so deleting the call left this green
		// (caught by mutation testing 2026-08-09). Count both occurrences —
		// definition plus call — so removing either fails.
		expect(src.match(/startBackupJob\(\)/g) ?? []).toHaveLength(2)
		expect(src).toContain('\n\t\tstartBackupJob()')
		expect(src).toContain("process.env.DB_BACKEND !== 'sqlite'")
		expect(src).toContain('backupSqlite(sqlitePath')
		expect(src).toContain('pruneBackups(sqlitePath, keep)')
		// A refusal must be logged loudly: nobody is watching, so a silently
		// skipped backup would look identical to a working one.
		expect(src).toContain('SQLite backup FAILED')
	})

	test('the CLI script and the job share ONE implementation', () => {
		const script = readFileSync(
			join(import.meta.dir, '..', '..', '..', 'scripts', 'backupSqlite.ts'),
			'utf8'
		)
		expect(script).toContain("from '#helpers/database/sqlite/backup'")
		// The script must not have kept its own copy of VACUUM INTO.
		expect(script).not.toContain('VACUUM INTO')
	})
})

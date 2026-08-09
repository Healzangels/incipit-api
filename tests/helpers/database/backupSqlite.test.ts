import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * scripts/backupSqlite.ts, run for real as a subprocess — the only way to test
 * a top-level script whose failure mode IS its exit path.
 *
 * The bug these pin: the script swapped `VACUUM INTO '<out>'` for a temp file
 * plus `renameSync`, which fixed the "output file already exists" death but
 * threw away the only thing protecting the PREVIOUS backup — that same refusal.
 * The surviving size check ran AFTER the destructive rename and only caught
 * exactly zero, which `VACUUM INTO` never produces. Proved 2026-08-08 by
 * running this script: SQLITE_PATH pointing at a nonexistent file (a wrong
 * mount or a typo, which sqliteDb() happily MINTS as an empty database)
 * replaced a 5,000,000-byte good backup with a 73,728-byte schema-only file,
 * printed "backup OK" and exited 0.
 *
 * Lives under tests/helpers/database rather than tests/scripts so it runs
 * inside the ordinary `bun run test` gate, which enumerates directories.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'backupSqlite.ts')

/** Byte the junk "previous backup" is filled with, so we can prove it survived. */
const MARKER = 0x47

let dir: string
let source: string
let backup: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'incipit-backup-'))
	source = join(dir, 'incipit.db')
	backup = join(dir, 'incipit-backup.db')
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

/** A real database carrying `rows` rows, checkpointed so the bytes are on disk. */
function makeDb(path: string, rows: number) {
	const db = new Database(path, { create: true })
	db.exec('PRAGMA journal_mode = WAL')
	db.exec('CREATE TABLE payload (id TEXT PRIMARY KEY, doc TEXT NOT NULL)')
	const insert = db.prepare('INSERT INTO payload (id, doc) VALUES (?, ?)')
	db.exec('BEGIN')
	for (let i = 0; i < rows; i++) insert.run(String(i), 'x'.repeat(1024))
	db.exec('COMMIT')
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
	db.close()
}

function writeGoodBackup(bytes: number) {
	writeFileSync(backup, Buffer.alloc(bytes, MARKER))
}

function backupIsUntouched(bytes: number) {
	expect(statSync(backup).size).toBe(bytes)
	// Size alone would pass if the file had been rewritten to the same length.
	expect(readFileSync(backup).every((b) => b === MARKER)).toBe(true)
}

async function runBackup(env: Record<string, string>) {
	const proc = Bun.spawn(['bun', 'run', SCRIPT], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe'
	})
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text()
	])
	return { exitCode: await proc.exited, stdout, stderr }
}

describe('backupSqlite refuses to destroy a good backup', () => {
	test('a MISSING source does not replace the previous backup — and is not minted', async () => {
		writeGoodBackup(5_000_000)
		// A path whose DIRECTORY exists — the wrong-mount/typo shape, and the one
		// `{ create: true }` will happily bring into existence.
		const missing = join(dir, 'not-mounted.db')

		const { exitCode, stdout, stderr } = await runBackup({
			SQLITE_PATH: missing,
			BACKUP_PATH: backup
		})

		expect(exitCode).not.toBe(0)
		expect(stdout).not.toContain('backup OK')
		expect(stderr).toContain('FAILED')
		backupIsUntouched(5_000_000)
		// sqliteDb() opens with { create: true }: the script must not bring the
		// wrong path into existence on its way to backing it up.
		expect(existsSync(missing)).toBe(false)
	})

	test('a NEAR-EMPTY source does not replace the previous backup', async () => {
		// The exact proved shape: a schema-only database is a perfectly valid
		// SQLite file of tens of kilobytes, so `VACUUM INTO` succeeds and the old
		// `!size` check waves it through — after the rename has already landed.
		makeDb(source, 0)
		writeGoodBackup(5_000_000)

		const { exitCode, stdout, stderr } = await runBackup({
			SQLITE_PATH: source,
			BACKUP_PATH: backup
		})

		expect(exitCode).not.toBe(0)
		expect(stdout).not.toContain('backup OK')
		expect(stderr).toContain('FAILED')
		backupIsUntouched(5_000_000)
		expect(existsSync(`${backup}.tmp`)).toBe(false)
	})

	test('a GENUINE snapshot still replaces the previous backup', async () => {
		// The guard must not turn into "never back up again".
		makeDb(source, 2000)
		writeGoodBackup(100_000)

		const { exitCode, stdout } = await runBackup({
			SQLITE_PATH: source,
			BACKUP_PATH: backup
		})

		expect(exitCode).toBe(0)
		expect(stdout).toContain('backup OK')
		expect(existsSync(`${backup}.tmp`)).toBe(false)
		expect(statSync(backup).size).toBeGreaterThan(1_000_000)
		const restored = new Database(backup, { readonly: true })
		const { n } = restored.query('SELECT count(*) AS n FROM payload').get() as { n: number }
		restored.close()
		expect(n).toBe(2000)
	})

	test('a DECLARED-BUT-EMPTY BACKUP_MIN_FRACTION does not disable the floor', async () => {
		// `BACKUP_MIN_FRACTION=` in a compose file is `Number('')` -> 0, which
		// would coerce the guard away silently. Unset-shaped means default.
		makeDb(source, 0)
		writeGoodBackup(5_000_000)

		const { exitCode } = await runBackup({
			SQLITE_PATH: source,
			BACKUP_PATH: backup,
			BACKUP_MIN_FRACTION: ''
		})

		expect(exitCode).not.toBe(0)
		backupIsUntouched(5_000_000)
	})

	test('BACKUP_MIN_FRACTION is the documented way out of a genuine shrink', async () => {
		// The refusal names this knob, so it has to work: an operator who really
		// did delete most of the library must be able to take a backup.
		makeDb(source, 0)
		writeGoodBackup(5_000_000)

		const { exitCode, stdout } = await runBackup({
			SQLITE_PATH: source,
			BACKUP_PATH: backup,
			BACKUP_MIN_FRACTION: '0'
		})

		expect(exitCode).toBe(0)
		expect(stdout).toContain('backup OK')
		expect(statSync(backup).size).toBeLessThan(5_000_000)
	})
})

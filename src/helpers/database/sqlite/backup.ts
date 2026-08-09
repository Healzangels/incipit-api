import { readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'

import { sqliteDb } from '#helpers/database/sqlite/SqliteModel'

/**
 * SQLite snapshotting, shared by the CLI script and the scheduled job.
 *
 * ONE implementation on purpose. The logic here is not obvious — it carries
 * three separately-earned guards (source-must-exist, temp-then-rename, and a
 * size floor checked BEFORE the destructive step), each of which cost a real
 * failure to learn. A second copy for the scheduler would drift away from them.
 */

/**
 * How small a snapshot may be relative to the largest thing it stands in for.
 *
 * `VACUUM INTO` compacts, so a copy is legitimately smaller than its source —
 * free pages go away — but it never halves a healthy database. The failure this
 * catches is off by orders of magnitude: measured 2026-08-08, a 73,728-byte
 * schema-only snapshot replaced a 5,000,000-byte good backup and reported
 * success.
 */
export const DEFAULT_MIN_FRACTION = 0.5

/** Size in bytes, or 0 when the path does not exist or cannot be read. */
function sizeOf(path: string): number {
	try {
		return statSync(path).size
	} catch {
		return 0
	}
}

export interface BackupResult {
	ok: boolean
	path: string
	bytes: number
	message: string
}

/** Parse a 0..1 fraction, falling back rather than coercing an empty string. */
export function parseMinFraction(raw: string | undefined): number {
	// An UNSET-shaped value must fall back: a declared-but-empty
	// `BACKUP_MIN_FRACTION=` in a compose file is Number('') -> 0, which would
	// silently disable the floor — the exact way this codebase has lost a guard.
	const trimmed = raw?.trim()
	const parsed = trimmed ? Number(trimmed) : Number.NaN
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_MIN_FRACTION
}

/** The dated filename a snapshot lands on, given the live database path. */
export function backupPathFor(sqlitePath: string, now: Date): string {
	const stamp = now.toISOString().slice(0, 10).replace(/-/g, '')
	const dir = sqlitePath.replace(/\/[^/]+$/, '')
	return `${dir}/incipit-backup-${stamp}.db`
}

/**
 * Take one consistent snapshot. Never throws — returns why it declined.
 *
 * Safe while the API is serving: `VACUUM INTO` snapshots without stopping the
 * writer, and busy_timeout is already set on the connection, so a concurrent
 * scheduler write waits rather than failing.
 * @param {string} sqlitePath the live database
 * @param {string} [outPath] destination; defaults to a dated sibling
 * @param {number} [minFraction] size floor as a fraction of the largest source
 * @returns {BackupResult} what happened, for the caller to log
 */
export function backupSqlite(
	sqlitePath: string,
	outPath?: string,
	minFraction: number = DEFAULT_MIN_FRACTION
): BackupResult {
	const out = outPath || backupPathFor(sqlitePath, new Date())
	// THE SOURCE MUST ALREADY EXIST. sqliteDb() opens with `{ create: true }`, so
	// a typo'd or unmounted SQLITE_PATH does not fail — it MINTS an empty
	// database and every step after faithfully backs up nothing.
	const sourceSize = sizeOf(sqlitePath)
	if (!sourceSize) {
		return {
			ok: false,
			path: out,
			bytes: 0,
			message: `SQLITE_PATH ${sqlitePath} is missing or empty; nothing written, previous backup untouched`
		}
	}

	const previousSize = sizeOf(out)

	// VACUUM INTO REFUSES an existing target, so a second run the same day died
	// outright. Write to a temp sibling and rename: the rename is atomic, so a
	// reader never sees a half-written file. That refusal was ALSO the only
	// thing protecting the previous good backup, so the floor below has to earn
	// it back — and must be checked BEFORE the rename, the destructive step.
	const tmp = `${out}.tmp`
	try {
		unlinkSync(tmp)
	} catch {
		/* no stale temp to clear */
	}
	try {
		sqliteDb().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`)
	} catch (err) {
		return { ok: false, path: out, bytes: 0, message: `VACUUM INTO failed: ${String(err)}` }
	}

	const snapshotSize = sizeOf(tmp)
	const floor = Math.floor(minFraction * Math.max(sourceSize, previousSize))
	if (!snapshotSize || snapshotSize < floor) {
		try {
			unlinkSync(tmp)
		} catch {
			/* nothing to clean */
		}
		return {
			ok: false,
			path: out,
			bytes: snapshotSize,
			message:
				`snapshot is ${snapshotSize} bytes, under the ${floor}-byte floor ` +
				`(${minFraction} x max(source ${sourceSize}, existing ${previousSize})). ` +
				`${previousSize ? `${out} is UNTOUCHED` : 'nothing written'}. ` +
				'If the database genuinely shrank, re-run with BACKUP_MIN_FRACTION.'
		}
	}
	renameSync(tmp, out)
	return {
		ok: true,
		path: out,
		bytes: snapshotSize,
		message: `${out} (${(snapshotSize / 1048576).toFixed(1)} MB)`
	}
}

/**
 * Delete all but the newest `keep` dated snapshots.
 *
 * The CLI script deliberately never deletes — a human running a backup by hand
 * should not have one silently removed. A SCHEDULED backup is the opposite: with
 * no retention it fills the volume, and on this deployment that volume also
 * holds the live database. Retention is therefore part of the job, not the
 * script.
 *
 * Only ever touches files matching the dated pattern this module writes, so an
 * operator's own copy sitting in the same directory is never a candidate.
 * @param {string} sqlitePath the live database, used to locate the directory
 * @param {number} keep how many to retain
 * @returns {string[]} paths removed
 */
export function pruneBackups(sqlitePath: string, keep: number): string[] {
	if (keep < 1) return []
	const dir = sqlitePath.replace(/\/[^/]+$/, '')
	let names: string[]
	try {
		names = readdirSync(dir)
	} catch {
		return []
	}
	const ours = names
		.filter((n) => /^incipit-backup-\d{8}\.db$/.test(n))
		.sort()
		.reverse()
	const doomed = ours.slice(keep)
	const removed: string[] = []
	for (const n of doomed) {
		try {
			unlinkSync(`${dir}/${n}`)
			removed.push(`${dir}/${n}`)
		} catch {
			/* leave it; a failed prune must never fail the backup */
		}
	}
	return removed
}

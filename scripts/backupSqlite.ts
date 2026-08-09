/**
 * One-command SQLite backup, safe while the API is serving.
 *
 *   docker exec incipit-api bun run backup
 *
 * Uses `VACUUM INTO`, which snapshots a consistent copy without stopping the
 * writer — a plain `cp` of a live WAL database can catch it mid-checkpoint and
 * omit the -wal file (plan §4). busy_timeout is already set on the connection,
 * so a concurrent scheduler write waits instead of failing.
 *
 * Output lands next to the live file as incipit-backup-YYYYMMDD.db (override
 * with BACKUP_PATH). Keeps whatever retention you enforce externally — this
 * script deliberately never deletes a backup, and never replaces one it has
 * not first checked (see the floor below); its own temp file is the only thing
 * it removes.
 */
import { renameSync, unlinkSync } from 'node:fs'

import { sqliteDb } from '#helpers/database/sqlite/SqliteModel'

if (!process.env.SQLITE_PATH) {
	console.error('SQLITE_PATH is not set — nothing to back up')
	process.exit(1)
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const dir = process.env.SQLITE_PATH.replace(/\/[^/]+$/, '')
const out = process.env.BACKUP_PATH || `${dir}/incipit-backup-${stamp}.db`

/**
 * How small the snapshot may be relative to the biggest thing it claims to
 * stand in for (the live database, or the backup it is about to replace).
 *
 * `VACUUM INTO` compacts, so the copy is LEGITIMATELY smaller than the source —
 * free pages go away — but it never halves a healthy database, while the
 * failure this floor exists to catch is off by orders of magnitude (measured:
 * a 73,728-byte schema-only snapshot against a 5,000,000-byte backup). Raise or
 * lower it with BACKUP_MIN_FRACTION for a one-off after a genuine bulk delete;
 * the refusal names the knob so the operator does not have to read this file.
 */
const DEFAULT_MIN_FRACTION = 0.5
// An UNSET-shaped value falls back to the default rather than coercing: a
// declared-but-empty `BACKUP_MIN_FRACTION=` in a compose file is `Number('')`
// -> 0, which would silently disable the floor — the exact way this codebase
// has lost a guard to an env var before.
const rawFraction = process.env.BACKUP_MIN_FRACTION?.trim()
const parsedFraction = rawFraction ? Number(rawFraction) : Number.NaN
const minFraction =
	Number.isFinite(parsedFraction) && parsedFraction >= 0 && parsedFraction <= 1
		? parsedFraction
		: DEFAULT_MIN_FRACTION

// THE SOURCE MUST ALREADY EXIST. sqliteDb() opens with `{ create: true }`, so a
// typo'd or unmounted SQLITE_PATH does not fail — it MINTS an empty database,
// and every step after that faithfully backs up nothing. Proved 2026-08-08 by
// running this script: a wrong SQLITE_PATH produced a 73,728-byte schema-only
// snapshot, replaced a 5,000,000-byte good backup with it, printed "backup OK"
// and exited 0.
const source = Bun.file(process.env.SQLITE_PATH)
const sourceSize = (await source.exists()) ? source.size : 0
if (!sourceSize) {
	console.error(
		`backup FAILED — SQLITE_PATH ${process.env.SQLITE_PATH} is missing or empty. ` +
			'Nothing was written; the previous backup is untouched.'
	)
	process.exit(1)
}

// VACUUM INTO REFUSES an existing target ("output file already exists"), so a
// second backup on the same day — or any retry after a partial/failed run, or
// a fixed BACKUP_PATH — died with a raw SQLiteError and no backup taken. Hit
// live 2026-08-08. Write to a temp sibling and rename into place: the rename
// is atomic, so a reader never sees a half-written file.
//
// That refusal was ALSO the only thing protecting the previous good backup, so
// the rename has to earn it back explicitly. The snapshot is sanity-checked
// BEFORE the rename, because the rename is the destructive step — checking
// after it can only report the loss, and `!size` never fires anyway: a failed
// snapshot is a valid, schema-only database, not a zero-byte file.
const previous = Bun.file(out)
const previousSize = (await previous.exists()) ? previous.size : 0
const tmp = `${out}.tmp`
if (await Bun.file(tmp).exists()) unlinkSync(tmp)
const db = sqliteDb()
db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`)

const snapshotSize = Bun.file(tmp).size
const floor = Math.floor(minFraction * Math.max(sourceSize, previousSize))
if (!snapshotSize || snapshotSize < floor) {
	unlinkSync(tmp)
	console.error(
		`backup FAILED — snapshot is ${snapshotSize} bytes, under the ${floor}-byte floor ` +
			`(${minFraction} x max(source ${sourceSize}, existing backup ${previousSize})). ` +
			`${previousSize ? `${out} is UNTOUCHED` : 'nothing was written'}. ` +
			'If the database genuinely shrank, re-run with BACKUP_MIN_FRACTION.'
	)
	process.exit(1)
}
renameSync(tmp, out)
console.log(`backup OK: ${out} (${(snapshotSize / 1048576).toFixed(1)} MB)`)

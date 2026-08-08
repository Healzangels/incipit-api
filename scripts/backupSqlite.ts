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
 * script deliberately never deletes anything.
 */
import { sqliteDb } from '#helpers/database/sqlite/SqliteModel'

if (!process.env.SQLITE_PATH) {
	console.error('SQLITE_PATH is not set — nothing to back up')
	process.exit(1)
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const dir = process.env.SQLITE_PATH.replace(/\/[^/]+$/, '')
const out = process.env.BACKUP_PATH || `${dir}/incipit-backup-${stamp}.db`

const db = sqliteDb()
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`)
const size = (await Bun.file(out).exists()) ? Bun.file(out).size : 0
if (!size) {
	console.error(`backup FAILED — ${out} missing or empty`)
	process.exit(1)
}
console.log(`backup OK: ${out} (${(size / 1048576).toFixed(1)} MB)`)

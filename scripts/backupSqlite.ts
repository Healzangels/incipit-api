/**
 * One-command SQLite backup, safe while the API is serving.
 *
 *   docker exec incipit-api bun run backup
 *
 * The snapshot logic lives in `#helpers/database/sqlite/backup` because the
 * SCHEDULED job uses it too — the container now backs itself up every
 * SQLITE_BACKUP_INTERVAL_HOURS, and a second copy of these guards here would
 * drift from the ones the unattended path relies on.
 *
 * This wrapper stays for the manual case: a snapshot before a risky operation,
 * or a one-off to a chosen BACKUP_PATH. Unlike the scheduled job it does NOT
 * prune — a human taking a deliberate backup should never have an older one
 * silently removed underneath them.
 */
import { backupSqlite, parseMinFraction } from '#helpers/database/sqlite/backup'

if (!process.env.SQLITE_PATH) {
	console.error('SQLITE_PATH is not set — nothing to back up')
	process.exit(1)
}

const result = backupSqlite(
	process.env.SQLITE_PATH,
	process.env.BACKUP_PATH,
	parseMinFraction(process.env.BACKUP_MIN_FRACTION)
)

if (!result.ok) {
	console.error(`backup FAILED — ${result.message}`)
	process.exit(1)
}
console.log(`backup OK: ${result.message}`)

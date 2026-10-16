/**
 * The overlay's runtime DATA: a private JSON file on the API volume, read at
 * serve time, never shipped in the image.
 *
 *   BOOK_OVERLAY_PATH   default /data/overlays/book-enrichment.json
 *
 * (the container's /data is the API appdata directory, beside the SQLite DB).
 *
 * The contract, in the order it matters:
 * - NO FILE means no overlay: the API serves exactly what it served before the
 *   feature existed. Deleting the file is a complete rollback.
 * - A file is served only after compileOverlay has accepted ALL of it. A file
 *   that fails to parse or fails any gate is REFUSED, logged once with every
 *   reason, and the last good table keeps serving — a typo in tonight's batch
 *   never blanks last week's approved text.
 * - A changed file is picked up on the next request, no restart: each lookup
 *   costs one stat(), and the file is re-read only when its inode, size or
 *   mtime moved.
 *
 * Redis caches only the stored record, never the served shape, so a reload
 * needs no cache invalidation; a forced Plex refresh delivers it.
 */
import { readFileSync, statSync } from 'node:fs'

import { compileOverlay, type OverlayTable } from '#helpers/overlay/bookOverlay'

export const DEFAULT_BOOK_OVERLAY_PATH = '/data/overlays/book-enrichment.json'

/** The slice of a pino logger this uses; request.log satisfies it. */
export interface OverlayLog {
	info: (obj: object, msg: string) => void
	error: (obj: object, msg: string) => void
}

export class BookOverlayStore {
	private table: OverlayTable | null = null
	/** The file state last LOOKED AT (served or refused), so a refused file is
	 *  logged once, not on every request until someone fixes it. */
	private seen: string | null = null

	constructor(readonly path: string) {}

	/**
	 * The table to serve right now.
	 * @param {OverlayLog} [log] where load and refusal lines go
	 * @returns {OverlayTable | null} the last good table, or null (no overlay)
	 */
	current(log?: OverlayLog): OverlayTable | null {
		// Measured 2026-10-16 under bun: about 1 microsecond per call whether or not
		// the file exists, so a stat per request is not worth a timer.
		let st: ReturnType<typeof statSync>
		try {
			st = statSync(this.path, { throwIfNoEntry: false })
		} catch (err) {
			// Unreadable for a reason other than absence (permissions, a stale
			// mount): that says nothing about the DATA, so the last good table stands.
			if (this.seen !== 'unreadable')
				log?.error(
					{ path: this.path, err },
					'book overlay file unreadable; keeping the last good table'
				)
			this.seen = 'unreadable'
			return this.table
		}
		if (!st) {
			// Gone, including after it was there: that IS the rollback.
			if (this.seen !== 'missing')
				log?.info(
					{ path: this.path },
					this.table
						? 'book overlay file removed: serving without an overlay'
						: 'no book overlay file: serving without an overlay'
				)
			this.seen = 'missing'
			this.table = null
			return null
		}
		const signature = `${st.ino}:${st.size}:${st.mtimeMs}`
		if (signature === this.seen) return this.table
		this.seen = signature

		let raw: unknown
		try {
			raw = JSON.parse(readFileSync(this.path, 'utf8'))
		} catch (err) {
			log?.error(
				{ path: this.path, err: String(err), kept: this.table?.report.served ?? 0 },
				'book overlay REFUSED: not valid JSON; keeping the last good table'
			)
			return this.table
		}
		const result = compileOverlay(raw)
		if (!result.ok) {
			log?.error(
				{ path: this.path, errors: result.errors, kept: this.table?.report.served ?? 0 },
				'book overlay REFUSED by the load gate; keeping the last good table'
			)
			return this.table
		}
		this.table = result.table
		log?.info({ path: this.path, ...result.table.report }, 'book overlay loaded')
		return this.table
	}
}

let shared: BookOverlayStore | null = null

/**
 * The process-wide table for BOOK_OVERLAY_PATH. The path is read on every call
 * so a test (or an operator moving the file) never fights a stale singleton.
 * @param {OverlayLog} [log] where load and refusal lines go
 * @returns {OverlayTable | null} the table to serve, or null
 */
export function bookOverlayTable(log?: OverlayLog): OverlayTable | null {
	const path = process.env.BOOK_OVERLAY_PATH || DEFAULT_BOOK_OVERLAY_PATH
	if (!shared || shared.path !== path) shared = new BookOverlayStore(path)
	return shared.current(log)
}

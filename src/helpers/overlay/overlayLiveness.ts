/**
 * Is every served overlay entry still REACHABLE in a library, and does any key
 * reach more than one album?
 *
 * The same two failures check:pins exists for (pinLiveness.ts), for the same
 * reasons: an entry keyed on an edition id silently stops applying when the
 * album is re-matched, and a portable key can reach a second album it was never
 * written for. Neither is visible in the code or the data, so both are checked
 * against a real library: `bun run check:overlay`.
 */
import type { OverlayTable } from '#helpers/overlay/bookOverlay'
import { overlayTitleKey } from '#helpers/overlay/bookOverlay'

export interface OverlayLivenessReport {
	total: number
	live: string[]
	/** Reached by a key but not by its own id: the entries a re-match moved. */
	byKeyOnly: string[]
	dead: string[]
	/** Served keys that reach MORE THAN ONE album. */
	ambiguous: { key: string; albums: string[] }[]
}

/**
 * Split the served entries into reachable and dead, and list ambiguous keys.
 * Pure: the script supplies the library.
 * @param {OverlayTable} table the compiled overlay
 * @param {Iterable<string>} liveRecordIds the album record ids in the library
 * @param {ReadonlyMap<string, readonly string[]>} albumsByKey album ids grouped
 *   by every overlay key the script could compute for them
 * @returns {OverlayLivenessReport} the report, every list sorted
 */
export function overlayLiveness(
	table: OverlayTable,
	liveRecordIds: Iterable<string>,
	albumsByKey: ReadonlyMap<string, readonly string[]>
): OverlayLivenessReport {
	const live = new Set(liveRecordIds)
	const reachable: string[] = []
	const byKeyOnly: string[] = []
	const dead: string[] = []
	const reaches = (k: string | null): boolean => !!k && (albumsByKey.get(k)?.length ?? 0) > 0
	for (const id of table.byId.keys()) {
		if (live.has(id)) {
			reachable.push(id)
			continue
		}
		const keys = table.keysByEdition.get(id)
		if (keys && (reaches(keys.narration) || reaches(keys.title))) {
			reachable.push(id)
			byKeyOnly.push(id)
			continue
		}
		dead.push(id)
	}
	const served = new Set([...table.byNarration.keys(), ...table.byTitle.keys()])
	const ambiguous = [...served]
		.map((key) => ({ key, albums: [...new Set(albumsByKey.get(key) ?? [])].sort() }))
		.filter((a) => a.albums.length > 1)
		.sort((a, b) => a.key.localeCompare(b.key))
	return {
		total: table.byId.size,
		live: reachable.sort(),
		byKeyOnly: byKeyOnly.sort(),
		dead: dead.sort(),
		ambiguous
	}
}

const XML_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'"
}

/**
 * Decode the entities Plex writes into attribute values.
 * @param {string} s an attribute value as it appears in the XML
 * @returns {string} the decoded value
 */
export function decodeXmlAttr(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
		if (body[0] === '#')
			return String.fromCodePoint(
				body[1] === 'x' || body[1] === 'X'
					? parseInt(body.slice(2), 16)
					: parseInt(body.slice(1), 10)
			)
		return XML_ENTITIES[body.toLowerCase()] ?? whole
	})
}

export interface PlexAlbumRow {
	id: string
	title: string
	artist: string
}

/**
 * The album rows of a Plex section listing: record id, album title and artist.
 *
 * Enough to form every album's TITLE key from one bulk request, which is what
 * lets `check:overlay` find title-key ambiguity WITHOUT reading each album
 * through the API (a full read has degraded the API's caches before). The
 * album title Plex holds is the title the bundle last wrote, so it is the
 * served title, near enough; narration keys need the narrators, which the bulk
 * listing does not carry.
 *
 * Anchored like albumRecordIds: ` guid="` (whitespace, lowercase) so the
 * artist's `parentGuid` is never read as the album's, ` title="` so neither
 * `parentTitle` nor `titleSort` is.
 * @param {string} xml a /library/sections/:id/all?type=9 response
 * @returns {PlexAlbumRow[]} one row per album carrying an Incipit guid
 */
export function plexAlbumRows(xml: string): PlexAlbumRow[] {
	const rows: PlexAlbumRow[] = []
	for (const tag of xml.match(/<Directory\s[^>]*>/g) ?? []) {
		const id = /\sguid="(?:[\w.]*\.)?incipit:\/\/([A-Za-z0-9-]+?)(?:_[a-z]{2})?\?/.exec(tag)?.[1]
		if (!id) continue
		const title = decodeXmlAttr(/\stitle="([^"]*)"/.exec(tag)?.[1] ?? '')
		const artist = decodeXmlAttr(/\sparentTitle="([^"]*)"/.exec(tag)?.[1] ?? '')
		rows.push({ id, title, artist })
	}
	return rows
}

/**
 * Album ids grouped by title key, from the bulk listing.
 * @param {PlexAlbumRow[]} rows the album rows
 * @returns {Map<string, string[]>} title key -> album ids
 */
export function albumsByTitleKey(rows: readonly PlexAlbumRow[]): Map<string, string[]> {
	const out = new Map<string, string[]>()
	for (const r of rows) {
		const k = overlayTitleKey(r.title, r.artist)
		if (k) out.set(k, [...(out.get(k) ?? []), r.id])
	}
	return out
}

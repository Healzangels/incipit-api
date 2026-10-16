/**
 * The description template (audiobooks PLAN-v2 section 4.2) as code: what Plex
 * shows for an overlaid book. The reference implementation is the research
 * renderer `overlay_render.py`; the text it printed is what the operator
 * approved, and `scripts/renderOverlay.ts --expect` holds this renderer to it.
 *
 *   1. the hook (operator prose);
 *   2. an optional setting paragraph;
 *   3. a block of lines:
 *      - "Series: <shelf>, Book N" (or "Book N of M" when the work states the
 *        series is complete), from the SERVED shelf — never for a standalone or
 *        a self-titled one-book shelf (Project Hail Mary on "Project Hail Mary");
 *      - the credits line, from the SERVED record: narrators (or "Read by the
 *        author", or a production credit), Unabridged/Abridged, runtime,
 *        publisher and year;
 *      - optional translator/introduction credits, an age band, a Contents line;
 *   4. "Praise", at most two approved quotes;
 *   5. "Awards", juried results only (the loader refuses anything else).
 *
 * Plain text: paragraphs are separated by a blank line, and the bundle writes
 * the string as it is (it strips tags and decodes nothing). Operator text is
 * proven plain at load; record text is decoded and stripped of `<` and `>` here.
 */
import { htmlToText } from 'html-to-text'

import type { OverlayEdition, OverlayWork } from '#helpers/overlay/overlaySchema'

type Named = { name?: string | null } | null | undefined

/** The served-record fields the renderer reads. Every one is optional: a
 *  Hardcover or OpenLibrary record can lack any of them, and a missing field
 *  drops its piece of the credits line rather than printing "undefined". */
export interface OverlayRecord {
	title?: string | null
	authors?: ReadonlyArray<Named> | null
	narrators?: ReadonlyArray<Named> | null
	formatType?: string | null
	runtimeLengthMin?: number | null
	publisherName?: string | null
	releaseDate?: Date | string | null
	seriesPrimary?: { name?: string | null; position?: string | null } | null
}

/**
 * Provider text made safe for a plain-text summary: entities decoded, any tag
 * removed, and a stray `<`/`>` dropped, whitespace collapsed. A publisher served
 * as "Simon &amp; Schuster" must reach Plex as "Simon & Schuster".
 * @param {unknown} value a record-derived value
 * @returns {string} the cleaned text, '' when nothing survives
 */
export function recordText(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) return ''
	return htmlToText(value, { wordwrap: false }).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
}

const names = (list: ReadonlyArray<Named> | null | undefined): string[] =>
	(list ?? []).map((p) => recordText(p?.name)).filter(Boolean)

/** Same fold as the reference renderer's self-titled test: lowercase, every
 *  "the " removed, then everything but letters, digits and `_`. */
const foldShelf = (s: string): string =>
	s
		.toLowerCase()
		.replaceAll('the ', '')
		.replace(/[^\p{L}\p{N}_]/gu, '')

const sameName = (a: string, b: string): boolean =>
	a.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === b.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/**
 * "17 h 03 min": hours unpadded, minutes always two digits.
 * @param {number} minutes the runtime in minutes
 * @returns {string} the display runtime
 */
export function hoursMinutes(minutes: number): string {
	const m = Math.round(minutes)
	return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/**
 * The release YEAR. Read off the ISO date's own digits for a string and in UTC
 * for a Date: a record released "2000-12-31T00:00:00.000Z" is a 2000 book in
 * every timezone, and local-time getFullYear() would call it 2000 or 2001
 * depending on where the API runs.
 * @param {Date | string | null | undefined} date the record's releaseDate
 * @returns {number | null} the year, or null when there is none
 */
export function releaseYear(date: Date | string | null | undefined): number | null {
	if (date instanceof Date) return Number.isNaN(date.getTime()) ? null : date.getUTCFullYear()
	const m = typeof date === 'string' ? /^(\d{4})/.exec(date.trim()) : null
	return m ? Number(m[1]) : null
}

/**
 * The Series line, or null for a book that gets none.
 * @param {OverlayWork} work the overlay work (for series_total)
 * @param {OverlayRecord} rec the SERVED record, after pins and shelf policy
 * @returns {string | null} "Series: <shelf>, Book N[ of M]" or null
 */
export function seriesLine(work: OverlayWork, rec: OverlayRecord): string | null {
	const shelf = recordText(rec.seriesPrimary?.name)
	const position = recordText(rec.seriesPrimary?.position).replace(/^book\s+/i, '')
	if (!shelf || !position) return null
	// A self-titled one-book shelf is a standalone (decision Q12): Project Hail
	// Mary keeps its shelf for the folder layout but the text says nothing.
	const title = recordText(rec.title)
	if (title && foldShelf(shelf) === foldShelf(title)) return null
	const total = work.series_total ? ` of ${work.series_total}` : ''
	return `Series: ${shelf}, Book ${position}${total}`
}

/**
 * The credits line. Never stored: a re-match to another edition, or a corrected
 * runtime, changes it by itself.
 * @param {OverlayEdition | null} edition the matched edition, or null on a
 *   work-only (title key) match, which carries no recording-scoped credit
 * @param {OverlayRecord} rec the served record
 * @returns {string} the credits line, '' when the record says nothing at all
 */
export function creditsLine(edition: OverlayEdition | null, rec: OverlayRecord): string {
	const narrators = names(rec.narrators)
	const leadAuthor = names(rec.authors)[0]
	let who: string | null = null
	if (edition?.production) who = edition.production
	else if (
		edition?.read_by_author ||
		(narrators.length > 0 && leadAuthor && sameName(narrators[0], leadAuthor))
	)
		who = 'Read by the author'
	else if (narrators.length)
		who = `Narrated by ${narrators.slice(0, 3).join(', ')}${narrators.length > 3 ? ' and others' : ''}`
	// A production credit replaces the abridgement too: "GraphicAudio dramatized
	// adaptation, full cast · Unabridged" says the wrong thing about a dramatization.
	const format = edition?.production
		? null
		: ({ unabridged: 'Unabridged', abridged: 'Abridged' } as Record<string, string>)[
				String(rec.formatType ?? '').toLowerCase()
			]
	const minutes = typeof rec.runtimeLengthMin === 'number' ? rec.runtimeLengthMin : 0
	const runtime = minutes > 0 ? hoursMinutes(minutes) : null
	const year = releaseYear(rec.releaseDate)
	const imprint = [recordText(rec.publisherName), year ? String(year) : '']
		.filter(Boolean)
		.join(', ')
	return [who, format, runtime, imprint].filter(Boolean).join(' · ')
}

/**
 * The full summary for one overlaid book.
 * @param {OverlayWork} work the work's approved text
 * @param {OverlayEdition | null} edition the edition, or null for a work-only
 *   match (narration praise, recording awards and edition credits are then left
 *   out: they belong to a recording this record may not be)
 * @param {OverlayRecord} rec the SERVED record (post-pin, post-policy)
 * @returns {string} plain text, paragraphs separated by a blank line
 */
export function renderOverlaySummary(
	work: OverlayWork,
	edition: OverlayEdition | null,
	rec: OverlayRecord
): string {
	const parts: string[] = [work.hook.trim()]
	if (work.setting) parts.push(work.setting.trim())

	const lines: string[] = []
	const series = seriesLine(work, rec)
	if (series) lines.push(series)
	const credits = creditsLine(edition, rec)
	if (credits) lines.push(credits)
	if (edition?.credits?.length) lines.push(edition.credits.join(' · '))
	if (work.age_band) lines.push(`Ages ${work.age_band}`)
	if (work.contents?.length) lines.push(`Contents: ${work.contents.join('; ')}`)
	if (lines.length) parts.push(lines.join('\n'))

	// The recording's own praise first: on a narrated book the reading is what
	// the listener is choosing.
	const praise = [...(edition?.praise ?? []), ...(work.praise ?? [])].slice(0, 2)
	if (praise.length)
		parts.push(['Praise', ...praise.map((p) => `“${p.text}” — ${p.source}, ${p.year}`)].join('\n'))

	const awards = [...(work.awards ?? []), ...(edition?.awards ?? [])]
	if (awards.length)
		parts.push(
			['Awards', ...awards.map((a) => `${a.award} ${a.year}: ${a.category} (${a.result})`)].join(
				'\n'
			)
		)

	return parts.join('\n\n')
}

/**
 * Reading one record's served shelf answer, for the drift sweep.
 *
 * Extracted from scripts/seriesSweep.ts because the distinction it encodes is a
 * DECISION, not plumbing: a 429 is the api asking us to slow down, while a 404
 * is the api answering that it has nothing for this record. Scoring them alike
 * makes the sweep's own concurrency look like missing data — and because
 * unavailable rows are (correctly) never queued for review, those records fall
 * out of drift detection entirely, silently. Two consecutive full sweeps on
 * 2026-07-31 both reported exactly 121 unavailable records: a stable number is
 * the fingerprint of a limiter, not of transient loss.
 */

import defaultSleep from '#helpers/utils/sleep'

export interface Answer {
	primary: string | null
	secondary: string | null
}

/** Project a served answer down to the two slots the ledger stores. */
export const answerOf = (a: Answer): Answer => ({ primary: a.primary, secondary: a.secondary })

/**
 * The ONE spelling of "same answer". Both slots, always.
 *
 * This rule already drifted once: a primary-only compare let a tag change through
 * undiffed, and the fix was then written out by hand in two files. A third slot
 * added to Answer must change exactly one comparator, not be missed by one.
 * @param {Answer} a one answer
 * @param {Answer} b the other
 * @returns {boolean} true when both slots agree
 */
export const sameAnswer = (a: Answer, b: Answer): boolean =>
	a.primary === b.primary && a.secondary === b.secondary

/** The marker fetchServedAnswer mints when the api cannot answer a record. */
export const UNAVAILABLE_PREFIX = 'UNAVAILABLE'

/**
 * Whether a stored primary is the unavailable marker rather than a shelf. The
 * producer and its consumers were joined only by a magic string in three places;
 * this is the predicate they share.
 * @param {string | null | undefined} primary a ledger or served primary
 * @returns {boolean} true for an unavailable marker
 */
export const isUnavailable = (primary: string | null | undefined): boolean =>
	Boolean(primary?.startsWith(UNAVAILABLE_PREFIX))

/**
 * The incipit guid grammar, in ONE place. `_region` is mandatory here (every
 * guid this agent stamps carries one); pinLiveness accepts region-less guids for
 * a different reason. Two copies of this literal in one file drifted apart once
 * about exactly that, so both readers below take it from here.
 */
const INCIPIT_GUID_RE = /guid="com\.plexapp\.agents\.incipit:\/\/([^_"]+)_/
const INCIPIT_GUID_RE_ALL = new RegExp(INCIPIT_GUID_RE.source, 'g')

/** The record id inside one Track/Directory block, or null. */
const incipitGuidOf = (block: string): string | null => INCIPIT_GUID_RE.exec(block)?.[1] ?? null

/**
 * An ASIN-shaped id. An ISBN-10 is ALSO ten alphanumeric characters, so length
 * alone does not separate them -- "1774240327" passed a length-only test once.
 * Requiring a letter drops all-digit ISBNs and keeps ASINs.
 */
const isAsin = (id: string): boolean => /^[A-Z0-9]{10}$/.test(id) && /[A-Z]/.test(id)

export interface ServedAnswer extends Answer {
	available: boolean
}

interface Series {
	name?: string
	position?: string | null
}

export interface FetchServedOptions {
	fetchImpl?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	/** Retries granted to a 429 only. */
	retries?: number
	region?: string
}

const show = (s: Series | null | undefined): string | null =>
	s?.name ? `${s.name} #${s.position ?? '-'}` : null

/**
 * Read a record's currently-served series answer.
 *
 * Retries ONLY on 429, honouring Retry-After when the limiter states it and
 * backing off geometrically when it does not. Every other outcome — 404, any
 * other non-OK status, a network throw — is returned as unavailable on the
 * first attempt, because retrying cannot change it.
 * @param {string} api base url of the incipit api
 * @param {string} id the record id (asin or provider-encoded)
 * @param {FetchServedOptions} opts injection points for tests plus retry budget
 * @returns {Promise<ServedAnswer>} the answer, or an UNAVAILABLE marker
 */
export async function fetchServedAnswer(
	api: string,
	id: string,
	opts: FetchServedOptions = {}
): Promise<ServedAnswer> {
	const doFetch = opts.fetchImpl ?? fetch
	const sleep = opts.sleep ?? defaultSleep
	const retries = opts.retries ?? 5
	const region = opts.region ?? 'us'
	const url = `${api}/books/${encodeURIComponent(id)}?region=${region}`

	for (let attempt = 0; ; attempt += 1) {
		let r: Response
		try {
			r = await doFetch(url)
		} catch {
			return { primary: 'UNAVAILABLE(error)', secondary: null, available: false }
		}
		if (r.status === 429) {
			if (attempt >= retries) {
				return { primary: 'UNAVAILABLE(429)', secondary: null, available: false }
			}
			const stated = Number(r.headers.get('retry-after'))
			// Geometric, not linear: the bucket refills on a window, so a fixed
			// short retry just burns the budget again on the same window.
			const wait = Number.isFinite(stated) && stated > 0 ? stated * 1000 : 2000 * 2 ** attempt
			await sleep(wait)
			continue
		}
		if (!r.ok) {
			return { primary: `UNAVAILABLE(${r.status})`, secondary: null, available: false }
		}
		const d = (await r.json()) as { seriesPrimary?: Series; seriesSecondary?: Series }
		return { primary: show(d.seriesPrimary), secondary: show(d.seriesSecondary), available: true }
	}
}

/**
 * One Plex server the sweep reads, from PLEX_BOXES.
 */
export interface PlexBox {
	host: string
	section: string
	/** Cosmetic: used in output and the ledger's `boxes` field. */
	name: string
}

/**
 * Parse PLEX_BOXES ("host:sectionId:label,...") into boxes, rejecting anything
 * malformed.
 *
 * Validation is the point. After the privacy scrub this became free-text env
 * input filtered only for truthiness, and a bad entry produced ZERO records
 * rather than an error — which the drift gate then reports as "0 distinct
 * records" and exits 0, having audited nothing. A section id is always numeric,
 * so requiring that also catches the `http://host:6:prod` mis-split, where
 * splitting on ':' yields host="http", section="//host".
 * @param {string | undefined} raw the PLEX_BOXES value
 * @returns {PlexBox[]} the parsed boxes
 * @throws {Error} when the value is empty or any entry is malformed
 */
export function parsePlexBoxes(raw: string | undefined): PlexBox[] {
	const entries = (raw ?? '')
		.split(',')
		.map((e) => e.trim())
		.filter(Boolean)
	if (!entries.length) {
		throw new Error(
			'PLEX_BOXES must be set, e.g. PLEX_BOXES="10.0.0.2:56:test,10.0.0.3:6:prod"\n' +
				'  (host:sectionId:label, comma-separated; the label is cosmetic)'
		)
	}
	return entries.map((entry) => {
		const [host, section, name] = entry.split(':')
		if (!host || !section || !/^\d+$/.test(section)) {
			throw new Error(
				`PLEX_BOXES entry "${entry}" is malformed: expected host:sectionId:label ` +
					'with a NUMERIC section id (do not include a scheme — "10.0.0.2:56:test", not ' +
					'"http://10.0.0.2:56:test")'
			)
		}
		return { host, section, name: name || host }
	})
}

/** One track's ASIN and the duration Plex ANALYSED for it. */
export interface PlexTrackDuration {
	asin: string
	durationMs: number
	title: string
}

/**
 * Every track that carries an ASIN guid AND an analysed duration.
 *
 * Two regex traps this deliberately avoids, both of which return plausible
 * garbage rather than failing:
 *  - a bare `duration="` matches the TRACK element's own duration as well as the
 *    PART's. The Part's is the analysed one and the only authoritative figure
 *    (`mvhd` lies), so this anchors on `<Part `.
 *  - a bare `title="` would also match `parentTitle=` / `grandparentTitle=` on a
 *    case-insensitive read; anchoring on a leading space keeps it to the track's
 *    own title.
 *
 * ASIN-shaped ids only. An `overdrive-…` or ISBN guid cannot resolve against an
 * ASIN-keyed service, so those are dropped HERE rather than being counted as
 * lookup failures later — the caller reports them as uncovered instead.
 * @param {string} xml a Plex `?type=10` section listing
 * @returns {PlexTrackDuration[]} one row per usable track
 */
export function tracksWithDurations(xml: string): PlexTrackDuration[] {
	const out: PlexTrackDuration[] = []
	for (const block of xml.split('<Track ').slice(1)) {
		const id = incipitGuidOf(block)
		if (!id) continue
		const asin = id.toUpperCase()
		if (!isAsin(asin)) continue
		const dur = /<Part (?:[^>]*?\s)?duration="(\d+)"/.exec(block)
		if (!dur) continue
		const ms = Number(dur[1])
		if (!(ms > 0)) continue
		const title = /\stitle="([^"]*)"/.exec(block)
		out.push({ asin, durationMs: ms, title: title ? title[1] : '' })
	}
	return out
}

/** Decode the handful of XML entities Plex emits in attribute values. */
const decodeXml = (v: string): string =>
	v
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')

/** One track as the album parser sees it: analysed, or not yet. */
export interface AlbumTrack {
	/** Analysed Part duration, or null when Plex has not analysed this file yet. */
	durationMs: number | null
}

/** One Plex album (a `parentRatingKey`) and everything the audit needs to judge it. */
export interface PlexAlbum {
	/** The album's own key, so two albums matched to one ASIN stay two albums. */
	key: string
	asin: string
	/** The ALBUM title (`parentTitle`), never a track's. */
	title: string
	tracks: AlbumTrack[]
}

/**
 * Every ASIN-keyed album in a `?type=10` listing, with per-track analysis state.
 *
 * Album COMPLETENESS is a decision that has to be made BEFORE anything is
 * summed, and it needs three facts a flat track list throws away:
 *  - which album a track belongs to (two Plex albums matched to one ASIN -- the
 *    twin shape this library is known to mint -- must be judged separately, or
 *    a consolidated 19.5h copy plus a 6.5h fragment sums to "26h, long, not
 *    damage" and the truncated twin is MASKED);
 *  - whether EVERY track is analysed (two analysed tracks of three sum to 2/3
 *    and read as "looks like 2 of 3 part(s)" -- a manufactured truncation that
 *    perfectly mimics the real signal, in the direction that costs files);
 *  - the album's title rather than the first track's, so a flag names the book.
 * `tracksWithDurations` stays for callers that want a flat analysed list; this
 * is what the duration audit consumes.
 * @param {string} xml a Plex `?type=10` section listing
 * @returns {PlexAlbum[]} one entry per album that carries an ASIN guid
 */
export function albumsFromListing(xml: string): PlexAlbum[] {
	const albums = new Map<string, PlexAlbum>()
	for (const block of xml.split('<Track ').slice(1)) {
		const id = incipitGuidOf(block)
		if (!id) continue
		const asin = id.toUpperCase()
		if (!isAsin(asin)) continue
		const key = /\sparentRatingKey="([^"]*)"/.exec(block)?.[1] ?? `asin:${asin}`
		const dur = /<Part (?:[^>]*?\s)?duration="(\d+)"/.exec(block)
		const ms = dur ? Number(dur[1]) : 0
		let album = albums.get(key)
		if (!album) {
			const title = /\sparentTitle="([^"]*)"/.exec(block)?.[1] ?? ''
			album = { key, asin, title: decodeXml(title), tracks: [] }
			albums.set(key, album)
		}
		album.tracks.push({ durationMs: ms > 0 ? ms : null })
	}
	return [...albums.values()]
}

/** The incipit agent guids a Plex library-section listing carries. */
export function incipitGuids(xml: string): string[] {
	return [...xml.matchAll(INCIPIT_GUID_RE_ALL)].map((m) => m[1])
}

/**
 * Read one box's incipit record ids.
 *
 * Every failure here is LOUD. `await (await fetch(url)).text()` checked no
 * status at all, so a wrong section id or an expired token yielded an error
 * page, zero guid matches, and a sweep that printed "0 distinct records" and
 * exited 0 — a drift gate that passes by auditing nothing is worse than one
 * that fails.
 * @param {PlexBox} box the server and section to read
 * @param {string} token the Plex token
 * @param {typeof fetch} [fetchImpl] injection point for tests
 * @returns {Promise<string[]>} the record ids found
 * @throws {Error} on a non-OK response, or when the section yields no records
 */
/**
 * ONE Plex section read, carrying the checks a silent-zero audit needs.
 *
 * `await (await fetch(url)).text()` with no status check is the anti-pattern
 * this exists to retire: an expired token or a wrong section id answers with
 * an error page, every regex then matches nothing, and the caller reports a
 * CLEAN result for a library it never read. That is worst for the duration
 * audit, whose entire purpose is catching a truncated file before an operator
 * does -- a clean bill of health from a 401 is the Soldiers Live class of
 * defect made invisible again. Three scripts had spelled this read three ways
 * with three different failure behaviours.
 * @param {PlexBox} box which server and section
 * @param {string} token the Plex token
 * @param {9 | 10} type 9 = albums, 10 = tracks
 * @param {typeof fetch} [fetchImpl] injection point for tests
 * @returns {Promise<string>} the section XML, only ever from a 2xx
 */
export async function fetchBoxXml(
	box: PlexBox,
	token: string,
	type: 9 | 10,
	fetchImpl?: typeof fetch
): Promise<string> {
	const doFetch = fetchImpl ?? fetch
	const where = `${box.name} (${box.host}, section ${box.section})`
	const url = `http://${box.host}:32400/library/sections/${box.section}/all?type=${type}&X-Plex-Token=${token}`
	const response = await doFetch(url)
	if (!response.ok) {
		throw new Error(`${where} returned HTTP ${response.status} ${response.statusText}`.trim())
	}
	return response.text()
}

export async function fetchBoxGuids(
	box: PlexBox,
	token: string,
	fetchImpl?: typeof fetch
): Promise<string[]> {
	const where = `${box.name} (${box.host}, section ${box.section})`
	const guids = incipitGuids(await fetchBoxXml(box, token, 9, fetchImpl))
	if (!guids.length) {
		throw new Error(
			`${where} returned ZERO incipit records. Check the section id and the token — ` +
				'a sweep that audits nothing must not report a clean gate.'
		)
	}
	return guids
}

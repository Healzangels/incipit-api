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
		const guid = /guid="com\.plexapp\.agents\.incipit:\/\/([^_"]+)_/.exec(block)
		if (!guid) continue
		const asin = guid[1].toUpperCase()
		// An ISBN-10 is ALSO ten alphanumeric characters, so length alone does not
		// separate it from an ASIN -- "1774240327" passed a length-only test and
		// would have been counted as a lookup failure against an ASIN-keyed
		// service. Requiring a letter drops all-digit ISBNs and keeps ASINs.
		if (!/^[A-Z0-9]{10}$/.test(asin) || !/[A-Z]/.test(asin)) continue
		const dur = /<Part (?:[^>]*?\s)?duration="(\d+)"/.exec(block)
		if (!dur) continue
		const ms = Number(dur[1])
		if (!(ms > 0)) continue
		const title = /\stitle="([^"]*)"/.exec(block)
		out.push({ asin, durationMs: ms, title: title ? title[1] : '' })
	}
	return out
}

/** The incipit agent guids a Plex library-section listing carries. */
export function incipitGuids(xml: string): string[] {
	return [...xml.matchAll(/guid="com\.plexapp\.agents\.incipit:\/\/([^_"]+)_/g)].map((m) => m[1])
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
export async function fetchBoxGuids(
	box: PlexBox,
	token: string,
	fetchImpl?: typeof fetch
): Promise<string[]> {
	const doFetch = fetchImpl ?? fetch
	const where = `${box.name} (${box.host}, section ${box.section})`
	const url = `http://${box.host}:32400/library/sections/${box.section}/all?type=9&X-Plex-Token=${token}`
	const response = await doFetch(url)
	if (!response.ok) {
		throw new Error(`${where} returned HTTP ${response.status} ${response.statusText}`.trim())
	}
	const guids = incipitGuids(await response.text())
	if (!guids.length) {
		throw new Error(
			`${where} returned ZERO incipit records. Check the section id and the token — ` +
				'a sweep that audits nothing must not report a clean gate.'
		)
	}
	return guids
}

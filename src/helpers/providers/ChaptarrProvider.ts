import type { FastifyBaseLogger } from 'fastify'

import type {
	BookProvider,
	BookSearchQuery,
	FetchBookOptions,
	ProviderBook,
	ProviderCandidate
} from './types'

import { envInt } from '#helpers/utils/env'
import fetch from '#helpers/utils/fetchPlus'
import { normalizeLanguage } from '#helpers/utils/language'
import { createPacer } from '#helpers/utils/pacer'

/**
 * Chaptarr metadata service (api2.chaptarr.com) — the aggregation server behind
 * the Chaptarr book manager, opened alongside its source on 2026-08-08.
 * Keyless. Verified live before this file was written: one GET returns the
 * work plus every edition with narrator names, duration seconds, chapter
 * offsets, ISBNs, publisher, language, and cross-provider ids (az/gr/hc/ol),
 * and POST /api/v5/match resolves a title+author query to work identity.
 *
 * POSTURE: a SUPPLEMENT, never primary — the same rule as OverDrive. It is
 * another project's free infrastructure (Cloudflare-fronted, closed server,
 * no SLA), so it must never be a single point of failure: the registry's
 * breaker isolates it, CHAPTARR_ENABLED=false removes it, and nothing
 * downstream depends on it exclusively.
 *
 * DELIBERATELY NOT CONSUMED, even though the wire carries them:
 *  - series: its series arrays lead with translated editions ("Comando Sul"
 *    for Southern Reach #1, measured live) — exactly the multi-language mess
 *    the series-authority rules exist to keep out. Only the rescue-path
 *    ProviderBook takes work.seriesName (the canonical English field), and
 *    the Goodreads serve-leg + shelf policy still override it at serve time.
 *  - candidates without an Audible ASIN: emitting them would mint a new
 *    provider-id namespace (decode path, data-lookup branch, bundle GUID
 *    round-trip). ASIN-keyed candidates ride the existing identity rails and
 *    merge with Audible rows in dedupe by construction.
 */

const BASE = 'https://api2.chaptarr.com'

/**
 * ONE ATTEMPT, time-boxed — the same posture (and the same call shape) as the
 * Goodreads mirror leg, and for the same reason: this is another project's free
 * infrastructure, so a flap must cost it one request, not four.
 *
 * The retry ladder bought nothing here anyway. On the SEARCH path
 * ProviderRegistry already races every provider against its own 25s cap, so a
 * second 30s attempt is orphaned work by construction. On the three ENRICHMENT
 * paths (genres, chapters, author) there is no registry at all — nothing capped
 * them, so a flapping upstream could hold a `/books/:asin` request for the full
 * 30s transport timeout times the ladder. `retries = 3` starts fetchPlus's
 * counter exhausted, which is how goodreadsSeries spells the same decision.
 */
const TIMEOUT_MS = 15000
const NO_RETRIES = 3

/**
 * Chaptarr's own pacing. ONE pacer for the whole transport, so the search leg,
 * the three enrichment legs and the duration audit queue together rather than
 * each discovering the rate limit separately -- the same shape as
 * hardcoverPacer, and for the same reason. The duration audit first carried a
 * pacer of its own, which paced only ITS calls while the serving path kept
 * hitting the same free host unpaced from the same egress; neither side saw the
 * other's push-back. api2.chaptarr.com 403'd a ~50-request burst while that
 * design was being sized.
 *
 * 'shed', not 'wait': three of the callers sit on a serve path with a time
 * budget, and a request queued when a push-back lands would sleep out the whole
 * cooldown and blow it. A batch caller that CAN afford to wait consults
 * chaptarrStandingDown()/chaptarrStandDownMs() and sleeps on its own terms.
 *
 * envInt, not a hand-rolled Number(): it is the one place that decides an empty
 * string is NOT zero. `CHAPTARR_MIN_GAP_MS=` left dangling in a compose file
 * would otherwise read as "no pacing at all", and a typo like `350ms` is NaN --
 * which defeats the gap AND the cooldown outright (measured: waits [] with
 * standingDown true).
 */
const chaptarrPacer = createPacer({
	minGapMs: () => envInt(process.env.CHAPTARR_MIN_GAP_MS, 350, 0, 60_000),
	cooldownMs: () => envInt(process.env.CHAPTARR_COOLDOWN_MS, 60_000, 0, 3_600_000),
	onPushBack: 'shed'
})

/** Whether the service has pushed back and a cooldown is in force. */
export const chaptarrStandingDown = (): boolean => chaptarrPacer.standingDown()
/** Milliseconds until that cooldown lifts, 0 when not standing down. */
export const chaptarrStandDownMs = (): number => chaptarrPacer.standDownRemainingMs()
/** Tests only: a module-level pacer otherwise leaks one suite's cooldown into the next. */
export const resetChaptarrPacer = (): void => chaptarrPacer.reset()

/**
 * Which statuses are the host telling us to back off? 429 obviously; 503 as
 * the Goodreads leg already treats it; and 403, because that is the status this
 * host ACTUALLY sent when it blocked a burst. A cooldown that only arms on 429
 * fires the next eight requests 350ms apart into a host that has just said no.
 */
const isPushBack = (err: unknown): boolean => {
	const status = (err as { status?: number })?.status
	return status === 429 || status === 403 || status === 503
}

/**
 * The CHAPTARR_ENABLED kill-switch, read at CALL time.
 *
 * registry.ts consults the env once at module load to decide whether to
 * register the provider — which governs the search path and nothing else. The
 * three enrichment legs call the transports directly, so without this predicate
 * `CHAPTARR_ENABLED=false` still sent outbound traffic to api2.chaptarr.com
 * from `/books/:asin`, `/authors/:asin` and `/chapters/:asin` — 3 of the 4
 * paths this provider touches, and the opposite of what this file's POSTURE
 * note promises. Every leg gates on this, so "false" means what it says.
 * @returns {boolean} false only when CHAPTARR_ENABLED is exactly 'false'
 */
export function chaptarrEnabled(): boolean {
	return process.env.CHAPTARR_ENABLED !== 'false'
}

export interface ChaptarrMatch {
	author?: string
	author_id?: string
	work_title?: string
	work_id?: string
	edition_title?: string
}

interface ChaptarrChapter {
	title?: string
	startOffsetMs?: number
	startOffsetSec?: number
	lengthMs?: number
}

export interface ChaptarrEdition {
	asin?: string | null
	title?: string
	subtitle?: string
	description?: string
	narratorNames?: string[]
	durationSeconds?: number | null
	coverUrl?: string | null
	language?: string | null
	publisher?: string
	publicationDate?: string
	formatType?: string
	readingFormatId?: number
	chapters?: ChaptarrChapter[]
	hasChapters?: boolean
	providerIdsAll?: { az?: string[] }
	// The Audible multipart pair the duration oracle reads to turn "this file is
	// short" into "this file holds k of N parts" -- which names the remedy. The
	// wire body is cast, not validated, so an UNREAD field here is documentation
	// that can drift from the payload with nothing noticing; only what is
	// consumed is declared. See docs/design/spec-chaptarr-duration-oracle.md.
	audibleParts?: { asin?: string; title?: string }[]
	isAudibleExpectedMultipart?: boolean
}

export interface ChaptarrWork {
	id?: string
	title?: string
	originalTitle?: string
	description?: string
	coverUrl?: string | null
	genres?: string[]
	seriesName?: string
	seriesPosition?: number | string
}

export interface ChaptarrWorkResponse {
	work?: ChaptarrWork
	authors?: { name?: string }[]
	editions?: ChaptarrEdition[]
}

export type ChaptarrMatchFetch = (
	q: string,
	tags: { artist?: string; album?: string },
	logger?: FastifyBaseLogger
) => Promise<ChaptarrMatch[]>
export type ChaptarrWorkFetch = (
	id: string,
	logger?: FastifyBaseLogger
) => Promise<ChaptarrWorkResponse | null>

/**
 * 404/410 from the service is "no such record", never breaker food. Exported
 * so every leg that talks to this host shares ONE spelling of the rule — the
 * author leg carried its own copy, which is how the two drift.
 * @param {unknown} err the rejection from fetchPlus
 * @returns {null} for 404/410
 * @throws the original error for anything else
 */
function nullOn404(err: unknown): null {
	const status = (err as { status?: number })?.status
	if (status === 404 || status === 410) return null
	throw err
}

/**
 * ONE GET against the Chaptarr service, carrying the whole house posture: the
 * time-box, the single attempt, and the 404/410-is-an-answer rule. Exported so
 * the author enrichment leg — the only transport that lives outside this file —
 * shares it instead of keeping a second, already-drifting copy.
 * @param {string} url the absolute url
 * @returns {Promise<unknown>} the response body, or null when there is no such record
 */
export async function chaptarrGet(url: string): Promise<unknown> {
	await chaptarrPacer.take()
	try {
		const res = await fetch(
			url,
			{ headers: { Accept: 'application/json' }, timeout: TIMEOUT_MS },
			NO_RETRIES
		).catch(nullOn404)
		return res?.data ?? null
	} catch (err) {
		// A push-back starts a cooldown for EVERY caller, not just this one.
		if (isPushBack(err)) chaptarrPacer.pushBack()
		throw err
	}
}

export const defaultMatchFetch: ChaptarrMatchFetch = async (q, tags) => {
	// `tags` is LOAD-BEARING, not optional garnish: the server answers a bare
	// {q, media_type} body with {} — no error, no matches. Measured live
	// 2026-08-08, and it cost this provider its first deploy (1 call, 0
	// candidates): the Chaptarr source's own contract is {q, tags, media_type}.
	//
	// The match leg gets the WORK leg's 404 discipline. Without it a 404 here
	// rejected out of search(), ProviderRegistry recorded a provider failure,
	// and six of those open the breaker for 60s — which also takes the two
	// ASIN rescue paths down with it. "No such record" is an answer, not an
	// outage; 5xx/403 still reject and still feed the breaker, as they should.
	const res = await fetch(
		`${BASE}/api/v5/match`,
		{
			method: 'POST',
			data: { q, media_type: 'audiobook', tags },
			headers: { 'Content-Type': 'application/json' },
			timeout: TIMEOUT_MS
		},
		NO_RETRIES
	).catch(nullOn404)
	const matches = (res?.data as { matches?: ChaptarrMatch[] })?.matches
	return Array.isArray(matches) ? matches : []
}

/** The default work transport, exported so enrichment legs (genres, author
 * art) share one implementation and its 404 discipline. */
/**
 * TWO routes, and the id type picks one: /api/v5/book/ resolves EDITION-level
 * ids (az:ASIN), /api/v5/work/ resolves WORK ids (hc:/gr:). Asking /book/ for
 * a work id 404s — measured live 2026-08-08, the second of the two bugs that
 * cost the first deploy its candidates (the match endpoint hands back hc:
 * WORK ids). Both answer the same {work, authors, editions} shape.
 * @param {string} id a prefixed provider id
 * @returns {'book' | 'work'} the v5 route segment that resolves it
 */
export function workRouteFor(id: string): 'book' | 'work' {
	return id.toLowerCase().startsWith('az:') ? 'book' : 'work'
}

export const fetchChaptarrWork: ChaptarrWorkFetch = async (id) => {
	const route = workRouteFor(id)
	const data = await chaptarrGet(`${BASE}/api/v5/${route}/${encodeURIComponent(id)}`)
	return (data as ChaptarrWorkResponse) ?? null
}

/** True when the edition is the audio format (belt and braces: either flag). */
function isAudiobookEdition(e: ChaptarrEdition): boolean {
	return e.formatType === 'audiobook' || e.readingFormatId === 2
}

/**
 * The AUDIOBOOK edition carrying `asin` — directly or among its regional az
 * variants.
 *
 * The format filter is HERE rather than only in search() because both rescue
 * paths (fetchBookByAsin, fetchCandidateByAsin) resolve through this function,
 * and unlike Audible — whose catalog holds no print editions, which is the
 * invariant BookSearchHelper's pin injection was written against — Chaptarr's
 * work carries every edition there is. Asking it for B09LVB8T3V on the repo's
 * own fixture returned a German KINDLE EBOOK, which withPinnedEdition then
 * stamps `provider: 'pinned'` and the floor-hold guarantees is offered as the
 * audiobook match. An audiobook ASIN that resolves to a print edition is not a
 * rescue, it is a wrong answer.
 * @param {ChaptarrEdition[] | undefined} editions the work's editions
 * @param {string} asin the requested Audible asin
 * @returns {ChaptarrEdition | null} the audio edition, or null
 */
export function editionForAsin(
	editions: ChaptarrEdition[] | undefined,
	asin: string
): ChaptarrEdition | null {
	if (!editions) return null
	const upper = asin.toUpperCase()
	// TWO passes, exact first. A single first-match pass let an edition that
	// merely LISTS the asked ASIN in providerIdsAll.az shadow a later edition
	// whose own asin IS it -- the parent winning over the child by list order.
	// The duration oracle then measured the child's file against the parent's
	// length, read the mismatch as a variant match, and capped a real truncation
	// to "report". Exact identity is a stronger claim than a variant listing and
	// must win regardless of where the service put it in the array.
	for (const e of editions) {
		if (isAudiobookEdition(e) && (e.asin ?? '').toUpperCase() === upper) return e
	}
	// Uppercase BOTH sides wholesale: the service writes the namespace prefix
	// lowercase ("az:") while ASINs are uppercase, so a one-sided fold
	// mismatches on the prefix — caught by this file's own first test run.
	const wanted = `AZ:${upper}`
	for (const e of editions) {
		if (!isAudiobookEdition(e)) continue
		for (const v of e.providerIdsAll?.az ?? []) {
			if (v.toUpperCase() === wanted) return e
		}
	}
	return null
}

/**
 * @param {ChaptarrWorkResponse} response the work envelope
 * @param {ChaptarrEdition} e the edition to emit
 * @param {string | null} [asin] the asin to STAMP — the one the caller ASKED
 *   for on a rescue, which is not always `e.asin`: editions are matched
 *   through `providerIdsAll.az`, so asking for a regional variant
 *   (B00HYG9KMC) resolves an edition whose own asin is the parent
 *   (B00HYGYN5Q). Emitting the parent made `isPinned` false for every row and
 *   `promoteDeadPinToIsbn` read the operator's live pin as DEAD — a floor-held
 *   row they never named, with none of the pin protections.
 */
function candidateFrom(
	response: ChaptarrWorkResponse,
	e: ChaptarrEdition,
	asin: string | null = e.asin ?? null
): ProviderCandidate | null {
	if (!asin) return null
	const title = e.title ?? response.work?.title
	if (!title) return null
	return {
		provider: 'chaptarr',
		id: asin,
		asin,
		title,
		authors: (response.authors ?? [])
			.map((a) => a.name ?? '')
			.filter((n): n is string => n.length > 0),
		narrators: (e.narratorNames ?? []).filter((n) => !!n),
		audioSeconds: typeof e.durationSeconds === 'number' ? e.durationSeconds : null,
		// NO work-cover fallback. The work cover is the PRINT jacket, and this
		// row carries audioSeconds — which is exactly what dedupe's isAudioArt
		// accepts as proof of audiobook art, so the jacket would be admitted
		// into coverAlternates and become the record's own cover whenever the
		// chaptarr row wins its group. An audiobook edition with no edition
		// cover has no audiobook art; say so.
		cover: e.coverUrl ?? null,
		language: normalizeLanguage(e.language)
	}
}

/**
 * @param {ChaptarrWorkResponse} response the work envelope
 * @param {ChaptarrEdition} e the edition to emit
 * @param {string | null} [asin] the asin to STAMP — see candidateFrom
 * @returns {ProviderBook | null} the served record, or null with no identity
 */
function bookFrom(
	response: ChaptarrWorkResponse,
	e: ChaptarrEdition,
	asin: string | null = e.asin ?? null
): ProviderBook | null {
	// The same null guard candidateFrom has always had. `GET /books/:asin`
	// carries no response schema, so an asin-less edition answered 200 with
	// `asin: null` — a record with no identity, which nothing downstream can
	// key, match or re-fetch.
	if (!asin) return null
	const work = response.work ?? {}
	const series =
		work.seriesName && work.seriesName.length > 0
			? {
					name: work.seriesName,
					...(work.seriesPosition != null ? { position: String(work.seriesPosition) } : {})
				}
			: undefined
	return {
		asin,
		title: e.title ?? work.title ?? '',
		...(e.subtitle ? { subtitle: e.subtitle } : {}),
		authors: (response.authors ?? [])
			.map((a) => ({ name: a.name ?? '' }))
			.filter((a) => a.name.length > 0),
		narrators: (e.narratorNames ?? []).filter((n) => !!n).map((n) => ({ name: n })),
		...(e.description || work.description ? { summary: e.description ?? work.description } : {}),
		// No work-cover fallback here either — see candidateFrom. This is the
		// SERVED image for an audiobook record; the print jacket is not it.
		image: e.coverUrl ?? null,
		...(e.publisher ? { publisherName: e.publisher } : {}),
		...(e.publicationDate ? { releaseDate: e.publicationDate } : {}),
		...(series ? { seriesPrimary: series } : {}),
		language: normalizeLanguage(e.language)
	}
}

/** Works consulted per search; editions emitted overall. Small on purpose —
 * this provider exists for corroboration and rescue, not recall: Audible and
 * Hardcover already carry the discovery load. */
const MAX_WORKS = 2
const MAX_CANDIDATES = 6

export default class ChaptarrProvider implements BookProvider {
	readonly name = 'chaptarr'
	private matchFetch: ChaptarrMatchFetch
	private workFetch: ChaptarrWorkFetch

	constructor(opts: { matchFetch?: ChaptarrMatchFetch; workFetch?: ChaptarrWorkFetch } = {}) {
		this.matchFetch = opts.matchFetch ?? defaultMatchFetch
		this.workFetch = opts.workFetch ?? fetchChaptarrWork
	}

	async search(query: BookSearchQuery, logger?: FastifyBaseLogger): Promise<ProviderCandidate[]> {
		const q = [query.title, query.author].filter(Boolean).join(' ').trim()
		if (!q) return []
		const tags: { artist?: string; album?: string } = {}
		if (query.author) tags.artist = query.author
		if (query.title) tags.album = query.title
		const matches = await this.matchFetch(q, tags, logger)
		const workIds: string[] = []
		for (const m of matches) {
			if (m.work_id && !workIds.includes(m.work_id)) workIds.push(m.work_id)
			if (workIds.length >= MAX_WORKS) break
		}
		const out: ProviderCandidate[] = []
		const seen = new Set<string>()
		for (const id of workIds) {
			const response = await this.workFetch(id, logger)
			if (!response) continue
			for (const e of response.editions ?? []) {
				if (!isAudiobookEdition(e)) continue
				const candidate = candidateFrom(response, e)
				if (!candidate) continue
				const key = candidate.asin ?? candidate.id
				if (seen.has(key)) continue
				seen.add(key)
				out.push(candidate)
				if (out.length >= MAX_CANDIDATES) return out
			}
		}
		return out
	}

	async fetchBookByAsin(asin: string, opts: FetchBookOptions): Promise<ProviderBook | null> {
		const response = await this.workFetch(`az:${asin}`, opts.logger)
		if (!response) return null
		const edition = editionForAsin(response.editions, asin)
		if (!edition) return null
		// The REQUESTED asin, not the edition's own — see candidateFrom.
		return bookFrom(response, edition, asin || null)
	}

	async fetchCandidateByAsin(
		asin: string,
		opts: FetchBookOptions
	): Promise<ProviderCandidate | null> {
		const response = await this.workFetch(`az:${asin}`, opts.logger)
		if (!response) return null
		const edition = editionForAsin(response.editions, asin)
		if (!edition) return null
		return candidateFrom(response, edition, asin || null)
	}
}

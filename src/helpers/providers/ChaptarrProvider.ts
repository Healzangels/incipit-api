import type { FastifyBaseLogger } from 'fastify'

import type {
	BookProvider,
	BookSearchQuery,
	FetchBookOptions,
	ProviderBook,
	ProviderCandidate
} from './types'

import fetch from '#helpers/utils/fetchPlus'
import { normalizeLanguage } from '#helpers/utils/language'

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

interface ChaptarrMatch {
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

/** 404/410 from the service is "no such record", never breaker food. */
function nullOn404(err: unknown): null {
	const status = (err as { status?: number })?.status
	if (status === 404 || status === 410) return null
	throw err
}

const defaultMatchFetch: ChaptarrMatchFetch = async (q, tags) => {
	// `tags` is LOAD-BEARING, not optional garnish: the server answers a bare
	// {q, media_type} body with {} — no error, no matches. Measured live
	// 2026-08-08, and it cost this provider its first deploy (1 call, 0
	// candidates): the Chaptarr source's own contract is {q, tags, media_type}.
	const res = await fetch(`${BASE}/api/v5/match`, {
		method: 'POST',
		data: { q, media_type: 'audiobook', tags },
		headers: { 'Content-Type': 'application/json' }
	})
	const matches = (res.data as { matches?: ChaptarrMatch[] })?.matches
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
	try {
		const res = await fetch(`${BASE}/api/v5/${route}/${encodeURIComponent(id)}`, {
			headers: { Accept: 'application/json' }
		})
		return (res.data as ChaptarrWorkResponse) ?? null
	} catch (err) {
		return nullOn404(err)
	}
}

/** True when the edition is the audio format (belt and braces: either flag). */
function isAudiobookEdition(e: ChaptarrEdition): boolean {
	return e.formatType === 'audiobook' || e.readingFormatId === 2
}

/** The edition carrying `asin` — directly or among its regional az variants. */
export function editionForAsin(
	editions: ChaptarrEdition[] | undefined,
	asin: string
): ChaptarrEdition | null {
	if (!editions) return null
	// Uppercase BOTH sides wholesale: the service writes the namespace prefix
	// lowercase ("az:") while ASINs are uppercase, so a one-sided fold
	// mismatches on the prefix — caught by this file's own first test run.
	const wanted = `AZ:${asin.toUpperCase()}`
	for (const e of editions) {
		if ((e.asin ?? '').toUpperCase() === asin.toUpperCase()) return e
		const variants = e.providerIdsAll?.az ?? []
		for (const v of variants) {
			if (v.toUpperCase() === wanted) return e
		}
	}
	return null
}

function candidateFrom(
	response: ChaptarrWorkResponse,
	e: ChaptarrEdition
): ProviderCandidate | null {
	const asin = e.asin ?? null
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
		cover: e.coverUrl ?? response.work?.coverUrl ?? null,
		language: normalizeLanguage(e.language)
	}
}

function bookFrom(response: ChaptarrWorkResponse, e: ChaptarrEdition): ProviderBook {
	const work = response.work ?? {}
	const series =
		work.seriesName && work.seriesName.length > 0
			? {
					name: work.seriesName,
					...(work.seriesPosition != null ? { position: String(work.seriesPosition) } : {})
				}
			: undefined
	return {
		asin: e.asin ?? null,
		title: e.title ?? work.title ?? '',
		...(e.subtitle ? { subtitle: e.subtitle } : {}),
		authors: (response.authors ?? [])
			.map((a) => ({ name: a.name ?? '' }))
			.filter((a) => a.name.length > 0),
		narrators: (e.narratorNames ?? []).filter((n) => !!n).map((n) => ({ name: n })),
		...(e.description || work.description ? { summary: e.description ?? work.description } : {}),
		image: e.coverUrl ?? work.coverUrl ?? null,
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
		return bookFrom(response, edition)
	}

	async fetchCandidateByAsin(
		asin: string,
		opts: FetchBookOptions
	): Promise<ProviderCandidate | null> {
		const response = await this.workFetch(`az:${asin}`, opts.logger)
		if (!response) return null
		const edition = editionForAsin(response.editions, asin)
		if (!edition) return null
		return candidateFrom(response, edition)
	}
}

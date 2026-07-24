import type { FastifyBaseLogger } from 'fastify'

import type {
	BookProvider,
	BookSearchQuery,
	FetchBookOptions,
	ProviderBook,
	ProviderCandidate
} from './types'

import { encodeOverdrive } from '#helpers/providers/providerId'
import fetch from '#helpers/utils/fetchPlus'
import { normalizeLanguage } from '#helpers/utils/language'

/**
 * OverDrive (Libby) provider — the Thunder discovery API that powers the Libby
 * app. Keyless: it is scoped to a LIBRARY, and any public library's key works as
 * a catalog lens (default a large public library; an operator can point it at
 * their own with OVERDRIVE_LIBRARY).
 *
 * Its value is coverage the mainstream Audible catalog lacks — library
 * audiobooks (Blackstone, Recorded Books, older/indie titles) that Audible does
 * not carry, the exact gap where the fan-out otherwise falls back to a PRINT
 * record. It carries the fields the scorer needs — narrator, runtime (from
 * formats[].duration), language, cover — so it participates fully in duration
 * corroboration, but it exposes no Audible ASIN, so it is a SUPPLEMENT to the
 * ASIN-keyed Audible source, never the primary: a duration-confirmed Audible
 * edition still outranks it, and it wins only when Audible has nothing.
 */

const OVERDRIVE_NAME = 'overdrive'
const THUNDER = 'https://thunder.api.overdrive.com/v2'
const NUM_RESULTS = 5
// Default catalog lens. Results reflect this library's holdings, so an operator
// with a card should set OVERDRIVE_LIBRARY to their own for the widest coverage.
const DEFAULT_LIBRARY = 'lapl'

interface OverDriveCreator {
	name?: string
	role?: string
}
interface OverDriveCoverEntry {
	href?: string
	width?: number
}
interface OverDriveFormat {
	id?: string
	duration?: string
}
interface OverDriveDetailedSeries {
	seriesName?: string
	readingOrder?: string
}
interface OverDriveLanguage {
	id?: string
	name?: string
}
interface OverDriveMedia {
	id?: number | string
	title?: string | { main?: string }
	creators?: OverDriveCreator[]
	formats?: OverDriveFormat[]
	covers?: Record<string, OverDriveCoverEntry>
	series?: string | null
	detailedSeries?: OverDriveDetailedSeries | null
	languages?: OverDriveLanguage[]
	description?: string
	starRating?: number
	publishDate?: string
	publisher?: { name?: string } | string
}

/** Transport for a Thunder request; injectable so tests need no network. */
export type OverDriveFetch = (url: string) => Promise<unknown>

const defaultFetch: OverDriveFetch = async (url) =>
	(await fetch(url, { headers: { Accept: 'application/json' } })).data

/** "HH:MM:SS" (or "MM:SS") -> seconds, or null. */
function parseDuration(d?: string): number | null {
	if (!d) return null
	const parts = d.split(':').map((p) => Number(p))
	if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null
	// left-to-right accumulate so 2- and 3-field forms both work.
	const seconds = parts.reduce((acc, p) => acc * 60 + p, 0)
	return seconds > 0 ? seconds : null
}

/** The Thunder title is either a plain string or `{ main }`. */
function mainTitle(t?: string | { main?: string }): string {
	return (typeof t === 'string' ? t : t?.main) ?? ''
}

/** Widest cover href, or null. */
function largestCover(covers?: Record<string, OverDriveCoverEntry>): string | null {
	if (!covers) return null
	let best: { href: string; width: number } | null = null
	for (const c of Object.values(covers)) {
		if (c?.href && (!best || (c.width ?? 0) > best.width)) {
			best = { href: c.href, width: c.width ?? 0 }
		}
	}
	return best?.href ?? null
}

/** Names of creators in a given role (author/narrator). */
function creatorsByRole(creators: OverDriveCreator[] | undefined, role: string): string[] {
	return (creators ?? [])
		.filter((c) => (c.role ?? '').toLowerCase() === role && c.name)
		.map((c) => c.name as string)
}

/** Runtime from the first audio format that reports one. */
function audioSecondsOf(formats?: OverDriveFormat[]): number | null {
	for (const f of formats ?? []) {
		const s = parseDuration(f.duration)
		if (s) return s
	}
	return null
}

/** OverDrive descriptions are HTML; flatten to plain text. */
function stripHtml(html?: string): string | undefined {
	if (!html) return undefined
	const text = html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/[ \t]+\n/g, '\n')
		.trim()
	return text || undefined
}

function firstLanguage(langs?: OverDriveLanguage[]): string | null {
	const l = langs?.[0]
	return normalizeLanguage(l?.id ?? l?.name)
}

function seriesOf(m: OverDriveMedia): { name: string; position?: string } | undefined {
	const name = m.detailedSeries?.seriesName ?? (typeof m.series === 'string' ? m.series : undefined)
	if (!name) return undefined
	const position = m.detailedSeries?.readingOrder
	return position ? { name, position } : { name }
}

export default class OverDriveProvider implements BookProvider {
	readonly name = OVERDRIVE_NAME
	private library: string
	private fetchThunder: OverDriveFetch

	constructor(opts: { library?: string; fetchThunder?: OverDriveFetch } = {}) {
		this.library = opts.library || DEFAULT_LIBRARY
		this.fetchThunder = opts.fetchThunder ?? defaultFetch
	}

	private searchUrl(query: BookSearchQuery): string {
		const params = new URLSearchParams({
			// One keyword query (title + author). Thunder has no structured author
			// filter; it relevance-ranks, and the scorer filters the noise.
			query: query.author ? `${query.title} ${query.author}` : query.title,
			format: 'audiobook-overdrive',
			perPage: String(NUM_RESULTS)
		})
		return `${THUNDER}/libraries/${this.library}/media?${params.toString()}`
	}

	async search(query: BookSearchQuery, logger?: FastifyBaseLogger): Promise<ProviderCandidate[]> {
		if (!query.title) return []
		let data: unknown
		try {
			data = await this.fetchThunder(this.searchUrl(query))
		} catch (err) {
			logger?.debug({ err, title: query.title }, 'overdrive: search failed')
			return []
		}
		const items = (data as { items?: OverDriveMedia[] })?.items ?? []
		logger?.debug({ count: items.length }, 'overdrive: search returned')
		return items
			.filter((it) => it.id != null && mainTitle(it.title))
			.map((it) => ({
				provider: OVERDRIVE_NAME,
				id: encodeOverdrive(it.id as number | string),
				asin: null,
				title: mainTitle(it.title),
				authors: creatorsByRole(it.creators, 'author'),
				narrators: creatorsByRole(it.creators, 'narrator'),
				audioSeconds: audioSecondsOf(it.formats),
				cover: largestCover(it.covers),
				language: firstLanguage(it.languages)
			}))
	}

	async fetchBook(
		nativeId: string,
		_kind: string,
		opts: FetchBookOptions
	): Promise<ProviderBook | null> {
		let data: unknown
		try {
			data = await this.fetchThunder(`${THUNDER}/libraries/${this.library}/media/${nativeId}`)
		} catch (err) {
			opts.logger?.debug({ err, nativeId }, 'overdrive: fetchBook failed')
			return null
		}
		const it = data as OverDriveMedia | undefined
		const title = mainTitle(it?.title)
		if (!it || !title) return null
		return {
			asin: null,
			title,
			authors: creatorsByRole(it.creators, 'author').map((name) => ({ name })),
			narrators: creatorsByRole(it.creators, 'narrator').map((name) => ({ name })),
			summary: stripHtml(it.description),
			image: largestCover(it.covers),
			publisherName: typeof it.publisher === 'string' ? it.publisher : it.publisher?.name,
			rating: typeof it.starRating === 'number' ? String(it.starRating) : undefined,
			releaseDate: it.publishDate,
			seriesPrimary: seriesOf(it),
			language: firstLanguage(it.languages)
		}
	}
}

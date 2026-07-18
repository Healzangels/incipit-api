import type { FastifyBaseLogger } from 'fastify'

import type AppleBooksProvider from '#helpers/providers/AppleBooksProvider'
import { normalizeTitle, sim, titleSim } from '#helpers/providers/matchScorer'
import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import type { BookSearchQuery } from '#helpers/providers/types'

/**
 * Best square cover for a matched book, for a square Plex poster.
 *
 * Plex music art is square, but Audible (the usual match) only has a portrait
 * cover. Apple Books covers are natively square and high-res, so we look one up
 * by title/author and hand it back as a separate `imageSquare` — the bundle
 * prefers it for the poster and keeps the original as a secondary option.
 * Cropping is deliberately avoided: it would cut the title/author off the art.
 *
 * Trust order is intentionally provider-based, not just resolution: Apple is the
 * one source that publishes designed-square covers, so we take its best
 * title-matching cover. Best-effort — any miss returns null and the caller keeps
 * the original cover.
 */

// A cover that is already a native square (Apple mzstatic …/NxNbb.jpg). Such a
// cover only needs bumping to high-res, not a fresh lookup.
const APPLE_SQUARE_RE = /mzstatic\.com\/.*\/\d+x\d+bb\.(?:jpg|png)/i
// Only accept an Apple cover whose title is a real match for the book — a loose
// Apple search can return a same-author different-book cover.
const TITLE_FLOOR = 0.8
// ...and whose author matches, so a same-title book by another author (an Apple
// term search returns those) can't supply the wrong cover.
const AUTHOR_FLOOR = 0.7
// Square poster size. 1400 is crisp in Plex without the weight of 3000.
const SQUARE_PX = 1400

function isAppleSquare(url?: string | null): boolean {
	return !!url && APPLE_SQUARE_RE.test(url)
}

/** Whether a candidate's author matches the wanted author (or no author asked). */
function authorMatches(candidateAuthors: string[], wantAuthor?: string): boolean {
	const want = wantAuthor?.toLowerCase().trim()
	if (!want) return true
	return candidateAuthors.some((a) => sim(want, a.toLowerCase().trim()) >= AUTHOR_FLOOR)
}

/** Bump an Apple mzstatic cover to a high-res square. */
function highRes(url: string): string {
	return url.replace(/\/\d+x\d+bb\.(jpg|png)(?=$|\?)/i, `/${SQUARE_PX}x${SQUARE_PX}bb.$1`)
}

export interface SquareCoverQuery {
	title: string
	author?: string
	/** The cover already on the matched book, if any. */
	currentImage?: string | null
	region: string
	credentials?: Record<string, string>
	logger?: FastifyBaseLogger
}

/**
 * Resolve the best square cover for a book, or null when none is found.
 * @param {ProviderRegistry} registry the provider registry (for the Apple provider)
 * @param {SquareCoverQuery} q the book title/author/region and current cover
 * @param {ProviderSearchCache} cache optional cache so repeated refreshes of the
 *   same title don't re-hit iTunes (this runs on every /books/:id response)
 * @returns {Promise<string | null>} a high-res square cover URL, or null
 */
export async function bestSquareCover(
	registry: ProviderRegistry,
	q: SquareCoverQuery,
	cache?: ProviderSearchCache
): Promise<string | null> {
	// The matched cover is already a native square (Apple mzstatic): just serve it
	// at high resolution, no extra lookup. Every other source (Audible/Amazon,
	// Hardcover, OpenLibrary, Storytel) ships PORTRAIT book covers, so look up
	// Apple's square for those — the title + author floors below keep it the same
	// book. (Earlier this was Amazon-only, which wrongly left Hardcover matches
	// with a portrait poster.)
	if (isAppleSquare(q.currentImage)) return highRes(q.currentImage as string)

	const apple = registry.get('apple') as AppleBooksProvider | undefined
	if (!apple || !q.title) return null

	const query: BookSearchQuery = {
		title: q.title,
		author: q.author,
		region: q.region,
		credentials: q.credentials
	}
	let candidates
	try {
		// Cache by (apple, region, title, author): the same book resolves to the
		// same Apple cover regardless of who asked, so one refresh warms the rest.
		candidates = cache
			? await cache.wrap('apple', query, () => apple.search(query, q.logger))
			: await apple.search(query, q.logger)
	} catch (err) {
		q.logger?.debug({ err, title: q.title }, 'square cover: apple lookup failed')
		return null
	}

	const want = normalizeTitle(q.title)
	let best: { cover: string; score: number } | null = null
	for (const c of candidates) {
		if (!c.cover) continue
		if (!authorMatches(c.authors, q.author)) continue
		const score = titleSim(want, normalizeTitle(c.title))
		if (score >= TITLE_FLOOR && (!best || score > best.score)) {
			best = { cover: c.cover, score }
		}
	}
	return best ? highRes(best.cover) : null
}

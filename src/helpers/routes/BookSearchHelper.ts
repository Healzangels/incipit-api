import type { FastifyBaseLogger } from 'fastify'

import type { BookSearchQueryString } from '#config/types'
import { dedupeCandidates } from '#helpers/providers/dedupe'
import {
	type CandidateScore,
	CONFIDENCE_FLOOR,
	DURATION_TOLERANCE,
	extractAsinAndClean,
	normalizeTitle,
	scoreCandidate
} from '#helpers/providers/matchScorer'
import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import type { BookSearchQuery, ProviderCandidate, ScoredCandidate } from '#helpers/providers/types'

// An album match at or above this makes a second (track-title) provider search
// pointless: duration corroboration (+0.15) or an ASIN pin lands here, but a bare
// title+author match (ceiling 0.85) does not — so a noisy album tag still widens
// to the track title, while an already-confirmed hit skips the extra fan-out.
const STRONG_MATCH = 0.9

// The authored path ceilings a duration-less title+author match at 0.85 (0.55 +
// 0.30) — below STRONG_MATCH — so it needs a duration corroboration to auto-match.
// An AUTHORLESS query has no such ceiling: scoreCandidate scores it on title
// alone, so a bare title reaches 1.0. That is the "Hell Bent" false-positive
// vector — a title-only match is unverifiable: distinct books share a title, and
// a shared main-title stem matches an unrelated subtitle ("Hell Bent" vs "Hell
// Bent: Groucho Marx, Sein Leben"). Re-impose the same 0.85 ceiling on authorless
// matches unless a duration corroborates the edition, so an uncorroborated hit
// surfaces as a confirm-me suggestion instead of auto-applying. Kept in the
// consumer so the Gate-0-pinned scoreCandidate stays bit-for-bit with the oracle.
const TITLE_ONLY_CEILING = 0.85

// A leading article ("The"/"A"/"An") is title noise — libraries even sort past
// it, and rips routinely drop or add it ("Taggerung" vs "The Taggerung"). The
// trailing \s+ means a bare "The"/"A" or a word like "Anansi"/"Theodore" is left
// intact; only a real leading-article token followed by more title is removed.
const LEADING_ARTICLE = /^\s*(?:the|a|an)\s+/i
function stripLeadingArticle(s: string): string {
	return s.replace(LEADING_ARTICLE, '')
}

// Co-author separators (mirrors the bundle's split): a rip's author field is
// often the full credit ("Robert Jordan, Brandon Sanderson") while a provider
// edition lists just one ("Robert Jordan"). \band\b is whitespace-bounded so a
// name like "Anderson"/"Sanderson" is never split.
const AUTHOR_SEP = /\s*(?:,|&|;|\/|\band\b)\s*/i
function splitAuthors(author: string | null | undefined): string[] {
	const full = (author ?? '').trim()
	// No author (many album searches) → one empty entry keeps the title-only
	// scoring path; never add '' when an author IS present, or a wrong-author
	// candidate could score on title+duration alone.
	if (!full) return ['']
	const parts = full
		.split(AUTHOR_SEP)
		.map((s) => s.trim())
		.filter(Boolean)
	// Full string first (best when the edition also credits everyone), then each
	// component; deduped so a single-author name isn't scored twice.
	return [...new Set([full, ...parts])]
}

/**
 * Whether a candidate is an actual audiobook edition (has an audio runtime or a
 * narrator) rather than a book-level record (OpenLibrary / a Hardcover book with
 * no audio edition). Used only as a same-confidence tiebreak.
 * @param {ScoredCandidate} c the candidate
 */
function isAudioEdition(c: ScoredCandidate): boolean {
	return (c.audioSeconds != null && c.audioSeconds > 0) || c.narrators.length > 0
}

// On a genuine tie (same confidence AND same audio-edition status), prefer the
// richer/more-authoritative source so a win never *degrades* metadata: Audible's
// full record beats a coin-flip, but a new provider still wins when it's actually
// a better match (higher confidence). Unknown providers sort last.
const PROVIDER_RANK: Record<string, number> = {
	audible: 0,
	hardcover: 1,
	apple: 2,
	storytel: 2,
	libro: 2,
	openlibrary: 3
}
function providerRank(c: ScoredCandidate): number {
	return PROVIDER_RANK[c.provider] ?? 9
}

/**
 * Runs a multi-provider book search: fan out across the registry, score every
 * candidate on one scale (title + author + duration), drop anything below the
 * acceptance floor, and return the survivors ranked best-first.
 *
 * The title is normalized the same way the Gate 0 benchmark normalized Plex
 * ALBUM tags, so the validated thresholds apply unchanged.
 */
export default class BookSearchHelper {
	private registry: ProviderRegistry
	private options: BookSearchQueryString
	private logger?: FastifyBaseLogger
	// Per-request provider credentials (e.g. a user's Hardcover token), sourced
	// from a request header rather than the query string so tokens never land in
	// access logs. Forwarded to providers via the internal BookSearchQuery.
	private credentials?: Record<string, string>
	private cache?: ProviderSearchCache

	constructor(
		registry: ProviderRegistry,
		options: BookSearchQueryString,
		logger?: FastifyBaseLogger,
		credentials?: Record<string, string>,
		cache?: ProviderSearchCache
	) {
		this.registry = registry
		this.options = options
		this.logger = logger
		this.credentials = credentials
		this.cache = cache
	}

	/** The raw search title (title param, or its `query` alias). */
	get rawTitle(): string {
		return this.options.title ?? this.options.query ?? this.options.keywords ?? ''
	}

	/**
	 * The ASIN to treat as a definitive match: the explicit `asin` param if given,
	 * else one extracted from a bracketed title. Uppercased for comparison.
	 */
	private effectiveAsin(): string | null {
		const explicit = this.options.asin?.trim()
		if (explicit) return explicit.toUpperCase()
		return extractAsinAndClean(this.rawTitle).asin
	}

	/**
	 * Execute the search across the album title and, when it differs, the track
	 * title too.
	 *
	 * A noisy ALBUM tag ("16 Loamhedge" — a leading track number normalizeTitle
	 * can't strip without risking real numeric titles) hurts matching two ways:
	 * it drags title similarity down AND it's the string sent to providers, so the
	 * best edition may never come back at all (a clean "Loamhedge" query returns a
	 * duration-corroborating source the noisy query misses). So we search the
	 * album title first; if that didn't already yield a STRONG match and a distinct
	 * track title exists, we ALSO search on the track title and merge the pools,
	 * scoring every candidate against both titles and keeping the higher score.
	 * This only ever raises a score or widens recall — it never lowers the floor
	 * or admits a candidate that fails both titles.
	 * @returns {Promise<ScoredCandidate[]>} accepted candidates, ranked best-first
	 */
	async search(): Promise<ScoredCandidate[]> {
		const asin = this.effectiveAsin()
		const primary = normalizeTitle(extractAsinAndClean(this.rawTitle).title)
		const track = normalizeTitle(extractAsinAndClean(this.options.trackTitle ?? '').title)
		const altTitle = track && track.toLowerCase() !== primary.toLowerCase() ? track : null
		if (!primary && !altTitle) return []

		const albumCandidates = primary ? await this.fanOut(primary) : []
		let ranked = this.scoreAndRank(albumCandidates, primary, altTitle, asin)

		// Widen to the track title when the album pass didn't already nail it.
		// STRONG_MATCH is above the title+author-only ceiling (0.85), so a bare
		// name match still triggers the wider search, but a duration-corroborated
		// or ASIN-pinned album hit skips the extra fan-out. Bounded to the
		// ambiguous case: only when a distinct track title exists.
		//
		// EXCEPTION — a strong hit is NOT trustworthy when the album title is a NOISY
		// SUPERSET of the track title (a leading track-number / prefix the album tag
		// carries and the track title doesn't, e.g. album "28 The Amazing Maurice…"
		// vs track "The Amazing Maurice…"). There the strong hit came from the
		// polluted query, which can miss the correct edition entirely: a wrong
		// LANGUAGE edition corroborated on author+duration still reaches STRONG_MATCH
		// and, left unchecked, suppresses the widening and auto-applies the wrong
		// book (the "una historia del mundodisco" Spanish false-100). So also widen
		// whenever the album title fully contains the track title — the merge only
		// adds candidates and keeps the best, so the clean query's correct edition
		// (e.g. the English audiobook that only the clean title surfaces) can win.
		const topAlbum = ranked.length ? ranked[0].confidence : 0
		const albumIsNoisySuperset =
			altTitle != null && primary.toLowerCase().includes(altTitle.toLowerCase())
		if (altTitle && (topAlbum < STRONG_MATCH || albumIsNoisySuperset)) {
			this.logger?.debug(
				{ altTitle, topAlbum, albumIsNoisySuperset },
				'book search: widening to the track title'
			)
			const trackCandidates = await this.fanOut(altTitle)
			ranked = this.scoreAndRank([...albumCandidates, ...trackCandidates], primary, altTitle, asin)
		}
		return ranked
	}

	/**
	 * Fan a single normalized title out across every provider.
	 * @param {string} normalizedTitle the title to search on
	 * @returns {Promise<ProviderCandidate[]>} the raw candidate union
	 */
	private async fanOut(normalizedTitle: string): Promise<ProviderCandidate[]> {
		const query: BookSearchQuery = {
			title: normalizedTitle,
			author: this.options.author,
			durationMs: this.options.duration,
			region: this.options.region,
			credentials: this.credentials
		}
		return this.registry.searchAll(query, this.logger, this.cache)
	}

	/**
	 * Score a candidate pool against the album title and (when present) the track
	 * title, keeping the higher score; then apply the ASIN override, filter to the
	 * floor, dedupe, and rank.
	 * @param {ProviderCandidate[]} candidates the raw candidate pool
	 * @param {string} primaryTitle the normalized album title
	 * @param {string | null} altTitle the normalized track title, if it differs
	 * @param {string | null} wantAsin the definitive ASIN to confirm matches against
	 * @returns {ScoredCandidate[]} accepted candidates, ranked best-first
	 */
	private scoreAndRank(
		candidates: ProviderCandidate[],
		primaryTitle: string,
		altTitle: string | null,
		wantAsin: string | null
	): ScoredCandidate[] {
		const authorParts = splitAuthors(this.options.author)
		const hasAuthor = !!this.options.author?.trim()
		const scored: ScoredCandidate[] = candidates.map((c) => {
			// Score against the album title and (when present) the track title,
			// keeping the higher. Both go through the same scoreCandidate (duration
			// identical), so taking the max only ever swaps in a better TITLE (or,
			// via scorePair, a better co-author) match — it can't relax the checks.
			let best = this.scorePair(primaryTitle, c, authorParts)
			if (altTitle) {
				const alt = this.scorePair(altTitle, c, authorParts)
				if (alt.confidence > best.confidence) best = alt
			}
			// An exact ASIN match is a definitive identity confirmation — it beats
			// any fuzzy score, so pin it to full confidence.
			const asinMatch = wantAsin != null && c.asin?.toUpperCase() === wantAsin
			let confidence = asinMatch ? 1 : best.confidence
			// Authorless title-only guard (see TITLE_ONLY_CEILING): with no author to
			// verify identity, hold a fuzzy title match below STRONG_MATCH unless its
			// duration corroborates the edition — so a bare "Hell Bent" can't silently
			// auto-match the wrong book. An ASIN pin and a duration match are exempt.
			if (!asinMatch && !hasAuthor) {
				const durCorroborated =
					best.durationDeltaPct != null && best.durationDeltaPct <= DURATION_TOLERANCE
				if (!durCorroborated) confidence = Math.min(confidence, TITLE_ONLY_CEILING)
			}
			return {
				...c,
				confidence,
				durationDeltaPct: best.durationDeltaPct
			}
		})

		const accepted = scored.filter((c) => c.confidence >= CONFIDENCE_FLOOR)
		return dedupeCandidates(accepted).sort((a, b) => {
			const byConfidence = b.confidence - a.confidence
			if (Math.abs(byConfidence) > 1e-9) return byConfidence
			// Equal confidence (e.g. an unanalyzed file gives no duration signal,
			// so an audio edition and a book-level record both sit at the floor):
			// prefer the ACTUAL audiobook edition. Otherwise the winner falls to
			// provider order, and a series can split across sources (half Audible,
			// half OpenLibrary) with inconsistent series/sort metadata.
			const byAudio = Number(isAudioEdition(b)) - Number(isAudioEdition(a))
			if (byAudio !== 0) return byAudio
			// Still tied: prefer the richer/more-authoritative source.
			return providerRank(a) - providerRank(b)
		})
	}

	/**
	 * Score one want-title against a candidate, also trying both sides with a
	 * leading article stripped so "Taggerung" ≈ "The Taggerung". Keeps the higher
	 * of the two — the stripped variant can only RAISE title similarity, never
	 * relax author/duration — and leaves the Gate-0-pinned scoreCandidate untouched.
	 * @param {string} wantTitle the normalized Plex-side title
	 * @param {ProviderCandidate} c the candidate
	 * @returns {CandidateScore} the better of the raw and article-stripped scores
	 */
	private scorePair(
		wantTitle: string,
		c: ProviderCandidate,
		authorParts: string[]
	): CandidateScore {
		const durationMs = this.options.duration ?? null
		const wantStripped = stripLeadingArticle(wantTitle)
		const candStripped = stripLeadingArticle(c.title)
		const hasStripped = wantStripped !== wantTitle || candStripped !== c.title

		// Try each co-author against the candidate (a rip crediting both authors
		// shouldn't lose points to an edition that lists one), and — when a leading
		// article differs — the article-stripped title too. Keep the best.
		let best: CandidateScore = { confidence: 0, durationDeltaPct: null }
		for (const author of authorParts) {
			const raw = scoreCandidate(wantTitle, author, c.title, c.authors, durationMs, c.audioSeconds)
			if (raw.confidence > best.confidence) best = raw
			if (hasStripped) {
				const s = scoreCandidate(
					wantStripped,
					author,
					candStripped,
					c.authors,
					durationMs,
					c.audioSeconds
				)
				if (s.confidence > best.confidence) best = s
			}
		}
		return best
	}
}

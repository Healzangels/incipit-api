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
import { languageConflict, regionLanguage } from '#helpers/utils/language'
import { type MatchDecision, recordMatchDecision } from '#helpers/utils/matchTelemetry'

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

// A candidate whose edition language positively CONFLICTS with the wanted one is
// the same book in the wrong language. Its title and author match perfectly —
// author names don't translate, and titles like "Dune"/"It"/"1984" don't either —
// so it scores identically to the correct edition, and a translation's runtime
// usually lands in the duration veto's 5–25% dead zone, so nothing vetoes it.
// Without this the winner falls to providerRank, i.e. WHICH SOURCE returned it
// decides the language the operator gets.
//
// A penalty, not a hard drop: language data is patchy, and languageConflict()
// already fires only when BOTH sides are positively known and differ (unknown is
// never a conflict).
//
// Sized at 0.15 deliberately. A title+author match ceilings at 0.85, so 0.15
// lands it at 0.70 — clearly beaten by a correct-language edition, but still
// ABOVE the 0.65 acceptance floor, so a book published ONLY in another language
// still matches instead of vanishing. 0.25 would drop it to 0.60 and delete it
// from the results entirely, trading a foreign-edition false positive for a
// no-match false negative.
// Consumer-side, so the Gate-0-pinned scoreCandidate stays bit-for-bit.
const LANGUAGE_CONFLICT_PENALTY = 0.15

// scoreCandidate rewards a runtime within 5% (+0.15) and vetoes one beyond 25%
// (-0.3), but gives a gap BETWEEN those exactly zero weight. That dead zone is
// not theoretical: "Demons Don't Dream" matched an edition 14% off, narrated by
// James Fouhey against a Bruce Huntey file — a verified WRONG EDITION. Three
// candidates were accepted, the top two tied at 0.85 (neither corroborated), and
// the tie fell through to providerRank. The 14% gap was the one piece of evidence
// that could have broken that tie correctly, and it counted for nothing.
//
// So grade the dead zone: penalty ramps linearly from 0 at 5% to the full veto
// magnitude at 25%, where scoreCandidate's own -0.3 takes over. Continuous by
// construction, and a worse runtime now always ranks below a better one instead
// of tying with it. Applied in the consumer off the durationDeltaPct the scorer
// already returns, so the Gate-0-pinned scoreCandidate stays bit-for-bit.
const DURATION_VETO_THRESHOLD = 0.25
const DURATION_DEADZONE_MAX_PENALTY = 0.3

// A BUNDLE record -- "Legacy of the Drow Gift Set", "Expanse Box Set Books 1-3",
// "The Stormlight Archive, Books 1-4" -- carries the queried book's title as a
// substring, so it scores like the single book it contains and can win outright.
// Measured on a 1341-book scan: Siege of Darkness matched the Drow gift set at
// 0.66, Rhythm of War the Books 1-4 omnibus, and Leviathan Wakes the Expanse box
// set at 1.0 because a stale sidecar ASIN pinned it there.
//
// Only fires when the QUERY does not itself ask for a bundle: "Arcanum Unbounded:
// The Cosmere Collection" is the actual book the operator has, and searching for
// it must still find it. Sized at 0.2 -- a title+author match at 0.85 lands at
// 0.65, the acceptance floor, so a real single-book edition always beats the
// bundle while a library that genuinely only has the box set still matches it.
const BUNDLE_RE =
	/\b(box(?:ed)?[- ]?set|gift[- ]?set|omnibus|collection|complete series|books? \d+\s*[-–—]\s*\d+|\d+[- ]book set|trilogy set)\b/i
const BUNDLE_PENALTY = 0.2

// A translated edition whose language field is NULL or mislabeled dodges the
// language demotion entirely -- but says so in its own title: "Everfound
// (Spanish Edition)" and "Medio rey [Half a King]" both won on the same scan,
// and Hardcover's French Dungeon Crawler Carl edition is tagged "en" at source.
// The marker is evidence the language field failed to carry, so treat it as a
// language conflict and reuse that penalty rather than inventing a second scale.
// Deliberately narrow: an explicit "<Language> Edition"/"edicion"/"ausgabe" tail,
// or a bracketed [Original Title] after non-ASCII words -- not a bare foreign
// word, which would demote legitimately foreign-titled English books.
const FOREIGN_EDITION_RE =
	/\b(spanish|french|german|italian|portuguese|dutch|polish|russian|japanese|chinese|swedish|norwegian|danish|finnish|czech|turkish|korean)\s+(edition|version)\b|\bedici[oó]n\b|\b[ée]dition\s+fran[cç]aise\b|\bausgabe\b|\bedizione\b/i

// A leading article ("The"/"A"/"An") is title noise — libraries even sort past
// it, and rips routinely drop or add it ("Taggerung" vs "The Taggerung"). The
// trailing \s+ means a bare "The"/"A" or a word like "Anansi"/"Theodore" is left
// intact; only a real leading-article token followed by more title is removed.
const LEADING_ARTICLE = /^\s*(?:the|a|an)\s+/i
function stripLeadingArticle(s: string): string {
	return s.replace(LEADING_ARTICLE, '')
}

// "&" and "and" are the same word in a title — rips write one, providers the
// other ("Faun and Games" vs Hardcover's "Faun & Games"), and sim() deleting
// the "&" outright left that pair at ~0.78, under the auto-match bar. Unifying
// to "and" before scoring makes them identical.
function unifyAmpersand(s: string): string {
	return s
		.replace(/\s*&\s*/g, ' and ')
		.replace(/\s{2,}/g, ' ')
		.trim()
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

/**
 * How much confidence an audio edition may give up to a print-only record and
 * still win.
 *
 * This service answers for an AUDIOBOOK library, but confidence is dominated by
 * title similarity, and audiobook titles routinely carry the series suffix the
 * print edition omits — "A Warrior's Knowledge, Book 2" against a catalogue
 * entry of "A Warrior's Knowledge". The audio edition therefore scores slightly
 * LOWER precisely because it is the audiobook, and the print record wins on a
 * gap that reflects punctuation rather than identity.
 *
 * Measured on the reporting case: an OpenLibrary work with no ASIN, no
 * narrators and no runtime beat the Audible edition 0.85 to 0.768 — and took
 * the match with it, so the book landed with no narrator, no runtime (nothing
 * for the duration veto to check) and a portrait print-scan cover.
 *
 * 0.10 is chosen to clear that 0.082 gap with a little room, and deliberately
 * kept below LANGUAGE_CONFLICT_PENALTY (0.15) so it can never overturn a
 * language decision — the wrong-language edition is the wrong BOOK, whereas
 * audio-vs-print is a format preference within the right one. It is a bounded
 * band, not a blanket override: a print record that is genuinely a better match
 * by more than this still wins, and when no audio edition is present nothing
 * changes.
 */
const AUDIO_EDITION_CONFIDENCE_TOLERANCE = 0.1

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
	// How many candidates the wrong-language demotion hit on the last scoring
	// pass. Reported in telemetry so the gate's real-world effect is measurable
	// rather than assumed.
	private languageDemoted = 0
	private bundleDemoted = 0
	// Ids of candidates the bundle penalty hit. A bundle forfeits its pinned-first
	// privilege in the sort below: the pin is an identity claim, and a box set is
	// structurally not the single book the caller asked for, so honouring the pin
	// there is what let a stale sidecar ASIN win outright.
	private bundleDemotedIds = new Set<string>()
	// How many candidates the graded duration dead-zone penalty hit on the last
	// scoring pass. Instrumented like the language gate so its effect is measured
	// rather than assumed.
	private durationDeadzoned = 0

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
	 * THE definition of "this candidate is the explicitly-hinted edition" —
	 * shared by scoring (confidence pin + veto exemptions), ranking (pinned-first
	 * tiebreak) and telemetry (asinPinned). One definition, so the layers cannot
	 * drift; dedupe receives the same wantAsin and applies it group-internally.
	 * @param {{ asin: string | null }} c the candidate
	 * @param {string | null} wantAsin the definitive ASIN, uppercased
	 */
	private isPinned(c: { asin: string | null }, wantAsin: string | null): boolean {
		return wantAsin != null && c.asin?.toUpperCase() === wantAsin
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
		let poolSize = albumCandidates.length
		let widened = false

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
			widened = true
			poolSize += trackCandidates.length
			ranked = this.scoreAndRank([...albumCandidates, ...trackCandidates], primary, altTitle, asin)
		}
		this.recordDecision(ranked, primary || (altTitle ?? ''), asin, widened, poolSize)
		return ranked
	}

	/**
	 * Emit one match-quality decision per search: a structured log line plus the
	 * in-memory aggregates behind /metrics.
	 *
	 * This is the only place the confidence a search actually acted on is
	 * preserved — it was previously computed and discarded, so a CONFIDENT WRONG
	 * match was invisible until someone eyeballed the library, and a dead provider
	 * token degraded quality with no signal at all. `risky` marks a match nothing
	 * corroborated (no ASIN, no duration); `risky && authorless` is exactly the
	 * conjunction behind the known false-positive class.
	 * @param {ScoredCandidate[]} ranked the accepted candidates, best-first
	 * @param {string} searchedTitle the normalized title actually searched
	 * @param {string | null} wantAsin the definitive ASIN, if one was supplied
	 * @param {boolean} widened whether the track-title widening pass fired
	 * @param {number} candidates the raw candidate pool size
	 */
	private recordDecision(
		ranked: ScoredCandidate[],
		searchedTitle: string,
		wantAsin: string | null,
		widened: boolean,
		candidates: number
	): void {
		const top = ranked.length ? ranked[0] : null
		const durationCorroborated =
			top != null && top.durationDeltaPct != null && top.durationDeltaPct <= DURATION_TOLERANCE
		const asinPinned = top != null && this.isPinned(top, wantAsin)
		const decision: MatchDecision = {
			title: searchedTitle,
			author: this.options.author ?? null,
			region: this.options.region ?? null,
			hasDuration: this.options.duration != null && this.options.duration > 0,
			authorless: !this.options.author?.trim(),
			manual: this.options.manual === true,
			wantLanguage: regionLanguage(this.options.region),
			matchedLanguage: top?.language ?? null,
			languageDemoted: this.languageDemoted,
			bundleDemoted: this.bundleDemoted,
			durationDeadzoned: this.durationDeadzoned,
			matched: top != null,
			provider: top?.provider ?? null,
			matchedTitle: top?.title ?? null,
			asin: top?.asin ?? null,
			confidence: top?.confidence ?? null,
			durationDeltaPct: top?.durationDeltaPct ?? null,
			runnerUpConfidence: ranked.length > 1 ? ranked[1].confidence : null,
			asinPinned,
			durationCorroborated,
			widened,
			candidates,
			accepted: ranked.length,
			risky: top != null && !asinPinned && !durationCorroborated
		}
		recordMatchDecision(decision)
		this.logger?.info(decision, 'book match decision')
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
		// The language we expect. Derived from region for now, which conflates
		// marketplace with language; an explicit per-request `language` param is the
		// follow-up that makes genuinely non-English LIBRARIES work.
		const wantLanguage = regionLanguage(this.options.region)
		// Narrator hint, folded to comparison keys once rather than per compare.
		// Split on commas and ampersands because a sidecar credits a cast as one
		// string ("Stephen Fry & full cast") while providers list members
		// separately -- matching ANY name is the useful test.
		const narratorKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
		const wantNarratorKeys = (this.options.narrator ?? '')
			.split(/[,&]/)
			.map((n) => narratorKey(n))
			.filter((n) => n.length >= 4)
		const narratorMatches = (c: ScoredCandidate): boolean => {
			for (const got of c.narrators ?? []) {
				const key = narratorKey(got)
				if (!key) continue
				for (const want of wantNarratorKeys) {
					if (key.includes(want) || want.includes(key)) return true
				}
			}
			return false
		}
		this.languageDemoted = 0
		this.bundleDemoted = 0
		this.bundleDemotedIds.clear()
		this.durationDeadzoned = 0
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
			const asinMatch = this.isPinned(c, wantAsin)
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
			// Wrong-language demotion. Exempt an ASIN pin: an exact ASIN is a
			// definitive identity the caller asked for by name, so honour it even
			// when its language differs.
			if (!asinMatch && languageConflict(c.language, wantLanguage)) {
				confidence = Math.max(0, confidence - LANGUAGE_CONFLICT_PENALTY)
				this.languageDemoted += 1
			}
			// A foreign-edition marker in the TITLE is evidence the language field
			// failed to carry (null, or mislabeled at source). Same conflict, same
			// penalty, same ASIN-pin exemption -- just a second way of detecting it.
			// Guarded so it cannot double-charge a candidate the field already caught.
			else if (
				!asinMatch &&
				FOREIGN_EDITION_RE.test(c.title ?? '') &&
				!FOREIGN_EDITION_RE.test(primaryTitle)
			) {
				confidence = Math.max(0, confidence - LANGUAGE_CONFLICT_PENALTY)
				this.languageDemoted += 1
			}
			// A bundle carries the queried title as a substring, so it scores like
			// the single book it contains. Applied even to an ASIN pin: a stale
			// sidecar ASIN pointing at a box set is exactly how "Leviathan Wakes"
			// matched "Expanse Box Set Books 1-3" at 1.0, and a bundle is
			// structurally not the single book regardless of what pinned it.
			if (BUNDLE_RE.test(c.title ?? '') && !BUNDLE_RE.test(primaryTitle)) {
				confidence = Math.max(0, confidence - BUNDLE_PENALTY)
				this.bundleDemoted += 1
				this.bundleDemotedIds.add(c.id)
			}
			// Graded duration dead zone (see DURATION_DEADZONE_MAX_PENALTY): a gap
			// between the corroboration and veto thresholds must cost SOMETHING, or a
			// wrong-runtime edition ties with a better one and the winner falls to
			// provider order. ASIN pins are exempt — the caller named that edition.
			const durDelta = best.durationDeltaPct
			// <= on the upper bound: scoreCandidate's own veto fires strictly ABOVE
			// the threshold, so a candidate at exactly 25% off fell in neither range
			// and paid nothing — the one discontinuity in an otherwise continuous
			// ramp. At exactly the threshold the ramp evaluates to the full veto
			// magnitude, so the two regimes meet without double-counting.
			if (
				!asinMatch &&
				durDelta != null &&
				durDelta > DURATION_TOLERANCE &&
				durDelta <= DURATION_VETO_THRESHOLD
			) {
				const through =
					(durDelta - DURATION_TOLERANCE) / (DURATION_VETO_THRESHOLD - DURATION_TOLERANCE)
				confidence = Math.max(0, confidence - through * DURATION_DEADZONE_MAX_PENALTY)
				this.durationDeadzoned += 1
			}
			return {
				...c,
				confidence,
				durationDeltaPct: best.durationDeltaPct
			}
		})

		const accepted = scored.filter((c) => c.confidence >= CONFIDENCE_FLOOR)
		// wantAsin is passed into dedupe so a pinned candidate cannot lose its
		// GROUP to a richer same-runtime rival — the pinned-first tiebreak below
		// runs after dedupe and cannot resurrect a deleted candidate.
		return dedupeCandidates(accepted, wantAsin).sort((a, b) => {
			// The explicitly-hinted ASIN outranks EVERYTHING, including a confidence
			// tie at 1.0: a perfect title+author+duration candidate also reaches 1.0,
			// and if the two don't dedupe-merge (different ASIN and runtime bucket)
			// the pin used to fall through to byAudio/providerRank like any other
			// tie — i.e. the one edition the caller named by identity could lose a
			// coin-flip. Nothing outscores a pin (1.0 is the ceiling), so this
			// tiebreak leading is equivalent to pinned-first, stated explicitly.
			const pinned = (c: ScoredCandidate) =>
				this.isPinned(c, wantAsin) && !this.bundleDemotedIds.has(c.id)
			const byPin = Number(pinned(b)) - Number(pinned(a))
			if (byPin !== 0) return byPin
			const byConfidence = b.confidence - a.confidence
			// A clear confidence win still decides. Inside the audio tolerance the
			// pair is treated as effectively tied, so the identity and format
			// tiebreaks below get to run — see
			// AUDIO_EDITION_CONFIDENCE_TOLERANCE for why a small gap between an
			// audio edition and a print-only record usually reflects a series
			// suffix in the title rather than a different book.
			if (Math.abs(byConfidence) > AUDIO_EDITION_CONFIDENCE_TOLERANCE) return byConfidence
			// Equal confidence: prefer the edition in the wanted language FIRST. A
			// duration-corroborated foreign edition (+0.15 corroboration, -0.15
			// demotion = net even) ties an uncorroborated correct-language book
			// record; when byAudio ran first it handed that tie to the foreign
			// audio edition and the language preference never executed. Language is
			// an identity property — the wrong-language book is the wrong BOOK —
			// while audio-vs-book-level is a richness property, so identity ranks
			// first.
			const byLanguage =
				Number(languageConflict(a.language, wantLanguage)) -
				Number(languageConflict(b.language, wantLanguage))
			if (byLanguage !== 0) return byLanguage
			// Still tied (e.g. an unanalyzed file gives no duration signal, so an
			// audio edition and a book-level record both sit at the floor): prefer
			// the ACTUAL audiobook edition. Otherwise the winner falls to provider
			// order, and a series can split across sources (half Audible, half
			// OpenLibrary) with inconsistent series/sort metadata.
			const byAudio = Number(isAudioEdition(b)) - Number(isAudioEdition(a))
			if (byAudio !== 0) return byAudio
			// The NARRATOR, when the caller told us who reads their copy.
			//
			// For a popular book the providers return several editions with
			// identical title and author, so title/author scoring cannot
			// separate them at all: Harry Potter and the Chamber of Secrets
			// comes back as Jim Dale, Stephen Fry and a Full-Cast edition, all
			// tied at 0.85. The narrator is the only field that says which one
			// is on disk, and it is categorical where duration is fuzzy -- so
			// it ranks above the runtime delta below.
			//
			// A RANKING signal, never a filter. It reorders candidates that
			// already passed acceptance and can never discard one, so a
			// missing, misspelt or differently-credited narrator ("Jim Dale"
			// vs "Jim Dale and a full cast") costs nothing beyond the tiebreak
			// it declines to decide. Same rule the ASIN pin follows.
			if (wantNarratorKeys.length) {
				const byNarrator = Number(narratorMatches(b)) - Number(narratorMatches(a))
				if (byNarrator !== 0) return byNarrator
			}
			// Both corroborated on duration -- but one is CLOSER.
			//
			// DURATION_TOLERANCE is 5%, which is the right width for deciding
			// whether a candidate is the same book at all, and far too wide to
			// separate two narrations OF that book. Measured on Harry Potter and
			// the Chamber of Secrets against a 34,968s file: the Stephen Fry
			// edition (34,980s) is 0.03% off and the Full-Cast edition (34,620s)
			// is 1.0% off, so both cleared tolerance, both took the same
			// corroboration bonus, and the tie fell through to provider order --
			// picking an edition with the wrong narrator entirely while the
			// evidence to choose correctly was already in hand.
			//
			// Ordering by the delta uses that evidence without changing what
			// counts as a match: it only ranks candidates that ALREADY passed,
			// and a null delta (no runtime to compare) never participates.
			const aDelta = a.durationDeltaPct
			const bDelta = b.durationDeltaPct
			if (aDelta != null && bDelta != null && Math.abs(aDelta - bDelta) > 1e-9) {
				return aDelta - bDelta
			}
			// Neither identity nor format separated them, so a residual gap inside
			// the tolerance decides after all — the band only ever lets the two
			// tiebreaks above jump a small deficit, it never discards confidence.
			if (Math.abs(byConfidence) > 1e-9) return byConfidence
			// Genuinely tied: prefer the richer/more-authoritative source.
			return providerRank(a) - providerRank(b)
		})
	}

	/**
	 * Score one want-title against a candidate, also trying title variants that
	 * can only RAISE similarity — leading article stripped ("Taggerung" ≈ "The
	 * Taggerung") and ampersand unified ("Faun and Games" ≈ "Faun & Games"),
	 * composed both ways. Keeps the best — a variant never relaxes
	 * author/duration — and leaves the Gate-0-pinned scoreCandidate untouched.
	 * @param {string} wantTitle the normalized Plex-side title
	 * @param {ProviderCandidate} c the candidate
	 * @returns {CandidateScore} the best score across all title variants
	 */
	private scorePair(
		wantTitle: string,
		c: ProviderCandidate,
		authorParts: string[]
	): CandidateScore {
		const durationMs = this.options.duration ?? null

		// Base + ampersand-unified, each also article-stripped when that differs.
		const pairs: Array<[string, string]> = []
		const bases: Array<[string, string]> = [
			[wantTitle, c.title],
			[unifyAmpersand(wantTitle), unifyAmpersand(c.title)]
		]
		// The candidate title put through the SAME normalizer the want title
		// already went through, making the comparison symmetric.
		//
		// titleSim's baseTitle() splits on ":" and "(", so "Dune: Book One" and
		// "Dune (Unabridged)" both score 1.000 against "Dune" -- but nothing
		// handles the trailing COMMA form. "Dune, Book 1" scores 0.533, and the
		// real case that surfaced this, "A Warrior's Knowledge, Book 2", scored
		// low enough to fall below CONFIDENCE_FLOOR and be discarded before
		// ranking ran at all. So for one of the commonest audiobook title
		// conventions there is, the audio edition was not out-ranked by the
		// print record -- it was thrown away, taking its narrators, runtime and
		// cover with it.
		//
		// Added as a VARIANT here rather than fixed inside baseTitle() so
		// scoreCandidate stays bit-for-bit with the Gate-0 oracle. Like every
		// other variant in this list it can only RAISE similarity: it is scored
		// alongside the original and the best result wins, so a provider title
		// that legitimately contains something the normalizer strips is never
		// made worse off.
		const candNormalized = normalizeTitle(c.title)
		if (candNormalized && candNormalized !== c.title) {
			bases.push([wantTitle, candNormalized])
			bases.push([unifyAmpersand(wantTitle), unifyAmpersand(candNormalized)])
		}
		for (const [w, cand] of bases) {
			pairs.push([w, cand])
			const ws = stripLeadingArticle(w)
			const cs = stripLeadingArticle(cand)
			if (ws !== w || cs !== cand) pairs.push([ws, cs])
		}

		// Try each co-author against the candidate (a rip crediting both authors
		// shouldn't lose points to an edition that lists one) for every distinct
		// title variant. Keep the best.
		const seen = new Set<string>()
		let best: CandidateScore = { confidence: 0, durationDeltaPct: null }
		for (const [w, candTitle] of pairs) {
			const key = w + '\u0000' + candTitle
			if (seen.has(key)) continue
			seen.add(key)
			for (const author of authorParts) {
				const s = scoreCandidate(w, author, candTitle, c.authors, durationMs, c.audioSeconds)
				if (s.confidence > best.confidence) best = s
			}
		}
		return best
	}
}

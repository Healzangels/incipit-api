/**
 * Match-quality telemetry.
 *
 * The matcher's dominant failure mode is a CONFIDENT WRONG match, and it has a
 * known shape: a fuzzy title+author hit that nothing corroborated (no ASIN, no
 * duration) — sharpest when the album carries no author tag at all. Until now
 * that decision was computed per request and thrown away, so the only way to
 * find a bad match was to eyeball the library, and a dead provider token
 * degraded quality with no signal at all.
 *
 * Every search records one decision here. Two consumers:
 *  - a structured log line per search (grep/alert on `risky` + `authorless`)
 *  - in-memory aggregates on /metrics, so quality is a NUMBER you can watch
 *    during a bulk import instead of a vibe. Aggregates survive any log level.
 *
 * Deliberately dependency-free: the caller computes the flags (it owns the
 * thresholds) and hands over a plain record, so this stays trivially testable
 * and the Gate-0-pinned scorer is untouched.
 */

/** One search's outcome — the unit of match-quality telemetry. */
export interface MatchDecision {
	/** Normalized album title that was searched. */
	title: string
	/** Author supplied by the caller, if any. */
	author: string | null
	region: string | null
	/** A duration was supplied (Plex sends none until the file is analyzed). */
	hasDuration: boolean
	/** No author tag — the sharpest false-positive risk factor. */
	authorless: boolean
	/** Language expected for this search (ISO-639-1), or null if undetermined. */
	wantLanguage: string | null
	/** Language of the winning candidate, or null when the provider gave no signal. */
	matchedLanguage: string | null
	/**
	 * How many candidates the wrong-language demotion hit. Makes the language
	 * gate's real effect measurable — if this stays 0 across a full library scan,
	 * foreign editions were never actually competing here.
	 */
	languageDemoted: number
	/**
	 * How many candidates the graded duration dead-zone penalty hit — a runtime
	 * gap between the corroboration and veto thresholds. Non-zero means the flat
	 * dead zone was previously letting wrong-runtime editions tie.
	 */
	durationDeadzoned: number

	/** At least one candidate survived the confidence floor. */
	matched: boolean
	provider: string | null
	matchedTitle: string | null
	asin: string | null
	confidence: number | null
	durationDeltaPct: number | null
	/** Second-place confidence — how close the call was. */
	runnerUpConfidence: number | null

	/** Identity confirmed by an exact ASIN. */
	asinPinned: boolean
	/** Runtime corroborated the edition within tolerance. */
	durationCorroborated: boolean
	/** The track-title widening pass fired. */
	widened: boolean
	/** Raw candidates fanned in, and how many cleared the floor. */
	candidates: number
	accepted: number

	/**
	 * Matched on fuzzy title/author alone — nothing (ASIN or duration) confirmed
	 * the identity. `risky && authorless` is precisely the conjunction behind the
	 * known false-positive class.
	 */
	risky: boolean
}

export interface MatchMetrics {
	total: number
	matched: number
	unmatched: number
	risky: number
	riskyAuthorless: number
	authorless: number
	widened: number
	asinPinned: number
	durationCorroborated: number
	/** Searches where at least one candidate was demoted for wrong language. */
	languageDemotedSearches: number
	/** Total candidates demoted for wrong language, across all searches. */
	languageDemotedCandidates: number
	/** Searches where at least one candidate hit the graded duration dead zone. */
	durationDeadzonedSearches: number
	/**
	 * Item lookups (/books/:asin) whose record language positively conflicts
	 * with the request region's expected language. The early-warning for a
	 * STALE/WRONG pinned ASIN: a delisted listing's ASIN resolving to another
	 * edition (the Dungeon Crawler Carl case served a FRENCH record for a
	 * sidecar-pinned ASIN) shows up here before anyone spots a foreign title
	 * on a shelf. Count only — the asin/language detail goes to the server
	 * log, so the open-mode /metrics payload stays content-free.
	 */
	languageMismatchedLookups: number
	/** Confidence distribution of matched searches. */
	byConfidence: Record<string, number>
	avgConfidence: number | null
	/** Most recent decisions, newest first — eyeball bad matches without log-diving. */
	recent: MatchDecision[]
}

/** How many recent decisions to retain for inspection. */
const RECENT_LIMIT = 50

const store: {
	total: number
	matched: number
	risky: number
	riskyAuthorless: number
	authorless: number
	widened: number
	asinPinned: number
	durationCorroborated: number
	languageDemotedSearches: number
	languageDemotedCandidates: number
	durationDeadzonedSearches: number
	languageMismatchedLookups: number
	confidenceSum: number
	byConfidence: Map<string, number>
	recent: MatchDecision[]
} = {
	total: 0,
	matched: 0,
	risky: 0,
	riskyAuthorless: 0,
	authorless: 0,
	widened: 0,
	asinPinned: 0,
	durationCorroborated: 0,
	languageDemotedSearches: 0,
	languageDemotedCandidates: 0,
	durationDeadzonedSearches: 0,
	languageMismatchedLookups: 0,
	confidenceSum: 0,
	byConfidence: new Map(),
	recent: []
}

/**
 * Bucket a confidence into a reporting band. Boundaries mirror the thresholds
 * that actually change behaviour: 0.9 auto-applies, 0.85 is the uncorroborated
 * ceiling, 0.65 is the acceptance floor.
 * @param {number} confidence the match confidence
 * @returns {string} the band label
 */
export function confidenceBand(confidence: number): string {
	if (confidence >= 0.9) return '0.90-1.00'
	if (confidence >= 0.85) return '0.85-0.90'
	if (confidence >= 0.7) return '0.70-0.85'
	return '0.65-0.70'
}

/**
 * Record one search decision into the in-memory aggregates.
 * @param {MatchDecision} decision the decision to record
 */
export function recordMatchDecision(decision: MatchDecision): void {
	store.total += 1
	if (decision.matched) store.matched += 1
	if (decision.risky) store.risky += 1
	if (decision.risky && decision.authorless) store.riskyAuthorless += 1
	if (decision.authorless) store.authorless += 1
	if (decision.widened) store.widened += 1
	if (decision.asinPinned) store.asinPinned += 1
	if (decision.durationCorroborated) store.durationCorroborated += 1
	if (decision.languageDemoted > 0) {
		store.languageDemotedSearches += 1
		store.languageDemotedCandidates += decision.languageDemoted
	}
	if (decision.durationDeadzoned > 0) store.durationDeadzonedSearches += 1

	if (decision.matched && decision.confidence != null) {
		store.confidenceSum += decision.confidence
		const band = confidenceBand(decision.confidence)
		store.byConfidence.set(band, (store.byConfidence.get(band) ?? 0) + 1)
	}

	store.recent.unshift(decision)
	if (store.recent.length > RECENT_LIMIT) store.recent.length = RECENT_LIMIT
}

/**
 * Snapshot the match-quality aggregates for /metrics.
 * @returns {MatchMetrics} the current aggregates
 */
export function getMatchMetrics(): MatchMetrics {
	const matched = store.matched
	return {
		total: store.total,
		matched,
		unmatched: store.total - matched,
		risky: store.risky,
		riskyAuthorless: store.riskyAuthorless,
		authorless: store.authorless,
		widened: store.widened,
		asinPinned: store.asinPinned,
		durationCorroborated: store.durationCorroborated,
		languageDemotedSearches: store.languageDemotedSearches,
		languageDemotedCandidates: store.languageDemotedCandidates,
		durationDeadzonedSearches: store.durationDeadzonedSearches,
		languageMismatchedLookups: store.languageMismatchedLookups,
		byConfidence: Object.fromEntries(store.byConfidence),
		avgConfidence: matched > 0 ? store.confidenceSum / matched : null,
		recent: [...store.recent]
	}
}

/**
 * Record one region-vs-record language mismatch on an item lookup.
 * Caller logs the identifying detail; this keeps only the count.
 */
export function recordLanguageMismatchedLookup(): void {
	store.languageMismatchedLookups += 1
}

/** Clear all aggregates (tests, and any future manual reset). */
export function resetMatchMetrics(): void {
	store.total = 0
	store.matched = 0
	store.risky = 0
	store.riskyAuthorless = 0
	store.authorless = 0
	store.widened = 0
	store.asinPinned = 0
	store.durationCorroborated = 0
	store.languageDemotedSearches = 0
	store.languageDemotedCandidates = 0
	store.durationDeadzonedSearches = 0
	store.languageMismatchedLookups = 0
	store.confidenceSum = 0
	store.byConfidence.clear()
	store.recent.length = 0
}

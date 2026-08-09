import type { FastifyBaseLogger } from 'fastify'

import type { BookSearchQueryString } from '#config/types'
import { byCandidateIdentity, dedupeCandidates } from '#helpers/providers/dedupe'
import {
	type CandidateScore,
	CONFIDENCE_FLOOR,
	DURATION_TOLERANCE,
	extractAsinAndClean,
	normalizeTitle,
	scoreCandidate,
	TITLE_FLOOR,
	titleSim
} from '#helpers/providers/matchScorer'
import { withNearTieAlternates } from '#helpers/providers/nearTieCovers'
import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import type { BookSearchQuery, ProviderCandidate, ScoredCandidate } from '#helpers/providers/types'
import { envInt } from '#helpers/utils/env'
import { isWrongLanguage, regionLanguage } from '#helpers/utils/language'
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
// Bent: Groucho Marx, Sein Leben"). Re-impose a ceiling on authorless matches
// unless a duration corroborates the edition, so an uncorroborated hit surfaces
// as a confirm-me suggestion instead of auto-applying. Kept in the consumer so
// the Gate-0-pinned scoreCandidate stays bit-for-bit with the oracle.
//
// 0.79, not 0.85 (changed 2026-07-26, operator decision): Plex's own auto-apply
// bar is a SCORE of 80, and 0.85 → 85 still cleared it — measured live when five
// tagless, mis-named files ("Manna from Heaven (1..5).m4b", ~96 hours of audio)
// each auto-applied to the real 5-hour collection with no author and no duration
// to contradict anything. One point under the bar makes "no author, no
// corroboration" mean what the guard intends: offered, never auto-applied.
// Session telemetry confirmed the only automatic authorless matches were that
// junk class; typed Fix Match searches (authorless by design) are unaffected in
// ordering — their displayed score just tops out at 79. Duration-corroborated
// and ASIN-pinned authorless matches remain exempt and can still auto-apply.
const TITLE_ONLY_CEILING = 0.79

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

// Providers round the SAME recording's runtime differently (OverDrive to the
// second, Audible to the minute), so two listings of one recording can differ
// by up to ~a minute of pure noise. Deltas BOTH inside this epsilon are treated
// as equal so seconds of rounding never decide a match; the fuller-title
// preference (or the arms below the delta) decide instead.
const DURATION_TIE_EPSILON_SECONDS_DEFAULT = 90

// The wider window the narrator-BRANDING arm alone may use: two listings that
// both match the hinted narrator and both sit within this many seconds of the
// file are the same narration re-released (credits/mastering variance --
// measured 240s between the 2015 and 2024 Fry Order of the Phoenix listings),
// so the branded release may outrank a slightly-closer unbranded one. Sized to
// exclude the 22.8-minute (1,368s) branded-vs-byte-exact case that proved the
// arm must NOT outrank real runtime evidence (2026-07-28).
const NARRATOR_BRAND_MAX_DELTA_SECONDS = 600

/**
 * The rounding epsilon in seconds; DURATION_TIE_EPSILON_SECONDS overrides.
 * A present-but-EMPTY value is absent, not zero -- see envInt.
 */
export function durationTieEpsilonSeconds(): number {
	return envInt(
		process.env.DURATION_TIE_EPSILON_SECONDS,
		DURATION_TIE_EPSILON_SECONDS_DEFAULT,
		0,
		600
	)
}

/**
 * What breaks a rounding-epsilon tie between title forms of one recording:
 * 'query' (the default since 2026-07-28) prefers the row titled what the
 * library calls the book -- trust-the-tags, the operator's curation model --
 * while 'fuller' prefers the fuller form of the same title ("Silverborn: The
 * Mystery of Morrigan Crow" over "Silverborn") regardless of the tag.
 * 'fuller' was the default during the Nevermoor work; libraries preferring
 * fuller display over their own tags opt back in via the env var.
 */
export function durationTieTitlePreference(): 'fuller' | 'query' {
	return process.env.DURATION_TIE_TITLE_PREFERENCE === 'fuller' ? 'fuller' : 'query'
}

/** Collapse a title for comparison: lowercase, single-spaced, trimmed. */
function looseTitle(title: string | null | undefined): string {
	return (title ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * True when `title` is the query title PLUS A SUBTITLE -- the same name,
 * extended at a real separator.
 *
 * A per-candidate KEY, not a relation between two candidates. The first cut
 * compared the two candidates to each other, which made the comparator
 * intransitive: with a third title that is prefix-unrelated to both, all six
 * input orders produced three different winners (verified 2026-07-28), so the
 * match depended on provider fan-out order. Every other arm in the chain
 * extracts a key from one candidate; this one now does too.
 *
 * The separator requirement is the other half. Squashing punctuation away and
 * testing `startsWith` had no word boundary, so "Dune Messiah" counted as the
 * fuller form of "Dune" -- likewise "Wintering"/"Winter" and "Ender in
 * Exile"/"Ender". A subtitle is introduced by punctuation, never by a bare
 * space.
 */
export function titleExtendsQuery(
	title: string | null | undefined,
	queryTitle: string | null | undefined
): boolean {
	const full = looseTitle(title)
	const base = looseTitle(queryTitle)
	if (!full || !base || full === base || !full.startsWith(base)) return false
	return /^[\s]*[:\-–—(,]/.test(full.slice(base.length))
}

/**
 * Providers that publish catalogued AUDIO editions. The fuller-title
 * preference is restricted to these because `dedupeCandidates` GRAFTS a
 * donor's asin onto a group winner that lacks one, so a print/work record can
 * carry a borrowed asin -- verified 2026-07-28 to reintroduce the Amazing
 * Maurice failure the asin guard was added to prevent. dedupe never grafts a
 * provider. (`isAudioEdition()` cannot serve here: this arm is only reachable
 * when both rows already have a runtime, which makes that predicate a
 * tautology.)
 */
const AUDIO_CATALOG_PROVIDERS = new Set([
	'audible',
	'apple',
	'storytel',
	'libro',
	'overdrive',
	// Chaptarr qualifies on the same terms: `ChaptarrProvider.search` emits
	// only editions that pass its audiobook-format filter, and `candidateFrom`
	// refuses an asin-less row — so a chaptarr candidate is a catalogued audio
	// edition carrying its OWN asin, never a print record wearing a grafted one.
	'chaptarr'
])

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

// Audible's catalog is increasingly polluted with AI-narrated "Virtual Voice"
// editions: Amazon auto-generates a synthetic-narration listing for a real book
// with a plausible title, author, and runtime, so it clears the confidence floor
// and can even duration-corroborate to 1.0 — then, if a stale sidecar ASIN points
// at it, PINS to 1.0 and out-ranks a real human-narrated edition from another
// provider. The reliable tell is the narrator string itself: no human narrator is
// named "Virtual Voice", so key off that rather than the noisier empty-narrator or
// implausible-runtime signals (a junk listing can have a plausible runtime).
//
// Demote rather than drop: a library may legitimately hold a Virtual Voice file,
// and it must still match when it is the only edition anywhere. Sized like the
// bundle penalty (0.2): a duration-corroborated junk edition lands at 0.8 — beaten
// by any human edition at 1.0, yet above the 0.65 floor and below the 0.9 auto-
// apply bar, so a junk-only book is OFFERED, never silently applied. Applied even
// to an ASIN pin (like BUNDLE_PENALTY), and the candidate is stripped of its
// pinned-first status, so a stale junk pin cannot force 1.0 over a real edition.
const AI_NARRATOR_RE = /\bvirtual voice\b/i
const AI_NARRATION_PENALTY = 0.2

/** True when a candidate's narrator marks it AI-generated (Amazon "Virtual Voice"). */
function isAiNarrated(narrators: string[] | undefined): boolean {
	return (narrators ?? []).some((n) => AI_NARRATOR_RE.test(n))
}

// Volume/part markers that DISTINGUISH two otherwise-identical titles.
// normalizeTitle strips "Part N"/"Book N"/"Vol N" as series noise -- correct for
// "A Warrior's Knowledge, Book 2" (which must still match the bare print record),
// but it also erases the ONLY difference between "KTF Part 1" and "KTF Part 2",
// two genuinely different books. They then normalize to the same "KTF" and score
// identically (both 0.85), so the tie fell to provider order and a search for
// Part 2 could return Part 1. Recover the numbers from the RAW titles here so a
// volume MISMATCH can be penalized WITHOUT touching scoreCandidate's Gate-0 pin.
// Two branches: a marker WORD ("part 2", "book 3", "vol. 4", "volume 5") or a
// bare "#N"; both require digits immediately after, so "The Book Thief" and
// "Fahrenheit 451" carry no volume and are never touched.
const VOLUME_MARKER_RE = /(?:\b(?:part|book|vol(?:ume)?\.?)\s*|#\s*)(\d{1,3})\b/gi

/**
 * The set of volume/part numbers a raw title advertises. Empty for the vast
 * majority of titles, which carry no such marker.
 * @param {string | null | undefined} raw a raw (un-normalized) title
 * @returns {Set<number>} every "Part N"/"Book N"/"Vol N"/"#N" number found
 */
function volumeNumbers(raw: string | null | undefined): Set<number> {
	const out = new Set<number>()
	if (!raw) return out
	VOLUME_MARKER_RE.lastIndex = 0
	let m: RegExpExecArray | null
	while ((m = VOLUME_MARKER_RE.exec(raw)) !== null) out.add(Number(m[1]))
	return out
}

/** Just the PART numbers, so they can be compared only against other parts. */
const PART_MARKER_RE = /\bpart\s*(\d{1,3})\b/gi
function partNumbers(raw: string | null | undefined): Set<number> {
	const out = new Set<number>()
	if (!raw) return out
	PART_MARKER_RE.lastIndex = 0
	let m: RegExpExecArray | null
	while ((m = PART_MARKER_RE.exec(raw)) !== null) out.add(Number(m[1]))
	return out
}

// A BARE trailing volume: "Defiance of the Fall 7". Providers list a numbered
// series this way at least as often as with a "Book N" marker, and the
// marker-based regex above cannot see it -- so a query for Book 10 found NO
// conflict with "Defiance of the Fall 1" and the wrong sibling won on score
// (measured: siblings at 0.824/0.812 beat the correct Book 10 at 0.771).
//
// Kept separate from VOLUME_MARKER_RE, and consulted ONLY when the QUERY itself
// advertises a volume, because a bare trailing number is otherwise ambiguous:
// "Fahrenheit 451" and "1984" are titles, not volumes. Two further guards make a
// false positive very unlikely -- at most 3 digits (so a year cannot match), and
// the text BEFORE the number must still look like the title we searched for.
const BARE_TRAILING_VOLUME_RE = /^(.*?)[\s,:.\-–—]+(\d{1,3})\s*$/

/**
 * A trailing number introduced by a FILE-SPLIT word is a part, not a series
 * position: "Catch-22, Part 1" is one book delivered in pieces, and multi-part
 * releases are routine on Audible and OverDrive.
 *
 * Reading those as volumes made a book conflict with ITSELF. Verified
 * 2026-07-28 against the real helper: album tag "Catch 22" with the only
 * listing titled "Catch-22, Part 1" returned ZERO results -- unmatchable, not
 * merely mis-ranked -- because the want side read "22" as a volume and the
 * candidate side read "1" as one, and the two sets are disjoint. Fahrenheit
 * 451, Apollo 13 and Slaughterhouse 5 all landed at 0.650, below Plex's 0.80
 * auto-apply bar, so they scan as unmatched.
 */
const PART_MARKER_STEM_RE = /\b(?:part|pt|disc|disk|cd|tape|side|file)\s*$/i

/**
 * The volume a candidate advertises as a bare trailing number, or null.
 * @param {string | null | undefined} candTitle the candidate's raw title
 * @param {string} wantTitle the normalized title we searched for
 * @returns {number | null} the volume, or null when this is not a numbered sibling
 */
function bareTrailingVolume(
	candTitle: string | null | undefined,
	wantTitle: string
): number | null {
	if (!candTitle) return null
	const m = BARE_TRAILING_VOLUME_RE.exec(candTitle.trim())
	if (!m) return null
	// "…, Part 1" is a file split of ONE recording, not volume 1 of a series.
	if (PART_MARKER_STEM_RE.test(m[1])) return null
	// The stem must still BE the book we asked for; otherwise a title that merely
	// ends in a number would be read as a sibling of something unrelated.
	if (titleSim(wantTitle, normalizeTitle(m[1])) < 0.9) return null
	// If the title WE searched for ends in that same number, the number is part of
	// the title, not a volume -- "Slaughterhouse 5" against a query for
	// "Slaughterhouse 5" is the same book, however the track tag numbers it.
	const wantBare = BARE_TRAILING_VOLUME_RE.exec(wantTitle.trim())
	if (wantBare && wantBare[2] === m[2]) return null
	return Number(m[2])
}

/**
 * A volume conflict: the query and candidate BOTH carry volume markers and share
 * NONE. Deliberately conservative -- a candidate with no marker (the bare print
 * record) never conflicts, and titles that share ANY number ("Galaxy's Edge,
 * Book 7: KTF Part 2" {7,2} vs a query for "KTF Part 2" {2}) do not either. It
 * only fires on a clear numbered mismatch like {1} vs {2}, so it can demote a
 * wrong sibling but never a right match.
 * @param {Set<number>} want the query's volume numbers
 * @param {Set<number>} cand the candidate's volume numbers
 * @returns {boolean} true only when both are non-empty and disjoint
 */
function volumeConflict(want: Set<number>, cand: Set<number>): boolean {
	if (want.size === 0 || cand.size === 0) return false
	for (const n of cand) if (want.has(n)) return false
	return true
}

/**
 * True when one side's numbers come only from a PART marker and the other
 * side advertises no part at all -- in which case the two sets describe
 * different things and must not be compared.
 *
 * "Part N" is ambiguous: some series really number volumes that way (The
 * Wandering Inn), but far more often it is a FILE SPLIT of one recording,
 * which Audible and OverDrive both do routinely. Comparing a file-split
 * number against a title-derived one made a book conflict with ITSELF:
 * verified 2026-07-28, album tag "Catch 22" with the only listing titled
 * "Catch-22, Part 1" returned ZERO results -- the correct book unmatchable,
 * not merely mis-ranked -- because want was {22} (the title's own digits)
 * and cand was {1} (the file part). Fahrenheit 451, Apollo 13 and
 * Slaughterhouse 5 all landed at 0.650, below Plex's 0.80 auto-apply bar.
 *
 * Comparing like with like keeps the genuine case working: two candidates
 * that BOTH carry part markers still conflict on disjoint parts.
 */
function partsAreIncomparable(
	wantParts: Set<number>,
	candParts: Set<number>,
	wantAll: Set<number>,
	candAll: Set<number>
): boolean {
	const wantOnlyParts = wantParts.size > 0 && wantParts.size === wantAll.size
	const candOnlyParts = candParts.size > 0 && candParts.size === candAll.size
	// Exactly one side is speaking about parts: not a disagreement.
	return (candOnlyParts && wantParts.size === 0) || (wantOnlyParts && candParts.size === 0)
}
// Sized like BUNDLE_PENALTY (0.2): a wrong sibling at 0.85 lands at 0.65, clear
// of the AUDIO_EDITION_CONFIDENCE_TOLERANCE band so the right sibling wins the
// ranking decisively rather than falling through to a coin-flip tiebreak.
const VOLUME_MISMATCH_PENALTY = 0.2

// Year-titled books are textually near-identical to a similarity scorer:
// measured live on Clarke's Space Odyssey shelf, a search for "2010" ranked
// "2001: A Space Odyssey" at 0.713 -- above every actual "2010: Odyssey Two"
// edition -- because sim('2010','2001') is high while the books share nothing
// but an author. When BOTH the wanted title's stem and the candidate's stem
// are PURE NUMBERS and they differ, they are different books, period. Same
// class and same shape as the volume-mismatch guard: consumer-side, pin-
// exempt, sized so a title+author match (0.85) lands under the floor.
// 2-4 digits: years and bare numbers; anything longer is an identifier, not
// a title.
const NUMERIC_STEM_RE = /^\s*(\d{2,4})\s*$/

/** The pure-numeric stem of a raw title ("2001: A Space Odyssey" -> "2001"), or null. */
function numericStem(raw: string | null | undefined): string | null {
	if (!raw) return null
	const match = NUMERIC_STEM_RE.exec(raw.split(/\s*[:(]\s*/)[0] ?? '')
	return match ? match[1] : null
}
const NUMERIC_TITLE_MISMATCH_PENALTY = 0.2

// The foreign-edition-marker rule now lives beside languageConflict, in
// helpers/utils/language: it is the SAME rule the ranking tiebreak needs, and
// keeping a private regex here is what let the two sites drift apart. See
// isWrongLanguage / titleEditionLanguage.

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
 * Convert a sidecar ISBN into the identifier Audible would catalogue it under,
 * or null when it cannot be one.
 *
 * Publishers frequently register an audio edition under its print ISBN-10
 * instead of a B0 ASIN, so the ISBN-10 IS the Audible product id. Measured live
 * on "The Secrets of the Immortal Nicholas Flamel: The Lost Stories Collection":
 * the sidecar's `asin` (B08WF9JR2P) resolves to nothing, while the ISBN-10 form
 * of its `isbn` (9780593399439 → 0593399439) resolves to the correct edition.
 *
 * ISBN-13s in the 979 block have no ISBN-10 form at all, and a 13-digit string
 * is not an Audible id, so those yield null rather than a lookup that cannot
 * succeed.
 * @param {string | null | undefined} raw the sidecar ISBN, either form, punctuated or not
 * @returns {string | null} a 10-character Audible-shaped id, or null
 */
export function audibleIdFromIsbn(raw: string | null | undefined): string | null {
	const digits = (raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase()
	// Already an ISBN-10: that is the id, X check digit included.
	if (digits.length === 10) return digits
	if (digits.length !== 13 || !digits.startsWith('978')) return null
	const core = digits.slice(3, 12)
	if (!/^\d{9}$/.test(core)) return null
	let sum = 0
	for (let i = 0; i < 9; i += 1) sum += (10 - i) * Number(core[i])
	const check = (11 - (sum % 11)) % 11
	return core + (check === 10 ? 'X' : String(check))
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

/**
 * Is this candidate within the confidence tolerance of the BEST in its set?
 *
 * Exported, and a pure function of ONE candidate's score, because that is the
 * whole point: the band used to be measured PAIRWISE
 * (`|a.confidence - b.confidence| > TOLERANCE`), which made the ranking
 * comparator non-transitive -- whether confidence decided depended on which two
 * rows the sort happened to compare. Three rows at 0.70 / 0.78 / 0.85 whose
 * identity arms prefer the lower-scored ones form a cycle: the two adjacent
 * pairs fall inside the band and defer to identity, the outer pair does not and
 * defers to confidence. Zero of the six orderings satisfy all three decisions,
 * and Array.sort returned three different winners purely from input order.
 *
 * Anchoring to a fixed reference makes it a per-candidate key, and a comparator
 * built only from per-candidate keys is transitive by construction.
 * @param {number} confidence this candidate's score
 * @param {number} best the highest score in the set being ranked
 * @param {number} [tolerance] the band width
 * @returns {boolean} whether it ranks as tied-for-best
 */
export function isNearBestConfidence(
	confidence: number,
	best: number,
	tolerance: number = AUDIO_EDITION_CONFIDENCE_TOLERANCE
): boolean {
	return best - confidence <= tolerance
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
	// Chaptarr sits BELOW every first-party catalog and ABOVE the book-level
	// fallback. It is an aggregator: its rows are second-hand copies of these
	// same catalogs, so when a first-party row ties it there is no reason to
	// prefer the copy — but it does carry a real audio edition (asin, narrator,
	// runtime), which outranks an OpenLibrary print record.
	//
	// Being ABSENT was the bug. `providerRank` returns `?? 9` for anything it
	// does not name, and the arm below records what that cost: on a live fresh
	// scan every candidate ties at 0.85 (nothing is analyzed, so no row
	// corroborates), the same `?? 9` fallthrough for overdrive/pinned lost 215
	// of 342 sidecar-pinned books, and this arm is where it happened.
	chaptarr: 3,
	openlibrary: 4
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
	// Ids the wrong-language demotion hit, recorded once per candidate during
	// scoring so the ranking tiebreak reads the SAME answer instead of
	// recomputing (and, as it turned out, drifting from) the rule.
	private wrongLanguageIds = new Set<string>()
	private aiNarratedIds = new Set<string>()
	// Pinned candidates whose own runtime is clearly wrong for the file while a
	// different edition corroborates it -- a stale/wrong sidecar ASIN. Stripped of
	// pin privilege in scoring, dedupe, and the pinned-first tiebreak.
	private pinOverriddenIds = new Set<string>()
	// The revoked pin's ASIN. `dedupeCandidates` runs AFTER the scoring pass and
	// GRAFTS a donor's asin onto a group winner that lacks one, so a row that
	// carried no asin when the pin was evaluated can acquire the stale one
	// afterwards -- and an id-keyed exclusion cannot see it. The ASIN is the
	// identity that survives the graft.
	private pinOverriddenAsin: string | null = null
	// How many candidates the volume-mismatch penalty hit on the last scoring pass
	// -- a numbered sibling ("KTF Part 1" against a query for "KTF Part 2"). Zero
	// for the overwhelming majority of searches, which involve no numbered pair.
	private volumeDemoted = 0
	// How many candidates the AI-narration demotion hit on the last scoring pass --
	// an Amazon "Virtual Voice" synthetic edition. Zero for almost every search.
	private aiNarrationDemoted = 0
	// How many pinned candidates lost their pin because their runtime contradicted
	// the file while another edition corroborated it (a stale/wrong sidecar ASIN).
	private pinDurationOverridden = 0
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
	 *
	 * A row we FETCHED by that ASIN (withPinnedEdition) is excluded. The warrant
	 * for pinning is independent corroboration — a provider returned this edition
	 * for the TITLE query and it carries the pinned ASIN, so two sources agree.
	 * Looking the ASIN up confirms only that it resolves, so pinning on that is
	 * circular. It matters at both call sites: the confidence override would set
	 * it to 1.0, and the ranking tiebreak puts pinned rows first on the (formerly
	 * safe) assumption that nothing outscores a pin — which stops being true once
	 * an uncorroborated pin scores on title+author alone. Excluded here rather
	 * than at each site so the two cannot drift apart.
	 * @param {{ asin: string | null; provider?: string }} c the candidate
	 * @param {string | null} wantAsin the definitive ASIN, uppercased
	 */
	private isPinned(
		c: { asin: string | null; provider?: string },
		wantAsin: string | null
	): boolean {
		if (c.provider === BookSearchHelper.PINNED_PROVIDER) return false
		return wantAsin != null && c.asin?.toUpperCase() === wantAsin
	}

	/**
	 * Whether the pin identity earns the FULL pin privilege (confidence
	 * override + pinned-first): only a B0-shaped store ASIN does. An
	 * ISBN-10-shaped identity — the isbn field, or an ABS sidecar's `asin`
	 * that is really the ISBN-10 twin of its own isbn — names a BOOK, not a
	 * store listing, and which listing a provider resolves it to is data-
	 * dependent: measured live (He Who Fights with Monsters, 2026-07-28),
	 * the sidecar's ISBN resolved through Hardcover to the deluxe-hardcover
	 * "Vol. 1" edition record and auto-matched it over the standard listing
	 * sitting 14s from the file. So an ISBN-derived pin is still fetched,
	 * offered, floor-held and group-protected — but it RANKS ON ITS MERITS,
	 * where the closest-runtime and exact-title arms express the operator's
	 * actual preference. The case ISBN pinning was built for (The Lost
	 * Stories Collection) ranks #1 on merits anyway: its ISBN-10 IS the
	 * audio product id and the only corroborated row.
	 */
	private static pinHasListingPrivilege(wantAsin: string | null): boolean {
		// The B0 prefix alone separates the two worlds: an ISBN-10 is digits
		// plus a possible X check digit, so it can never start with "B".
		return wantAsin != null && wantAsin.startsWith('B0')
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
		let asin = this.effectiveAsin()
		const primary = normalizeTitle(extractAsinAndClean(this.rawTitle).title)
		const track = normalizeTitle(extractAsinAndClean(this.options.trackTitle ?? '').title)
		const altTitle = track && track.toLowerCase() !== primary.toLowerCase() ? track : null
		if (!primary && !altTitle) return []

		const albumCandidates = await this.withPinnedEdition(
			primary ? await this.fanOut(primary) : [],
			asin
		)
		asin = this.promoteDeadPinToIsbn(albumCandidates, asin)
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
			const merged = [...albumCandidates, ...trackCandidates]
			// Re-run the promotion against the merged pool: a noisy album tag can
			// miss the ISBN edition that the clean track title returns, and the
			// widened fan-out is a fan-out row like any other for the
			// two-sources-agree warrant.
			asin = this.promoteDeadPinToIsbn(merged, asin)
			ranked = this.scoreAndRank(merged, primary, altTitle, asin)
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
		// An OVERRIDDEN pin is not a confirmed identity: the file's runtime just told
		// us that ASIN is wrong. Counting it as pinned reported the match as
		// ASIN-confirmed and therefore `risky: false` -- marking clean exactly the
		// class of match this guard exists to flag.
		const asinPinned =
			top != null &&
			this.isPinned(top, wantAsin) &&
			// An ISBN-derived identity at the top is a merits win, not an ASIN
			// confirmation -- reporting it as pinned would over-claim identity.
			BookSearchHelper.pinHasListingPrivilege(wantAsin) &&
			this.pinOverriddenAsin !== wantAsin &&
			!this.pinOverriddenIds.has(top.id)
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
			volumeDemoted: this.volumeDemoted,
			aiNarrationDemoted: this.aiNarrationDemoted,
			pinDurationOverridden: this.pinDurationOverridden,
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
	/**
	 * Make sure the pinned ASIN is IN the pool, fetching it directly when the
	 * title fan-out missed it.
	 *
	 * Every pin protection downstream — isPinned, the pinned-first tiebreak, the
	 * stale-pin duration override, the floor that keeps a contradicted pin
	 * offered — can only act on a candidate that came back from a provider. When
	 * the title search does not surface the pinned edition, all of it is dead
	 * code: the pin has no effect whatsoever, which is the opposite of what an
	 * explicit ASIN should mean.
	 *
	 * Measured live 2026-07-26 on Neal Shusterman / "Everfound": the sidecar
	 * carried B004XNIO5I, `GET /books/B004XNIO5I` resolved it correctly, and the
	 * search returned four rows (a Spanish edition, an OverDrive row, an Apple
	 * row, a Hardcover work record) with the pinned ASIN nowhere among them even
	 * on refresh. The book went unmatched through a whole library rebuild.
	 *
	 * INJECTED, NOT PROMOTED. The row is appended and then scored like any other:
	 * these ASINs come from ABS sidecars, which are known to be wrong and even
	 * dead (the same rebuild carried B07XG1S8LM on "2010", which resolves to
	 * nothing), so obeying one outright would auto-apply a wrong edition with no
	 * signal that it happened. The injected row also carries no runtime —
	 * ProviderBook has no duration field — so it scores on title+author alone and
	 * cannot out-argue a duration-corroborated rival. A wrong pin therefore ranks
	 * low and stays merely OFFERED for Fix Match.
	 *
	 * Failure is never fatal: a dead ASIN or a provider error leaves the pool
	 * exactly as it was, matching how searchAll isolates a failing provider.
	 * @param {ProviderCandidate[]} pool the candidates the fan-out produced
	 * @param {string | null} asin the pinned ASIN, uppercased, if any
	 * @returns {Promise<ProviderCandidate[]>} the pool, with the pin present when resolvable
	 */
	/**
	 * Provider name for a row fetched BY the pinned ASIN rather than returned by a
	 * title search. Marks it as uncorroborated so the ASIN override does not apply
	 * to it (see the asinMatch guard in scoreAndRank).
	 */
	private static readonly PINNED_PROVIDER = 'pinned'

	/**
	 * A DEAD sidecar ASIN falls back to the sidecar's ISBN as the pin identity.
	 * Only when the ASIN is nowhere in the pool (a live one is always present,
	 * from the fan-out or the injection) AND a row a FAN-OUT returned carries the
	 * ISBN-derived id — the same two-sources-agree warrant the pin override has
	 * always required, just with the sidecar's other identifier. Measured on
	 * "The Lost Stories Collection": asin B08WF9JR2P is dead, while Audible's
	 * title search returns 0593399439 (the sidecar's ISBN-10) at #1.
	 *
	 * Called once per scored pool — the album pass, then again on the merged
	 * pool after the track-title widening — so corroboration that only the
	 * widened fan-out surfaces still engages the pin. Idempotent: once the
	 * identity has flipped, the row carrying it is in the pool and the guard
	 * short-circuits.
	 * @param {ProviderCandidate[]} pool the candidates about to be scored
	 * @param {string | null} asin the current pin identity, uppercased
	 * @returns {string | null} the pin identity to score with
	 */
	private promoteDeadPinToIsbn(pool: ProviderCandidate[], asin: string | null): string | null {
		if (pool.some((c) => asin != null && c.asin?.toUpperCase() === asin)) return asin
		const isbnId = audibleIdFromIsbn(this.options.isbn)
		const corroborated =
			isbnId != null &&
			isbnId !== asin &&
			pool.some(
				(c) => c.provider !== BookSearchHelper.PINNED_PROVIDER && c.asin?.toUpperCase() === isbnId
			)
		if (!corroborated) return asin
		this.logger?.info(
			{ asin, isbn: isbnId },
			'book search: dead pinned asin, using the sidecar isbn as the pin identity'
		)
		return isbnId
	}

	private async withPinnedEdition(
		pool: ProviderCandidate[],
		asin: string | null
	): Promise<ProviderCandidate[]> {
		// The sidecar's ASIN first, then its ISBN. A sidecar ASIN can be DEAD while
		// the ISBN is live: measured on "The Lost Stories Collection", whose sidecar
		// pins B08WF9JR2P (resolves to nothing) alongside isbn 9780593399439, whose
		// ISBN-10 form 0593399439 IS the Audible product id and resolves to the
		// right edition. Publishers routinely register audio editions under the
		// print ISBN-10, so this is a class rather than a one-off.
		//
		// search_tools.py refuses an ISBN-10 sitting in a sidecar's `asin` field
		// because pinning it blind "would match the print edition over the audio
		// one". That objection does not reach this path — but READ WHY, because
		// the reason changed. It used to rest on "only Audible implements
		// fetchCandidateByAsin, and Audible's catalog holds no print editions".
		// Chaptarr implements it too, is registered after Audible (so it is
		// exactly the fallthrough for an ASIN Audible declines), and its work
		// carries every edition there is — it answered B09LVB8T3V with a German
		// Kindle ebook. What enforces the invariant now is the PROVIDER side:
		// ChaptarrProvider.editionForAsin only ever resolves an audiobook-format
		// edition, so a print-only identifier still resolves to nothing here.
		const isbnId = audibleIdFromIsbn(this.options.isbn)
		const ids = [asin, isbnId === asin ? null : isbnId].filter((v): v is string => Boolean(v))
		const inPool = (id: string) => pool.some((c) => c.asin?.toUpperCase() === id)
		// The ids are in PRIORITY order: the ASIN is the sidecar's stated identity,
		// the ISBN only its fallback. So the membership check is per-id, not
		// either-id — an ISBN row sitting in the pool must not stop the ASIN from
		// being fetched, or a live ASIN the fan-out merely missed reads as dead
		// and the pin identity flips to an edition the sidecar never named.
		// A satisfied id — in the pool already (the corroborated case the pin
		// override exists for) or successfully fetched — ends the loop; the
		// fallback only gets its turn when the primary produced nothing.
		for (const id of ids) {
			if (inPool(id)) return pool
			try {
				const found = await this.registry.fetchCandidateByAsin(id, {
					region: this.options.region,
					credentials: this.credentials,
					logger: this.logger
				})
				if (!found || !found.title?.trim()) {
					// A title-less candidate is a husk: it can be neither displayed nor
					// scored, and the floor-hold below would prop it up into the offered
					// results regardless (measured live -- it crashed the Plex bundle's
					// result listing). Whatever a provider returns, a husk counts as a
					// MISS so the loop proceeds to the next identifier.
					this.logger?.debug({ asin: id }, 'book search: pinned id resolved to nothing usable')
					continue
				}
				this.logger?.info(
					{ asin: id, title: found.title },
					'book search: injected the pinned edition'
				)
				// provider is overwritten so isPinned can recognise this as the
				// uncorroborated, fetched-by-asin row; everything else is the provider's
				// own data, runtime included.
				return [...pool, { ...found, provider: BookSearchHelper.PINNED_PROVIDER }]
			} catch (err) {
				this.logger?.debug({ err, asin: id }, 'book search: pinned id lookup failed')
			}
		}
		return pool
	}

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
		// The hint the arms may actually TRUST. Blanked when the runtime
		// fingerprint discredits the pin (see pinFingerprintContradicted): the
		// narrator field came from the same wrong sidecar record as the asin,
		// so once the file's runtime proves that record describes a different
		// narration, its narrator claim must not win the arbitration the pin
		// just lost -- the delta arm decides on file evidence instead.
		let trustedNarratorKeys = wantNarratorKeys
		const narratorMatches = (c: ScoredCandidate): boolean => {
			for (const got of c.narrators ?? []) {
				const key = narratorKey(got)
				if (!key) continue
				for (const want of trustedNarratorKeys) {
					if (key.includes(want) || want.includes(key)) return true
				}
			}
			return false
		}
		// True when the candidate's TITLE carries a "(Narrated by X)" tag naming
		// the REQUESTED narrator -- the publisher's own label for a re-release
		// built around that narrator. Distinct from narratorMatches (the
		// narrators FIELD), which cannot separate two editions of the same
		// narration; only the title branding can.
		const titleNamesWantedNarrator = (c: ScoredCandidate): boolean => {
			const m = /\(narrated by ([^)]+)\)/i.exec(c.title ?? '')
			if (!m) return false
			const key = narratorKey(m[1])
			if (!key) return false
			return trustedNarratorKeys.some((want) => key.includes(want) || want.includes(key))
		}
		// Hoisted out of the comparator: these were read per COMPARISON, i.e.
		// O(n log n) env lookups and regex passes per search.
		const tieEpsilonSeconds = durationTieEpsilonSeconds()
		const tieTitlePreference = durationTieTitlePreference()
		// Both runtimes within the provider-rounding epsilon of the file, so
		// the runtime cannot tell the two candidates apart.
		const withinRoundingNoise = (a: ScoredCandidate, b: ScoredCandidate): boolean => {
			const aDelta = a.durationDeltaPct
			const bDelta = b.durationDeltaPct
			// No runtime on one or both (an unanalyzed file, a record with no
			// listed length) is also "runtime cannot separate them" -- the
			// delta arm below cannot order such a pair either, so a cosmetic
			// arm is the best signal available rather than a usurper.
			if (aDelta == null || bDelta == null) return true
			const aAbs = a.audioSeconds ? aDelta * a.audioSeconds : Infinity
			const bAbs = b.audioSeconds ? bDelta * b.audioSeconds : Infinity
			return aAbs <= tieEpsilonSeconds && bAbs <= tieEpsilonSeconds
		}
		// A per-candidate key: this row is the query's title plus a subtitle,
		// AND is itself a catalogued audio edition (see AUDIO_CATALOG_PROVIDERS
		// for why the asin alone is not enough).
		const prefersFullerTitle = (c: ScoredCandidate): boolean =>
			titleExtendsQuery(c.title, primaryTitle) &&
			Boolean(c.asin) &&
			AUDIO_CATALOG_PROVIDERS.has(c.provider)
		this.languageDemoted = 0
		this.bundleDemoted = 0
		this.bundleDemotedIds.clear()
		this.wrongLanguageIds.clear()
		this.aiNarratedIds.clear()
		this.pinOverriddenIds.clear()
		this.pinOverriddenAsin = null
		this.durationDeadzoned = 0
		this.volumeDemoted = 0
		this.aiNarrationDemoted = 0
		this.pinDurationOverridden = 0
		// The volume/part numbers the QUERY carries, read from the RAW titles
		// (normalizeTitle strips them). Empty for almost every search; when
		// present, a candidate carrying a DIFFERENT number is a different book.
		const wantVolumes = new Set<number>([
			...volumeNumbers(this.rawTitle),
			...volumeNumbers(this.options.trackTitle)
		])
		// The want side's PART claims, read from the same two title sources as
		// wantVolumes above. Reading only rawTitle made a part claim that
		// arrives via the TRACK title look like "the want side isn't speaking
		// about parts" -- so an album tagged "The Wandering Inn" with a track
		// titled "…, Part 2" treated a Part 1 listing as incomparable, and the
		// disjoint-part conflict this guard exists to keep was silently
		// skipped: the wrong part kept 0.85, above the auto-apply bar.
		// Loop-invariant, so hoisted out of the per-candidate map as well.
		const wantParts = new Set<number>([
			...partNumbers(this.rawTitle),
			...partNumbers(this.options.trackTitle)
		])
		// Pure-numeric title stems on the QUERY side ("2010"), for the
		// numeric-title mismatch guard below. Both title forms -- but the track
		// side only for a FOUR-digit, no-leading-zero stem (a year, the class
		// this guard exists for). A bare 2-3 digit track title is a disc/track
		// index the tagger left behind ("04"), not a title claim, and it arrives
		// here precisely because it differs from the album tag -- so it would
		// become a wanted stem no correct candidate can carry, and the mismatch
		// penalty lands on the RIGHT book. The album tag keeps the full 2-4
		// digit range: an album tagged "04" names the album, not a track.
		const trackNumericStem = numericStem(this.options.trackTitle)
		const wantNumericStems = new Set<string>(
			[
				numericStem(this.rawTitle),
				trackNumericStem?.length === 4 && !trackNumericStem.startsWith('0')
					? trackNumericStem
					: null
			].filter((s): s is string => s != null)
		)
		// ...and the BARE form on the query side too, or the whole fallback is
		// gated off for the convention it was written for. Measured: with album
		// tag AND track title both "Defiance of the Fall 10" (the bare
		// ABS/folder convention), volumeNumbers finds nothing, the candidate-side
		// fallback never runs because it requires wantVolumes to be non-empty,
		// and the wrong sibling won -- v1 at 0.838 over the correct v10 at 0.812.
		// Only the tag punctuation decided whether the bug was fixed.
		//
		// Consulted ONLY when the marker form found nothing, so a title that
		// already advertises "Book N" is unaffected. The candidate side still
		// stem-checks against the query title, so an ordinary title ending in a
		// digit ("Fahrenheit 451") yields a want-number that no unrelated
		// candidate can be made to conflict with.
		if (wantVolumes.size === 0) {
			for (const raw of [this.rawTitle, this.options.trackTitle]) {
				const m = raw ? BARE_TRAILING_VOLUME_RE.exec(raw.trim()) : null
				// SAME STEM CHECK THE CANDIDATE SIDE APPLIES (line ~296). A rip
				// split across discs tags "The Wandering Inn - Disc 2", and
				// neither VOLUME_MARKER_RE nor PART_MARKER_RE covers "disc" —
				// so this fallback read the 2 as a wanted VOLUME and demoted
				// the correct Book 1 in favour of Book 2. A media-part suffix
				// says which piece of the file this is, never which book.
				if (m && !PART_MARKER_STEM_RE.test(m[1])) wantVolumes.add(Number(m[2]))
			}
		}
		// Snapshot of the volumes the TITLE ITSELF claims, for the ranker's
		// agreeing-volume tiebreak. Taken before the stated-position fallback
		// below so a sidecar position can only ever DEMOTE a conflicting sibling
		// (via wantVolumes/volumeConflict), never help one win a tie -- sidecar
		// positions are not trustworthy enough to promote on, the file's own
		// title is.
		const titleWantVolumes = new Set(wantVolumes)
		// ...and finally the caller's STATED series position, when the title
		// advertised nothing. Book 1 of a series is normally titled bare -- a
		// search for "Defiance of the Fall" declares no volume at all -- so a
		// sibling titled "Defiance of the Fall, Book 10" escapes the mismatch
		// penalty, and normalizeTitle strips its "Book 10" as series noise, so it
		// scores an EXACT title match and ties book 1 at 0.85. The winner then
		// falls to provider order.
		//
		// Measured live 2026-07-26: a fresh library scan matched TheFirstDefier's
		// book 1 file to BOOK 10 on exactly that tie. It hits every rebuild,
		// because Plex has not analysed the files during a fresh scan, so duration
		// is -1 and never reaches us -- and duration is the signal that otherwise
		// separates these (book 1 reaches 1.0 with it). The agent has been sending
		// seriesPosition on all of these searches while the scorer ignored it.
		//
		// PENALISE-ONLY and INTEGERS-ONLY, deliberately. This only ever adds a
		// number for volumeConflict to contradict; it never boosts the sibling
		// that agrees, because these positions come from the same sidecars known
		// to carry wrong ASINs and cannot be trusted to promote a candidate. A
		// fractional novella position (1.5 Mitosis, 12.5 Extraction) describes no
		// integer volume, so it is ignored rather than rounded into a claim that
		// would demote the legitimate siblings around it. Title-derived volumes
		// take precedence: the file's own title is the stronger claim.
		if (wantVolumes.size === 0) {
			const stated = this.options.seriesPosition?.trim()
			if (stated && /^\d{1,3}$/.test(stated)) wantVolumes.add(Number(stated))
		}
		// The file's own runtime lets us catch a STALE pin: a sidecar ASIN pointing
		// at the wrong edition (a Rosamund Pike ASIN on a Kate Reading file). A pin
		// whose edition runtime is clearly wrong for the file (>5% off) while a
		// DIFFERENT edition corroborates it is trusting a bad ASIN over ground truth.
		const wantSeconds = this.options.duration != null ? this.options.duration / 1000 : null
		// ONE duration arithmetic for both sides of this decision. The pin's own
		// delta used to be read from scoreCandidate's result, which is null whenever
		// every scored variant clamps to 0 -- i.e. exactly when the pinned ASIN is a
		// DIFFERENT BOOK, the case most in need of catching. Measuring it here means
		// the contradiction is judged on the same basis as the corroboration.
		const durationDelta = (c: ProviderCandidate): number | null => {
			if (wantSeconds == null || c.audioSeconds == null || c.audioSeconds <= 0) return null
			return Math.abs(wantSeconds - c.audioSeconds) / c.audioSeconds
		}
		const durationCorroborates = (c: ProviderCandidate): boolean => {
			const delta = durationDelta(c)
			return delta != null && delta <= DURATION_TOLERANCE
		}
		// The corroborator has to be something we would actually accept. An
		// AI-narrated "Virtual Voice" listing whose runtime happens to match would
		// otherwise strip a legitimate pin and then win the ranking outright --
		// inverting AI_NARRATION_PENALTY, which exists precisely so junk cannot beat
		// a real edition.
		// The witness must be a plausible candidate for THIS book. It previously
		// accepted any row in the raw pool -- no title check, no author check,
		// not even a requirement that it clear the acceptance floor -- so a row
		// the search itself discards could still revoke a pin. Measured
		// 2026-07-28: file 36000s, the CORRECT pinned edition drifting 9% in its
		// Audible listing, and one OpenLibrary row titled "A Completely
		// Different Book About Ducks" reporting 36000s dropped the pinned
		// edition from 1.000 to 0.789 -- under Plex's 0.80 bar, so the right
		// book went unmatched, caused by a row the operator never sees.
		//
		// TITLE_FLOOR is the same bar acceptance uses, so anything that could
		// not be returned as a match cannot silently veto one either.
		const witnessIsPlausible = (c: ProviderCandidate): boolean => {
			const t = normalizeTitle(c.title ?? '')
			if (!t) return false
			return (
				titleSim(primaryTitle, t) >= TITLE_FLOOR ||
				(altTitle != null && titleSim(altTitle, t) >= TITLE_FLOOR)
			)
		}
		const corroboratedNonPinExists =
			wantAsin != null &&
			candidates.some(
				(c) =>
					!this.isPinned(c, wantAsin) &&
					!isAiNarrated(c.narrators) &&
					witnessIsPlausible(c) &&
					durationCorroborates(c)
			)
		// Decide the contradiction ONCE for the pinned ASIN, over every row carrying
		// it, rather than per row: providers routinely return the same edition twice
		// and Hardcover audio rows often have a null runtime, so a per-row test let
		// the runtime-less twin keep the pin and win anyway. A pin is stale only when
		// rows that DO report a runtime all disagree with the file.
		const pinnedRows = wantAsin != null ? candidates.filter((c) => this.isPinned(c, wantAsin)) : []
		const pinnedDeltas = pinnedRows.map(durationDelta).filter((d): d is number => d != null)
		// RUNTIME-FINGERPRINT contradiction (Monstrous Regiment, 2026-07-28): a
		// self-consistent wrong sidecar -- asin AND narrator both naming the
		// Stephen Briggs edition -- pinned a narration 660s from the file while
		// the true Katherine Parkinson recording sat ONE second away. Field
		// cross-checks cannot catch that class (every sidecar field agrees with
		// itself), but the file's runtime is evidence the sidecar cannot fake:
		// when the pin's own rows all sit beyond provider ROUNDING of the file
		// while a plausible rival of a DIFFERENT narration sits inside it, the
		// file fingerprints the other narration. The narrator-disjoint
		// requirement (both sides non-empty, no key overlap either direction)
		// protects same-narration re-releases -- the Fry Phoenix pin is 286s
		// off with a 46s rival, but both are Fry, so it never trips -- and a
		// provider that lists no narrators can never prove disjointness.
		const absDeltaSeconds = (c: ProviderCandidate): number | null => {
			const d = durationDelta(c)
			return d != null && c.audioSeconds ? d * c.audioSeconds : null
		}
		const rowNarratorKeys = (c: ProviderCandidate): string[] =>
			(c.narrators ?? []).map(narratorKey).filter((k) => k.length >= 4)
		const narratorsDisjoint = (a: string[], b: string[]): boolean =>
			a.length > 0 &&
			b.length > 0 &&
			a.every((x) => b.every((y) => !x.includes(y) && !y.includes(x)))
		const pinNarrKeys = pinnedRows.flatMap(rowNarratorKeys)
		const pinnedAbsDeltas = pinnedRows.map(absDeltaSeconds).filter((d): d is number => d != null)
		const pinBestAbs = pinnedAbsDeltas.length ? Math.min(...pinnedAbsDeltas) : null
		const pinFingerprintContradicted =
			pinBestAbs != null &&
			pinBestAbs > tieEpsilonSeconds &&
			candidates.some((c) => {
				if (this.isPinned(c, wantAsin)) return false
				if (isAiNarrated(c.narrators)) return false
				if (!witnessIsPlausible(c)) return false
				const abs = absDeltaSeconds(c)
				if (abs == null || abs > tieEpsilonSeconds) return false
				return narratorsDisjoint(rowNarratorKeys(c), pinNarrKeys)
			})
		if (pinFingerprintContradicted) trustedNarratorKeys = []
		const pinIsStale =
			(corroboratedNonPinExists &&
				pinnedDeltas.length > 0 &&
				pinnedDeltas.every((d) => d > DURATION_TOLERANCE)) ||
			pinFingerprintContradicted
		// The runtime belongs to the EDITION, not the row. The veto is applied per
		// row, but an ASIN names one edition and providers routinely return it
		// twice -- and a Hardcover audio row often carries a null runtime. So a
		// vetoed 7200s abridgement, correctly filtered on its own, came straight
		// back at 0.850 through its runtime-less twin: Plex score 85, above the
		// auto-apply bar, applied automatically and sticky (verified 2026-07-28).
		//
		// Each ASIN keeps the BEST delta any of its rows reported, and a row with
		// no runtime of its own inherits it. Best, not worst, so a single bad
		// listing among good ones cannot manufacture a veto. Same shape as
		// pinIsStale above, generalized beyond the pinned ASIN.
		//
		// KEYED UPPERCASE, like every other cross-row ASIN identity in this file
		// (the pin arms at 642/873/879/908 all fold case). This map alone used
		// the raw value on BOTH sides, so a provider spelling an ASIN in a
		// different case produced a SEPARATE entry — and the runtime-less twin
		// then inherited nothing and laundered the veto away at 0.850, which is
		// the exact laundering the map exists to stop.
		const editionDelta = new Map<string, number>()
		for (const c of candidates) {
			if (!c.asin) continue
			const d = durationDelta(c)
			if (d == null) continue
			const key = c.asin.toUpperCase()
			const prior = editionDelta.get(key)
			if (prior == null || d < prior) editionDelta.set(key, d)
		}
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
			// any fuzzy score, so pin it to full confidence. UNLESS the pin is stale:
			// its own edition's runtime is clearly wrong for the file (>5% off) while a
			// different edition corroborates the file's runtime — a wrong sidecar ASIN
			// (a Rosamund Pike ASIN on a Kate Reading file). Then withdraw the override
			// and let the candidate score on its merits (the dead-zone penalty below),
			// so the duration-corroborated edition wins instead of the wrong narrator.
			// isPinned excludes a row we fetched BY this ASIN, so an injected pin
			// scores on title+author and loses to corroborated evidence.
			const asinMatch = this.isPinned(c, wantAsin)
			// Applies to EVERY row carrying the stale ASIN, including one with no
			// runtime of its own -- otherwise that row keeps the pin and wins.
			const pinContradicted = asinMatch && pinIsStale
			if (pinContradicted) {
				this.pinDurationOverridden += 1
				this.pinOverriddenIds.add(c.id)
				this.pinOverriddenAsin = wantAsin
			}
			// An ISBN-derived pin identity gets no confidence override (and no
			// penalty exemptions): it scores like any other row -- see
			// pinHasListingPrivilege for why an ISBN names a book, not a listing.
			const effectivePin =
				asinMatch && !pinContradicted && BookSearchHelper.pinHasListingPrivilege(wantAsin)
			let confidence = effectivePin ? 1 : best.confidence
			// Authorless title-only guard (see TITLE_ONLY_CEILING): with no author to
			// verify identity, hold a fuzzy title match below STRONG_MATCH unless its
			// duration corroborates the edition — so a bare "Hell Bent" can't silently
			// auto-match the wrong book. An ASIN pin and a duration match are exempt.
			if (!effectivePin && !hasAuthor) {
				const durCorroborated =
					best.durationDeltaPct != null && best.durationDeltaPct <= DURATION_TOLERANCE
				if (!durCorroborated) confidence = Math.min(confidence, TITLE_ONLY_CEILING)
			}
			// Wrong-language demotion: the language FIELD conflicts, or the title
			// carries a foreign-edition marker that names a language the request did
			// not ask for (evidence the field failed to carry -- null, or mislabeled
			// at source). One predicate, one charge, and the same answer the ranking
			// tiebreak below reads from `wrongLanguageIds`; see isWrongLanguage for
			// why the two must not each carry their own copy of this rule.
			if (isWrongLanguage(c, wantLanguage, primaryTitle, effectivePin)) {
				confidence = Math.max(0, confidence - LANGUAGE_CONFLICT_PENALTY)
				this.languageDemoted += 1
				this.wrongLanguageIds.add(c.id)
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
			// An AI-narrated "Virtual Voice" edition (see AI_NARRATION_PENALTY):
			// demote it below any human-narrated alternative and — like the bundle
			// penalty — apply it even to an ASIN pin, then strip its pinned-first
			// status below, so a stale junk pin cannot force 1.0 over a real edition.
			if (isAiNarrated(c.narrators)) {
				confidence = Math.max(0, confidence - AI_NARRATION_PENALTY)
				this.aiNarrationDemoted += 1
				this.aiNarratedIds.add(c.id)
			}
			// Wrong-volume demotion. The query named a "Part N"/"Book N"/"Vol N" and
			// this candidate carries a DIFFERENT one -- a search for "KTF Part 2"
			// looking at "KTF Part 1". normalizeTitle deleted both numbers before
			// scoring, so the two tied at 0.85 and the wrong one could win on
			// provider order; this restores the distinction the normalizer erased.
			// ASIN-pin exempt, like the other demotions: the caller named that
			// edition by identity even if its printed part number reads oddly.
			// Fall back to a bare trailing number when the candidate carries no
			// marker-style volume -- only reachable when the query HAS a volume, so
			// an ordinary title ending in a digit is never consulted.
			const candVolumes = volumeNumbers(c.title)
			if (candVolumes.size === 0 && wantVolumes.size > 0) {
				// Both titles, not just the album tag. scoreAndRank evaluates every
				// other check against primaryTitle AND altTitle, and the widening
				// pass exists precisely because the album tag can be noisy or
				// absent -- with no album tag, normalizeTitle('') gives a stem
				// similarity of 0, the 0.9 bar fails, and the fallback silently
				// died on the exact books it was written for (measured: the wrong
				// sibling stayed accepted at 0.824).
				const bare =
					bareTrailingVolume(c.title, primaryTitle) ??
					(altTitle ? bareTrailingVolume(c.title, altTitle) : null)
				if (bare != null) candVolumes.add(bare)
			}
			const incomparableParts = partsAreIncomparable(
				wantParts,
				partNumbers(c.title),
				wantVolumes,
				candVolumes
			)
			if (!effectivePin && !incomparableParts && volumeConflict(wantVolumes, candVolumes)) {
				confidence = Math.max(0, confidence - VOLUME_MISMATCH_PENALTY)
				this.volumeDemoted += 1
			}
			// Numeric-title mismatch (see NUMERIC_STEM_RE): "2010" vs a candidate
			// stem of "2001" is a different book however similar the digits look.
			// Fires only when BOTH sides are pure numbers -- a numeric query never
			// demotes a worded candidate ("The Year We Make Contact") and worded
			// queries are untouched entirely. Pin-exempt like the volume guard.
			// No dedicated telemetry counter: sized to drop the wrong year below
			// the acceptance floor, so its effect shows up as the candidate simply
			// not being offered.
			if (!effectivePin && wantNumericStems.size > 0) {
				const candNumeric = numericStem(c.title)
				if (candNumeric != null && !wantNumericStems.has(candNumeric)) {
					confidence = Math.max(0, confidence - NUMERIC_TITLE_MISMATCH_PENALTY)
					this.logger?.debug(
						{ candidate: c.title, wanted: [...wantNumericStems] },
						'book search: numeric-title mismatch, demoted'
					)
				}
			}
			// Graded duration dead zone (see DURATION_DEADZONE_MAX_PENALTY): a gap
			// between the corroboration and veto thresholds must cost SOMETHING, or a
			// wrong-runtime edition ties with a better one and the winner falls to
			// provider order. ASIN pins are exempt — the caller named that edition.
			// A row with no runtime of its own answers to its EDITION's evidence
			// (see editionDelta): otherwise the runtime-less twin of a vetoed
			// edition launders the veto away and wins at 0.850.
			const inherited =
				best.durationDeltaPct == null && c.asin ? editionDelta.get(c.asin.toUpperCase()) : undefined
			if (!effectivePin && inherited != null && inherited > DURATION_VETO_THRESHOLD) {
				// Past the veto threshold the scorer would have applied its own
				// veto had this row reported the runtime; match that magnitude.
				confidence = Math.max(0, confidence - DURATION_DEADZONE_MAX_PENALTY)
				this.durationDeadzoned += 1
			}
			const durDelta = best.durationDeltaPct ?? inherited ?? null
			// <= on the upper bound: scoreCandidate's own veto fires strictly ABOVE
			// the threshold, so a candidate at exactly 25% off fell in neither range
			// and paid nothing — the one discontinuity in an otherwise continuous
			// ramp. At exactly the threshold the ramp evaluates to the full veto
			// magnitude, so the two regimes meet without double-counting.
			if (
				!effectivePin &&
				durDelta != null &&
				durDelta > DURATION_TOLERANCE &&
				durDelta <= DURATION_VETO_THRESHOLD
			) {
				const through =
					(durDelta - DURATION_TOLERANCE) / (DURATION_VETO_THRESHOLD - DURATION_TOLERANCE)
				confidence = Math.max(0, confidence - through * DURATION_DEADZONE_MAX_PENALTY)
				this.durationDeadzoned += 1
			}
			// A contradicted pin is DEMOTED, never deleted. Withdrawing the override
			// re-exposes it to the language/volume/dead-zone penalties, which together
			// can push it under the acceptance floor -- so `GET /books?asin=X` could
			// come back with no row carrying X at all, and the operator could not even
			// pick their named edition in Fix Match. Hold it at the floor: it ranks
			// well below the corroborated winner but stays offered.
			//
			// An INJECTED pin row gets the same hold, for the same reason. It scores
			// on its merits (no override -- see isPinned), and when the provider's
			// full title is much longer than the query ("Series Name: The Actual
			// Title" against a sidecar title of just "The Actual Title"), that
			// natural score can land UNDER the floor -- silently deleting the one
			// edition the sidecar named, which defeats the entire point of fetching
			// it. Offered-not-winning is the contract for both cases -- and for an
			// ISBN-derived pin identity too (asinMatch without the listing
			// privilege): it ranks on its merits, but the row the sidecar named
			// must never vanish from the list.
			if ((asinMatch && !effectivePin) || c.provider === BookSearchHelper.PINNED_PROVIDER) {
				confidence = Math.max(confidence, CONFIDENCE_FLOOR)
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
		// AI-narrated ids are junk (no pin, no donation); a pin-overridden id is a
		// REAL edition whose pin we distrust, so it keeps donating its ASIN/narrators.
		// Near-tied rows lend each other art LAST, after ranking: dedupe merges
		// only what it can prove is one record, so two obviously-identical
		// packagings a point apart (100 and 99) stay separate and each shows only
		// its own cover. Adds to coverAlternates only -- no cover, confidence or
		// position changes, so a wrong borrow is a spare tile, never a changed
		// poster. See nearTieCovers for the narrator rule and why absence cannot
		// count as a match.
		const ranked = dedupeCandidates(accepted, wantAsin, this.aiNarratedIds, this.pinOverriddenIds)
		// Per-candidate sort keys, computed ONCE before the sort. The comparator
		// runs O(n log n) times and normalizeTitle/volumeNumbers are regex
		// passes whose answers cannot change mid-sort -- the byLanguage arm
		// already learned this lesson (wrongLanguageIds, filled by the scoring
		// pass, after its inline recompute drifted from the demotion rule it
		// copied). These two follow the same pattern, keyed by c.id like every
		// other per-candidate set here.
		const volumeClaimIds = new Set<string>()
		if (titleWantVolumes.size) {
			for (const c of ranked) {
				for (const v of volumeNumbers(c.title)) {
					if (titleWantVolumes.has(v)) {
						volumeClaimIds.add(c.id)
						break
					}
				}
			}
		}
		// Decoration weight per candidate: how many characters the raw title
		// loses to normalizeTitle. "Xanth 19 - Roc and a Hard Place" and
		// "Roc and a Hard Place" NORMALIZE IDENTICALLY, so no title arm can
		// separate them -- the last cosmetic arm below prefers the raw form
		// closest to its own normalized name. Per-candidate, precomputed,
		// transitive by construction.
		const decorationById = new Map<string, number>()
		for (const c of ranked) {
			const raw = c.title ?? ''
			decorationById.set(c.id, raw.length - normalizeTitle(raw).length)
		}
		const titleTierById = new Map<string, number>()
		{
			const primaryLower = primaryTitle.toLowerCase()
			const altLower = altTitle != null ? altTitle.toLowerCase() : null
			for (const c of ranked) {
				const t = normalizeTitle(c.title).toLowerCase()
				titleTierById.set(
					c.id,
					t === primaryLower ? 2 : altLower !== null && t === altLower ? 1 : 0
				)
			}
		}
		// The confidence band, as a PER-CANDIDATE key anchored to the best score in
		// this set -- see the byNearBest arm for why it cannot stay pairwise.
		const bestConfidence = ranked.reduce((m, c) => Math.max(m, c.confidence), 0)
		const nearBest = (c: ScoredCandidate): boolean =>
			isNearBestConfidence(c.confidence, bestConfidence)
		return withNearTieAlternates(
			ranked.sort((a, b) => {
				// The explicitly-hinted ASIN outranks EVERYTHING, including a confidence
				// tie at 1.0: a perfect title+author+duration candidate also reaches 1.0,
				// and if the two don't dedupe-merge (different ASIN and runtime bucket)
				// the pin used to fall through to byAudio/providerRank like any other
				// tie — i.e. the one edition the caller named by identity could lose a
				// coin-flip. Nothing outscores a pin (1.0 is the ceiling), so this
				// tiebreak leading is equivalent to pinned-first, stated explicitly.
				const pinned = (c: ScoredCandidate) =>
					this.isPinned(c, wantAsin) &&
					// An ISBN-derived identity ranks on its merits (see
					// pinHasListingPrivilege) -- no pinned-first.
					BookSearchHelper.pinHasListingPrivilege(wantAsin) &&
					// A revoked pin stays revoked however the row acquired the asin.
					this.pinOverriddenAsin !== wantAsin &&
					!this.bundleDemotedIds.has(c.id) &&
					!this.aiNarratedIds.has(c.id) &&
					!this.pinOverriddenIds.has(c.id)
				const byPin = Number(pinned(b)) - Number(pinned(a))
				if (byPin !== 0) return byPin
				// A clear confidence win still decides; inside the tolerance the pair
				// is effectively tied so the identity and format tiebreaks below get
				// to run -- see AUDIO_EDITION_CONFIDENCE_TOLERANCE for why a small gap
				// between an audio edition and a print-only record usually reflects a
				// series suffix in the title rather than a different book.
				//
				// ANCHORED TO THE BEST SCORE, not measured between the two rows. As a
				// PAIRWISE test -- `|a.conf - b.conf| > TOLERANCE` -- this arm made the
				// whole comparator NON-TRANSITIVE, because whether confidence decides
				// depended on which two rows the sort happened to hand it. Every other
				// arm is per-candidate for exactly this reason; this one was the
				// exception, and it is the one that broke.
				//
				// Demonstrated with three rows at 0.70 / 0.78 / 0.85 where the identity
				// arms prefer the lower-scored ones: 0.70>0.78 and 0.78>0.85 are both
				// in band, but 0.70 vs 0.85 is not, so 0.85>0.70 -- a cycle. ZERO of
				// the six possible orderings satisfy all three decisions, and
				// Array.sort returned THREE DIFFERENT winners depending only on the
				// order the providers happened to return the rows in. That is the same
				// arrival-order dependence the determinism work set out to remove.
				//
				// Now: rows within the tolerance OF THE BEST are tied and fall through
				// to the identity arms; a row outside that band loses to any row inside
				// it; and two rows both outside rank by raw confidence, which is a
				// total order. All three keys are per-candidate, so the composition is
				// transitive. Only the ordering of rows that cannot win changes.
				const byConfidence = b.confidence - a.confidence
				const byNearBest = Number(nearBest(b)) - Number(nearBest(a))
				if (byNearBest !== 0) return byNearBest
				// Both outside the band: raw confidence, which is a total order. Neither
				// can win the match anyway -- something inside the band exists by
				// definition -- so this only settles the order of also-rans.
				if (!nearBest(a) && byConfidence !== 0) return byConfidence
				// Equal confidence: prefer the edition in the wanted language FIRST. A
				// duration-corroborated foreign edition (+0.15 corroboration, -0.15
				// demotion = net even) ties an uncorroborated correct-language book
				// record; when byAudio ran first it handed that tie to the foreign
				// audio edition and the language preference never executed. Language is
				// an identity property — the wrong-language book is the wrong BOOK —
				// while audio-vs-book-level is a richness property, so identity ranks
				// first.
				// Consult the SAME TWO SIGNALS the demotion above does. Reading
				// `c.language` alone left this arm blind to exactly the rows that
				// demotion had just penalized: a translated edition whose language
				// field is null or mislabeled is betrayed only by its title marker,
				// so `languageConflict` returns false for it and the arm declines to
				// decide. The -0.15 demotion then cancels its +0.15 duration
				// corroboration, it ties the correct-language row at 0.85, and
				// byAudio hands it the match -- because the foreign row IS the audio
				// edition while the correct English row is a runtime-less book
				// record. Measured on "Everfound (Spanish Edition)"; Babel persisted
				// the same way in the live library.
				//
				// Per-CANDIDATE, deliberately: a pairwise predicate here would make
				// the comparator's behaviour depend on which two rows it is handed,
				// which is how a sort loses transitivity.
				//
				// Read from the set the scoring pass filled, not recomputed here. It
				// was recomputed per COMPARISON -- O(n log n) regex passes over
				// primaryTitle for an answer that cannot change during a sort -- and,
				// worse, it was a SECOND copy of the demotion's rule that had already
				// drifted from it (this one had lost the ASIN-pin exemption).
				const byLanguage =
					Number(this.wrongLanguageIds.has(a.id)) - Number(this.wrongLanguageIds.has(b.id))
				if (byLanguage !== 0) return byLanguage
				// The volume the QUERY TITLE itself claims is identity evidence too:
				// searching "Defiance of the Fall, Book 10" must prefer the sibling
				// titled Book 10 over the BARE book 1. Scoring cannot separate them —
				// a bare title claims nothing so volumeConflict rightly declines to
				// penalize it, and normalizeTitle strips "Book 10" so both rows score
				// an exact title match. This tie used to fall through to arrival
				// order, which happened to seat the right sibling first; the ranker
				// must state the preference, not inherit it from luck. Title-derived
				// volumes ONLY (see titleWantVolumes): a sidecar seriesPosition never
				// promotes. Per-candidate key, so the sort stays transitive.
				if (titleWantVolumes.size) {
					// Precomputed above -- volumeNumbers is a regex walk and this arm
					// used to run it twice per comparison.
					const byWantedVolume = Number(volumeClaimIds.has(b.id)) - Number(volumeClaimIds.has(a.id))
					if (byWantedVolume !== 0) return byWantedVolume
				}
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
				// Can runtime tell these two apart? Both gaps inside the
				// provider-rounding epsilon means no: providers round the SAME
				// recording differently (OverDrive to the second, Audible to the
				// minute), so a few seconds of difference is noise, not evidence.
				// Only then may a COSMETIC arm (narrator branding, fuller title)
				// decide. Shipped the other way round on 2026-07-27 and verified
				// wrong on 2026-07-28: a branded edition 22.8 minutes off beat the
				// byte-exact recording, and a 0s-off row lost to an 88s-off one.
				// WHICH of the library's own title forms a candidate matches,
				// ranked rather than boolean: the album/sidecar title (2)
				// outranks the track title (1). Both are the operator's voice,
				// but the sidecar is curated machine-written metadata while the
				// embedded track tag is whatever the ripper wrote -- measured
				// live on the Nevermoor shelf (2026-07-28), where three of four
				// files carry the long form in their track tag while every
				// sidecar says the short form. Treating the two as equal let one
				// series rank inconsistently against its own curated titles.
				// Precomputed above (titleTierById) -- normalizeTitle is a regex pass
				// and this ran it, plus two toLowerCase()s of the SAME query strings,
				// on every comparison.
				const tagTitleTier = (c: ScoredCandidate): number => titleTierById.get(c.id) ?? 0
				const runtimeCannotSeparate = withinRoundingNoise(a, b)
				if (trustedNarratorKeys.length) {
					const byNarrator = Number(narratorMatches(b)) - Number(narratorMatches(a))
					if (byNarrator !== 0) return byNarrator
					// Among editions that ALL match the requested narrator, the one
					// whose TITLE names that narrator is the purpose-built release:
					// a library holding both narrations of a book (measured live on
					// Harry Potter, 2026-07-27) needs its Stephen Fry copies on the
					// "(Narrated by Stephen Fry)" editions or both copies collide in
					// the plain series -- and without this arm the exact-title
					// tiebreak below actively PENALIZED the branding for not being
					// the tag's exact title. Same shape as the narrator arm: a
					// ranking signal only, and inert without a narrator hint, so
					// single-narration libraries never notice it.
					//
					// The window is WIDER than the rounding epsilon for this arm
					// alone (measured live on the Fry Order of the Phoenix,
					// 2026-07-28): two listings that BOTH match the hinted narrator
					// and BOTH corroborate the file are the same narration in
					// different releases, and their inter-listing gap (46s vs 286s
					// there -- credits and mastering, 240s apart) is not identity
					// evidence, so closest-runtime was seating the unbranded 2015
					// listing above the branded 2024 one the operator wants. The
					// 600s bound is what keeps the SAME-DAY lesson intact: a
					// branded edition 22.8 MINUTES off (1,368s) must still lose to
					// the byte-exact recording -- that class stays outside the
					// window and falls to the delta arm exactly as before.
					const aAbs =
						a.durationDeltaPct != null && a.audioSeconds
							? a.durationDeltaPct * a.audioSeconds
							: null
					const bAbs =
						b.durationDeltaPct != null && b.audioSeconds
							? b.durationDeltaPct * b.audioSeconds
							: null
					const sameNarrationWindow =
						narratorMatches(a) &&
						narratorMatches(b) &&
						aAbs != null &&
						bAbs != null &&
						aAbs <= NARRATOR_BRAND_MAX_DELTA_SECONDS &&
						bAbs <= NARRATOR_BRAND_MAX_DELTA_SECONDS
					if (runtimeCannotSeparate || sameNarrationWindow) {
						const byNarratorTitleTag =
							Number(titleNamesWantedNarrator(b)) - Number(titleNamesWantedNarrator(a))
						if (byNarratorTitleTag !== 0) return byNarratorTitleTag
					}
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
				if (aDelta != null && bDelta != null) {
					// Inside the rounding epsilon the delta is noise, so the
					// fuller form of the SAME name may jump it -- the Nevermoor
					// shelf (2026-07-27), where 3-24 seconds of OverDrive-vs-
					// Audible rounding was choosing between a full-title and a
					// short-title row for the identical recording.
					//
					// Then FALL THROUGH to the delta ordering either way. The
					// first cut returned early inside the epsilon, which deleted
					// closest-runtime ordering for every pair within 90s of each
					// other -- verified 2026-07-28: a 0s-off row lost to an
					// 88s-off row on provider order alone, and on works under
					// ~30 minutes 90s exceeds DURATION_TOLERANCE itself, killing
					// the arm outright. The epsilon licenses a preference; it
					// never discards the evidence underneath it.
					if (runtimeCannotSeparate && tieTitlePreference === 'fuller') {
						const byExtends = Number(prefersFullerTitle(b)) - Number(prefersFullerTitle(a))
						if (byExtends !== 0) return byExtends
					}
					// The symmetric leg: 'query' means TRUST THE TAGS -- inside the
					// rounding band prefer the row titled what the library calls
					// the book (measured live on Apex, 2026-07-28: the subtitled
					// listing won the band via 'fuller' while the operator's tag
					// is the bare form). Runtime evidence stays sovereign: this
					// only runs where the delta is provider-rounding noise.
					if (runtimeCannotSeparate && tieTitlePreference === 'query') {
						const byTagTitle = tagTitleTier(b) - tagTitleTier(a)
						if (byTagTitle !== 0) return byTagTitle
					}
					if (Math.abs(aDelta - bDelta) > 1e-9) {
						return aDelta - bDelta
					}
				}
				// Neither identity nor format separated them, so a residual gap inside
				// the tolerance decides after all — the band only ever lets the two
				// tiebreaks above jump a small deficit, it never discards confidence.
				if (Math.abs(byConfidence) > 1e-9) return byConfidence
				// Still tied: prefer the candidate whose TITLE IS what the library
				// calls the book. Providers title the SAME recording differently --
				// measured on Seth Ring's "Apex" (fresh scan, no duration signal):
				// Audible says "Apex: A Fantasy LitRPG Adventure", OverDrive says
				// "Apex" (same narrator), both scored 0.85, and provider order handed
				// the match to the marketing-subtitled row -- so the album displayed a
				// tail its five series siblings don't carry. Cosmetic-only by
				// construction: every identity tiebreak above (pin, language, audio,
				// narrator, runtime delta, residual confidence) has already declined
				// to decide, so this can only choose between rows the evidence cannot
				// tell apart.
				const byExactTitle = tagTitleTier(b) - tagTitleTier(a)
				if (byExactTitle !== 0) return byExactTitle
				// ABRIDGED loses to UNABRIDGED when nothing else can separate them.
				//
				// normalizeTitle strips "(Abridged)"/"(Unabridged)", so the two
				// editions of one book reduce to the SAME string and every arm above
				// — including byExactTitle — declines. With no duration signal they
				// were genuinely indistinguishable and the winner fell through to the
				// cosmetic arms below.
				//
				// That is the NORMAL state on a first scan: Plex matches before it
				// analyses, so `part.duration` is -1 and the bundle withholds the
				// hint by design (a partial sum would veto the CORRECT edition).
				// Measured on this library 2026-08-09 — four books sat on abridged
				// records at less than half the file's runtime: I Shall Wear Midnight
				// (707min file / 262min record), Hannibal (758/366), Fade (588/278),
				// Dirk Gently (479/181). Replaying them against the live API with a
				// duration hint put the unabridged edition first at 1.000; without
				// one, four candidates tied at 0.850.
				//
				// Deliberately BELOW every evidence arm (pin, language, volume,
				// audio, narrator, runtime, title) — an operator who owns the
				// abridged edition still wins on their sidecar pin or a known
				// duration. This only decides rows the evidence cannot, and it never
				// filters: an abridged edition stays offered and pickable.
				//
				// `undefined` (provider said nothing) must not beat a stated
				// unabridged, so only a POSITIVE abridged claim demotes.
				const byAbridged = Number(a.abridged === true) - Number(b.abridged === true)
				if (byAbridged !== 0) return byAbridged
				// Same normalized name, different DECORATION: prefer the title
				// closest to its own normalized form. Measured live 2026-08-07:
				// Hardcover community data held "Xanth 19 - Roc and a Hard Place"
				// and "Roc and a Hard Place" as sibling editions, tied at 0.850
				// with no asin/narrator/duration on either side; every arm above
				// declined, and the FINAL deterministic id key handed the win to
				// the folder-form junk -- which the operator then saw beat the
				// clean edition 85-84 in Fix Match (the bundle's score is
				// confidence-minus-index). Cosmetic-only by construction: it
				// runs after every identity arm has already declined, and it
				// deliberately does NOT merge the rows -- the operator rule
				// keeps edition variants pickable.
				const byDecoration = (decorationById.get(a.id) ?? 0) - (decorationById.get(b.id) ?? 0)
				if (byDecoration !== 0) return byDecoration
				// Genuinely tied: prefer the richer/more-authoritative source.
				const byProvider = providerRank(a) - providerRank(b)
				if (byProvider !== 0) return byProvider
				// Last call before the coin flip: prefer the edition the CALLER
				// NAMED. Measured on a live fresh scan (2026-08-01): of 342 books
				// whose sidecar named a B0 ASIN, 215 — 63% — matched to a different
				// record, and this is where they were lost. Nothing above had
				// declined for a *reason*: with no analyzed durations every
				// candidate ties at 0.85, and `providerRank` has no entry for
				// either `pinned` or `overdrive` so both take the `?? 9` default —
				// so the decision fell through to an arm documented as arbitrary.
				//
				// NOT `isPinned()`, deliberately: that returns false for the row
				// fetched BY this asin, which is the very row being seated here.
				// This is also why the arm sits at the BOTTOM rather than beside
				// `byPin` — a stale sidecar ASIN must still lose to any real
				// evidence, which is the whole reason the pin was denied privilege
				// upstream. It can only settle a tie that was about to be settled
				// by nothing at all.
				const namedByCaller = (c: ScoredCandidate): boolean =>
					wantAsin != null && c.asin?.toUpperCase() === wantAsin
				const byNamedAsin = Number(namedByCaller(b)) - Number(namedByCaller(a))
				if (byNamedAsin !== 0) return byNamedAsin
				// Same provider (or same rank) too: fall to intrinsic identity, so
				// the sort is a TOTAL order. A stable sort's fallthrough is arrival
				// order — registry order times each provider's own API order — which
				// flips whenever a cache expires or a provider times out; that was
				// the residual ~5% of tops that drifted between full-library runs.
				// The pair this decides is one the evidence cannot tell apart, so
				// WHICH one wins is arbitrary; that it is ALWAYS the same one is the
				// point.
				return byCandidateIdentity(a, b)
			})
		)
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

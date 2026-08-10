import type { ApiGenre } from '#config/types'
import { AUDIBLE_VOCABULARY } from '#helpers/providers/audibleVocabulary'

/**
 * Shelf-noise rules for COMMUNITY genre feeds (Hardcover cached_tags, Chaptarr
 * work genres), and the fold that lets those feeds be merged into a record that
 * already has Audible's own categories without restating them.
 *
 * WHY THIS EXISTS. Until now the community backfill only ran on books with NO
 * genres at all — measured 2026-08-09 that was 2 of 1,758 cached books, so the
 * leg was structurally starved. Merging instead of filling makes it useful, but
 * only if the raw feed is cleaned first: sampled live against 14 real books,
 * Chaptarr returned 69 genuinely new names and, alongside them, every one of
 * these:
 *
 *   "Ebooks"                                        a format, not a genre
 *   "Fiction / Fantasy / General"                   a BISAC path
 *   "Epic; Action & Adventure; Dark Fantasy; ..."   FOUR genres in one string
 *   "Colecção Suspense"                             a Portuguese collection
 *   "Intercontinental ballistic missiles"           a subject heading
 *   "Harry Potter"                                  the series as a genre
 *   "dragons"                                       casing
 *   "Fantasy fiction" beside Audible's "Fantasy"    near-duplicate
 *   "Anthologies" AND "Anthology" on the same book  near-duplicate
 *
 * The existing cleanGenreName/alias/dedupe chain caught none of them: it folds
 * case and emoji, which is why "Science Fiction" vs "Science fiction" already
 * collapses, but nothing above differs only by case.
 */

/**
 * The book a genre feed is being mapped for. Only what the self-reference rule
 * needs — a shelf named after the book or its series is not a genre.
 */
export interface GenreContext {
	title?: string | null
	series?: string | null
}

/**
 * Shelves that are never a genre: format, provenance, and reading-status
 * vocabulary. Goodreads shelves are user-authored, so these arrive constantly.
 *
 * A Set of already-folded keys — membership is tested against dedupeKey(), so
 * "Ebooks", "ebook" and "E-Books" all land on the same entry.
 */
const NOISE_SHELVES = new Set([
	'ebook',
	'audiobook',
	'audio',
	'book',
	'kindle',
	'paperback',
	'hardcover',
	'hardback',
	'library',
	'owned',
	'series',
	'novel',
	'fiction genre',
	'tbr',
	'to read',
	'toread',
	'currently reading',
	'favorite',
	'favourite',
	'wishlist',
	'unfinished',
	'dnf',
	'default',
	'general',
	'unknown'
])

/** Longest a real genre name runs. "Intercontinental ballistic missiles" (35)
 * is a subject heading; "Mystery, Thriller & Suspense" (28) is a real Audible
 * category, so the line sits above one and below the other. */
const MAX_NAME_LENGTH = 30

/** Most words a real genre carries, ignoring conjunctions. "Science Fiction &
 * Fantasy" is three; "Growing Up & Facts of Life" is five and is shelf prose. */
const MAX_WORDS = 3

/** Conjunctions that pad a compound category without adding a word of meaning. */
const CONNECTORS = new Set(['and', '&', 'of', 'the'])

/**
 * Split a shelf that is really several genres joined together.
 *
 * Semicolon, slash, pipe and colon — all four measured across the full library
 * 2026-08-09 ("Epic; Action & Adventure; ...", "Fiction / Fantasy / General",
 * "Literature & Fiction|Mystery", "Literature & Fiction:Classics").
 *
 * Commas are deliberately NOT split on: real categories contain them
 * ("Mystery, Thriller & Suspense"), the same reason the bundle refuses to split
 * the files' own ©gen tags.
 * @param {string} name a raw shelf name
 * @returns {string[]} one or more names, never empty unless the input was
 */
export function splitJoinedShelf(name: string): string[] {
	return name
		.split(/[;/|:]/)
		.map((part) => part.trim())
		.filter(Boolean)
}

/**
 * The key two genre names share when they mean the same thing.
 *
 * Case, punctuation and English plurals, including -ies ("Anthologies" =
 * "Anthology", "childrens" = "Children").
 *
 * A TRAILING " fiction" IS DELIBERATELY NOT STRIPPED HERE. It was, and it was
 * wrong: "Science Fiction" folded to "science", colliding a major genre with
 * the unrelated "Science" — caught by the existing suite 2026-08-09. The
 * "X fiction"/"X" pairs that genuinely mean the same thing are named
 * explicitly in the canonical table instead, where each one is a collision the
 * full-library diff actually produced rather than a guess from a pattern.
 *
 * DISPLAY names are never rewritten by this — it is a comparison key only.
 * @param {string} name a cleaned genre name
 * @returns {string} the comparison key
 */
export function dedupeKey(name: string): string {
	let k = name
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	if (k.endsWith('ies') && k.length > 4) k = `${k.slice(0, -3)}y`
	else if (k.endsWith('es') && k.length > 4) k = k.slice(0, -2)
	else if (k.endsWith('s') && k.length > 3) k = k.slice(0, -1)
	return k
}

/**
 * Whether a community shelf should be discarded rather than shown.
 *
 * Non-ASCII letters are the tell for a foreign-language shelf ("Colecção
 * Suspense"): this library is English, and a Portuguese collection name is
 * never the genre a reader is looking for. Cheap, and it costs nothing real —
 * no English genre name needs a character outside ASCII.
 * @param {string} name a cleaned, already-split genre name
 * @returns {boolean} true when the name is noise
 */
export function isNoiseShelf(name: string): boolean {
	if (!name) return true
	if (name.length > MAX_NAME_LENGTH) return true
	if (/[^\x20-\x7E]/.test(name)) return true
	// Pure numbers and decades ("1980s", "2015") are shelving, not genre.
	if (/^\d{2,4}s?$/.test(name.trim())) return true
	// A YEAR anywhere is a reading list, not a genre ("Read Next 2024").
	if (/\b(19|20)\d{2}\b/.test(name)) return true
	// A PARENTHETICAL qualifier is a catalogue entity, never a genre:
	// "Frodo (Fictitious character)", "Discworld (Imaginary place)",
	// "Belfast (Northern Ireland)", "Adirondack Mountains (N.Y.)".
	if (/[()]/.test(name)) return true
	// The word "and" spelled out marks a Library-of-Congress subject heading
	// ("Detective and mystery stories", "Free will and determinism",
	// "Imaginary wars and battles"). Real shelf genres use an ampersand
	// ("Science Fiction & Fantasy", "Mystery, Thriller & Suspense"), so this
	// separates the two vocabularies cleanly. Measured across all 1,758 books.
	if (/\sand\s/i.test(name)) return true
	// LCSH format headings: "Chinese language materials".
	if (/\smaterials$/i.test(name)) return true
	const words = name
		.split(/\s+/)
		.filter((w) => !CONNECTORS.has(w.toLowerCase().replace(/[^a-z&]/g, '')))
	if (words.length > MAX_WORDS) return true
	return NOISE_SHELVES.has(dedupeKey(name))
}

/**
 * ONE canonical spelling per genre, so the library's tag list does not carry
 * the same genre twice under two names.
 *
 * Within a book dedupeKey already collapses these, but ACROSS books nothing
 * did: the full-library diff (2026-08-09) found 20 keys reached by two or three
 * spellings — "Fantasy" on one book and "Fantasy fiction" on another, "Thriller"
 * beside "Thrillers" — which Plex's genre filter would list as separate tags.
 * That is the duplicate information this whole layer exists to prevent, one
 * level up from where it was being looked for.
 *
 * Keyed by dedupeKey. Where Audible has its own name for the genre that name
 * wins, because Audible's vocabulary is the house standard and its entries are
 * never rewritten by the merge; the rest take the form that reads best. Every
 * entry here is a collision the diff actually produced — this is not a
 * speculative synonym table.
 */
const CANONICAL_NAMES = new Map<string, string>([
	// EXTRAS FIRST, Audible LAST — a Map keeps the last value for a repeated
	// key, so this ordering is what makes Audible authoritative. With the extras
	// last they silently overrode it, which would have merged Audible's own
	// "Historical" and "Historical Fiction" into one genre.
	//
	// Only keys Audible has NO entry for can take effect here. Each is a
	// collision the full-library diff produced; the "X fiction" pairs are listed
	// one by one on purpose, because deriving them from a pattern is exactly
	// what broke "Science Fiction" into "science".
	['fantasy fiction', 'Fantasy'],
	['childrens fantasy fiction', 'Fantasy'],
	['american fiction', 'American'],
	['apocalyptic fiction', 'Apocalyptic'],
	['military fiction', 'Military'],
	['english fiction', 'English'],
	['adventure story', 'Adventure'],
	['literature', 'Literature & Fiction'],
	['children', 'Children'],
	['american', 'American'],
	['thriller', 'Thriller'],
	['apocalyptic', 'Apocalyptic'],
	['juvenile', 'Juvenile Fiction'],
	['christian', 'Christian Fiction'],
	['english', 'English'],
	['comics graphic novel', 'Comics & Graphic Novels'],
	['graphic novel', 'Graphic Novels'],
	['art', 'Art'],
	['craft', 'Crafts'],
	...AUDIBLE_VOCABULARY
])

/**
 * The one spelling this genre is shown under, given its fold key.
 * @param {string} key a dedupeKey
 * @returns {string | null} the canonical display name, or null when unlisted
 */
export function canonicalName(key: string): string | null {
	return CANONICAL_NAMES.get(key) ?? null
}

/**
 * The key a genre is deduped under once its canonical spelling is applied.
 *
 * dedupeKey alone is not enough at the merge: "Fantasy fiction" and "Fantasy"
 * key differently (deliberately — see dedupeKey), and only the canonical table
 * knows they are the same genre. Folding through that table here means the
 * merge behaves identically whether it is handed raw community names or names
 * the mapper has already canonicalised.
 * @param {string} name any genre name
 * @returns {string} the key to dedupe on
 */
export function foldKey(name: string): string {
	const key = dedupeKey(name)
	const canonical = CANONICAL_NAMES.get(key)
	return canonical ? dedupeKey(canonical) : key
}

/**
 * Title-case a name that arrived entirely lowercase ("dragons" -> "Dragons").
 *
 * Only that case. A name with any capital is left exactly as its source wrote
 * it, so "iRobot", "YA" and "Sci-Fi" survive untouched.
 * @param {string} name a cleaned genre name
 * @returns {string} the display form
 */
export function normalizeDisplay(name: string): string {
	if (name !== name.toLowerCase()) return name
	return name.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

/**
 * Names that restate the book itself rather than describe it.
 *
 * "Harry Potter" is shelved as a genre on its own books. The book's own title
 * and series are the one reliable way to recognise that, and they are already
 * in hand at merge time.
 * @param {string} name a cleaned genre name
 * @param {{ title?: string | null; series?: string | null }} ctx the book
 * @returns {boolean} true when the name is the book restating itself
 */
export function isSelfReference(name: string, ctx: GenreContext): boolean {
	const key = dedupeKey(name)
	if (!key) return false
	for (const raw of [ctx.title, ctx.series]) {
		if (!raw) continue
		const subject = dedupeKey(raw)
		if (!subject) continue
		if (subject === key) return true
		// A series shelf is usually the series name alone, so a containment test
		// on WORD boundaries catches "Harry Potter" under "Harry Potter and the
		// Goblet of Fire" without matching a one-word genre inside a long title.
		if (key.includes(' ') && subject.includes(key)) return true
	}
	return false
}

/**
 * Most genres a merged record carries. Audible alone can supply nine, so this
 * is a ceiling on the total rather than a budget for the community half.
 */
export const MAX_MERGED_GENRES = 10

/**
 * Append community genres to the record's own, keeping only what is new.
 *
 * `existing` is Audible's, and it is AUTHORITATIVE: every entry survives, in
 * its original order, with its original id — the bundle replaces the album's
 * genres wholesale from this list, so re-ordering it would churn the tags on
 * every refresh for no gain. Incoming names that fold onto something already
 * present are dropped, which is what stops "Fantasy fiction" landing beside
 * "Fantasy".
 * @param {ApiGenre[]} existing the record's own genres, kept verbatim
 * @param {ApiGenre[]} incoming normalized community genres, in source order
 * @returns {ApiGenre[]} existing followed by the genuinely new, capped
 */
export function mergeGenres(existing: ApiGenre[], incoming: ApiGenre[]): ApiGenre[] {
	const out = [...existing]
	const seen = new Set(existing.map((g) => foldKey(g.name)))
	for (const genre of incoming) {
		if (out.length >= MAX_MERGED_GENRES) break
		const key = foldKey(genre.name)
		if (!key || seen.has(key)) continue
		seen.add(key)
		out.push(genre)
	}
	return out
}

/**
 * Read a provider's abridgement statement into the candidate's `abridged` flag.
 *
 * One implementation, shared, because two providers state it in different
 * vocabularies (Audible's `format_type`, Apple's title suffix) and a per-caller
 * `=== 'abridged'` would drift the moment a third arrives — the exact shape that
 * cost this repo the series fold and the touchUpdatedAt bug on 2026-08-08.
 *
 * The three-state return is load-bearing. `undefined` means the provider said
 * NOTHING, which must never be read as "unabridged": most providers carry no
 * flag at all, and treating silence as a positive claim would let a
 * no-signal row outrank a genuinely-unabridged one in the tiebreak.
 * @param {string | null | undefined} value the provider's raw statement
 * @returns {boolean | undefined} true = abridged, false = unabridged, undefined = unstated
 */
export function abridgedFrom(value: string | null | undefined): boolean | undefined {
	if (typeof value !== 'string') return undefined
	const v = value.trim().toLowerCase()
	if (!v) return undefined
	// Check UNabridged first: "unabridged" contains "abridged" as a substring, so
	// the obvious `v.includes('abridged')` ordering gets every unabridged edition
	// exactly backwards.
	if (v === 'unabridged' || v.includes('unabridged')) return false
	if (v === 'abridged' || v.includes('abridged')) return true
	return undefined
}

/** Apple states abridgement as a title suffix: "Some Book (Unabridged)". */
const APPLE_SUFFIX_RE = /\((un)?abridged\)\s*$/i

/**
 * Apple Books' abridgement, read from the title suffix it appends.
 *
 * `cleanAppleTitle` strips this suffix before scoring, so the signal has to be
 * captured BEFORE that call or it is gone.
 * @param {string | null | undefined} rawTitle the provider's untrimmed title
 * @returns {boolean | undefined} true = abridged, false = unabridged, undefined = unstated
 */
export function abridgedFromTitleSuffix(rawTitle: string | null | undefined): boolean | undefined {
	if (typeof rawTitle !== 'string') return undefined
	const m = APPLE_SUFFIX_RE.exec(rawTitle)
	if (!m) return undefined
	return !m[1]
}

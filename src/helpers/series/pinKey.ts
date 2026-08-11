/**
 * The portable identity of a book, shared by the pin GENERATOR and the pin
 * LOOKUP.
 *
 * Its own module on purpose. scripts/mintPins.ts writes shelfPins.data.ts and
 * shelfPins.ts reads it, so a key function living in either one makes the
 * generator import the file it is about to generate. More importantly, the two
 * sides must never drift: a generator that folds a title one way and a lookup
 * that folds it another produces a table that is silently unreachable, which is
 * exactly the failure mode being fixed here and would be invisible in tests
 * that use hand-written pins.
 */
import { foldSeriesName } from '#helpers/providers/goodreadsSeries'
import { foldDiacritics } from '#helpers/utils/foldDiacritics'

/**
 * The edition qualifier providers bolt onto a title. Two libraries that matched
 * the same collection independently routinely disagree on it, and it never
 * distinguishes two different books. Same rule the bundle applies to the sort
 * title (v1.3.200/201) and the resolver applies to the mirror query.
 */
const EDITION_QUALIFIER = /[\s:;,–—-]*[([]?(un)?abridged[)\]]?\s*$/i
/**
 * A generational or post-nominal suffix. "Kurt Vonnegut Jr" and "Kurt Vonnegut"
 * are one person — the same tolerance the bundle's author confirmation uses
 * (v1.3.204), added after Slaughterhouse-Five failed to auto-confirm.
 */
const NAME_SUFFIX = /[\s,]+(?:jr|jnr|sr|snr|ii|iii|iv|v|phd|md|esq)\.?\s*$/i

const flatten = (value: string): string =>
	foldDiacritics(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '')

/**
 * A folded (title, author) key.
 *
 * WHY THIS EXISTS: a pin is keyed on the matched EDITION id, and two libraries
 * that matched the same collection independently agree on only 58% of those.
 * The shipped table therefore serves one library and not the other — 90/90 on
 * .99, 49/90 on .98 — and for anyone else installing Incipit it starts near
 * zero. Re-binding the dead 41 would not fix them, it would FLIP them. The
 * table is not merely narrow, it is unshareable, and that is the difference
 * between operator decisions being a personal fix and being a feature.
 *
 * Deliberately NOT foldSeriesName: that folds a leading article, which is right
 * for a SERIES name ("The Riyria Chronicles" is one shelf under either
 * spelling) and wrong for a TITLE, where "The Stand" and "Stand" are different
 * books.
 *
 * Returns '' when either half is missing. A key with an empty side would match
 * every other book missing the same half, so callers MUST treat '' as "no key"
 * rather than as a lookup value.
 * @param {string | null | undefined} title the book title, before any pin rewrites it
 * @param {string | null | undefined} author one author's name
 * @returns {string} the folded key, or '' when it cannot be formed
 */
export function pinKey(
	title: string | null | undefined,
	author: string | null | undefined
): string {
	if (!title || !author) return ''
	const t = flatten(String(title).replace(EDITION_QUALIFIER, ''))
	const a = flatten(String(author).replace(NAME_SUFFIX, ''))
	return t && a ? `${t}|${a}` : ''
}

/**
 * The extra key a pin may be filed under when its title BAKES ITS OWN SERIES IN.
 *
 * Some records carry the series inside the title — "Gauntlgrym: Legend of
 * Drizzt", "Night of the Hunter: Legend of Drizzt: Companions Codex" — while
 * another library matched the same book to an edition titled plainly
 * ("Gauntlgrym"). Measured on prod 2026-08-11, that is five of the six pins the
 * (title, author) key still could not reach.
 *
 * A blanket "cut at the first colon" fallback fixes those and is WRONG: for a
 * `Series: Volume` title it cuts away the part that identifies the book.
 * Measured, it collapses "Ahriman: Sorcerer" #2, "Ahriman: Unchanged" #3 and
 * "Ahriman: Undying" #5 onto one key, three pins claiming it, and the correctly
 * unpinned #5 collecting whichever won.
 *
 * The two shapes are distinguishable, so this rule fires only on the first:
 * the series name must appear as a LATER colon-segment, never the leading one.
 * "Ahriman: Sorcerer" has its series first and is left alone; "Gauntlgrym:
 * Legend of Drizzt" does not, and keys additionally as "Gauntlgrym".
 *
 * Mint-time only, deliberately — the lookup stays a plain table hit, and
 * mintPins' collision gate is what proves the extra key is unambiguous.
 * @param {string | null | undefined} title the record's title
 * @param {string | null | undefined} author one author's name
 * @param {string | null | undefined} series the series the pin states
 * @returns {string[]} extra keys, or empty when the shape does not apply
 */
export function pinKeyAliases(
	title: string | null | undefined,
	author: string | null | undefined,
	series: string | null | undefined
): string[] {
	if (!title || !author || !series) return []
	const segments = String(title).split(':')
	if (segments.length < 2) return []
	const want = foldSeriesName(String(series))
	const bakedInLater = segments.slice(1).some((s) => s.trim() && foldSeriesName(s) === want)
	if (!bakedInLater) return []
	const head = pinKey(segments[0], author)
	return head && head !== pinKey(title, author) ? [head] : []
}

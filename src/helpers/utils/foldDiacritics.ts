const COMBINING_MARKS = /[̀-ͯ]/g

/**
 * Fold combining diacritical marks off a string: "Brontë" -> "Bronte",
 * "bokmål" -> "bokmal", "Muñoz" -> "Munoz".
 *
 * NFD decomposes a precomposed letter into its base + combining mark(s), then we
 * strip the marks (Unicode block U+0300-U+036F). This is the standard, cheap
 * fold used across entity resolution; it is an EXACT IDENTITY on pure-ASCII
 * input, so applying it upstream of an ASCII-only normalizer never changes an
 * ASCII result -- only rescues an accented one.
 *
 * Limitation: it only folds marks that NFD separates. Latin letters that carry
 * their stroke intrinsically (o-slash, l-stroke, d-stroke, eszett) do not
 * decompose and pass through unchanged -- acceptable, since the common
 * author/title case is combining accents (e-acute, n-tilde, u-umlaut, a-ring),
 * and this is strictly better than dropping them.
 * @param {string} s the input string
 * @returns {string} the string with combining diacritical marks removed
 */
export function foldDiacritics(s: string): string {
	return s.normalize('NFD').replace(COMBINING_MARKS, '')
}

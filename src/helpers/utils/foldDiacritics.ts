// The Combining Diacritical Marks block, U+0300..U+036F. Built from code points
// rather than written as literal marks in the source, so the character class
// stays ASCII-visible and corruption-proof: a literal combining mark renders
// invisibly onto the adjacent bracket and can be silently dropped by an editor.
const COMBINING_MARKS = new RegExp(
	'[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']',
	'g'
)

/**
 * Fold combining diacritical marks off a string: e.g. an e-acute becomes "e",
 * an a-ring becomes "a", an n-tilde becomes "n".
 *
 * NFD decomposes a precomposed letter into its base + combining mark(s), then we
 * strip the marks. This is the standard, cheap fold used across entity
 * resolution; it is an EXACT IDENTITY on pure-ASCII input, so applying it
 * upstream of an ASCII-only normalizer never changes an ASCII result -- only
 * rescues an accented one.
 *
 * Limitation: it only folds marks that NFD separates. Latin letters that carry
 * their stroke intrinsically (o-slash, l-stroke, d-stroke, eszett) do not
 * decompose and pass through unchanged -- acceptable, since the common
 * author/title case is combining accents, and this is strictly better than
 * dropping the accented letter outright.
 * @param {string} s the input string
 * @returns {string} the string with combining diacritical marks removed
 */
export function foldDiacritics(s: string): string {
	return s.normalize('NFD').replace(COMBINING_MARKS, '')
}

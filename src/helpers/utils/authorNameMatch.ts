import { sim } from '#helpers/providers/matchScorer'

const TOKEN_FLOOR = 0.85
const FULL_NAME_FLOOR = 0.9

/**
 * Whether two author names denote the SAME person — the false-positive gate for
 * any fuzzy author lookup (the Mongo $text author cache, Hardcover's author
 * search()).
 *
 * A fuzzy match ranks by relevance, not identity: "$text" is a loose OR over
 * tokens, and Hardcover's search() likewise surfaces near-name authors, so a
 * shared FIRST name ("Andrew Karevik" -> "Andrew Rowe", "Jessica Townsend" ->
 * "Jessica Day George") or a shared SURNAME ("John Smith" -> "Jane Smith") lifts
 * the overall similarity over any single threshold (~0.72). Require the name to
 * be near-identical OR to match on BOTH first and last token, so neither a shared
 * first name nor a shared surname alone is enough to accept a candidate.
 * @param {string} query the searched name
 * @param {string} candidate the candidate author name
 * @returns {boolean} true only when they are confidently the same person
 */
export function isSameAuthor(query: string, candidate: string): boolean {
	if (sim(query, candidate) >= FULL_NAME_FLOOR) return true
	const toks = (s: string) => s.trim().toLowerCase().split(/\s+/).filter(Boolean)
	const q = toks(query)
	const c = toks(candidate)
	if (!q.length || !c.length) return false
	const firstOk = sim(q[0], c[0]) >= TOKEN_FLOOR
	const lastOk = sim(q[q.length - 1], c[c.length - 1]) >= TOKEN_FLOOR
	return firstOk && lastOk
}

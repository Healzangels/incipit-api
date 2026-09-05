/**
 * Parallel listings: the Goodreads series that are RE-LISTINGS of another
 * candidate (a translation, a split-volume renumbering) rather than a shelf of
 * their own. They compete in the ranking with large member counts and no name
 * tell, and they are what an umbrella demotion EXPOSES -- with `The Realm of the
 * Elderlings` out of the pool, `L'Assassin royal` (25 members) beats `The Farseer
 * Trilogy` (7). Measured 2026-08-18 and again 2026-09-05; see
 * docs/design/spec-shelf-granularity.md §6.3.
 *
 * The librarians annotate re-listings with hrefs, and the href carries the id, so
 * matching on ids is exact: no orthography, no language guessing. What matters is
 * DIRECTION -- "X is a re-listing of me" versus "X is a related series" -- and the
 * text around the link is the only thing that encodes it. Three phrasings carry
 * the re-listing direction, measured on the live descriptions:
 *
 *   "Also known as:"                        (heading; block of names/links)
 *   "Editions with different numbering:"    (heading; block of links)
 *   "... under the name: <a href=.../series/NNNN>"   (phrase; ONE link)
 *
 * The phrase form is anchored to the link IMMEDIATELY after it, because the
 * sentence that carries it also names a legitimate sibling: Farseer's description
 * reads "combined with the <Tawny Man> trilogy in French under the name:
 * <L'assassin royal>". Taking every link in that block would deny Tawny Man.
 *
 * The naive alternative -- deny every series any candidate links -- is REFUTED:
 * parents and children link EACH OTHER (Legend of Drizzt lists Legacy of the Drow
 * as an arc; Legacy of the Drow says "part of the larger Legend of Drizzt"), so it
 * denies both and hands Siege of Darkness to a 301-member publication ordering.
 * Dry-run over the 2026-09-05 probe set: this extraction denied 0 expected
 * shelves; the naive form denied Farseer, Legend of Drizzt and Malazan.
 */

/** Section headings whose following block lists re-listings of this series. */
export const PARALLEL_LISTING_HEADINGS: readonly RegExp[] = [
	/also\s+known\s+as\s*:?/i,
	/editions?\s+with\s+(?:a\s+)?different\s+numbering\s*:?/i
]

/**
 * A re-listing named inline: the link IMMEDIATELY after "under the name:".
 * Global, so a description that says it twice yields both. Inline tags between
 * the colon and the anchor (an <i>, a <b>) are stepped over. The stepper needs
 * no anchor guard: a real anchor carries text, and text stops the step, so the
 * first anchor is always the one taken -- a guard was measured redundant
 * (mutation survived) and removed.
 */
export const PARALLEL_LISTING_PHRASE =
	/under\s+the\s+(?:name|title)s?\s*:?\s*(?:<[^>]+>\s*)*<a\b[^>]*\/series\/(\d+)/gi

/**
 * The series ids a description declares as re-listings of itself, or [].
 *
 * Heading blocks end at the first blank-ish line, exactly as linkedSeriesIdsUnder
 * does, so a later paragraph's incidental link cannot join the list.
 * @param {string | null | undefined} description the /series record's Description
 * @returns {number[]} the linked Goodreads series ids, de-duplicated, in order found
 */
export function parallelListingIds(description: string | null | undefined): number[] {
	if (!description) return []
	const ids = new Set<number>()
	for (const heading of PARALLEL_LISTING_HEADINGS) {
		const match = heading.exec(description)
		if (!match) continue
		const block = description.slice(match.index + match[0].length).split(/\n\s*\n/)[0] ?? ''
		for (const hit of block.matchAll(/\/series\/(\d+)/g)) ids.add(Number(hit[1]))
	}
	for (const hit of description.matchAll(PARALLEL_LISTING_PHRASE)) ids.add(Number(hit[1]))
	return [...ids]
}

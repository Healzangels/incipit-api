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

import { foldDiacritics } from '#helpers/utils/foldDiacritics'

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
	return parallelListings(description).ids
}

/**
 * The NAMES of those same re-listings, folded with foldListingName, or [].
 *
 * Goodreads duplicates translated listings and the librarians link one of them;
 * the href slug ("65016-o-regresso-do-assassino") and the anchor text both carry
 * the name, so a candidate under a DIFFERENT id but the same name is still the
 * re-listing the description declares. Both sources are read: a slug can be
 * truncated, an anchor can be styled.
 * @param {string | null | undefined} description the /series record's Description
 * @returns {string[]} folded names, de-duplicated, in order found
 */
export function parallelListingNames(description: string | null | undefined): string[] {
	return parallelListings(description).names
}

/**
 * One fold for both sides of the name comparison: NFD, strip combining marks,
 * lowercase, and reduce everything that is not a letter or digit to a single
 * space. A slug's hyphens, an anchor's apostrophes and a Title's diacritics all
 * collapse to the same string ("l-assassin-royal" == "L'Assassin royal").
 * @param {string} name a series title, slug or anchor text
 * @returns {string} the folded name
 */
export function foldListingName(name: string): string {
	return foldDiacritics(name)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
}

/** A link's id and every name it carries: the slug after the id, and the anchor text. */
const LINK_RE = /\/series\/(\d+)(?:-([a-z0-9-]+))?[^>]*>([^<]*)</gi

function parallelListings(description: string | null | undefined): {
	ids: number[]
	names: string[]
} {
	if (!description) return { ids: [], names: [] }
	const ids = new Set<number>()
	const names = new Set<string>()
	const take = (text: string) => {
		for (const hit of text.matchAll(LINK_RE)) {
			ids.add(Number(hit[1]))
			for (const raw of [hit[2], hit[3]]) {
				const folded = raw ? foldListingName(raw) : ''
				if (folded) names.add(folded)
			}
		}
	}
	for (const heading of PARALLEL_LISTING_HEADINGS) {
		const match = heading.exec(description)
		if (!match) continue
		take(description.slice(match.index + match[0].length).split(/\n\s*\n/)[0] ?? '')
	}
	// The phrase form: the anchored link only. PARALLEL_LISTING_PHRASE yields the
	// id; re-scan from the phrase for the slug and anchor of that same link.
	for (const hit of description.matchAll(PARALLEL_LISTING_PHRASE)) {
		ids.add(Number(hit[1]))
		const from = description.slice(hit.index ?? 0)
		const link = from.match(LINK_RE)
		if (link) take(link[0])
	}
	return { ids: [...ids], names: [...names] }
}

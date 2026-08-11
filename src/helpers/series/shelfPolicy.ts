/**
 * Q2 shelf policy — the first pure module of the series-authority core.
 *
 * Operator decision 2026-07-30 (tests/fixtures/series-decisions.json):
 * a POSITIONLESS primary never ships as the shelf. The bundle composes the
 * sort title from name+position, so a positionless primary was never a shelf
 * anyway — it was a half-answer that blocked the folder fallback's number,
 * shipped junk names ("Warhammer 40,000") to the mood layer, and hid a real,
 * POSITIONED secondary behind it (Baneblade: primary "Warhammer 40,000" with
 * no position, secondary "Warhammer 40,000 : Imperial Guard" #1).
 *
 * The policy, in order:
 *   1. A positioned secondary is PROMOTED to primary.
 *   2. A vacated real sub-series name demotes to the tag (secondary) slot.
 *   3. A cross-author franchise CONTAINER name is dropped entirely — under the
 *      split policy it is not even a tag.
 *   4. The two slots may never hold the same series (the fb058d2 class).
 *
 * Applied at SERVE time (the route's finish wrapper), deliberately: the
 * Goodreads redis cache stores pre-policy answers, so warm week-old entries
 * obey the policy too and no cache invalidation rides along with it (P3).
 *
 * Container membership is folded-EXACT, never substring (R5: "The Xenos:
 * Warhammer 40,000" contains a container name and is not one). The list is
 * deliberately tiny and reviewable; classification-as-data (C2/C3) grows it.
 */
import {
	foldSeriesName,
	isShelvablePosition,
	sameSeriesName
} from '#helpers/providers/goodreadsSeries'

interface ShelfSeries {
	name?: string
	position?: string | null
	asin?: string
}
// seriesSecondary is `unknown` at the route boundary, so the policy narrows it
// at runtime instead of forcing every caller to re-type it.
interface ShelfBook {
	seriesPrimary?: ShelfSeries | null
	seriesSecondary?: unknown
}

const asSeries = (v: unknown): ShelfSeries | undefined => {
	if (!v || typeof v !== 'object') return undefined
	const s = v as { name?: unknown }
	return typeof s.name === 'string' && s.name ? (v as ShelfSeries) : undefined
}

/**
 * Cross-author franchise containers: never a shelf, and under the operator's
 * split policy never a tag either. Folded with foldSeriesName. Kept in sync
 * with the operator-reviewed tag policy in tests/fixtures/series-decisions.json.
 */
export const CONTAINER_SHELF_NAMES: ReadonlySet<string> = new Set([
	'warhammer 40,000',
	'cosmere',
	'cosmere universe',
	'jack ryan universe',
	// Added 2026-08-11 on the same test as the four above, measured rather than
	// judged: each shelves ZERO albums of its own while the sub-series it
	// umbrellas shelves 3, 6 and 4. Every one of them was reaching the shelf as
	// a resolver PRIMARY with the real sub-series stranded in the tag slot, and
	// the operator had answered all twelve by hand with a pin apiece. Naming
	// them lets the promote arm below do it generically: A/B over the golden
	// corpus, 12 of those pins become redundant, 0 unpinned rows move, 0 break.
	// This is the difference between a per-book pin and a rule another library
	// inherits for free.
	//
	// HOLLY GIBNEY IS DELIBERATELY ABSENT and must stay so. It reads like the
	// same shape — it umbrellas Bill Hodges — but it shelves FOUR albums of its
	// own (The Outsider, If It Bleeds, Holly, Never Flinch). Classifying it here
	// would strip their shelf entirely. Shelving zero albums is the test;
	// "sounds like a franchise" is not.
	'halo',
	'camp half-blood chronicles',
	'eisenhorn/ravenor/bequin'
])

/**
 * Whether a name is a franchise container. Exported for shelfPins, which must
 * not re-seat one into the tag slot it just vacated.
 * @param {string | null | undefined} name the series name
 * @returns {boolean} true when the name is a container
 */
export const isContainer = (name: string | null | undefined): boolean =>
	Boolean(name) && CONTAINER_SHELF_NAMES.has(foldSeriesName(String(name)))

/**
 * SPLIT SHELVES: one series carrying two spellings, so part of it sorts away
 * from the rest.
 *
 * The sort title is composed from the shelf NAME plus the position, so two
 * spellings of one series are two shelves: "Hannibal Lecter Series, Book 3"
 * files nowhere near "Hannibal Lecter, Book 1". The book is correctly matched
 * and correctly numbered and still out of order, which is the failure mode that
 * costs the most trust.
 *
 * Censused across the whole library 2026-08-11 (1,456 albums carrying a
 * "<shelf>, Book N - <title>" sort title): NINE series split, SIXTEEN albums
 * sorting away from their own siblings. Each entry below is one of them, keyed
 * on the MINORITY spelling and mapped to the one its siblings already use.
 *
 * Deliberately a curated table rather than a rule that strips "Series"/
 * "Trilogy"/parentheticals. Measured, that rule is wrong twice over: it would
 * merge "Riyria Chronicles" with the genuinely separate "Riyria Revelations",
 * and Isaac Asimov's majority spelling is the QUALIFIED one ("Foundation
 * (Chronological Order)" 3 albums vs "Foundation" 1) so majority-wins picks the
 * name that should not survive. Only the VARIANT is rewritten, never the
 * canonical name, so a same-named series by another author is untouched.
 *
 * HARRY POTTER IS DELIBERATELY ABSENT. Its 7/7 split is not damage: the
 * library holds the Jim Dale AND Stephen Fry narrations, and "Harry Potter
 * (Narrated by Stephen Fry)" is what keeps two complete readings from
 * interleaving on one shelf. A balanced split is an operator choice; a lone
 * straggler is a defect. Do not "fix" it.
 */
export const SERIES_ALIASES: ReadonlyMap<string, string> = new Map([
	['mitch rapp (abridged)', 'Mitch Rapp'],
	['chronicles of narnia (publication order)', 'Chronicles of Narnia'],
	['riyria', 'Riyria Chronicles'],
	['foundation (chronological order)', 'Foundation'],
	['hannibal lecter series', 'Hannibal Lecter'],
	['dragon king', 'Dragon King Trilogy'],
	['jack ryan jr. novel', 'Jack Ryan, Jr.'],
	['lighthouse trilogy', 'Lighthouse']
])

/**
 * The canonical spelling for a shelf name, or the name unchanged.
 * @param {string | null | undefined} name the series name as the provider gave it
 * @returns {string | null | undefined} the canonical spelling
 */
export function canonicalShelfName<T extends string | null | undefined>(name: T): T | string {
	if (!name) return name
	return SERIES_ALIASES.get(foldSeriesName(String(name))) ?? name
}

/** A series with its name canonicalised, or the same object when nothing moves. */
const canonicalised = (s: ShelfSeries | undefined): ShelfSeries | undefined => {
	if (!s?.name) return s
	const name = canonicalShelfName(s.name)
	return name === s.name ? s : { ...s, name }
}

const positioned = (s: ShelfSeries | null | undefined): boolean =>
	Boolean(s?.name) && isShelvablePosition(s?.position ?? null)

export function applyShelfPolicy<T extends ShelfBook>(book: T): T {
	// Canonicalise FIRST, so every rule below sees one spelling. The duplicate
	// check in particular is a fold comparison: with the alias applied after it,
	// "Hannibal Lecter" and "Hannibal Lecter Series" would still read as two
	// different series and both survive into the two slots.
	const primary = canonicalised(book.seriesPrimary?.name ? book.seriesPrimary : undefined)
	const secondary = canonicalised(asSeries(book.seriesSecondary))
	if (!primary && !secondary) return book
	// A rename alone is a change worth returning, even when no rule below fires.
	if (primary !== book.seriesPrimary || (secondary && secondary !== book.seriesSecondary)) {
		book = { ...book }
		if (primary) (book as ShelfBook).seriesPrimary = primary
		if (secondary) (book as ShelfBook).seriesSecondary = secondary
	}

	// The two slots may never hold the same series, whatever else happens. The
	// compare is sameSeriesName, not a bare fold: a bare fold reads
	// "Warhammer 40,000 : Imperial Guard" and "Warhammer 40,000: Imperial Guard"
	// as two series, which is how Baneblade shipped one series in both slots.
	const duplicate = primary && secondary && sameSeriesName(primary.name, secondary.name)

	// A CONTAINER never shelves, even POSITIONED. This guard used to be
	// `positioned(primary)` alone, and isContainer was consulted only in the
	// demote-to-tag branch below — so an umbrella arriving with a number
	// returned from here untouched, and rule 3 in this file's own header was
	// unenforceable for exactly the case that matters. Live on both boxes
	// 2026-07-31: The Sunlit Man served `The Cosmere #32` while
	// `Secret Projects #4` sat in the secondary slot, which is what the golden
	// corpus requires. A number from an umbrella is a coordinate in a
	// franchise, not a place on a shelf; falling through lets the positioned
	// secondary be promoted exactly as it is for a positionless primary.
	if (primary && positioned(primary) && !isContainer(primary.name)) {
		if (!duplicate) return book
		// Same series twice: keep the primary, clear the echo.
		const out = { ...book }
		delete (out as ShelfBook).seriesSecondary
		return out
	}

	// Primary is absent or positionless: the shelf, if any, is the positioned
	// secondary.
	const out = { ...book }
	delete (out as ShelfBook).seriesPrimary
	delete (out as ShelfBook).seriesSecondary
	// ...unless that secondary is itself a CONTAINER. The guard on the primary arm
	// above is meaningless without this one: an umbrella arriving in the SECONDARY
	// slot with a number was promoted straight into the shelf, which is the exact
	// state 375355c exists to prevent. Measured:
	//   {primary: 'Secret Projects', secondary: {'The Cosmere', #32}}
	//     -> seriesPrimary: {'The Cosmere', #32}
	// Falling through leaves the container in the tag slot, which is already how
	// every POSITIONLESS container-as-secondary row is served today — so this
	// closes the hole without moving a single currently-served row.
	if (secondary && positioned(secondary) && !isContainer(secondary.name)) {
		;(out as ShelfBook).seriesPrimary = secondary
		// The vacated name survives as a tag unless it is a container — or unless
		// it IS the promoted series, which would just recreate the duplicate.
		if (primary && !duplicate && !isContainer(primary.name))
			(out as ShelfBook).seriesSecondary = primary
		return out
	}
	// No shelf. Keep at most one tag: the existing secondary wins over the
	// vacated primary name; containers are dropped outright.
	const tag = secondary ?? (primary && !isContainer(primary.name) ? primary : undefined)
	if (tag) (out as ShelfBook).seriesSecondary = tag
	return out
}

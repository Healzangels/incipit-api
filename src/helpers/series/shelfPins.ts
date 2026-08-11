/**
 * Answer-level shelf pins — operator-stated answers for records the resolver
 * cannot derive or derives wrongly (mirror 500s, name-form drift, search
 * recall, taste calls like the Jack Ryan family).
 *
 * A pin is DATA, minted from the golden corpus: it exists only for records
 * whose required outcome the operator has already stated (R4 — the system
 * never invents a number; the operator may). Applied at serve time BEFORE the
 * shelf policy, so dedup/tag semantics still govern the result, and warm
 * cache entries obey pins immediately — no invalidation (P3).
 *
 * The pin table lives in shelfPins.data.ts, GENERATED from the corpus by
 * scripts/mintPins.ts — edit the corpus (the operator's truth), regenerate,
 * and the gate re-verifies. Hand-editing the data file drifts it from the
 * corpus and the generator will clobber it.
 */
import { SHELF_PINS, SHELF_PINS_BY_KEY } from './shelfPins.data'

import { sameSeriesName } from '#helpers/providers/goodreadsSeries'
import { pinKey } from '#helpers/series/pinKey'
import { isContainer } from '#helpers/series/shelfPolicy'

export interface ShelfPin {
	series?: string
	position?: string
	/** Operator-stated display title, for records that bake series/edition text
	 *  into the TITLE itself (": Legend of Drizzt: Paths of Darkness, Book 2")
	 *  where re-matching cannot help — the correct record IS the long-titled
	 *  one. Same R4 shape as a stated number. */
	displayTitle?: string
	/** Suppress the shelf outright (the Unfettered class). */
	none?: boolean
	/** With none: keep the displaced name as the tag instead of erasing it. */
	keepTag?: boolean
	/** Corpus pinType that authorized this pin. */
	source: string
}

interface PinSeries {
	name?: string
	position?: string | null
}
interface PinBook {
	title?: string
	authors?: ReadonlyArray<{ name?: string } | null | undefined> | null
	seriesPrimary?: PinSeries | null
	seriesSecondary?: unknown
}

/**
 * Every key a book could be filed under — one per author, because two editions
 * of one book do not reliably list their authors in the same order.
 * @param {PinBook} book the book being served, before any pin is applied
 * @returns {string[]} the candidate keys, most likely first
 */
const keysFor = (book: PinBook): string[] => {
	const names = (book.authors ?? []).map((a) => a?.name).filter((n): n is string => Boolean(n))
	// Empty keys are NOT filtered here on purpose: `owned` rejects a falsy key,
	// so a second guard would be unreachable duplication — and unreachable code
	// no mutation can kill is how a guard rots into decoration.
	return [...new Set(names.map((n) => pinKey(book.title, n)))]
}

const asSeries = (v: unknown): PinSeries | undefined => {
	if (!v || typeof v !== 'object') return undefined
	const s = v as { name?: unknown }
	return typeof s.name === 'string' && s.name ? (v as PinSeries) : undefined
}

/** Own-property lookup. Both tables are plain object literals, so "constructor"
 *  / "toString" / "valueOf" would otherwise return a truthy Function off
 *  Object.prototype and every `pin.x` would read undefined off it — a pin that
 *  was never stated. */
const owned = (
	table: Record<string, ShelfPin>,
	k: string | null | undefined
): ShelfPin | undefined => (k && Object.hasOwn(table, k) ? table[k] : undefined)

export function applyPins<T extends PinBook>(
	book: T,
	recordId: string | null | undefined,
	pins: Record<string, ShelfPin> = SHELF_PINS,
	keyed: Record<string, ShelfPin> = SHELF_PINS_BY_KEY
): T {
	// The EDITION id first and unconditionally: it is exact, and it keeps every
	// pin that works today working. The folded (title, author) key is the
	// fallback that makes the same table reach a library which matched the same
	// book to a different edition — see pinKey.
	const pin =
		owned(pins, recordId) ??
		keysFor(book).reduce<ShelfPin | undefined>((hit, k) => hit ?? owned(keyed, k), undefined)
	// An unpinned book returns the SAME object, not a clone: the route calls this
	// on every served book.
	if (!pin) return book
	const resolved = book.seriesPrimary?.name ? book.seriesPrimary : undefined
	const existingSecondary = asSeries(book.seriesSecondary)
	const echoesPin = (s: PinSeries | undefined): boolean => sameSeriesName(s?.name, pin.series)
	const out = { ...book }
	if (pin.displayTitle) (out as PinBook).title = pin.displayTitle

	if (pin.none) {
		delete (out as PinBook).seriesPrimary
		delete (out as PinBook).seriesSecondary
		// A tag the resolver placed outranks the name the pin displaced, mirroring
		// the vacancy rule in applyShelfPolicy. POSITIONLESS deliberately: a
		// positioned tag is promoted straight back onto the shelf by that policy,
		// which would hand the shelf back to the pin that exists to suppress it.
		const keep = existingSecondary ?? resolved
		if (pin.keepTag && keep?.name) (out as PinBook).seriesSecondary = { name: keep.name }
		return out
	}

	// A pin with no series states no shelf. Without this the block below installs
	// `{name: undefined, position: undefined}` over a good resolver answer, and
	// applyShelfPolicy reads that as a positionless primary and strips the shelf.
	if (!pin.series) return out

	// Rename in place when the pin only re-states the series the resolver already
	// found, so sibling fields (asin) survive; build fresh when it names a
	// different series, so they do not leak onto the wrong one. `position` is
	// ABSENT rather than undefined when the pin states none — applyShelfPolicy
	// distinguishes them.
	const carry = resolved && echoesPin(resolved) ? { ...resolved } : {}
	delete (carry as PinSeries).name
	delete (carry as PinSeries).position
	;(out as PinBook).seriesPrimary = {
		...carry,
		name: pin.series,
		...(pin.position ? { position: pin.position } : {})
	}

	// ONE occupant in the tag slot, and a tag the resolver placed owns it —
	// containers included. Evicting a container the resolver put there would
	// strip "Warhammer 40,000" from rows the operator's container-tag policy
	// deliberately keeps.
	if (existingSecondary && !echoesPin(existingSecondary)) return out
	delete (out as PinBook).seriesSecondary
	// Otherwise the answer the pin displaced falls back into the freed slot. The
	// old code branched on whether a secondary EXISTED rather than on whether the
	// slot was free afterwards, so a displaced answer was dropped whenever an
	// echoing secondary had just been deleted — 12 served rows lost a tag they
	// keep when the same book is unpinned.
	//
	// Refused for a CONTAINER (a franchise umbrella is not a tag when we are the
	// one placing it) and for a POSITIONLESS pin (a positioned tag beside a
	// positionless primary is promoted onto the shelf by applyShelfPolicy, which
	// would hand the shelf straight back to the answer the pin overrides).
	if (pin.position && resolved && !echoesPin(resolved) && !isContainer(resolved.name))
		(out as PinBook).seriesSecondary = resolved
	return out
}

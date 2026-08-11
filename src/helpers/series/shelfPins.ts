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
import { SHELF_PINS } from './shelfPins.data'

import { sameSeriesName } from '#helpers/providers/goodreadsSeries'
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
	seriesPrimary?: PinSeries | null
	seriesSecondary?: unknown
}

const asSeries = (v: unknown): PinSeries | undefined => {
	if (!v || typeof v !== 'object') return undefined
	const s = v as { name?: unknown }
	return typeof s.name === 'string' && s.name ? (v as PinSeries) : undefined
}

export function applyPins<T extends PinBook>(
	book: T,
	recordId: string | null | undefined,
	pins: Record<string, ShelfPin> = SHELF_PINS
): T {
	// Own-property only. `pins` is a plain object literal, so a recordId of
	// "constructor" / "toString" / "valueOf" returns a truthy Function off the
	// prototype chain and every `pin.x` below reads undefined off it — a pin that
	// was never stated. Unreachable while record ids are 10-character ASINs;
	// reachable the moment pins key on anything else.
	const pin = recordId && Object.hasOwn(pins, recordId) ? pins[recordId] : undefined
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

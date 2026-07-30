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

import { foldSeriesName } from '#helpers/providers/goodreadsSeries'

export interface ShelfPin {
	series?: string
	position?: string
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
	const pin = recordId ? pins[recordId] : undefined
	if (!pin) return book
	const resolved = book.seriesPrimary?.name ? book.seriesPrimary : undefined
	const out = { ...book }

	if (pin.none) {
		delete (out as PinBook).seriesPrimary
		delete (out as PinBook).seriesSecondary
		if (pin.keepTag && resolved) (out as PinBook).seriesSecondary = resolved
		return out
	}

	const pinned: PinSeries = { name: pin.series, position: pin.position }
	;(out as PinBook).seriesPrimary = pinned
	// The displaced resolver answer survives as the tag unless it would echo
	// the pin; an existing secondary that echoes the pin is cleared the same way.
	const existingSecondary = asSeries(book.seriesSecondary)
	const echo = (s: PinSeries | undefined): boolean =>
		Boolean(s?.name && pin.series && foldSeriesName(String(s.name)) === foldSeriesName(pin.series))
	if (existingSecondary && echo(existingSecondary)) delete (out as PinBook).seriesSecondary
	else if (!existingSecondary && resolved && !echo(resolved))
		(out as PinBook).seriesSecondary = resolved
	return out
}

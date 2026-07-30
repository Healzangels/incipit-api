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
import { foldSeriesName, isShelvablePosition } from '#helpers/providers/goodreadsSeries'

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
	'jack ryan universe'
])

const isContainer = (name: string | null | undefined): boolean =>
	Boolean(name) && CONTAINER_SHELF_NAMES.has(foldSeriesName(String(name)))

const positioned = (s: ShelfSeries | null | undefined): boolean =>
	Boolean(s?.name) && isShelvablePosition(s?.position ?? null)

export function applyShelfPolicy<T extends ShelfBook>(book: T): T {
	const primary = book.seriesPrimary?.name ? book.seriesPrimary : undefined
	const secondary = asSeries(book.seriesSecondary)
	if (!primary && !secondary) return book

	// The two slots may never hold the same series, whatever else happens.
	const duplicate =
		primary &&
		secondary &&
		foldSeriesName(String(primary.name)) === foldSeriesName(String(secondary.name))

	if (primary && positioned(primary)) {
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
	if (secondary && positioned(secondary)) {
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

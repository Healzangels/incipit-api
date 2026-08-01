import { describe, expect, test } from 'bun:test'

import {
	alternateCoverWorthOffering,
	siblingRegion
} from '#helpers/providers/alternateCover'

/**
 * A SECOND REGION'S COVER, offered as an extra choice.
 *
 * Audible sells the same recording in several marketplaces and frequently
 * commissions different art for each. Measured 2026-08-01 over the 16 library
 * ASINs that resolve in BOTH us and uk: 7 of 15 comparable pairs carry a
 * genuinely different cover asset, and 13 of 15 share the same narrator. So
 * about half the time there is a real extra option, and it is usually the same
 * recording.
 *
 * THE NARRATOR CHECK IS LOAD-BEARING, not a formality. "Fever Dream"
 * (B003GXDDYS) comes back with a DIFFERENT narrator in the two marketplaces —
 * a different recording sold under the same ASIN. Borrowing its art would put
 * another edition's cover on the book, which is precisely the quiet kind of
 * wrong this codebase keeps paying for.
 *
 * Runtime cannot stand in for it: in that same sample the uk records return
 * `runtimeLengthMin: null` almost everywhere, so the narrator set is the ONLY
 * corroborating signal available across regions.
 */
describe('siblingRegion', () => {
	test('pairs the two marketplaces that share ASINs', () => {
		expect(siblingRegion('us')).toBe('uk')
		expect(siblingRegion('uk')).toBe('us')
	})

	test('is undefined elsewhere — only us/uk was measured', () => {
		// ca/au/de were NOT part of the measurement, and inventing a pairing
		// would spend a lookup per book on an unevidenced guess.
		for (const r of ['ca', 'au', 'de', 'fr', '', 'US ']) {
			expect(siblingRegion(r)).toBeUndefined()
		}
	})
})

describe('alternateCoverWorthOffering', () => {
	const rec = (over: Record<string, unknown> = {}) => ({
		image: 'https://m.media-amazon.com/images/I/51AAA._SL500_.jpg',
		narrators: [{ name: 'Ann Dowd' }, { name: 'Mae Whitman' }],
		...over
	})

	test('offers a genuinely different cover from the sibling region', () => {
		const alt = rec({ image: 'https://m.media-amazon.com/images/I/99ZZZ._SL500_.jpg' })
		expect(alternateCoverWorthOffering(rec(), alt)).toBe(alt.image)
	})

	test('refuses when the NARRATOR differs — the Fever Dream case', () => {
		const alt = rec({
			image: 'https://m.media-amazon.com/images/I/99ZZZ._SL500_.jpg',
			narrators: [{ name: 'Someone Else' }]
		})
		expect(alternateCoverWorthOffering(rec(), alt)).toBeNull()
	})

	test('refuses the SAME asset wearing a different size modifier', () => {
		// ._SL500_ vs ._SX450_ is one picture, not two. Offering it would add a
		// duplicate tile to a picker that already carries several.
		const alt = rec({ image: 'https://m.media-amazon.com/images/I/51AAA._SX450_.jpg' })
		expect(alternateCoverWorthOffering(rec(), alt)).toBeNull()
	})

	test('narrator comparison ignores order and case', () => {
		const alt = rec({
			image: 'https://m.media-amazon.com/images/I/99ZZZ._SL500_.jpg',
			narrators: [{ name: 'mae whitman' }, { name: 'ANN DOWD' }]
		})
		expect(alternateCoverWorthOffering(rec(), alt)).toBe(alt.image)
	})

	test('refuses when either side has no narrators — nothing corroborates', () => {
		const alt = rec({ image: 'https://m.media-amazon.com/images/I/99ZZZ._SL500_.jpg' })
		expect(alternateCoverWorthOffering(rec({ narrators: [] }), alt)).toBeNull()
		expect(alternateCoverWorthOffering(rec(), { ...alt, narrators: [] })).toBeNull()
	})

	test('refuses when either side has no image', () => {
		expect(alternateCoverWorthOffering(rec({ image: null }), rec())).toBeNull()
		expect(alternateCoverWorthOffering(rec(), rec({ image: null }))).toBeNull()
	})

	test('survives a malformed record without throwing', () => {
		expect(alternateCoverWorthOffering(null as never, rec())).toBeNull()
		expect(alternateCoverWorthOffering(rec(), undefined as never)).toBeNull()
	})
})

/**
 * IT MUST BE THE SAME KIND OF ART.
 *
 * Caught live on 2026-08-01 minutes after shipping: the sibling-region lookup
 * goes through the provider registry, and HARDCOVER answers for an Audible
 * ASIN, so the first deployment offered print jackets as "alternate
 * marketplace art" —
 *   Leviathan Wakes  -> assets.hardcover.app/edition/30572103/...jpeg
 *   Theft of Swords  -> assets.hardcover.app/book/427664/...jpg
 * The narrator check passed, because Hardcover's record carries the same
 * narrators. So the guard that makes this safe against the WRONG RECORDING
 * says nothing about the wrong KIND of image.
 *
 * A portrait print jacket is exactly what the whole squareCover machinery
 * exists to keep out of a square Plex poster slot, so offering one here as a
 * bonus tile works against the rest of the system.
 */
describe('alternateCoverWorthOffering — same kind of art', () => {
	const AMAZON_A = 'https://m.media-amazon.com/images/I/51AAA._SL500_.jpg'
	const AMAZON_B = 'https://m.media-amazon.com/images/I/99ZZZ._SL500_.jpg'
	const HARDCOVER = 'https://assets.hardcover.app/edition/30572103/abc.jpeg'
	const narrators = [{ name: 'Jefferson Mays' }]

	test('refuses a Hardcover print jacket as an alternate', () => {
		expect(
			alternateCoverWorthOffering(
				{ image: AMAZON_A, narrators },
				{ image: HARDCOVER, narrators }
			)
		).toBeNull()
	})

	test('still offers a genuine Amazon alternate', () => {
		expect(
			alternateCoverWorthOffering(
				{ image: AMAZON_A, narrators },
				{ image: AMAZON_B, narrators }
			)
		).toBe(AMAZON_B)
	})
})


import { describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'

/**
 * A pinned ASIN must be FETCHED, not merely recognised if it happens to show up.
 *
 * Every pin protection in the scorer -- isPinned, the pinned-first tiebreak, the
 * stale-pin duration override, the floor that keeps a contradicted pin offered --
 * can only act on a candidate the provider fan-out already returned. When the
 * title search does not surface the pinned edition, all of it is dead code and
 * the pin has no effect at all.
 *
 * Measured live 2026-07-26 on Neal Shusterman / "Everfound": the sidecar carried
 * B004XNIO5I, `GET /books/B004XNIO5I` resolves it correctly (834 min), yet a
 * search for title "Everfound" with that asin returned four rows -- a Spanish
 * edition, an OverDrive row, an Apple row and a Hardcover work record -- none of
 * them the pinned ASIN, even with refresh=1. The book stayed unmatched through a
 * full library rebuild.
 *
 * Deliberately NOT forced to the top. The sidecars are known to carry wrong and
 * even dead ASINs (the same rebuild had B07XG1S8LM on "2010", which resolves to
 * nothing), so an injected pin still faces the ordinary scoring: a rival the
 * duration corroborates outranks it, and it stays offered for Fix Match either
 * way. It is resolved through fetchCandidateByAsin rather than fetchBookByAsin
 * for two reasons: only Hardcover implements the latter (it is the rescue path
 * for ASINs Audible will not serve, so an ordinary Audible ASIN resolved to
 * nothing and the injection silently never fired), and ProviderBook carries no
 * runtime, which would leave the pin unable to be duration-corroborated OR
 * duration-vetoed.
 */

const PINNED_ASIN = 'B004XNIO5I'

function candidate(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
	return {
		provider: 'audible',
		id: 'x',
		asin: null,
		title: 'Everfound',
		authors: ['Neal Shusterman'],
		narrators: [],
		audioSeconds: null,
		cover: null,
		language: null,
		...over
	}
}

/** The rows the live fan-out actually returns -- none carrying the pin. */
const spanish = candidate({
	id: 'B0CN3SPD12',
	asin: 'B0CN3SPD12',
	title: 'Everfound (Spanish Edition)',
	narrators: ['Chema Agullo'],
	language: 'es'
})
const overdrive = candidate({ provider: 'overdrive', id: 'overdrive-10268336' })
const hardcoverWork = candidate({ provider: 'hardcover', id: 'hardcover-book-174750' })

/** What the ASIN lookup returns: the real audio edition, RUNTIME INCLUDED. */
const pinnedBook: ProviderCandidate = candidate({
	id: PINNED_ASIN,
	asin: PINNED_ASIN,
	narrators: ['Nick Podehl'],
	audioSeconds: 834 * 60,
	cover: 'https://example/cover.jpg',
	language: 'en'
})

function helperFor(
	poolCandidates: ProviderCandidate[],
	fetchCandidateByAsin: (asin: string) => Promise<ProviderCandidate | null>,
	options: Record<string, unknown> = {}
) {
	const registry = {
		searchAll: async () => poolCandidates,
		fetchCandidateByAsin
	} as unknown as ProviderRegistry
	return new BookSearchHelper(registry, {
		title: 'Everfound',
		author: 'Neal Shusterman',
		asin: PINNED_ASIN,
		region: 'us',
		...options
	} as never)
}

describe('pinned ASIN injection', () => {
	test('the pinned edition is fetched when the fan-out misses it', async () => {
		const helper = helperFor([spanish, overdrive, hardcoverWork], async (asin) =>
			asin === PINNED_ASIN ? pinnedBook : null
		)
		const ranked = await helper.search()
		expect(ranked.some((c) => c.asin === PINNED_ASIN)).toBe(true)
	})

	test('the injected pin ranks first against rows with no duration signal', async () => {
		// Title+author are exact, the others are a foreign edition and two rows
		// that match on title alone -- so it wins WITHOUT being forced.
		const helper = helperFor([spanish, overdrive, hardcoverWork], async () => pinnedBook)
		const ranked = await helper.search()
		expect(ranked[0]?.asin).toBe(PINNED_ASIN)
	})

	test('no extra lookup when the fan-out already returned the pin', async () => {
		let calls = 0
		const alreadyThere = candidate({ id: PINNED_ASIN, asin: PINNED_ASIN })
		const helper = helperFor([alreadyThere, spanish], async () => {
			calls += 1
			return pinnedBook
		})
		await helper.search()
		expect(calls).toBe(0)
	})

	test('a dead pinned ASIN changes nothing', async () => {
		// "2010" carried B07XG1S8LM, which resolves to nothing. A lookup miss must
		// leave the search as it was -- not throw, not empty the pool.
		const helper = helperFor([spanish, overdrive], async () => null)
		const ranked = await helper.search()
		expect(ranked.length).toBeGreaterThan(0)
		expect(ranked.some((c) => c.asin === PINNED_ASIN)).toBe(false)
	})

	test('a lookup failure is swallowed, never fatal', async () => {
		const helper = helperFor([spanish, overdrive], async () => {
			throw new Error('provider down')
		})
		const ranked = await helper.search()
		expect(ranked.length).toBeGreaterThan(0)
	})

	test('no lookup at all when no ASIN was supplied', async () => {
		let calls = 0
		const helper = helperFor(
			[spanish, overdrive],
			async () => {
				calls += 1
				return pinnedBook
			},
			{ asin: undefined }
		)
		await helper.search()
		expect(calls).toBe(0)
	})

	test('a duration-corroborated rival still beats the injected pin', async () => {
		// The wrong-sidecar protection: the pin is offered but does not win, and
		// nothing about injection bypasses the duration evidence.
		const rival = candidate({
			id: 'B0RIVAL0000',
			asin: 'B0RIVAL0000',
			narrators: ['Nick Podehl'],
			audioSeconds: 50000
		})
		const helper = helperFor([rival], async () => pinnedBook, { duration: 50000 * 1000 })
		const ranked = await helper.search()
		expect(ranked[0]?.asin).toBe('B0RIVAL0000')
		expect(ranked.some((c) => c.asin === PINNED_ASIN)).toBe(true)
	})
})

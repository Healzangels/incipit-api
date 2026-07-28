import { describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper, { audibleIdFromIsbn } from '#helpers/routes/BookSearchHelper'

/**
 * A sidecar ASIN can be DEAD, and the sidecar's ISBN can be the live identifier.
 *
 * Measured live 2026-07-26 on Michael Scott / "The Lost Stories Collection". The
 * sidecar carried `"asin": "B08WF9JR2P"` -- correctly B0-prefixed, so it passed
 * the bundle's Audible-shape guard and was pinned -- but `GET /books/B08WF9JR2P`
 * resolves to NOTHING, so the injection never fired and the search returned zero
 * candidates above the floor. The book went unmatched through a full rebuild.
 *
 * The same sidecar carried `"isbn": "9780593399439"`, whose ISBN-10 form is
 * 0593399439 -- which IS the Audible product id (it is the id in the audible.com
 * URL for this title) and resolves to the right edition, 688 min against a
 * 688.3 min file. With it the search scores 1.0 and ranks first.
 *
 * Publishers routinely register audio editions under the print ISBN-10 rather
 * than a B0 ASIN, so this is a class, not a one-off.
 *
 * The safety question this raises was already answered by the shape of the
 * lookup. search_tools.py deliberately REFUSES an ISBN-10 sitting in a sidecar's
 * `asin` field, because pinning it "would match the print edition over the audio
 * one". That reasoning holds for a blind pin but not for this path: the fallback
 * resolves through fetchCandidateByAsin, which only Audible implements, and
 * Audible's catalog contains no print editions. An ISBN that is print-only
 * resolves to nothing and injects nothing. The injected row is also tagged
 * PINNED_PROVIDER like the ASIN injection, so isPinned still excludes it and it
 * faces ordinary scoring -- duration veto included.
 */

const DEAD_ASIN = 'B08WF9JR2P'
const ISBN13 = '9780593399439'
const ISBN10 = '0593399439'

function candidate(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
	return {
		provider: 'audible',
		id: 'x',
		asin: null,
		title: 'The Lost Stories Collection',
		authors: ['Michael Scott'],
		narrators: [],
		audioSeconds: null,
		cover: null,
		language: null,
		...over
	}
}

/** What the ISBN-10 lookup returns: the real audio edition, runtime included. */
const isbnEdition: ProviderCandidate = candidate({
	id: ISBN10,
	asin: ISBN10,
	title: 'The Secrets of the Immortal Nicholas Flamel: The Lost Stories Collection',
	narrators: ['Alan Kelly'],
	audioSeconds: 688 * 60,
	language: 'en'
})

/** An ordinary fan-out row: matches on title+author, carries no identifier. */
const plainRow = candidate({ provider: 'overdrive', id: 'overdrive-1' })

function helperFor(
	pool: ProviderCandidate[],
	lookups: Record<string, ProviderCandidate>,
	options: Record<string, unknown> = {},
	onLookup?: (id: string) => void
) {
	const registry = {
		searchAll: async () => pool,
		fetchCandidateByAsin: async (id: string) => {
			onLookup?.(id)
			return lookups[id] ?? null
		}
	} as unknown as ProviderRegistry
	return new BookSearchHelper(registry, {
		title: 'The Lost Stories Collection',
		author: 'Michael Scott',
		region: 'us',
		...options
	} as never)
}

describe('audibleIdFromIsbn', () => {
	test('converts a 978 ISBN-13 to its ISBN-10 form', () => {
		expect(audibleIdFromIsbn(ISBN13)).toBe(ISBN10)
	})

	test('tolerates hyphens and spacing', () => {
		expect(audibleIdFromIsbn('978-0-593-39943-9')).toBe(ISBN10)
	})

	test('passes an ISBN-10 through, uppercased for the X check digit', () => {
		expect(audibleIdFromIsbn('080442957x')).toBe('080442957X')
	})

	test('computes an X check digit', () => {
		// 9780804429573 -> 080442957X
		expect(audibleIdFromIsbn('9780804429573')).toBe('080442957X')
	})

	test('refuses a 979 ISBN-13, which has no ISBN-10 form', () => {
		expect(audibleIdFromIsbn('9791234567896')).toBeNull()
	})

	test('refuses a wrong-length or non-numeric value', () => {
		expect(audibleIdFromIsbn('12345')).toBeNull()
		expect(audibleIdFromIsbn('')).toBeNull()
		expect(audibleIdFromIsbn('not-an-isbn')).toBeNull()
	})
})

describe('ISBN fallback for a dead pinned ASIN', () => {
	test('falls back to the ISBN when the pinned ASIN resolves to nothing', async () => {
		const helper = helperFor(
			[plainRow],
			{ [ISBN10]: isbnEdition },
			{
				asin: DEAD_ASIN,
				isbn: ISBN13
			}
		)
		const ranked = await helper.search()
		expect(ranked.some((c) => c.asin === ISBN10)).toBe(true)
	})

	test('works when the sidecar carried an ISBN but no ASIN at all', async () => {
		const helper = helperFor([plainRow], { [ISBN10]: isbnEdition }, { isbn: ISBN13 })
		const ranked = await helper.search()
		expect(ranked.some((c) => c.asin === ISBN10)).toBe(true)
	})

	test('a LIVE pinned ASIN is never second-guessed by the ISBN', async () => {
		const live = candidate({ id: DEAD_ASIN, asin: DEAD_ASIN, audioSeconds: 688 * 60 })
		const tried: string[] = []
		const helper = helperFor(
			[plainRow],
			{ [DEAD_ASIN]: live, [ISBN10]: isbnEdition },
			{ asin: DEAD_ASIN, isbn: ISBN13 },
			(id) => tried.push(id)
		)
		await helper.search()
		expect(tried).toEqual([DEAD_ASIN])
	})

	test('no ISBN lookup when the fan-out already returned that edition', async () => {
		const tried: string[] = []
		const helper = helperFor(
			[candidate({ id: ISBN10, asin: ISBN10 })],
			{ [ISBN10]: isbnEdition },
			{ isbn: ISBN13 },
			(id) => tried.push(id)
		)
		await helper.search()
		expect(tried).toEqual([])
	})

	test('a print-only ISBN injects nothing and is not fatal', async () => {
		// Audible serves no print editions, so a print ISBN resolves to null --
		// which is what makes sending the ISBN safe at all.
		const helper = helperFor([plainRow], {}, { asin: DEAD_ASIN, isbn: ISBN13 })
		const ranked = await helper.search()
		expect(ranked.some((c) => c.asin === ISBN10)).toBe(false)
		expect(ranked.length).toBeGreaterThan(0)
	})

	test('an unconvertible ISBN triggers no lookup', async () => {
		const tried: string[] = []
		const helper = helperFor([plainRow], {}, { isbn: '9791234567896' }, (id) => tried.push(id))
		await helper.search()
		expect(tried).toEqual([])
	})

	test('an ISBN lookup failure is swallowed, never fatal', async () => {
		const registry = {
			searchAll: async () => [plainRow],
			fetchCandidateByAsin: async () => {
				throw new Error('provider down')
			}
		} as unknown as ProviderRegistry
		const helper = new BookSearchHelper(registry, {
			title: 'The Lost Stories Collection',
			author: 'Michael Scott',
			region: 'us',
			isbn: ISBN13
		} as never)
		const ranked = await helper.search()
		expect(ranked.length).toBeGreaterThan(0)
	})

	test('a fan-out row carrying the ISBN id ranks on its merits when the ASIN is dead', async () => {
		// SUPERSEDED CONTRACT (2026-07-28): this used to assert the full pin
		// override -- confidence 1.0, ranked first by privilege. An ISBN names
		// a BOOK, not a store listing, and which listing it resolves to is
		// provider-dependent (the He Who Fights with Monsters sidecar's ISBN
		// resolved to the deluxe-hardcover "Vol. 1" record and auto-matched it
		// over the standard listing). The identity is still adopted -- the row
		// stays offered whatever it scores -- but the ranking is earned: here
		// the ISBN row is the strongest title match and still comes first, at
		// its merit score rather than a minted 1.0.
		const fromFanOut = candidate({
			id: ISBN10,
			asin: ISBN10,
			title: 'The Secrets of the Immortal Nicholas Flamel: The Lost Stories Collection',
			narrators: ['Alan Kelly']
		})
		const helper = helperFor([fromFanOut, plainRow], {}, { asin: DEAD_ASIN, isbn: ISBN13 })
		const ranked = await helper.search()
		// The exact-title row wins on merits; the ISBN row is adopted as the
		// pin identity, floor-held, and stays pickable -- offered, not crowned.
		expect(ranked[0]?.id).toBe('overdrive-1')
		const isbnRow = ranked.find((c) => c.asin === ISBN10)
		expect(isbnRow).toBeDefined()
		expect(isbnRow?.confidence).not.toBe(1)
	})

	test('the ISBN never displaces a corroborated ASIN as the pin identity', async () => {
		// Sidecar carries both, and the fan-out returns BOTH rows. The ASIN is the
		// stated identity; the ISBN is only its fallback, so the ASIN row keeps the
		// override and the ISBN row scores on its merits.
		const asinRow = candidate({ id: DEAD_ASIN, asin: DEAD_ASIN })
		const isbnRow = candidate({ id: ISBN10, asin: ISBN10 })
		const helper = helperFor([asinRow, isbnRow], {}, { asin: DEAD_ASIN, isbn: ISBN13 })
		const ranked = await helper.search()
		const byAsin = ranked.find((c) => c.asin === DEAD_ASIN)
		const byIsbn = ranked.find((c) => c.asin === ISBN10)
		expect(byAsin?.confidence).toBe(1)
		expect(byIsbn?.confidence).not.toBe(1)
	})

	test('an ISBN row in the pool does not stop the live ASIN from being fetched', async () => {
		// The sidecar's PRIMARY claim is the ASIN; the ISBN is only its fallback.
		// With the ISBN row sitting in the pool and the ASIN merely missing from
		// it, an either-id early return would skip the fetch, infer the ASIN dead,
		// and flip the pin identity to the ISBN row at 1.0 -- auto-applying an
		// edition the sidecar never named. The ASIN must get its fetch first.
		const LIVE_ASIN = 'B0LIVE12345'
		const liveEdition = candidate({ id: LIVE_ASIN, asin: LIVE_ASIN, audioSeconds: 700 * 60 })
		const isbnRow = candidate({ id: ISBN10, asin: ISBN10 })
		const tried: string[] = []
		const helper = helperFor(
			[isbnRow, plainRow],
			{ [LIVE_ASIN]: liveEdition },
			{ asin: LIVE_ASIN, isbn: ISBN13 },
			(id) => tried.push(id)
		)
		const ranked = await helper.search()
		expect(tried).toEqual([LIVE_ASIN])
		expect(ranked.some((c) => c.asin === LIVE_ASIN)).toBe(true)
		// No identity flip while the ASIN is alive: the ISBN row scores on its
		// merits instead of inheriting the pin override.
		expect(ranked.find((c) => c.asin === ISBN10)?.confidence).not.toBe(1)
	})

	test('the ISBN pin identity engages when the row arrives via the track-title widening', async () => {
		// A noisy album tag misses the edition entirely; the clean track title
		// returns it. The dead-ASIN promotion must re-run against the MERGED pool,
		// or the identity the fallback exists to provide never fires for exactly
		// the tags that need the widening most.
		//
		// Under the merits contract (2026-07-28) "engages" means: the row the
		// sidecar named is adopted as the pin identity and STAYS OFFERED --
		// floor-held, never silently deleted -- while its rank is earned, not
		// granted (no minted 1.0).
		const fromTrackFanOut = candidate({ id: ISBN10, asin: ISBN10 })
		const registry = {
			searchAll: async (query: { title: string }) =>
				query.title.toLowerCase().includes('lost stories collection') &&
				!query.title.startsWith('16')
					? [fromTrackFanOut, plainRow]
					: [plainRow],
			fetchCandidateByAsin: async () => null
		} as unknown as ProviderRegistry
		const helper = new BookSearchHelper(registry, {
			title: '16 The Lost Stories Collection',
			trackTitle: 'The Lost Stories Collection',
			author: 'Michael Scott',
			region: 'us',
			asin: DEAD_ASIN,
			isbn: ISBN13
		} as never)
		const ranked = await helper.search()
		const isbnRow = ranked.find((c) => c.asin === ISBN10)
		expect(isbnRow).toBeDefined()
		expect(isbnRow?.confidence).not.toBe(1)
	})

	test('the ISBN-injected row is not self-confirming', async () => {
		// Same rule as the ASIN injection: resolving an identifier proves only that
		// it resolves, so a duration-corroborated rival must still win.
		const rival = candidate({
			id: 'B0RIVAL0000',
			asin: 'B0RIVAL0000',
			title: 'The Secrets of the Immortal Nicholas Flamel: The Lost Stories Collection',
			authors: ['Michael Scott'],
			narrators: ['Alan Kelly'],
			audioSeconds: 50000
		})
		const helper = helperFor(
			[rival],
			{ [ISBN10]: isbnEdition },
			{
				isbn: ISBN13,
				duration: 50000 * 1000
			}
		)
		const ranked = await helper.search()
		expect(ranked[0]?.asin).toBe('B0RIVAL0000')
		expect(ranked.some((c) => c.asin === ISBN10)).toBe(true)
	})
})

describe('husk protection', () => {
	test('a title-less candidate is never injected', async () => {
		// Belt to the provider-side guard: whatever a provider returns, a
		// candidate that cannot be displayed or scored must not enter the pool.
		const husk = candidate({ id: DEAD_ASIN, asin: DEAD_ASIN, title: '' })
		const helper = helperFor([plainRow], { [DEAD_ASIN]: husk }, { asin: DEAD_ASIN })
		const ranked = await helper.search()
		expect(ranked.some((c) => c.asin === DEAD_ASIN)).toBe(false)
	})

	test('a husk resolved for the ASIN does not block the ISBN fallback', async () => {
		// The live failure shape: the dead ASIN resolves to an empty stub while
		// the ISBN resolves to the real edition. The husk must count as a MISS so
		// the loop proceeds to the next identifier instead of injecting garbage.
		const husk = candidate({ id: DEAD_ASIN, asin: DEAD_ASIN, title: '' })
		const helper = helperFor(
			[plainRow],
			{ [DEAD_ASIN]: husk, [ISBN10]: isbnEdition },
			{ asin: DEAD_ASIN, isbn: ISBN13 }
		)
		const ranked = await helper.search()
		expect(ranked.some((c) => c.asin === DEAD_ASIN)).toBe(false)
		expect(ranked.some((c) => c.asin === ISBN10)).toBe(true)
	})
})

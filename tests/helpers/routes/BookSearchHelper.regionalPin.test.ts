import { beforeEach, describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'
import { getMatchMetrics, resetMatchMetrics } from '#helpers/utils/matchTelemetry'

/**
 * A sidecar ASIN that names the right RECORDING by a regional id the store does
 * not sell moves to the sibling listing it does (docs/design/spec-regional-pin-sibling.md).
 *
 * Measured live on prod 2026-09-25, Leigh Bardugo / "Ninth House" (file 58,947,942
 * ms). Chaptarr files the Lauren Fortgang recording under twelve regional ids and
 * names B07LH8GF23 -- sold by no Audible region -- its own; B07LHB5ZJ6, what
 * audible.com sells, sits in the same list. Searched with the sidecar's
 * `asin=B07LH8GF23`, the chaptarr row won and Audible's listing was ABSENT from
 * the results: same minute bucket, so dedupe merged the two, and its pin-aware
 * winner kept the pinned row. 138 prod albums matched that way, all served by the
 * Chaptarr rescue with no runtime.
 */

const FILE_MS = 58_947_942
const REGIONAL = 'B07LH8GF23'
const STORE = 'B07LHB5ZJ6'

function row(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
	return {
		provider: 'audible',
		id: 'x',
		asin: null,
		title: 'Ninth House',
		authors: ['Leigh Bardugo'],
		narrators: [],
		audioSeconds: null,
		cover: null,
		language: null,
		...over
	}
}

/** audible.com's listing of the recording. */
const storeRow = row({
	id: STORE,
	asin: STORE,
	narrators: ['Lauren Fortgang', 'Michael David Axtell'],
	audioSeconds: 982 * 60,
	cover: 'audible.jpg',
	language: 'en'
})

/** Chaptarr's row for the same recording, under the id it calls its own. */
const chaptarrRow = row({
	provider: 'chaptarr',
	id: REGIONAL,
	asin: REGIONAL,
	asinAliases: ['1250230918', STORE, 'B07LHC24PJ'],
	narrators: ['Lauren Fortgang', 'Michael David Axtell'],
	audioSeconds: 58_920,
	cover: 'chaptarr.jpg'
})

function helperFor(
	pool: ProviderCandidate[],
	options: Record<string, unknown> = {},
	lookups: Record<string, ProviderCandidate> = {}
) {
	const registry = {
		searchAll: async () => pool,
		fetchCandidateByAsin: async (id: string) => lookups[id] ?? null
	} as unknown as ProviderRegistry
	return new BookSearchHelper(registry, {
		title: 'Ninth House',
		author: 'Leigh Bardugo',
		region: 'us',
		duration: FILE_MS,
		asin: REGIONAL,
		...options
	} as never)
}

const decision = () => getMatchMetrics().recent[0]

describe('a regional pin moves to its store listing', () => {
	beforeEach(() => resetMatchMetrics())

	test("the live Ninth House shape: the pin lands on audible.com's listing", async () => {
		const ranked = await helperFor([storeRow, chaptarrRow]).search()
		expect(ranked[0]?.asin).toBe(STORE)
		expect(ranked[0]?.provider).toBe('audible')
		expect(ranked[0]?.confidence).toBe(1)
		expect(decision().pinPromotedToSibling).toBe(true)
		// The moved identity is a real pin: telemetry reads it as ASIN-confirmed.
		expect(decision().asinPinned).toBe(true)
	})

	test('without a hint nothing moves (and the store listing wins on its merits)', async () => {
		const ranked = await helperFor([storeRow, chaptarrRow], { asin: undefined }).search()
		expect(ranked[0]?.asin).toBe(STORE)
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test("a pin that Audible's search carries is a store listing and is never moved", async () => {
		const liveRegional = row({ ...storeRow, id: REGIONAL, asin: REGIONAL })
		const ranked = await helperFor([storeRow, liveRegional, chaptarrRow]).search()
		expect(ranked[0]?.asin).toBe(REGIONAL)
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test('an injected fetch-by-asin row cannot vouch: R1 transfers privilege, never creates it', async () => {
		// The pin is on no fan-out row, so the injection fetches it -- here through
		// the Chaptarr rescue, aliases and all. That row holds no pin privilege by
		// design (isPinned excludes it), and moving the pin off it would CREATE a
		// 1.0: measured on Midnight Tides, a 0.777 merits row of a recording 9% off
		// the file became a pinned 1.0 in the first cut. The store listing arrives
		// only with the track-title widening -- the album pass injects the rescued
		// row, the merged pool then holds both, and that is the one shape in which
		// R1 can meet an injected namer (the injection itself stands down when the
		// store listing is already in the album pool).
		const rescued = row({ ...chaptarrRow })
		const registry = {
			searchAll: async (q: { title: string }) => (q.title === 'Ninth House' ? [storeRow] : []),
			fetchCandidateByAsin: async (id: string) => (id === REGIONAL ? rescued : null)
		} as unknown as ProviderRegistry
		const ranked = await new BookSearchHelper(registry, {
			title: '16 Ninth House',
			trackTitle: 'Ninth House',
			author: 'Leigh Bardugo',
			region: 'us',
			duration: FILE_MS,
			asin: REGIONAL
		} as never).search()
		expect(ranked.some((c) => c.provider === 'pinned')).toBe(true)
		expect(decision().widened).toBe(true)
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test('a runtime beyond provider rounding is a different recording: refused', async () => {
		// 91 s apart -- just past the 90 s rounding epsilon.
		const other = row({ ...storeRow, audioSeconds: 58_920 + 91 })
		await helperFor([other, chaptarrRow]).search()
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test('...while a gap inside rounding is the same recording', async () => {
		const close = row({ ...storeRow, audioSeconds: 58_920 + 90 })
		await helperFor([close, chaptarrRow]).search()
		expect(decision().pinPromotedToSibling).toBe(true)
	})

	test('narrators that share no one are a different recording: refused', async () => {
		const other = row({ ...storeRow, narrators: ['Someone Else'] })
		await helperFor([other, chaptarrRow]).search()
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test('a side with no narrators listed does not block the move', async () => {
		const bare = row({ ...storeRow, narrators: [] })
		await helperFor([bare, chaptarrRow]).search()
		expect(decision().pinPromotedToSibling).toBe(true)
	})

	test('a sibling that is not an Audible row is not a store listing: refused', async () => {
		const overdrive = row({ ...storeRow, provider: 'overdrive' })
		await helperFor([overdrive, chaptarrRow]).search()
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test("an Audible row outside the edition's ids is not a sibling: refused", async () => {
		const unrelated = row({ ...storeRow, id: 'B0NOTALIAS', asin: 'B0NOTALIAS' })
		await helperFor([unrelated, chaptarrRow]).search()
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test('a namer with no runtime cannot vouch for the recording: refused', async () => {
		const noRuntime = row({ ...chaptarrRow, audioSeconds: null })
		await helperFor([storeRow, noRuntime]).search()
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test('a store row with no runtime cannot be checked: refused', async () => {
		const noRuntime = row({ ...storeRow, audioSeconds: null })
		await helperFor([noRuntime, chaptarrRow]).search()
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test('an ISBN-derived identity is never moved', async () => {
		// 9781250230911 -> ISBN-10 1250230918, which IS in the edition's id list.
		const isbnNamer = row({
			...chaptarrRow,
			id: '1250230918',
			asin: '1250230918',
			asinAliases: [STORE]
		})
		await helperFor([storeRow, isbnNamer], { asin: undefined, isbn: '9781250230911' }).search()
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test('an ISBN-shaped hint is never moved, even when an edition lists it', async () => {
		// The listing privilege is B0-only (pinHasListingPrivilege): an ISBN names a
		// BOOK, and by the 2026-07-28 contract it ranks on its merits.
		const isbnNamer = row({
			...chaptarrRow,
			id: '1250230918',
			asin: '1250230918',
			asinAliases: [STORE]
		})
		await helperFor([storeRow, isbnNamer], { asin: '1250230918' }).search()
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test('an id a row merely LISTS is a dead pin before R1, and stays one', async () => {
		// Royal Assassin: the sidecar names B003NYOBOQ, which Chaptarr lists only as
		// a regional id of its edition B003NTPCVM -- also audible.com's listing. No
		// row carries the pin as its own asin, so it held no privilege, and R1 does
		// not mint one. The store listing still wins -- on its merits.
		const store = row({
			...storeRow,
			id: 'B003NTPCVM',
			asin: 'B003NTPCVM',
			title: 'Royal Assassin',
			narrators: ['Paul Boehmer'],
			audioSeconds: 105_420
		})
		const namer = row({
			...chaptarrRow,
			id: 'B003NTPCVM',
			asin: 'B003NTPCVM',
			title: 'Royal Assassin',
			asinAliases: ['B003NYOBOQ', 'B019HQZ9AS'],
			narrators: ['Paul Boehmer'],
			audioSeconds: 105_420
		})
		const ranked = await helperFor([store, namer], {
			title: 'Royal Assassin',
			author: 'Robin Hobb',
			duration: 105_424_800,
			asin: 'B003NYOBOQ'
		}).search()
		expect(ranked[0]?.asin).toBe('B003NTPCVM')
		expect(decision().pinPromotedToSibling).toBe(false)
		expect(decision().asinPinned).toBe(false)
	})

	test('a listed-only pin is not moved even with a store sibling in the pool', async () => {
		// The pin is one of the chaptarr row's regional ids, not its own asin, and
		// audible.com's listing IS among that row's ids -- so the only thing between
		// this pin and a minted 1.0 is the own-asin rule.
		const namer = row({
			...chaptarrRow,
			id: 'B0CHAPT001',
			asin: 'B0CHAPT001',
			asinAliases: [REGIONAL, STORE]
		})
		await helperFor([storeRow, namer]).search()
		expect(decision().pinPromotedToSibling).toBe(false)
	})

	test('the pin keeps its privilege on an ISBN-shaped store id (Peace Talks)', async () => {
		// audible.com sells Peace Talks as 0593290704. The pin moved onto it must
		// stay a pin: the first cut keyed privilege on the new id's SHAPE, lost it,
		// and a closer-runtime OverDrive row with no ASIN took #1.
		const store = row({
			...storeRow,
			id: '0593290704',
			asin: '0593290704',
			title: 'Peace Talks',
			narrators: ['James Marsters'],
			audioSeconds: 46_320
		})
		const namer = row({
			...chaptarrRow,
			id: 'B082YH6QL4',
			asin: 'B082YH6QL4',
			title: 'Peace Talks',
			asinAliases: ['0593290704'],
			narrators: ['James Marsters'],
			audioSeconds: 46_320
		})
		const overdrive = row({
			...store,
			provider: 'overdrive',
			id: 'overdrive-1',
			asin: null,
			audioSeconds: 46_352
		})
		const ranked = await helperFor([store, namer, overdrive], {
			title: 'Peace Talks',
			author: 'Jim Butcher',
			duration: 46_360_000,
			asin: 'B082YH6QL4'
		}).search()
		expect(ranked[0]?.asin).toBe('0593290704')
		expect(ranked[0]?.confidence).toBe(1)
		expect(decision().pinPromotedToSibling).toBe(true)
		expect(decision().asinPinned).toBe(true)
	})

	test('the move also runs on the widened pool', async () => {
		// A noisy album tag finds nothing; the clean track title finds both rows.
		const registry = {
			searchAll: async (q: { title: string }) =>
				q.title === 'Ninth House' ? [storeRow, chaptarrRow] : [],
			fetchCandidateByAsin: async () => null
		} as unknown as ProviderRegistry
		const ranked = await new BookSearchHelper(registry, {
			title: '16 Ninth House',
			trackTitle: 'Ninth House',
			author: 'Leigh Bardugo',
			region: 'us',
			duration: FILE_MS,
			asin: REGIONAL
		} as never).search()
		expect(ranked[0]?.asin).toBe(STORE)
		expect(decision().pinPromotedToSibling).toBe(true)
		expect(decision().widened).toBe(true)
	})

	test('two siblings: the closer runtime wins, then the smaller id', async () => {
		const near = row({
			...storeRow,
			id: 'B07LHC24PJ',
			asin: 'B07LHC24PJ',
			audioSeconds: 58_920 + 60
		})
		const exact = row({ ...storeRow })
		let ranked = await helperFor([near, exact, chaptarrRow]).search()
		expect(ranked[0]?.asin).toBe(STORE)
		const twin = row({ ...storeRow, id: 'B07LHC24PJ', asin: 'B07LHC24PJ' })
		ranked = await helperFor([twin, exact, chaptarrRow]).search()
		expect(ranked[0]?.asin).toBe(STORE) // B07LHB5ZJ6 < B07LHC24PJ
	})

	test('the response never carries asinAliases', async () => {
		// 45 s longer: 982.75 min rounds to another minute bucket, so dedupe keeps
		// the chaptarr row as its own group and it reaches the response -- the
		// shape that would ship its alias list if the search did not strip it.
		const separate = row({ ...chaptarrRow, audioSeconds: 58_920 + 45 })
		const ranked = await helperFor([storeRow, separate], { asin: undefined }).search()
		expect(ranked.some((c) => c.provider === 'chaptarr')).toBe(true)
		for (const c of ranked) expect('asinAliases' in c).toBe(false)
	})
})

describe('the pinned-edition injection stands down for a recording already here (spec-chaptarr-wire-drift)', () => {
	beforeEach(() => resetMatchMetrics())

	test('its store listing is in the pool: nothing injected, the store row wins on its merits', async () => {
		// Royal Assassin's shape once the variant rescue resolves again: the
		// sidecar names a regional id, the rescue returns the recording with its
		// to-the-second runtime -- which, injected, can out-rank the same
		// recording's whole-minute store row on closest runtime.
		const rescued = row({ ...chaptarrRow })
		const ranked = await helperFor([storeRow], {}, { [REGIONAL]: rescued }).search()
		expect(ranked.some((c) => c.provider === 'pinned')).toBe(false)
		expect(ranked[0]?.asin).toBe(STORE)
		// No privilege is minted from the fetch: the store row is not pinned.
		expect(decision().asinPinned).toBe(false)
	})

	test('a store row of a DIFFERENT recording does not stand the injection down', async () => {
		const rescued = row({ ...chaptarrRow })
		const other = row({ ...storeRow, audioSeconds: 58_920 + 91 })
		const ranked = await helperFor([other], {}, { [REGIONAL]: rescued }).search()
		expect(ranked.some((c) => c.provider === 'pinned')).toBe(true)
	})

	test('a rescued row that lists no store ids is injected as before', async () => {
		const rescued = row({ ...chaptarrRow, asinAliases: undefined })
		const ranked = await helperFor([storeRow], {}, { [REGIONAL]: rescued }).search()
		expect(ranked.some((c) => c.provider === 'pinned')).toBe(true)
	})
})

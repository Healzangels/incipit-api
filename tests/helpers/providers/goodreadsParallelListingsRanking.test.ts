import { afterEach, describe, expect, mock, test } from 'bun:test'

// Same transport mock as goodreadsSeries.test.ts: the REAL ranking runs over
// fixture payloads. This file covers the WIRING of parallelListingIds into the
// ranking pool; the extraction itself is covered in goodreadsParallelListings.test.ts.
const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { fetchGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')

function respond(...bodies: unknown[]) {
	fetchMock.mockReset()
	for (const body of bodies) fetchMock.mockImplementationOnce(() => Promise.resolve({ data: body }))
}

const members = (n: number) => Array.from({ length: n }, (_, i) => ({ ForeignWorkId: 1000 + i }))

// The live sentence, mirror 10.0.1.99:8788, 2026-09-05. Series IDS are per test:
// seriesRecord memoizes /series/{id} for the PROCESS lifetime, so a test that
// reuses another test's id gets that test's record -- description included --
// and the mocked fixture is never consumed. The first draft of the CONTROL below
// reused 41452 and "proved" the deny with a memo hit; the call-count assertions
// are what catch that (the same defence goodreadsSeries.test.ts uses).
const under = (id: number) =>
	`This series also receives a separate numbering and is combined with the <a href="https://www.goodreads.com/series/45182-tawny-man">Tawny Man</a> trilogy in French under the name: <a href="https://www.goodreads.com/series/${id}-l-assassin-royal">L'assassin royal</a>.`

const assassinsApprentice = (canonical: number, translation: number, workId: number) => ({
	Title: "Assassin's Apprentice",
	Series: [
		{
			Title: 'The Farseer Trilogy',
			ForeignId: canonical,
			LinkItems: [{ ForeignWorkId: workId, PositionInSeries: '1' }]
		},
		{
			Title: "L'Assassin royal",
			ForeignId: translation,
			LinkItems: [{ ForeignWorkId: workId, PositionInSeries: '1' }]
		}
	]
})

describe('parallel listings are denied in the RANKING, not only in the secondary slot', () => {
	afterEach(() => fetchMock.mockReset())

	test("a translation the canonical series links as 'under the name:' loses despite 25 members vs 7", async () => {
		// Arm B1 of the 2026-09-05 A/B: with the Elderlings umbrella demoted,
		// Assassin's Apprentice served `L'Assassin royal #1` -- the French listing
		// won on member count. Farseer's own description declares it a re-listing.
		respond(
			[{ workId: 171715 }],
			assassinsApprentice(41452, 89770, 171715),
			{ LinkItems: members(7), Description: under(89770) }, // Farseer
			{ LinkItems: members(25) } // L'Assassin royal
		)
		const out = await fetchGoodreadsSeries("Assassin's Apprentice", 'Robin Hobb')
		expect(out?.primary).toEqual({ name: 'The Farseer Trilogy', position: '1' })
		// search + work + BOTH /series records: the translation stays in the pool
		// long enough to be counted, and is removed by the deny, not by a filter.
		expect(fetchMock.mock.calls.length).toBe(4)
	})

	test('CONTROL: with no declaration, the same two candidates rank by member count and the translation wins', async () => {
		// Proves the deny is what decides the test above, not fixture order or a
		// tie-break: identical inputs minus the description flip the answer.
		respond(
			[{ workId: 271715 }],
			assassinsApprentice(141452, 189770, 271715),
			{ LinkItems: members(7) },
			{ LinkItems: members(25) }
		)
		const out = await fetchGoodreadsSeries("Assassin's Apprentice", 'Robin Hobb')
		expect(out?.primary?.name).toBe("L'Assassin royal")
		expect(fetchMock.mock.calls.length).toBe(4)
	})

	test('the deny never empties the ranking: when every candidate is denied, the order is kept', async () => {
		// A worse answer beats none. Two series that each declare the OTHER a
		// re-listing deny each other; the ranking must still return one of them.
		const A = 7001
		const B = 7002
		respond(
			[{ workId: 5 }],
			{
				Title: 'Mutual',
				Series: [
					{
						Title: 'Series A',
						ForeignId: A,
						LinkItems: [{ ForeignWorkId: 5, PositionInSeries: '1' }]
					},
					{
						Title: 'Series B',
						ForeignId: B,
						LinkItems: [{ ForeignWorkId: 5, PositionInSeries: '1' }]
					}
				]
			},
			{ LinkItems: members(9), Description: `Also known as: <a href="/series/${B}-b">B</a>` },
			{ LinkItems: members(4), Description: `Also known as: <a href="/series/${A}-a">A</a>` }
		)
		const out = await fetchGoodreadsSeries('Mutual', null)
		expect(out?.primary).toBeDefined()
		expect(['Series A', 'Series B']).toContain(out?.primary?.name)
	})

	test('a description never denies its OWN series, only the re-listings beside it', async () => {
		// The live Rain Wild Chronicles description, mirror 2026-09-05, reads
		// "Series also known as: * Rain Wild Chronicles * Cronache delle Giungle
		// delle Piogge [Italian]" -- an AKA block routinely lists EVERY name the
		// series goes by, the canonical one included. Those two entries carry no
		// href today; the moment a librarian links them, a deny that reads its own
		// declaration back drops the canonical shelf from its own ranking and hands
		// the book to the translation with the bigger member count -- the exact
		// outcome this deny exists to prevent.
		const RAIN_WILD = 8001
		const CRONACHE = 8002
		respond(
			[{ workId: 21457174 }],
			{
				Title: 'Dragon Haven',
				Series: [
					{
						Title: 'Rain Wild Chronicles',
						ForeignId: RAIN_WILD,
						LinkItems: [{ ForeignWorkId: 21457174, PositionInSeries: '2' }]
					},
					{
						Title: 'Cronache delle Giungle delle Piogge',
						ForeignId: CRONACHE,
						LinkItems: [{ ForeignWorkId: 21457174, PositionInSeries: '2' }]
					}
				]
			},
			{
				LinkItems: members(7),
				Description:
					`Series also known as:\n* <a href="/series/${RAIN_WILD}-rain-wild-chronicles">Rain Wild Chronicles</a>\n` +
					`* <a href="/series/${CRONACHE}-cronache-delle-giungle-delle-piogge">Cronache delle Giungle delle Piogge</a>`
			},
			{ LinkItems: members(12) }
		)
		const out = await fetchGoodreadsSeries('Dragon Haven', 'Robin Hobb')
		expect(out?.primary).toEqual({ name: 'Rain Wild Chronicles', position: '2' })
		expect(fetchMock.mock.calls.length).toBe(4)
	})

	test('the SECONDARY deny also ignores a description declaring itself', async () => {
		// Same bug one slot over. The secondary deny filters ranked.slice(1) by the
		// ids any description lists under "Also known as"; reading a series' own
		// declaration back removes it from the TAG slot the way the ranking deny
		// removed it from the SHELF. The sub-arc keeps its tag only if the deny
		// skips the declaring series itself.
		const PARENT = 8101
		const ARC = 8102
		respond(
			[{ workId: 4242 }],
			{
				Title: 'A Book',
				Series: [
					{
						Title: 'Parent Series',
						ForeignId: PARENT,
						LinkItems: [{ ForeignWorkId: 4242, PositionInSeries: '3' }]
					},
					{
						Title: 'Inner Arc',
						ForeignId: ARC,
						LinkItems: [{ ForeignWorkId: 4242, PositionInSeries: '1' }]
					}
				]
			},
			// Parent wins the ranking on member count and declares the arc as its own
			// sub-series, so the arc is allowed into the secondary slot...
			{
				LinkItems: members(20),
				Description: `Sub-series: <a href="/series/${ARC}-inner-arc">Inner Arc</a>`
			},
			// ...while the arc's OWN description says "Also known as: Inner Arc".
			{
				LinkItems: members(4),
				Description: `Also known as: <a href="/series/${ARC}-inner-arc">Inner Arc</a>`
			}
		)
		const out = await fetchGoodreadsSeries('A Book', 'Someone')
		expect(out?.primary).toEqual({ name: 'Parent Series', position: '3' })
		expect(out?.secondary).toEqual({ name: 'Inner Arc', position: '1' })
		expect(fetchMock.mock.calls.length).toBe(4)
	})

	test('a DUPLICATED re-listing (same name, different id than the one linked) is denied by name', async () => {
		// Fool's Errand, 2026-09-06: Tawny Man links O Regresso do Assassino as 65016; the
		// work carried 311441 under the same name. Fresh ids per test (process memo).
		const TAWNY = 345182
		const DUP = 311441
		respond(
			[{ workId: 2406151 }],
			{
				Title: "Fool's Errand",
				Series: [
					{
						Title: 'The Tawny Man',
						ForeignId: TAWNY,
						LinkItems: [{ ForeignWorkId: 2406151, PositionInSeries: '1' }]
					},
					{
						Title: 'O Regresso do Assassino',
						ForeignId: DUP,
						LinkItems: [{ ForeignWorkId: 2406151, PositionInSeries: '1' }]
					}
				]
			},
			{
				LinkItems: members(4),
				Description:
					'This trilogy has also been published with a different numbering in Portuguese, under the name: <a href="http://www.goodreads.com/series/65016-o-regresso-do-assassino">O Regresso do Assassino</a>'
			},
			{ LinkItems: members(5) }
		)
		const out = await fetchGoodreadsSeries("Fool's Errand", 'Robin Hobb')
		expect(out?.primary).toEqual({ name: 'The Tawny Man', position: '1' })
		expect(fetchMock.mock.calls.length).toBe(4)
	})

	test('CONTROL: when the linked name is a DIFFERENT listing, the duplicate is not denied and wins on count', async () => {
		const TAWNY = 445182
		const DUP = 411441
		respond(
			[{ workId: 3406151 }],
			{
				Title: "Fool's Errand",
				Series: [
					{
						Title: 'The Tawny Man',
						ForeignId: TAWNY,
						LinkItems: [{ ForeignWorkId: 3406151, PositionInSeries: '1' }]
					},
					{
						Title: 'O Regresso do Assassino',
						ForeignId: DUP,
						LinkItems: [{ ForeignWorkId: 3406151, PositionInSeries: '1' }]
					}
				]
			},
			{
				LinkItems: members(4),
				Description:
					'Also known as: <a href="/series/65099-something-else-entirely">Something Else Entirely</a>'
			},
			{ LinkItems: members(5) }
		)
		const out = await fetchGoodreadsSeries("Fool's Errand", 'Robin Hobb')
		expect(out?.primary?.name).toBe('O Regresso do Assassino')
		expect(fetchMock.mock.calls.length).toBe(4)
	})
})

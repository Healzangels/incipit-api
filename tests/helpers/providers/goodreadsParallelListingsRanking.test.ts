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

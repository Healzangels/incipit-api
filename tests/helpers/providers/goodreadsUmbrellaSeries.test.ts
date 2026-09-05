import { afterEach, describe, expect, mock, test } from 'bun:test'

// Same transport mock as goodreadsSeries.test.ts: the module is mocked at the
// import boundary, so the REAL ranking runs over fixture payloads.
const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { fetchGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')

function respond(...bodies: unknown[]) {
	fetchMock.mockReset()
	for (const body of bodies) fetchMock.mockImplementationOnce(() => Promise.resolve({ data: body }))
}

// Operator-declared umbrella ids from UMBRELLA_SERIES. These are the live
// Goodreads ids; a test that used made-up ids would exercise nothing.
const ELDERLINGS = 54099 // The Realm of the Elderlings
const HOLLY_GIBNEY = 318697 // Holly Gibney

describe('UMBRELLA_SERIES: franchise umbrellas declared by Goodreads series id', () => {
	afterEach(() => fetchMock.mockReset())

	test('a declared umbrella LOSES to a smaller clean sub-series, even though it has more members', async () => {
		// Measured live 2026-09-05 (work 21457174, Dragon Haven): The Realm of the
		// Elderlings, 25 members, #11 -- versus Rain Wild Chronicles, 7 members, #2.
		// Member-count ranking hands the shelf to the umbrella; the declaration
		// drops it from the clean pool before the count is even asked for.
		respond(
			[{ workId: 21457174 }],
			{
				Title: 'Dragon Haven',
				Series: [
					{
						Title: 'The Realm of the Elderlings',
						ForeignId: ELDERLINGS,
						LinkItems: [{ ForeignWorkId: 21457174, PositionInSeries: '11' }]
					},
					{
						Title: 'Rain Wild Chronicles',
						ForeignId: 49413,
						LinkItems: [{ ForeignWorkId: 21457174, PositionInSeries: '2' }]
					}
				]
			},
			// Only the clean survivor's /series record is fetched: the umbrella
			// never enters the pool, so its 25 members are never consulted.
			{ LinkItems: Array.from({ length: 7 }, (_, i) => ({ ForeignWorkId: i })) }
		)
		const out = await fetchGoodreadsSeries('Dragon Haven', 'Robin Hobb')
		expect(out?.primary).toEqual({ name: 'Rain Wild Chronicles', position: '2' })
		expect(out?.primary?.name).not.toBe('The Realm of the Elderlings')
		// search + work + ONE /series call. A fourth call would mean the umbrella
		// was still in the pool being counted.
		expect(fetchMock.mock.calls.length).toBe(3)
	})

	test("a declared umbrella that is a book's ONLY series still shelves it (rescued, never blanked)", async () => {
		// The Outsider lists Holly Gibney alone. Holly Gibney is declared because it
		// umbrellas the Bill Hodges trilogy (Mr. Mercedes must shelve Bill Hodges),
		// but declaring it must not strip The Outsider -- the shelf-layer container
		// list would have; the ranking-layer rescue path does not.
		respond([{ workId: 57566471 }], {
			Title: 'The Outsider',
			Series: [
				{
					Title: 'Holly Gibney',
					ForeignId: HOLLY_GIBNEY,
					LinkItems: [{ ForeignWorkId: 57566471, PositionInSeries: '1' }]
				}
			]
		})
		const out = await fetchGoodreadsSeries('The Outsider', 'Stephen King')
		expect(out?.primary).toEqual({ name: 'Holly Gibney', position: '1' })
		// The umbrella-only answer is flagged so the apply path spends no clean
		// provider series on it -- exactly as a -verse umbrella is flagged today.
		expect(out?.variantOnly).toBe(true)
	})

	test('the same umbrella loses when a positioned sub-series is present (Bill Hodges over Holly Gibney)', async () => {
		// Arm A of the 2026-09-05 A/B: Mr. Mercedes served `Holly Gibney #0.1` with
		// pins off -- 7 members beat 3. One declaration fixes this AND keeps The
		// Outsider above; that pair is the whole argument for demote-not-remove.
		respond(
			[{ workId: 18775247 }],
			{
				Title: 'Mr. Mercedes',
				Series: [
					{
						Title: 'Holly Gibney',
						ForeignId: HOLLY_GIBNEY,
						LinkItems: [{ ForeignWorkId: 18775247, PositionInSeries: '0.1' }]
					},
					{
						Title: 'Bill Hodges',
						ForeignId: 137422,
						LinkItems: [{ ForeignWorkId: 18775247, PositionInSeries: '1' }]
					}
				]
			},
			{ LinkItems: Array.from({ length: 3 }, (_, i) => ({ ForeignWorkId: i })) }
		)
		const out = await fetchGoodreadsSeries('Mr. Mercedes', 'Stephen King')
		expect(out?.primary).toEqual({ name: 'Bill Hodges', position: '1' })
	})
})

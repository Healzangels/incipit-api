import { afterEach, describe, expect, it, mock } from 'bun:test'

// Section 12 of docs/design/spec-shelf-titles-across-the-board.md. The secondary
// (tag) slot takes the first ranked series the filters keep -- NOT always
// ranked[1]: a non-Latin, alias-denied or out-of-arc candidate is skipped. The
// display rename used to read ranked[1]'s record anyway, so ANOTHER listing's
// declared alias renamed the tag. A routing mock: the ranking reads one /series
// record per candidate, and what matters is which record the rename reads.
process.env.GOODREADS_MIN_GAP_MS = '0'

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { withGoodreadsSeries, resetGoodreadsThrottle } =
	await import('#helpers/providers/goodreadsSeries')

function route(routes: Record<string, unknown>) {
	fetchMock.mockReset()
	fetchMock.mockImplementation((url: string) => {
		const u = new URL(url)
		const key = u.pathname + u.search
		const hit = Object.keys(routes).find(
			(k) => key === k || (k.endsWith('*') && key.startsWith(k.slice(0, -1)))
		)
		return hit
			? Promise.resolve({ data: routes[hit] })
			: Promise.reject(new Error(`unrouted ${key}`))
	})
}

/** A /series record with `count` members and the given description. */
const record = (count: number, description = '') => ({
	Description: description,
	LinkItems: Array.from({ length: count }, (_, i) => ({ ForeignWorkId: 900000 + i }))
})

describe('the secondary tag is renamed from its OWN series record', () => {
	afterEach(() => {
		fetchMock.mockReset()
		resetGoodreadsThrottle()
	})

	it("a skipped listing's declared alias never renames the tag", async () => {
		// Discworld #4 (41 members) wins; the Russian re-listing (30) ranks second
		// but is skipped as non-Latin, so the tag is the sub-arc "Discworld - Death".
		// The Russian listing declares an English alias -- read from the wrong record,
		// it renamed the sub-arc to "Discworld Novels".
		route({
			'/search*': [{ workId: 46001 }],
			'/work/46001': {
				Title: 'Mort',
				Authors: [{ Name: 'Terry Pratchett' }],
				Series: [
					{
						Title: 'Discworld',
						ForeignId: 46100,
						LinkItems: [{ ForeignWorkId: 46001, PositionInSeries: '4' }]
					},
					{
						Title: 'Плоский мир',
						ForeignId: 46101,
						LinkItems: [{ ForeignWorkId: 46001, PositionInSeries: '4' }]
					},
					{
						Title: 'Discworld - Death',
						ForeignId: 46102,
						LinkItems: [{ ForeignWorkId: 46001, PositionInSeries: '1' }]
					}
				]
			},
			'/series/46100': record(41),
			'/series/46101': record(30, 'Also known as:\n- Discworld Novels (English)\n\nThe series.'),
			'/series/46102': record(5)
		})
		const out = (await withGoodreadsSeries(
			{ title: 'Mort', authors: [{ name: 'Terry Pratchett' }] } as never,
			null
		)) as { seriesPrimary?: unknown; seriesSecondary?: unknown }
		expect(out.seriesPrimary).toEqual({ name: 'Discworld', position: '4' })
		expect(out.seriesSecondary).toEqual({ name: 'Discworld - Death', position: '1' })
	})
})

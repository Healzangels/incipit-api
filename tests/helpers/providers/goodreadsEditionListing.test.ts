import { afterEach, describe, expect, it, mock } from 'bun:test'

// Q1, decided 2026-09-24: an EDITION listing (split volume, omnibus, box set,
// "... Edition") never shelves a book on its own. A reading ORDER still does --
// the operator chose that for Hornblower on 2026-09-08. Same transport mock as
// the other resolver suites, so the REAL apply path runs over fixture payloads.
// See docs/design/spec-shelf-titles-across-the-board.md, section 8.
const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { isEditionListing, isSeriesOrdering, withGoodreadsSeries } = await import(
	'#helpers/providers/goodreadsSeries'
)

function respond(...bodies: unknown[]) {
	fetchMock.mockReset()
	for (const body of bodies) fetchMock.mockImplementationOnce(() => Promise.resolve({ data: body }))
}

describe('isEditionListing', () => {
	it('names printings, not reading orders', () => {
		for (const name of [
			'Under the Dome Split-Volume',
			'Needful Things (Split-Volume)',
			'The Expanse (omnibus)',
			'Harry Potter Box Set',
			'The English Edition'
		])
			expect(isEditionListing(name)).toBe(true)
		for (const name of [
			'Hornblower Saga: Chronological Order',
			'A Jack Ryan Novel (publication order)',
			'The Expeditionary Force',
			'Order of the Centurion',
			'Discworld'
		])
			expect(isEditionListing(name)).toBe(false)
	})

	it('is a strict subset of the ordering vocabulary', () => {
		// Held together on purpose: an edition listing the RANKING did not also
		// demote could win outright on member count, and this refusal only ever
		// sees answers the ranking already marked variant-only.
		for (const name of [
			'Under the Dome Split-Volume',
			'Needful Things (Split-Volume)',
			'The Expanse (omnibus)',
			'Harry Potter Box Set',
			'The English Edition'
		])
			expect(isSeriesOrdering(name)).toBe(true)
	})
})

// Per-test work and series ids: seriesRecord memoizes /series/{id} per process.
const onlyListing = (workId: number, seriesId: number, title: string, series: string, position: string) => ({
	Title: title,
	Series: [{ Title: series, ForeignId: seriesId, LinkItems: [{ ForeignWorkId: workId, PositionInSeries: position }] }]
})

describe('the apply path never shelves a book by an edition listing alone', () => {
	afterEach(() => fetchMock.mockReset())

	it('Under the Dome: a standalone whose only listing is its split edition gets no series', async () => {
		// Live since July: the primary work carries no series, the split-volume
		// EDITION work carries "Under the Dome Split-Volume", and with no provider
		// series nothing refused it -- prod shelved "Under the Dome Split-Volume,
		// Book 1 - Under the Dome".
		respond(
			[{ workId: 935554137 }],
			onlyListing(935554137, 9101, 'Under the Dome', 'Under the Dome Split-Volume', '1'),
			{ LinkItems: [], Description: '' }
		)
		const out = (await withGoodreadsSeries(
			{ title: 'Under the Dome', authors: [{ name: 'Stephen King' }] } as never,
			null
		)) as { seriesPrimary?: unknown }
		expect(out.seriesPrimary ?? null).toBeNull()
	})

	it('CONTROL: a book whose only listing is a READING ORDER still shelves by it', async () => {
		// The operator's 2026-09-08 decision, which this rule must not undo.
		respond(
			[{ workId: 935554138 }],
			onlyListing(935554138, 9102, 'Lieutenant Hornblower', 'Hornblower Saga: Chronological Order', '2'),
			{ LinkItems: [], Description: '' }
		)
		const out = (await withGoodreadsSeries(
			{ title: 'Lieutenant Hornblower', authors: [{ name: 'C. S. Forester' }] } as never,
			null
		)) as { seriesPrimary?: unknown }
		expect(out.seriesPrimary).toEqual({ name: 'Hornblower Saga: Chronological Order', position: '2' })
	})

	it('an ORDERING provider series is kept rather than released to an edition listing', async () => {
		// Without this rule, O1 releases an ordering incumbent to any variant-only
		// answer -- including a split edition, which is worse than what it replaces.
		respond(
			[{ workId: 935554139 }],
			onlyListing(935554139, 9103, 'Insomnia', 'Insomnia Split-Volume', '1'),
			{ LinkItems: [], Description: '' }
		)
		const out = (await withGoodreadsSeries(
			{
				title: 'Insomnia',
				authors: [{ name: 'Stephen King' }],
				seriesPrimary: { name: 'Stephen King (publication order)', position: '24' }
			} as never,
			null
		)) as { seriesPrimary?: unknown }
		expect(out.seriesPrimary).toEqual({ name: 'Stephen King (publication order)', position: '24' })
	})
})

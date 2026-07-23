import { afterEach, describe, expect, mock, test } from 'bun:test'

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { fetchGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')

/** Queue responses in call order; a `null` entry makes that call reject. */
function respond(...bodies: Array<unknown | null>) {
	fetchMock.mockReset()
	for (const body of bodies) {
		if (body === null) fetchMock.mockImplementationOnce(() => Promise.reject(new Error('boom')))
		else fetchMock.mockImplementationOnce(() => Promise.resolve({ data: body }))
	}
}

const work = (over: Record<string, unknown> = {}) => ({
	Title: 'The Grief of Stones',
	Series: [
		{
			Title: 'The Cemeteries of Amalo',
			LinkItems: [
				{ ForeignWorkId: 999, PositionInSeries: '9', SeriesPosition: 9 },
				{ ForeignWorkId: 42, PositionInSeries: '2', SeriesPosition: 2 }
			]
		}
	],
	...over
})

describe('goodreads series enrichment', () => {
	afterEach(() => fetchMock.mockReset())

	test('returns the series and the position of OUR work', async () => {
		respond([{ workId: 42 }], work())
		const out = await fetchGoodreadsSeries('The Grief of Stones', 'Katherine Addison')
		// Position 2 is ours; 9 belongs to a different member of the same series.
		// Reading LinkItems[0] would have returned someone else's number.
		expect(out).toEqual({ primary: { name: 'The Cemeteries of Amalo', position: '2' } })
	})

	test('refuses a work whose title is not ours', async () => {
		// /search is fuzzy and will return a different book in the same universe.
		// Attaching that book's series would mis-shelve ours while looking
		// authoritative, so an unverified answer must be discarded entirely.
		respond([{ workId: 42 }], work({ Title: 'An Entirely Different Novel' }))
		expect(await fetchGoodreadsSeries('The Grief of Stones', 'Katherine Addison')).toBeNull()
	})

	test('returns null when the work carries no series', async () => {
		respond([{ workId: 42 }], work({ Series: [] }))
		expect(await fetchGoodreadsSeries('The Grief of Stones', null)).toBeNull()
	})

	test('never throws when the service is down', async () => {
		// Enrichment is best-effort: an outage must not fail the request that
		// asked for it, it must just leave the field as empty as it found it.
		respond(null)
		expect(await fetchGoodreadsSeries('The Grief of Stones', null)).toBeNull()
	})

	test('prefers the PARENT series (more members) over its sub-series', async () => {
		// Not the Goodreads "Primary" flag -- measured against how this operator
		// organizes by hand, the parent is the wanted shelf (Chronicles of Osreth
		// over Cemeteries of Amalo). The parent is the container, so it has more
		// members; the ranking asks /series/{id} for each count.
		respond(
			[{ workId: 42 }],
			work({
				Series: [
					{ Title: 'Sub Series', ForeignId: 1, LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }] },
					{ Title: 'Parent Series', ForeignId: 2, LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '7' }] }
				]
			}),
			{ LinkItems: Array.from({ length: 4 }, (_, i) => i) }, // Sub: 4 members
			{ LinkItems: Array.from({ length: 9 }, (_, i) => i) } // Parent: 9 members
		)
		const out = await fetchGoodreadsSeries('The Grief of Stones', null)
		expect(out?.primary).toEqual({ name: 'Parent Series', position: '7' })
		// The sub-series is still carried, so a consumer that disagrees can use it.
		expect(out?.secondary).toEqual({ name: 'Sub Series', position: '1' })
	})

	test('omits position when the work has no link of its own', async () => {
		// A series naming only OTHER members tells us nothing about our position,
		// and inventing one would mis-order the shelf.
		respond(
			[{ workId: 42 }],
			work({
				Series: [
					{
						Title: 'Someone Elses Series',
						LinkItems: [
							{ ForeignWorkId: 111, PositionInSeries: '1' },
							{ ForeignWorkId: 222, PositionInSeries: '2' }
						]
					}
				]
			})
		)
		const out = await fetchGoodreadsSeries('The Grief of Stones', null)
		expect(out?.primary).toEqual({ name: 'Someone Elses Series' })
	})
})

	describe('parent-series preference', () => {
		// A work in a sub-series, its parent, and a variant. The variant has the
		// most members but is an edition listing; the parent has more members than
		// the sub. Order: search, work, then one /series/{id} per pooled series.
		const multi = () => ({
			Title: 'The Grief of Stones',
			Series: [
				{ Title: 'The Cemeteries of Amalo', ForeignId: 1,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '2' }] },
				{ Title: 'The Chronicles of Osreth', ForeignId: 2,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '3' }] },
				{ Title: 'Osreth Omnibus Edition', ForeignId: 3,
					LinkItems: [{ ForeignWorkId: 42, PositionInSeries: '1' }] }
			]
		})
		// member-count responses, in ForeignId order of the CLEAN pool (1 then 2)
		const members = (n) => ({ LinkItems: Array.from({ length: n }, (_, i) => i) })

		test('prefers the parent (more members) among clean series', async () => {
			// clean pool = Cemeteries(1), Osreth(2); the Omnibus Edition is excluded
			respond([{ workId: 42 }], multi(), members(6), members(9))
			const out = await fetchGoodreadsSeries('The Grief of Stones', null)
			expect(out?.primary).toEqual({ name: 'The Chronicles of Osreth', position: '3' })
			expect(out?.secondary).toEqual({ name: 'The Cemeteries of Amalo', position: '2' })
		})

		test('excludes an edition/ordering variant even when it is largest', async () => {
			// If the variant filter were off, Omnibus(#1) with a huge count could win.
			respond([{ workId: 42 }], multi(), members(6), members(9))
			const out = await fetchGoodreadsSeries('The Grief of Stones', null)
			expect(out?.primary?.name).not.toContain('Omnibus')
			expect(out?.secondary?.name).not.toContain('Omnibus')
		})
	})

describe('withGoodreadsSeries enrichment wrapper', () => {
	const fakeRedis = () => {
		const store = new Map<string, string>()
		return {
			store,
			get: (k: string) => Promise.resolve(store.get(k) ?? null),
			set: (k: string, v: string) => {
				store.set(k, v)
				return Promise.resolve('OK')
			}
		}
	}

	test('leaves a book that already has a series untouched (no lookup)', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		fetchMock.mockReset()
		const redis = fakeRedis()
		const book = {
			title: 'Some Book',
			authors: [{ name: 'Someone' }],
			seriesPrimary: { name: 'Existing Series', position: '3' }
		}
		const out = await withGoodreadsSeries(book, redis)
		expect(out.seriesPrimary).toEqual({ name: 'Existing Series', position: '3' })
		// The provider's series is authoritative -- nothing was fetched or cached.
		expect(fetchMock).not.toHaveBeenCalled()
		expect(redis.store.size).toBe(0)
	})

	test('fills a missing series from Goodreads and caches it', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond([{ workId: 42 }], work())
		const redis = fakeRedis()
		const book = { title: 'The Grief of Stones', authors: [{ name: 'Katherine Addison' }] }
		const out = await withGoodreadsSeries(book, redis)
		expect(out.seriesPrimary).toEqual({ name: 'The Cemeteries of Amalo', position: '2' })

		// Second call is served from cache -- no further upstream fetches.
		fetchMock.mockReset()
		const again = await withGoodreadsSeries(book, redis)
		expect(again.seriesPrimary).toEqual({ name: 'The Cemeteries of Amalo', position: '2' })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('remembers a MISS so it is not re-fetched every refresh', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond([]) // /search returns nothing -> null result
		const redis = fakeRedis()
		const book = { title: 'Standalone Novel', authors: [{ name: 'Nobody' }] }
		const first = await withGoodreadsSeries(book, redis)
		expect(first.seriesPrimary).toBeUndefined()

		fetchMock.mockReset()
		const second = await withGoodreadsSeries(book, redis)
		expect(second.seriesPrimary).toBeUndefined()
		// The cached miss short-circuits before any upstream call.
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('never fails the response when the lookup throws', async () => {
		const { withGoodreadsSeries } = await import('#helpers/providers/goodreadsSeries')
		respond(null) // /search rejects
		const book = { title: 'Some Book', authors: [{ name: 'Someone' }] }
		const out = await withGoodreadsSeries(book, null)
		expect(out).toEqual(book)
	})
})

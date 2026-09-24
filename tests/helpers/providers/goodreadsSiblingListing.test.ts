import { afterEach, describe, expect, it, mock } from 'bun:test'

// S1, 2026-09-24: the sibling-listing fallback. When the title+author search
// adopts nothing, a hit credited to OUR author that the title gate turned away --
// a sibling -- names a listing, and its numbered members are tried under the
// strict title gate and every other gate a hit faces.
// See docs/design/spec-shelf-titles-across-the-board.md, section 10.
//
// A ROUTING transport mock, not a response queue: the fallback adds requests only
// on a miss, and what these tests pin is exactly which requests a lookup makes.
process.env.GOODREADS_MIN_GAP_MS = '0'

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { withGoodreadsSeries, resetGoodreadsThrottle } =
	await import('#helpers/providers/goodreadsSeries')

type Routes = Record<string, unknown>
/**
 * Serve each request from `routes` by path+query (a key ending in `*` matches a
 * prefix); a path in `fail`, or one not routed at all, is a failed call.
 */
function route(routes: Routes, fail: readonly string[] = []) {
	fetchMock.mockReset()
	fetchMock.mockImplementation((url: string) => {
		const u = new URL(url)
		const key = u.pathname + u.search
		if (fail.includes(u.pathname)) return Promise.reject(new Error(`failed ${key}`))
		const hit = Object.keys(routes).find(
			(k) => key === k || (k.endsWith('*') && key.startsWith(k.slice(0, -1)))
		)
		return hit
			? Promise.resolve({ data: routes[hit] })
			: Promise.reject(new Error(`unrouted ${key}`))
	})
}
const requested = () => fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)
const workReads = () => requested().filter((p) => p.startsWith('/work/'))
const listingReads = () => requested().filter((p) => p.startsWith('/series/'))

/** A /work record for work `id`, credited to `author`, in `series` at `position`. */
const work = (
	id: number,
	title: string,
	author: string | null,
	series?: [string, number, string]
) => ({
	Title: title,
	Authors: author ? [{ Name: author }] : [],
	Series: series
		? [
				{
					Title: series[0],
					ForeignId: series[1],
					LinkItems: [{ ForeignWorkId: id, PositionInSeries: series[2] }]
				}
			]
		: []
})
/** A /series listing: [workId, position] pairs. */
const listing = (title: string, members: Array<[number, string]>) => ({
	Title: title,
	Description: '',
	LinkItems: members.map(([id, position]) => ({ ForeignWorkId: id, PositionInSeries: position }))
})

const BALDACCI = 'David Baldacci'
const book = (over: Record<string, unknown> = {}) =>
	({
		title: 'King and Maxwell',
		authors: [{ name: BALDACCI }],
		seriesPrimary: { name: 'King and Maxwell', position: '6' },
		...over
	}) as never

// Every test gets its own ids: seriesRecord memoizes /series per process.
/** King and Maxwell's search as measured: junk, a companion, two siblings; never the book. */
function kingRoutes(sid: number, overrides: Routes = {}): Routes {
	return {
		'/search*': [
			{ workId: 1 },
			{ workId: 2 },
			{ workId: 3 },
			{ workId: sid + 4 },
			{ workId: sid + 5 }
		],
		'/work/1': work(
			1,
			'REVIEW of King And Maxwell by David Baldacci -- Sibling Summary',
			'BookBuddy'
		),
		'/work/2': work(2, 'Book Review', 'Expert Book Reviews'),
		'/work/3': work(3, 'King And Maxwell (King & Maxwell)', 'BookBuddy'),
		[`/work/${sid + 4}`]: work(sid + 4, 'Split Second', BALDACCI, [
			'Sean King & Michelle Maxwell',
			sid,
			'1'
		]),
		[`/work/${sid + 5}`]: work(sid + 5, 'The Sixth Man', BALDACCI, [
			'Sean King & Michelle Maxwell',
			sid,
			'5'
		]),
		[`/series/${sid}`]: listing('Sean King & Michelle Maxwell', [
			[sid + 4, '1'],
			[sid + 12, '2'],
			[sid + 13, '3'],
			[sid + 14, '4'],
			[sid + 5, '5'],
			[sid + 16, '6'],
			[sid + 17, '1-3']
		]),
		[`/work/${sid + 12}`]: work(sid + 12, 'Hour Game', BALDACCI, [
			'Sean King & Michelle Maxwell',
			sid,
			'2'
		]),
		[`/work/${sid + 13}`]: work(sid + 13, 'Simple Genius', BALDACCI, [
			'Sean King & Michelle Maxwell',
			sid,
			'3'
		]),
		[`/work/${sid + 14}`]: work(sid + 14, 'First Family', BALDACCI, [
			'Sean King & Michelle Maxwell',
			sid,
			'4'
		]),
		[`/work/${sid + 16}`]: work(sid + 16, 'King and Maxwell', BALDACCI, [
			'Sean King & Michelle Maxwell',
			sid,
			'6'
		]),
		...overrides
	}
}
const kingAndMaxwell = (sid: number, overrides: Routes = {}) => route(kingRoutes(sid, overrides))

describe('the sibling-listing fallback', () => {
	afterEach(() => {
		fetchMock.mockReset()
		resetGoodreadsThrottle()
	})

	it('King and Maxwell: a book the search never returns is found in its sibling listing', async () => {
		kingAndMaxwell(43100)
		const out = (await withGoodreadsSeries(book(), null)) as { seriesPrimary?: unknown }
		expect(out.seriesPrimary).toEqual({ name: 'Sean King & Michelle Maxwell', position: '6' })
		// The listing once; then its unseen numbered members in order until the book.
		expect(listingReads()).toEqual(['/series/43100'])
		expect(workReads().slice(5)).toEqual([
			'/work/43112',
			'/work/43113',
			'/work/43114',
			'/work/43116'
		])
	})

	it('CONTROL: a book the search finds never reads a listing', async () => {
		route({
			'/search*': [{ workId: 43216 }, { workId: 43204 }],
			'/work/43216': work(43216, 'King and Maxwell', BALDACCI, [
				'Sean King & Michelle Maxwell',
				43200,
				'6'
			])
		})
		const out = (await withGoodreadsSeries(book(), null)) as { seriesPrimary?: unknown }
		expect(out.seriesPrimary).toEqual({ name: 'Sean King & Michelle Maxwell', position: '6' })
		// One /work: the hit itself, no listing member. (The one /series read is the
		// adopted series' own record, which the display-name rename reads for every
		// answer -- not a listing.)
		expect(workReads()).toEqual(['/work/43216'])
		expect(requested()).toEqual(['/search', '/work/43216', '/series/43200'])
	})

	it('CONTROL: siblings credited to someone else name no listing', async () => {
		kingAndMaxwell(43300, {
			'/work/43304': work(43304, 'Split Second', 'Someone Else', [
				'Sean King & Michelle Maxwell',
				43300,
				'1'
			]),
			'/work/43305': work(43305, 'The Sixth Man', 'Someone Else', [
				'Sean King & Michelle Maxwell',
				43300,
				'5'
			])
		})
		const out = (await withGoodreadsSeries(book(), null)) as { seriesPrimary?: unknown }
		expect(out.seriesPrimary).toEqual({ name: 'King and Maxwell', position: '6' })
		expect(listingReads()).toEqual([])
	})

	it('CONTROL: a sibling with no author data names no listing', async () => {
		// The author gate forgives absent credits; the sibling test does not --
		// absence proves nothing about whose listing a work sits in.
		kingAndMaxwell(43400, {
			'/work/43404': work(43404, 'Split Second', null, [
				'Sean King & Michelle Maxwell',
				43400,
				'1'
			]),
			'/work/43405': work(43405, 'The Sixth Man', null, [
				'Sean King & Michelle Maxwell',
				43400,
				'5'
			])
		})
		await withGoodreadsSeries(book(), null)
		expect(listingReads()).toEqual([])
	})

	it('an ordering or umbrella a sibling sits in names no listing', async () => {
		kingAndMaxwell(43500, {
			'/work/43504': work(43504, 'Split Second', BALDACCI, [
				'David Baldacci (publication order)',
				43500,
				'9'
			]),
			'/work/43505': work(43505, 'The Sixth Man', BALDACCI, ['Baldacciverse', 43501, '5'])
		})
		await withGoodreadsSeries(book(), null)
		expect(listingReads()).toEqual([])
	})

	it('a listing member still faces the author gate', async () => {
		kingAndMaxwell(43600, {
			'/work/43616': work(43616, 'King and Maxwell', 'BookBuddy', [
				'Sean King & Michelle Maxwell',
				43600,
				'6'
			])
		})
		const out = (await withGoodreadsSeries(book(), null)) as { seriesPrimary?: unknown }
		expect(out.seriesPrimary).toEqual({ name: 'King and Maxwell', position: '6' })
	})

	it('a listing member must match our FULL title: the relaxed arms stay off', async () => {
		// The candidate-stem arm scores "King and Maxwell: The Graphic Novel" at 1.0
		// against our title. In a listing of siblings that is exactly the false
		// accept the strict gate exists to stop.
		kingAndMaxwell(43700, {
			'/work/43716': work(43716, 'King and Maxwell: The Graphic Novel', BALDACCI, [
				'Sean King & Michelle Maxwell',
				43700,
				'6'
			])
		})
		const out = (await withGoodreadsSeries(book(), null)) as { seriesPrimary?: unknown }
		expect(out.seriesPrimary).toEqual({ name: 'King and Maxwell', position: '6' })
	})

	it('a degraded search pass never reads a listing', async () => {
		// The review record's /work fails: the pass did not see every candidate, so
		// its miss is not a miss -- and the fallback must not act on it.
		route(kingRoutes(43800), ['/work/1'])
		await withGoodreadsSeries(book(), null)
		expect(listingReads()).toEqual([])
	})

	it('the member at our own volume marker is tried first', async () => {
		kingAndMaxwell(43900)
		const out = (await withGoodreadsSeries(
			book({ subtitle: 'Sean King & Michelle Maxwell, Book 6' }),
			null
		)) as { seriesPrimary?: unknown }
		expect(out.seriesPrimary).toEqual({ name: 'Sean King & Michelle Maxwell', position: '6' })
		expect(workReads().slice(5)).toEqual(['/work/43916'])
	})

	it('the stem retry never reads a listing: a bare stem would adopt the sibling named for it', async () => {
		// "Ahriman: Exile" misses and its first pass reads the listing -- no member
		// carries its full title. The stem retry then searches "Ahriman", and a
		// listing read THERE would strict-match book 1, titled exactly "Ahriman",
		// and shelve Exile in book 1's slot. First pass only.
		route({
			'/search*': [{ workId: 44102 }],
			'/work/44102': work(44102, 'Ahriman: Sorcerer', 'John French', ['Ahriman', 44100, '2']),
			'/series/44100': listing('Ahriman', [
				[44101, '1'],
				[44102, '2'],
				[44103, '3']
			]),
			'/work/44101': work(44101, 'Ahriman', 'John French', ['Ahriman', 44100, '1']),
			'/work/44103': work(44103, 'Ahriman: Unchanged', 'John French', ['Ahriman', 44100, '3'])
		})
		const out = (await withGoodreadsSeries(
			{ title: 'Ahriman: Exile', authors: [{ name: 'John French' }] } as never,
			null
		)) as { seriesPrimary?: unknown }
		expect(out.seriesPrimary ?? null).toBeNull()
		expect(workReads().filter((p) => p === '/work/44101')).toHaveLength(1)
	})

	it('reads at most eight listing members', async () => {
		const members: Array<[number, string]> = Array.from({ length: 12 }, (_, i) => [
			44020 + i,
			String(i + 10)
		])
		const routes: Routes = {
			'/search*': [{ workId: 44004 }],
			'/work/44004': work(44004, 'Split Second', BALDACCI, [
				'Sean King & Michelle Maxwell',
				44000,
				'1'
			]),
			'/series/44000': listing('Sean King & Michelle Maxwell', [[44004, '1'], ...members])
		}
		for (const [id, position] of members)
			routes[`/work/${id}`] = work(id, `Another Book ${position}`, BALDACCI, [
				'Sean King & Michelle Maxwell',
				44000,
				position
			])
		route(routes)
		await withGoodreadsSeries(book(), null)
		expect(workReads().length).toBe(1 + 8)
	})
})

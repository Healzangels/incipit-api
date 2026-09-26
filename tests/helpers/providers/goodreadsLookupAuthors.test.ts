import { afterEach, describe, expect, it, mock } from 'bun:test'

import { fakeRedis } from '#tests/setup/fakeRedis'

// Q-author, 2026-09-24: the Goodreads lookup searches for, and gates on, PEOPLE.
// Audible's credit list also carries combined pen-name credits ("Andrews &
// Wilson") and role credits ("Stephen King - introduction"), and puts either one
// first as readily as an author -- and the first credit is the /search query
// author. Same transport mock as the other resolver suites, so the REAL lookup
// runs over fixture payloads.
// See docs/design/spec-shelf-titles-across-the-board.md, section 9.
process.env.GOODREADS_MIN_GAP_MS = '0'

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const {
	lookupAuthors,
	withGoodreadsSeries,
	resetGoodreadsThrottle,
	queryAuthor,
	fetchGoodreadsAuthorInfo
} = await import('#helpers/providers/goodreadsSeries')

function respond(...bodies: unknown[]) {
	fetchMock.mockReset()
	for (const body of bodies) fetchMock.mockImplementationOnce(() => Promise.resolve({ data: body }))
}

/** Every /search the lookup sent, in order. */
const searches = () =>
	fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/search?q='))

const searchFor = (text: string) => `/search?q=${encodeURIComponent(text)}`

/** A /work payload placing work 42 in `series` at `position`, credited to `author`. */
const work = (title: string, series: string, position: string, author: string) => ({
	Title: title,
	Authors: [{ Name: author }],
	Series: [{ Title: series, LinkItems: [{ ForeignWorkId: 42, PositionInSeries: position }] }]
})

const credits = (...names: string[]) => names.map((name) => ({ name }))

describe('lookupAuthors', () => {
	it('drops a combined credit whose every part is another credit on the list', () => {
		// The Adversary as Audible lists it since November 2025.
		expect(lookupAuthors(['Andrews & Wilson', 'Brian Andrews', 'Jeffrey Wilson'])).toEqual([
			'Brian Andrews',
			'Jeffrey Wilson'
		])
		// Ember: the same two people, joined by a semicolon, listed last.
		expect(
			lookupAuthors(['Jeffrey Wilson', 'Brian Andrews', 'Brian Andrews; Jeffrey Wilson'])
		).toEqual(['Jeffrey Wilson', 'Brian Andrews'])
		expect(
			lookupAuthors(['Lincoln Child and Douglas Preston', 'Douglas Preston', 'Lincoln Child'])
		).toEqual(['Douglas Preston', 'Lincoln Child'])
	})

	it('keeps a combined credit that names someone the list does not', () => {
		// Nothing better to search by: the credit is all the list says.
		expect(lookupAuthors(['Andrews & Wilson'])).toEqual(['Andrews & Wilson'])
		expect(lookupAuthors(['Andrews & Wilson', 'Brian Andrews'])).toEqual([
			'Andrews & Wilson',
			'Brian Andrews'
		])
	})

	it("drops an editor's credit like any other role", () => {
		// An editor's name searches the anthology's Goodreads work, whose story
		// series then win the ranking (Heroic Hearts -> Darkest Powers #3.4). A
		// role-only list has no person left, so it comes back as given -- and
		// searches exactly as it did before role credits were recognised.
		expect(lookupAuthors(['Jim Butcher - editor', 'Kerrie Hughes - editor'])).toEqual([
			'Jim Butcher - editor',
			'Kerrie Hughes - editor'
		])
		expect(lookupAuthors(['John Scalzi - editor', 'Jay Lake', 'Elizabeth Bear'])).toEqual([
			'Jay Lake',
			'Elizabeth Bear'
		])
		expect(
			lookupAuthors(['Christopher Tolkien - editor', 'J. R. R. Tolkien', 'Christopher Tolkien'])
		).toEqual(['J. R. R. Tolkien', 'Christopher Tolkien'])
		// Unfettered, as Audible lists it: the editor mid-list, behind the authors.
		expect(lookupAuthors(['Terry Brooks', 'Shawn Speakman - editor', 'Peter V. Brett'])).toEqual([
			'Terry Brooks',
			'Peter V. Brett'
		])
	})

	it('drops a credit for introducing, translating or illustrating the book', () => {
		// Nightmare at 20,000 Feet: Stephen King wrote its introduction, and is
		// ALSO listed plainly -- once is enough.
		expect(
			lookupAuthors(['Stephen King - introduction', 'Richard Matheson', 'Stephen King'])
		).toEqual(['Richard Matheson', 'Stephen King'])
		expect(
			lookupAuthors(['Leo Tolstoy', 'Louise Maude - translator', 'Aylmer Maude - translator'])
		).toEqual(['Leo Tolstoy'])
		// The Godfather: three roles, one of them the survey's lone "note".
		expect(
			lookupAuthors([
				'Mario Puzo',
				'Francis Ford Coppola - introduction',
				'Anthony Puzo - note',
				'Robert J. Thompson - afterword'
			])
		).toEqual(['Mario Puzo'])
	})

	it('returns a list with nothing to change exactly as it came in', () => {
		// The inertness the A/B relies on: same names, same order, so the query,
		// the author gate and the cache key of every such book are unchanged.
		for (const list of [
			['Lincoln Child', 'Douglas Preston'],
			['Brandon Sanderson'],
			['Jean-Paul Sartre'],
			['Ilona Andrews'],
			['Jason Anspach', 'Nick Cole'],
			['Andrews & Wilson']
		])
			expect(lookupAuthors(list)).toEqual(list)
	})

	it('falls back to the credits as given when no person survives', () => {
		// A list of translators alone still names someone to search by.
		expect(lookupAuthors(['Louise Maude - translator'])).toEqual(['Louise Maude - translator'])
		expect(lookupAuthors([])).toEqual([])
		expect(lookupAuthors([null, '  ', undefined])).toEqual([])
	})
})

describe('the Goodreads lookup searches for a person', () => {
	afterEach(() => {
		fetchMock.mockReset()
		resetGoodreadsThrottle()
	})

	it('The Adversary: a combined first credit is not the search author', async () => {
		// Measured on the mirror: "The Adversary Andrews & Wilson" returns ZERO
		// hits, "The Adversary Brian Andrews" returns the work -- credited to
		// "Brian  Andrews", in Tier One at 9. With no hit the book fell to its
		// provider's "The Tier One Thrillers" beside nine siblings on "Tier One".
		respond([{ workId: 42 }], work('The Adversary', 'Tier One', '9', 'Brian  Andrews'))
		const out = (await withGoodreadsSeries(
			{
				title: 'The Adversary',
				authors: credits('Andrews & Wilson', 'Brian Andrews', 'Jeffrey Wilson'),
				seriesPrimary: { name: 'The Tier One Thrillers', position: '9' }
			} as never,
			fakeRedis()
		)) as { seriesPrimary?: unknown }
		expect(searches()[0]).toContain(searchFor('The Adversary Brian Andrews'))
		expect(out.seriesPrimary).toEqual({ name: 'Tier One', position: '9' })
	})

	it('the combined credit does not change the cache entry', async () => {
		// The record the API holds today, then the same record after the update
		// sweep stores Audible's new list: one entry, so the refetch cannot send
		// a shelf through a fresh lookup at all.
		const redis = fakeRedis()
		respond([{ workId: 42 }], work('The Adversary', 'Tier One', '9', 'Brian  Andrews'))
		await withGoodreadsSeries(
			{
				title: 'The Adversary',
				authors: credits('Brian Andrews', 'Jeffrey Wilson'),
				seriesPrimary: { name: 'The Tier One Thrillers', position: '9' }
			} as never,
			redis
		)
		fetchMock.mockReset()
		const out = (await withGoodreadsSeries(
			{
				title: 'The Adversary',
				authors: credits('Andrews & Wilson', 'Brian Andrews', 'Jeffrey Wilson'),
				seriesPrimary: { name: 'The Tier One Thrillers', position: '9' }
			} as never,
			redis
		)) as { seriesPrimary?: unknown }
		expect(fetchMock).not.toHaveBeenCalled()
		expect(out.seriesPrimary).toEqual({ name: 'Tier One', position: '9' })
	})

	it('a role credit listed first is not the search author', async () => {
		respond([])
		await withGoodreadsSeries(
			{
				title: 'Nightmare at 20,000 Feet',
				authors: credits('Stephen King - introduction', 'Richard Matheson', 'Stephen King')
			} as never,
			fakeRedis()
		)
		expect(searches()[0]).toContain(searchFor('Nightmare at 20,000 Feet Richard Matheson'))
	})

	it('Heroic Hearts: an editor-only anthology searches exactly as it always did', async () => {
		// Recorded: "Heroic Hearts Jim Butcher - editor" finds nothing, and the book
		// is shelved by its pin alone. With the role cut off, "Heroic Hearts Jim
		// Butcher" returned work 85291724 -- one series per contributor's story --
		// and the ranking answered Darkest Powers #3.4 with an "Heirs of
		// Chicagoland" tag, which leaked past the pin as a Series: mood.
		respond([])
		const out = (await withGoodreadsSeries(
			{
				title: 'Heroic Hearts',
				authors: credits('Jim Butcher - editor', 'Kerrie Hughes - editor')
			} as never,
			fakeRedis()
		)) as { seriesPrimary?: unknown }
		expect(searches()[0]).toContain(searchFor('Heroic Hearts Jim Butcher - editor'))
		expect(out.seriesPrimary ?? null).toBeNull()
	})

	it('CONTROL: the introducer alone does not open the author gate', async () => {
		// Credited to the introducer only: a positive mismatch with the book's
		// author, rejected exactly as it was when the role credit could never match.
		respond([{ workId: 42 }], work('Nightmare at 20,000 Feet', 'Some Series', '1', 'Stephen King'))
		const out = (await withGoodreadsSeries(
			{
				title: 'Nightmare at 20,000 Feet',
				authors: credits('Richard Matheson', 'Stephen King - introduction')
			} as never,
			fakeRedis()
		)) as { seriesPrimary?: unknown }
		expect(out.seriesPrimary ?? null).toBeNull()
	})

	it('CONTROL: a plain credit list searches exactly as before', async () => {
		respond([])
		await withGoodreadsSeries(
			{ title: 'Cemetery Dance', authors: credits('Lincoln Child', 'Douglas Preston') } as never,
			fakeRedis()
		)
		expect(searches()[0]).toContain(searchFor('Cemetery Dance Lincoln Child'))
	})
})

// K1, 2026-09-25 (spec-shelf-titles-across-the-board section 13): the mirror's
// /search finds NOTHING for "A Quiet Life in the Country T E Kinsey" and the
// work for "... T. E. Kinsey" -- so every T. E. Kinsey book kept its provider's
// series name, Chaptarr's "Lady Hardcastle Mysteries" or Audible's "A Lady
// Hardcastle Mystery", and a re-match onto the Audible listing split the shelf.
describe('K1: a bare initial is dotted in the search query', () => {
	afterEach(() => {
		fetchMock.mockReset()
		resetGoodreadsThrottle()
	})

	it('dots bare initials and leaves every other name as it came', () => {
		expect(queryAuthor('T E Kinsey')).toBe('T. E. Kinsey')
		expect(queryAuthor('Duncan M Hamilton')).toBe('Duncan M. Hamilton')
		expect(queryAuthor('J R R Tolkien')).toBe('J. R. R. Tolkien')
		for (const name of [
			'T.E. Kinsey',
			'J. R. R. Tolkien',
			'C.S. Lewis',
			'George R. R. Martin',
			'Brian Andrews',
			'Malcolm X'
		])
			expect(queryAuthor(name)).toBe(name)
		expect(queryAuthor(null)).toBeNull()
	})

	/** The mirror as measured: the undotted query finds nothing, the dotted one the work. */
	function mirror() {
		fetchMock.mockImplementation((url: string) => {
			const u = String(url)
			if (u.includes(searchFor('A Quiet Life in the Country T. E. Kinsey')))
				return Promise.resolve({ data: [{ workId: 42 }] })
			if (u.includes('/search?q=')) return Promise.resolve({ data: [] })
			if (u.includes('/work/42'))
				return Promise.resolve({
					data: work('A Quiet Life in the Country', 'Lady Hardcastle Mysteries', '1', 'T.E. Kinsey')
				})
			return Promise.resolve({ data: null })
		})
	}

	it("the Audible record takes Goodreads' shelf name instead of Audible's", async () => {
		mirror()
		const out = (await withGoodreadsSeries(
			{
				title: 'A Quiet Life in the Country',
				subtitle: 'A Lady Hardcastle Mystery, Book 1',
				authors: credits('T E Kinsey'),
				seriesPrimary: { name: 'A Lady Hardcastle Mystery', position: '1' }
			} as never,
			fakeRedis()
		)) as { seriesPrimary?: { name: string; position?: string } }
		expect(searches()[0]).toContain(searchFor('A Quiet Life in the Country T. E. Kinsey'))
		expect(out.seriesPrimary).toEqual({ name: 'Lady Hardcastle Mysteries', position: '1' })
	})

	it('the author portrait search is dotted the same way', async () => {
		fetchMock.mockImplementation(() => Promise.resolve({ data: [] }))
		await fetchGoodreadsAuthorInfo('T E Kinsey')
		expect(searches()[0]).toContain('/search?q=' + encodeURIComponent('T. E. Kinsey'))
	})
})

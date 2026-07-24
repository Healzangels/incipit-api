import { describe, expect, test } from 'bun:test'

import LibriVoxProvider, { type LibriVoxFetch } from '#helpers/providers/LibriVoxProvider'
import { decodeProviderId, encodeLibrivox } from '#helpers/providers/providerId'

// A LibriVox search record, shaped as the live API returns it (verified against
// librivox.org/api/feed/audiobooks): authors split into first/last, runtime in
// totaltimesecs, language as an English NAME, and no artwork field at all.
const prideAndPrejudice = {
	id: '253',
	title: 'Pride and Prejudice',
	description:
		'<em>Pride and Prejudice</em> is the most famous of Jane Austen&nbsp;novels.<br />(Wikipedia)',
	language: 'English',
	copyright_year: '1813',
	num_sections: '37',
	totaltime: '13:06:44',
	totaltimesecs: 47204,
	url_librivox: 'https://librivox.org/pride-and-prejudice-by-jane-austen/',
	authors: [{ id: '155', first_name: 'Jane', last_name: 'Austen' }]
}

const search =
	(books: unknown[]): LibriVoxFetch =>
	async () => ({ books })

const q = { title: 'Pride and Prejudice', author: 'Jane Austen', region: 'us' }

describe('LibriVoxProvider search', () => {
	test('maps a record to a candidate with runtime, author and language', async () => {
		const p = new LibriVoxProvider({ fetchLibriVox: search([prideAndPrejudice]) })
		const [c] = await p.search(q)
		expect(c.provider).toBe('librivox')
		expect(c.id).toBe('librivox-253')
		expect(c.asin).toBeNull() // public domain: no store listing
		expect(c.title).toBe('Pride and Prejudice')
		expect(c.authors).toEqual(['Jane Austen']) // first + last joined
		expect(c.audioSeconds).toBe(47204)
		expect(c.language).toBe('en') // "English" normalized
		expect(c.cover).toBeNull() // the API exposes no artwork
	})

	test('the id round-trips through the provider-id codec', () => {
		expect(decodeProviderId(encodeLibrivox(253))).toEqual({
			provider: 'librivox',
			kind: 'book',
			nativeId: '253'
		})
	})

	test('treats totaltimesecs 0 as NO runtime, not a zero-length book', async () => {
		// Live: a second "Pride and Prejudice" listing reports 0. Passing that
		// through as a real runtime would make the duration veto compare against
		// nothing and reject the correct match.
		const p = new LibriVoxProvider({
			fetchLibriVox: search([{ ...prideAndPrejudice, id: '22765', totaltimesecs: 0 }])
		})
		const [c] = await p.search(q)
		expect(c.audioSeconds).toBeNull()
	})

	test('searches by TITLE only — sending author too is a 500 from this API', async () => {
		let seen = ''
		const p = new LibriVoxProvider({
			fetchLibriVox: async (url) => {
				seen = url
				return { books: [] }
			}
		})
		await p.search(q)
		expect(seen).toContain('title=Pride+and+Prejudice')
		expect(seen).not.toContain('author=')
		// extended=1 costs ~13x the payload and only adds readers, which fetchBook
		// asks for once, for the record that actually won.
		expect(seen).not.toContain('extended=')
	})

	test('retries without a leading article, which LibriVox catalogues away', async () => {
		// Live: "The Time Machine" is a hard 404 -- the catalogue stores it as
		// "Time Machine". Three of four classics tested needed this to resolve.
		const urls: string[] = []
		const p = new LibriVoxProvider({
			fetchLibriVox: async (url) => {
				urls.push(url)
				// First attempt (with the article) 404s the way the real API does.
				if (urls.length === 1) throw new Error('Request failed with status 404')
				return { books: [{ ...prideAndPrejudice, id: '817', title: 'Time Machine' }] }
			}
		})
		const out = await p.search({ title: 'The Time Machine', region: 'us' })
		expect(out).toHaveLength(1)
		expect(out[0].title).toBe('Time Machine')
		expect(urls).toHaveLength(2)
		expect(urls[0]).toContain('title=The+Time+Machine')
		expect(urls[1]).toContain('title=Time+Machine')
	})

	test('does NOT re-query when the exact title already worked', async () => {
		// Additive, like the Audible keyword fallback: a working search is untouched.
		let calls = 0
		const p = new LibriVoxProvider({
			fetchLibriVox: async () => {
				calls += 1
				return { books: [prideAndPrejudice] }
			}
		})
		await p.search({ title: 'The Wind in the Willows', region: 'us' })
		expect(calls).toBe(1)
	})

	test('a title with no leading article is only tried once', async () => {
		let calls = 0
		const p = new LibriVoxProvider({
			fetchLibriVox: async () => {
				calls += 1
				throw new Error('Request failed with status 404')
			}
		})
		expect(await p.search({ title: 'Moby Dick', region: 'us' })).toEqual([])
		expect(calls).toBe(1)
	})

	test('tolerates an author with only one name half', async () => {
		const p = new LibriVoxProvider({
			fetchLibriVox: search([{ ...prideAndPrejudice, authors: [{ last_name: 'Homer' }] }])
		})
		const [c] = await p.search(q)
		expect(c.authors).toEqual(['Homer'])
	})

	test('returns [] on a transport failure rather than throwing', async () => {
		const p = new LibriVoxProvider({
			fetchLibriVox: async () => {
				throw new Error('down')
			}
		})
		expect(await p.search(q)).toEqual([])
	})

	test('returns [] for an empty title and for a non-list payload', async () => {
		const p = new LibriVoxProvider({ fetchLibriVox: search([prideAndPrejudice]) })
		expect(await p.search({ title: '', region: 'us' })).toEqual([])
		const odd = new LibriVoxProvider({ fetchLibriVox: async () => ({ books: 'nope' }) })
		expect(await odd.search(q)).toEqual([])
	})
})

describe('LibriVoxProvider fetchBook', () => {
	// extended=1 adds `sections`, each with its own readers. LibriVox recordings
	// are frequently collaborative, so this is a CAST, not one narrator.
	const extended = {
		...prideAndPrejudice,
		sections: [
			{ id: '1', readers: [{ reader_id: '168', display_name: 'Chris Goringe' }] },
			{ id: '2', readers: [{ reader_id: '99', display_name: 'Elisabeth Shields' }] },
			{ id: '3', readers: [{ reader_id: '168', display_name: 'Chris Goringe' }] }
		]
	}

	test('resolves the reader cast, stripped description and language', async () => {
		const p = new LibriVoxProvider({ fetchLibriVox: search([extended]) })
		const b = await p.fetchBook('253', 'book', { region: 'us' })
		expect(b?.title).toBe('Pride and Prejudice')
		expect(b?.authors).toEqual([{ name: 'Jane Austen' }])
		// Deduped across sections, order preserved.
		expect(b?.narrators).toEqual([{ name: 'Chris Goringe' }, { name: 'Elisabeth Shields' }])
		expect(b?.summary).toBe(
			'Pride and Prejudice is the most famous of Jane Austen novels.\n(Wikipedia)'
		)
		expect(b?.asin).toBeNull()
		expect(b?.publisherName).toBe('LibriVox')
		expect(b?.language).toBe('en')
	})

	test('asks for extended=1, which is what carries the readers', async () => {
		let seen = ''
		const p = new LibriVoxProvider({
			fetchLibriVox: async (url) => {
				seen = url
				return { books: [extended] }
			}
		})
		await p.fetchBook('253', 'book', { region: 'us' })
		expect(seen).toContain('id=253')
		expect(seen).toContain('extended=1')
	})

	test('a book with no sections simply has no narrators', async () => {
		const p = new LibriVoxProvider({ fetchLibriVox: search([prideAndPrejudice]) })
		const b = await p.fetchBook('253', 'book', { region: 'us' })
		expect(b?.narrators).toEqual([])
	})

	test('returns null on a transport failure or an unknown id', async () => {
		const dead = new LibriVoxProvider({
			fetchLibriVox: async () => {
				throw new Error('down')
			}
		})
		expect(await dead.fetchBook('253', 'book', { region: 'us' })).toBeNull()
		const empty = new LibriVoxProvider({ fetchLibriVox: search([]) })
		expect(await empty.fetchBook('999999', 'book', { region: 'us' })).toBeNull()
	})
})

import { describe, expect, test } from 'bun:test'

import OpenLibraryProvider, {
	type OpenLibraryDoc,
	type OpenLibraryFetch,
	titleCaseSentence
} from '#helpers/providers/OpenLibraryProvider'

const spellDoc: OpenLibraryDoc = {
	key: '/works/OL80870W',
	title: 'A Spell for Chameleon',
	author_name: ['Piers Anthony'],
	first_publish_year: 1987,
	cover_i: 6453925
}

describe('OpenLibraryProvider', () => {
	test('maps a doc to a book-level candidate with a cover URL and no audio data', async () => {
		const fetchDocs: OpenLibraryFetch = async () => [spellDoc]
		const p = new OpenLibraryProvider({ fetchDocs })
		const out = await p.search({ title: 'A Spell for Chameleon', region: 'us' })
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({
			provider: 'openlibrary',
			id: 'openlibrary-works-OL80870W',
			title: 'A Spell for Chameleon',
			authors: ['Piers Anthony'],
			narrators: [],
			audioSeconds: null,
			cover: 'https://covers.openlibrary.org/b/id/6453925-L.jpg'
		})
	})

	test("title-cases OpenLibrary's sentence-cased titles (Cube route -> Cube Route)", async () => {
		const fetchDocs: OpenLibraryFetch = async () => [
			{ key: '/works/OL1W', title: 'Cube route', author_name: ['Piers Anthony'] },
			{ key: '/works/OL2W', title: 'heaven cent', author_name: ['Piers Anthony'] }
		]
		const out = await new OpenLibraryProvider({ fetchDocs }).search({
			title: 'Cube Route',
			region: 'us'
		})
		expect(out.map((c) => c.title)).toEqual(['Cube Route', 'Heaven Cent'])
	})

	test('retries on the pre-subtitle stem when the full title misses', async () => {
		// "...: A Jack Ryan Novel" returns nothing; the stem returns a hit.
		const seen: string[] = []
		const fetchDocs: OpenLibraryFetch = async (params) => {
			seen.push(params.title)
			return params.title === 'The Hunt for Red October'
				? [
						{
							key: '/works/OL159452W',
							title: 'The Hunt for Red October',
							author_name: ['Tom Clancy']
						}
					]
				: []
		}
		const p = new OpenLibraryProvider({ fetchDocs })
		const out = await p.search({
			title: 'The Hunt for Red October: A Jack Ryan Novel',
			region: 'us'
		})
		expect(seen).toEqual([
			'The Hunt for Red October: A Jack Ryan Novel',
			'The Hunt for Red October'
		])
		expect(out).toHaveLength(1)
		expect(out[0].title).toBe('The Hunt for Red October')
	})

	test('retries on the stem before an " - " suffix too', async () => {
		const seen: string[] = []
		const fetchDocs: OpenLibraryFetch = async (params) => {
			seen.push(params.title)
			return params.title === 'The Butcher of Anderson Station' ? [spellDoc] : []
		}
		const p = new OpenLibraryProvider({ fetchDocs })
		await p.search({
			title: 'The Butcher of Anderson Station - An Expanse Novella',
			region: 'us'
		})
		expect(seen[1]).toBe('The Butcher of Anderson Station')
	})

	test('does not retry when the full title already returns results', async () => {
		let calls = 0
		const fetchDocs: OpenLibraryFetch = async () => {
			calls++
			return [spellDoc]
		}
		const p = new OpenLibraryProvider({ fetchDocs })
		await p.search({ title: 'A Spell for Chameleon: Xanth', region: 'us' })
		expect(calls).toBe(1)
	})

	test('emits a null cover when the doc has no cover_i', async () => {
		const fetchDocs: OpenLibraryFetch = async () => [{ key: '/works/OL1W', title: 'No Cover' }]
		const p = new OpenLibraryProvider({ fetchDocs })
		const out = await p.search({ title: 'No Cover', region: 'us' })
		expect(out[0].cover).toBeNull()
	})

	test('passes the author through to the fetch', async () => {
		let seenAuthor: string | undefined
		const fetchDocs: OpenLibraryFetch = async (params) => {
			seenAuthor = params.author
			return [spellDoc]
		}
		const p = new OpenLibraryProvider({ fetchDocs })
		await p.search({ title: 'A Spell for Chameleon', author: 'Piers Anthony', region: 'us' })
		expect(seenAuthor).toBe('Piers Anthony')
	})

	test('returns [] for an empty title', async () => {
		const p = new OpenLibraryProvider({ fetchDocs: async () => [spellDoc] })
		expect(await p.search({ title: '', region: 'us' })).toEqual([])
	})
})

describe('titleCaseSentence', () => {
	test('title-cases a sentence-cased title, keeping small words lowercase', () => {
		expect(titleCaseSentence('cube route')).toBe('Cube Route')
		expect(titleCaseSentence('heaven cent')).toBe('Heaven Cent')
		expect(titleCaseSentence('the color of magic')).toBe('The Color of Magic')
		// First-capital-only is still sentence case -> title-cased.
		expect(titleCaseSentence('Cube route')).toBe('Cube Route')
	})

	test('leaves an already-cased title, an acronym, or intentional casing untouched', () => {
		// Interior capitals -> not sentence case -> returned as-is.
		expect(titleCaseSentence('A Spell for Chameleon')).toBe('A Spell for Chameleon')
		expect(titleCaseSentence('The Hunt for Red October')).toBe('The Hunt for Red October')
		expect(titleCaseSentence('Esrever Doom: A Fun-Filled Adventure')).toBe(
			'Esrever Doom: A Fun-Filled Adventure'
		)
		expect(titleCaseSentence('NASA and the Moon')).toBe('NASA and the Moon')
	})

	test('handles empty and single-word input', () => {
		expect(titleCaseSentence('')).toBe('')
		expect(titleCaseSentence('dune')).toBe('Dune')
	})
})

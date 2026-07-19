import { describe, expect, test } from 'bun:test'

import HardcoverProvider, { type HardcoverGql } from '#helpers/providers/HardcoverProvider'
import type { BookSearchQuery } from '#helpers/providers/types'

// Canned responses mirror the real Hardcover shapes verified live during Gate 0:
// a two-step search -> books, with audio editions (reading_format_id 2) carrying
// asin, audio_seconds, a 2400x2400 cached_image, and a "Narrator" contribution.
function gqlWith(searchIds: number[], books: unknown): HardcoverGql {
	return async <T>(query: string): Promise<T> => {
		if (query.includes('search(')) return { search: { ids: searchIds } } as T
		return { books } as T
	}
}

const projectHailMary = {
	id: 427578,
	title: 'Project Hail Mary',
	cached_image: { url: 'https://assets.hardcover.app/book-cover.jpg' },
	contributions: [{ author: { name: 'Andy Weir' }, contribution: null }],
	editions: [
		{
			id: 31501578,
			asin: 'B08GB58KD5',
			audio_seconds: 58200,
			cached_image: { url: 'https://assets.hardcover.app/edition/audio.jpg' },
			contributions: [
				{ author: { name: 'Andy Weir' }, contribution: null },
				{ author: { name: 'Ray Porter' }, contribution: 'Narrator' }
			]
		}
	]
}

// A Xanth-shaped book: found, but no audio edition.
const castleRoogna = {
	id: 100,
	title: 'Castle Roogna',
	cached_image: { url: 'https://assets.hardcover.app/xanth.jpg' },
	contributions: [{ author: { name: 'Piers Anthony' }, contribution: null }],
	editions: []
}

const baseQuery: BookSearchQuery = { title: 'x', region: 'us', credentials: { hardcover: 'tok' } }

describe('HardcoverProvider', () => {
	test('maps an audio edition to a candidate with asin, duration, narrator and square cover', async () => {
		const p = new HardcoverProvider({ gql: gqlWith([427578], [projectHailMary]) })
		const out = await p.search({ ...baseQuery, title: 'Project Hail Mary' })
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({
			provider: 'hardcover',
			// id routes data fetches back to Hardcover, never to the ASIN.
			id: 'hardcover-edition-31501578',
			asin: 'B08GB58KD5',
			title: 'Project Hail Mary',
			authors: ['Andy Weir'],
			narrators: ['Ray Porter'],
			audioSeconds: 58200,
			cover: 'https://assets.hardcover.app/edition/audio.jpg'
		})
	})

	test('keeps an audiobook edition that has no audio_seconds (square cover, not book-level)', async () => {
		// Tolkien's "The Fall of Gondolin" case: a real audiobook edition with no
		// audio_seconds — must still be an edition candidate (its square cover +
		// narrator), not fall back to the print book cover.
		const noDuration = {
			...projectHailMary,
			editions: [{ ...projectHailMary.editions[0], audio_seconds: null }]
		}
		const out = await new HardcoverProvider({ gql: gqlWith([1], [noDuration]) }).search({
			...baseQuery,
			title: 'Project Hail Mary'
		})
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('hardcover-edition-31501578')
		expect(out[0].audioSeconds).toBeNull()
		expect(out[0].narrators).toEqual(['Ray Porter'])
		expect(out[0].cover).toBe('https://assets.hardcover.app/edition/audio.jpg')
	})

	test('a book with no audio edition yields a book-level candidate (no narrator, no asin, book cover)', async () => {
		const p = new HardcoverProvider({ gql: gqlWith([100], [castleRoogna]) })
		const out = await p.search({ ...baseQuery, title: 'Castle Roogna' })
		expect(out).toHaveLength(1)
		expect(out[0]).toMatchObject({
			provider: 'hardcover',
			id: 'hardcover-book-100',
			title: 'Castle Roogna',
			authors: ['Piers Anthony'],
			narrators: [],
			audioSeconds: null,
			cover: 'https://assets.hardcover.app/xanth.jpg'
		})
	})

	test('emits one candidate per audio edition so duration can disambiguate', async () => {
		const twoEditions = {
			...projectHailMary,
			editions: [
				projectHailMary.editions[0],
				{ ...projectHailMary.editions[0], id: 999, asin: 'B08G9PRS1K', audio_seconds: 58253 }
			]
		}
		const p = new HardcoverProvider({ gql: gqlWith([427578], [twoEditions]) })
		const out = await p.search({ ...baseQuery, title: 'Project Hail Mary' })
		expect(out).toHaveLength(2)
		expect(out.map((c) => c.audioSeconds)).toEqual([58200, 58253])
	})

	test('prefers the region-language edition; falls back to all when none match', async () => {
		const mixed = {
			...projectHailMary,
			editions: [
				{ ...projectHailMary.editions[0], id: 1, language: { language: 'French' } },
				{ ...projectHailMary.editions[0], id: 2, language: { language: 'English' } }
			]
		}
		const en = await new HardcoverProvider({ gql: gqlWith([1], [mixed]) }).search({
			...baseQuery,
			title: 'Project Hail Mary'
		})
		expect(en).toHaveLength(1)
		expect(en[0].id).toBe('hardcover-edition-2')

		// No English edition -> keep what we have rather than drop the book.
		const frOnly = {
			...projectHailMary,
			editions: [{ ...projectHailMary.editions[0], id: 3, language: { language: 'French' } }]
		}
		const fallback = await new HardcoverProvider({ gql: gqlWith([1], [frOnly]) }).search({
			...baseQuery,
			title: 'Project Hail Mary'
		})
		expect(fallback).toHaveLength(1)
		expect(fallback[0].id).toBe('hardcover-edition-3')
	})

	test('falls back to the edition id when an audio edition has no asin', async () => {
		const noAsin = {
			...projectHailMary,
			editions: [{ ...projectHailMary.editions[0], asin: null }]
		}
		const p = new HardcoverProvider({ gql: gqlWith([427578], [noAsin]) })
		const out = await p.search({ ...baseQuery, title: 'Project Hail Mary' })
		expect(out[0].id).toBe('hardcover-edition-31501578')
	})

	test('returns [] and does not call the API when no token is available', async () => {
		let called = false
		const p = new HardcoverProvider({
			gql: async () => {
				called = true
				return {} as never
			}
		})
		const out = await p.search({ title: 'Dune', region: 'us' })
		expect(out).toEqual([])
		expect(called).toBe(false)
	})

	test('prefers a per-request token over the env default', async () => {
		let seenToken = ''
		const gql: HardcoverGql = async <T>(
			query: string,
			_v: Record<string, unknown>,
			token: string
		): Promise<T> => {
			seenToken = token
			if (query.includes('search(')) return { search: { ids: [] } } as T
			return { books: [] } as T
		}
		const p = new HardcoverProvider({ token: 'env-token', gql })
		await p.search({ ...baseQuery, credentials: { hardcover: 'user-token' } })
		expect(seenToken).toBe('user-token')
	})

	test('returns [] when search finds no ids', async () => {
		const p = new HardcoverProvider({ gql: gqlWith([], []) })
		const out = await p.search({ ...baseQuery, title: 'zzzznotabook' })
		expect(out).toEqual([])
	})
})

describe('HardcoverProvider.fetchBook', () => {
	// Route by operation name: the exact-edition lookup, then the book lookup.
	function fetchGql(edition: unknown, book: unknown): HardcoverGql {
		return async <T>(query: string): Promise<T> => {
			if (query.includes('IncipitEditionFull')) return { editions: edition ? [edition] : [] } as T
			if (query.includes('IncipitBook')) return { books: book ? [book] : [] } as T
			return {} as T
		}
	}

	const matchedEdition = {
		id: 31501578,
		book_id: 427578,
		asin: 'B08GB58KD5',
		audio_seconds: 58200,
		reading_format_id: 2,
		release_date: '2021-05-04',
		cached_image: { url: 'https://assets.hardcover.app/edition/audio.jpg' },
		publisher: { name: 'Audible Studios' },
		contributions: [
			{ author: { name: 'Andy Weir' }, contribution: null },
			{ author: { name: 'Ray Porter' }, contribution: 'Narrator' }
		]
	}

	// The parent book, whose OWN editions list is led by an unrelated, more-popular
	// PRINT edition — exactly what the old code re-picked and applied by mistake.
	const parentBook = {
		id: 427578,
		title: 'Project Hail Mary',
		description: 'A lone astronaut.',
		rating: 4.5,
		cached_image: { url: 'https://assets.hardcover.app/book-cover.jpg' },
		contributions: [{ author: { name: 'Andy Weir' }, contribution: null }],
		book_series: [],
		editions: [
			{
				id: 999,
				asin: 'PRINTASIN0',
				reading_format_id: 1, // print
				release_date: '1999-01-01',
				cached_image: { url: 'https://assets.hardcover.app/print.jpg' },
				publisher: { name: 'Paperback Co' }
			}
		]
	}

	test('applies the MATCHED edition, not a popularity re-pick of the book editions', async () => {
		const p = new HardcoverProvider({ gql: fetchGql(matchedEdition, parentBook) })
		const book = await p.fetchBook('31501578', 'edition', { region: 'us', credentials: { hardcover: 'tok' } })
		// asin/date/cover/publisher/narrators come from the matched AUDIO edition,
		// never the print edition that leads the book's own editions list.
		expect(book?.asin).toBe('B08GB58KD5')
		expect(book?.releaseDate).toBe('2021-05-04')
		expect(book?.image).toBe('https://assets.hardcover.app/edition/audio.jpg')
		expect(book?.publisherName).toBe('Audible Studios')
		expect(book?.narrators).toEqual([{ name: 'Ray Porter' }])
		// Book-level fields still come from the book.
		expect(book?.title).toBe('Project Hail Mary')
		expect(book?.authors).toEqual([{ name: 'Andy Weir' }])
	})

	test('returns null when the edition is not found', async () => {
		const p = new HardcoverProvider({ gql: fetchGql(null, parentBook) })
		expect(
			await p.fetchBook('404', 'edition', { region: 'us', credentials: { hardcover: 'tok' } })
		).toBeNull()
	})

	test('a book-level id still resolves via the book pick', async () => {
		const p = new HardcoverProvider({ gql: fetchGql(null, parentBook) })
		const book = await p.fetchBook('427578', 'book', { region: 'us', credentials: { hardcover: 'tok' } })
		expect(book?.title).toBe('Project Hail Mary')
		// Only a print edition exists on the book, so it's the fallback pick.
		expect(book?.asin).toBe('PRINTASIN0')
	})

	test('returns null with no token', async () => {
		const p = new HardcoverProvider({ gql: fetchGql(matchedEdition, parentBook) })
		expect(await p.fetchBook('31501578', 'edition', { region: 'us' })).toBeNull()
	})
})

describe('HardcoverProvider.fetchAuthorImage', () => {
	const authorGql =
		(authors: unknown): HardcoverGql =>
		async <T>() =>
			({ authors }) as T

	test('returns the exact-name match image over another result', async () => {
		const gql = authorGql([
			{ name: 'Andy Other', image: { url: 'https://assets.hardcover.app/wrong.jpg' } },
			{ name: 'Andy Weir', image: { url: 'https://assets.hardcover.app/andy.jpg' } }
		])
		const img = await new HardcoverProvider({ token: 'tok', gql }).fetchAuthorImage('Andy Weir', {
			region: 'us'
		})
		expect(img).toBe('https://assets.hardcover.app/andy.jpg')
	})

	test('falls back to the first result with an image when no exact match', async () => {
		const gql = authorGql([
			{ name: 'A. Weir', image: null },
			{ name: 'Andrew Weir', image: { url: 'https://assets.hardcover.app/aw.jpg' } }
		])
		const img = await new HardcoverProvider({ token: 'tok', gql }).fetchAuthorImage('Andy Weir', {
			region: 'us'
		})
		expect(img).toBe('https://assets.hardcover.app/aw.jpg')
	})

	test('returns null with no token, no match, or on a query error', async () => {
		expect(
			await new HardcoverProvider({ gql: authorGql([]) }).fetchAuthorImage('Andy Weir', {
				region: 'us'
			})
		).toBeNull()

		expect(
			await new HardcoverProvider({ token: 'tok', gql: authorGql([]) }).fetchAuthorImage('Nobody', {
				region: 'us'
			})
		).toBeNull()

		const throwing: HardcoverGql = async () => {
			throw new Error('bad field')
		}
		expect(
			await new HardcoverProvider({ token: 'tok', gql: throwing }).fetchAuthorImage('Andy Weir', {
				region: 'us'
			})
		).toBeNull()
	})
})

describe('HardcoverProvider.fetchAuthorInfo (image + bio)', () => {
	const authorGql =
		(authors: unknown): HardcoverGql =>
		async <T>() =>
			({ authors }) as T

	test('picks image and bio from DIFFERENT same-name records (the Stephen Fry case)', async () => {
		// Canonical record has the photo but no bio; a duplicate has the bio.
		const gql = authorGql([
			{ name: 'Stephen Fry', bio: null, image: { url: 'https://assets.hardcover.app/fry.png' } },
			{ name: 'Stephen Fry', bio: 'Stephen John Fry is a British actor and writer.', image: null }
		])
		const info = await new HardcoverProvider({ token: 'tok', gql }).fetchAuthorInfo('Stephen Fry', {
			region: 'us'
		})
		expect(info.image).toBe('https://assets.hardcover.app/fry.png')
		expect(info.bio).toBe('Stephen John Fry is a British actor and writer.')
	})

	test('prefers the longest exact-name bio and cleans markdown/footnotes', async () => {
		const gql = authorGql([
			{ name: 'Stephen Fry', bio: 'Short stub.', image: null },
			{
				name: 'Stephen Fry',
				bio: 'Fry wrote *The Liar* (1993).\r\n\r\n([Source][1])\r\n\r\n\r\n  [1]: http://en.wikipedia.org/wiki/Stephen_Fry',
				image: null
			}
		])
		const info = await new HardcoverProvider({ token: 'tok', gql }).fetchAuthorInfo('Stephen Fry', {
			region: 'us'
		})
		// Longest bio chosen; asterisks, "([Source][1])" and the "[1]: …" line stripped.
		expect(info.bio).toBe('Fry wrote The Liar (1993).')
	})

	test('bio is null when no record carries one; image still resolves', async () => {
		const gql = authorGql([
			{ name: 'Andy Weir', bio: null, image: { url: 'https://assets.hardcover.app/aw.jpg' } }
		])
		const info = await new HardcoverProvider({ token: 'tok', gql }).fetchAuthorInfo('Andy Weir', {
			region: 'us'
		})
		expect(info.image).toBe('https://assets.hardcover.app/aw.jpg')
		expect(info.bio).toBeNull()
	})

	test('no token or a query error yields both null', async () => {
		expect(await new HardcoverProvider({ gql: authorGql([]) }).fetchAuthorInfo('X', { region: 'us' })).toEqual(
			{ image: null, bio: null }
		)
		const throwing: HardcoverGql = async () => {
			throw new Error('boom')
		}
		expect(
			await new HardcoverProvider({ token: 'tok', gql: throwing }).fetchAuthorInfo('X', { region: 'us' })
		).toEqual({ image: null, bio: null })
	})
})

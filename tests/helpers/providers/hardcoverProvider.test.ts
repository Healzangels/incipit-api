import { describe, expect, test } from 'bun:test'

import HardcoverProvider, {
	type HardcoverGql,
	interpretGqlBody
} from '#helpers/providers/HardcoverProvider'
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

	test('keeps untagged (null-language) editions alongside the preferred language', async () => {
		// A patchy-data book: one English-tagged edition and one with no language.
		// Both must survive a US query — the untagged one is very likely English.
		const withNull = {
			...projectHailMary,
			editions: [
				{ ...projectHailMary.editions[0], id: 10, language: { language: 'English' } },
				{ ...projectHailMary.editions[0], id: 11, language: null }
			]
		}
		const kept = await new HardcoverProvider({ gql: gqlWith([1], [withNull]) }).search({
			...baseQuery,
			title: 'Project Hail Mary'
		})
		expect(kept.map((c) => c.id).sort()).toEqual(['hardcover-edition-10', 'hardcover-edition-11'])
	})

	test('drops a foreign-tagged edition but keeps the untagged one', async () => {
		const frAndNull = {
			...projectHailMary,
			editions: [
				{ ...projectHailMary.editions[0], id: 20, language: { language: 'French' } },
				{ ...projectHailMary.editions[0], id: 21, language: null }
			]
		}
		const out = await new HardcoverProvider({ gql: gqlWith([1], [frAndNull]) }).search({
			...baseQuery,
			title: 'Project Hail Mary'
		})
		expect(out.map((c) => c.id)).toEqual(['hardcover-edition-21'])
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

	test('an ORDERING listing never becomes the shelf', async () => {
		// Reaper's Gale, measured live: Hardcover's book_series carried the real
		// shelf AND "Malazan Authors' Suggested Reading Order", and buildSeries
		// preserves Hardcover's own array order -- so series[1] handed the
		// ordering to seriesSecondary. That value then WINS over the filtered
		// goodreads answer (`book.seriesSecondary ?? result.secondary`), which is
		// why filtering has to happen here and not only downstream.
		const book = {
			...parentBook,
			book_series: [
				{ position: 7, series: { name: 'Malazan Book of the Fallen' } },
				{ position: 7, series: { name: "Malazan Authors' Suggested Reading Order" } },
				{ position: 2, series: { name: 'The Tales of Bauchelain and Korbal Broach' } }
			]
		}
		const p = new HardcoverProvider({ gql: fetchGql(matchedEdition, book) })
		const out = await p.fetchBook('31501578', 'edition', {
			region: 'us',
			credentials: { hardcover: 'tok' }
		})
		expect(out?.seriesPrimary?.name).toBe('Malazan Book of the Fallen')
		expect(out?.seriesSecondary?.name).toBe('The Tales of Bauchelain and Korbal Broach')
	})

	test('an ordering in FIRST position does not become the primary either', async () => {
		const book = {
			...parentBook,
			book_series: [
				{ position: 1, series: { name: 'Discworld (publication order)' } },
				{ position: 1, series: { name: 'Discworld' } }
			]
		}
		const p = new HardcoverProvider({ gql: fetchGql(matchedEdition, book) })
		const out = await p.fetchBook('31501578', 'edition', {
			region: 'us',
			credentials: { hardcover: 'tok' }
		})
		expect(out?.seriesPrimary?.name).toBe('Discworld')
		expect(out?.seriesSecondary).toBeUndefined()
	})

	test('when EVERY entry is an ordering, a coarse shelf still beats none', async () => {
		// The same fallback goodreadsSeries makes when nothing survives the
		// demotion: a variant shelf beats leaving the book unshelved.
		const book = {
			...parentBook,
			book_series: [{ position: 1, series: { name: 'Wheel of Time (chronological)' } }]
		}
		const p = new HardcoverProvider({ gql: fetchGql(matchedEdition, book) })
		const out = await p.fetchBook('31501578', 'edition', {
			region: 'us',
			credentials: { hardcover: 'tok' }
		})
		expect(out?.seriesPrimary?.name).toBe('Wheel of Time (chronological)')
	})

	test('a clean series pair is untouched', async () => {
		const book = {
			...parentBook,
			book_series: [
				{ position: 1, series: { name: 'Mistborn' } },
				{ position: 1, series: { name: 'The Cosmere' } }
			]
		}
		const p = new HardcoverProvider({ gql: fetchGql(matchedEdition, book) })
		const out = await p.fetchBook('31501578', 'edition', {
			region: 'us',
			credentials: { hardcover: 'tok' }
		})
		expect(out?.seriesPrimary?.name).toBe('Mistborn')
		expect(out?.seriesSecondary?.name).toBe('The Cosmere')
	})

	test('applies the MATCHED edition, not a popularity re-pick of the book editions', async () => {
		const p = new HardcoverProvider({ gql: fetchGql(matchedEdition, parentBook) })
		const book = await p.fetchBook('31501578', 'edition', {
			region: 'us',
			credentials: { hardcover: 'tok' }
		})
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

	test('carries the matched edition language so the lookup route can flag a mismatch', async () => {
		// The Dungeon Crawler Carl case: a FRENCH edition served over a provider id
		// must reach the route WITH its language, or flagLanguageMismatch is a no-op.
		const frenchEdition = { ...matchedEdition, language: { language: 'French' } }
		const p = new HardcoverProvider({ gql: fetchGql(frenchEdition, parentBook) })
		const book = await p.fetchBook('31501578', 'edition', {
			region: 'us',
			credentials: { hardcover: 'tok' }
		})
		expect(book?.language).toBe('fr')
	})

	test('a book-level fetch carries the picked edition language (query selects it)', async () => {
		// Serve the edition's language ONLY when the book query selects the field —
		// guards the GraphQL selection itself, not just the response mapping.
		const gql: HardcoverGql = async <T>(query: string): Promise<T> => {
			if (query.includes('IncipitEditionFull')) return { editions: [] } as T
			const edition = query.includes('language')
				? { ...parentBook.editions[0], language: { language: 'French' } }
				: parentBook.editions[0]
			return { books: [{ ...parentBook, editions: [edition] }] } as T
		}
		const p = new HardcoverProvider({ gql })
		const book = await p.fetchBook('427578', 'book', {
			region: 'us',
			credentials: { hardcover: 'tok' }
		})
		expect(book?.language).toBe('fr')
	})

	test('returns null when the edition is not found', async () => {
		const p = new HardcoverProvider({ gql: fetchGql(null, parentBook) })
		expect(
			await p.fetchBook('404', 'edition', { region: 'us', credentials: { hardcover: 'tok' } })
		).toBeNull()
	})

	test('a book-level id still resolves via the book pick', async () => {
		const p = new HardcoverProvider({ gql: fetchGql(null, parentBook) })
		const book = await p.fetchBook('427578', 'book', {
			region: 'us',
			credentials: { hardcover: 'tok' }
		})
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

	test('a BOOK COVER is never served as an author portrait', async () => {
		// Measured live 2026-07-29: 8 of the operator's 181 authors carried
		// `assets.hardcover.app/books/<id>/...` as their photo -- Terry Pratchett
		// and Octavia E. Butler among them -- because Hardcover's contributed
		// authors.image relation can point at a book asset. A jacket is simply
		// the wrong subject, so it is dropped rather than displayed.
		const gql = authorGql([
			{
				name: 'George Alec Effinger',
				bio: 'An American science fiction author.',
				image: { url: 'https://assets.hardcover.app/books/135179/10360944-L.jpg' }
			}
		])
		const info = await new HardcoverProvider({ token: 'tok', gql }).fetchAuthorInfo(
			'George Alec Effinger',
			{ region: 'us' }
		)
		expect(info.image).toBeNull()
		// The BIO on that same record is still perfectly good data.
		expect(info.bio).toContain('science fiction author')
	})

	test('a real portrait on a sibling record beats a book cover', async () => {
		const gql = authorGql([
			{
				name: 'Terry Pratchett',
				bio: null,
				image: { url: 'https://assets.hardcover.app/books/349845/x-L.jpg' }
			},
			{
				name: 'Terry Pratchett',
				bio: null,
				image: { url: 'https://assets.hardcover.app/authors/1/real-L.jpg' }
			}
		])
		const info = await new HardcoverProvider({ token: 'tok', gql }).fetchAuthorInfo(
			'Terry Pratchett',
			{ region: 'us' }
		)
		expect(info.image).toBe('https://assets.hardcover.app/authors/1/real-L.jpg')
	})

	test.each([
		'https://assets.hardcover.app/author/86158/f18a10d8.jpeg',
		'https://assets.hardcover.app/authors/178795/7241662-L.jpg',
		'https://images-na.ssl-images-amazon.com/images/S/amzn-author-media-prod/abc.jpg',
		'https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/authors/1442.jpg'
	])('keeps the real portrait shape %s', async (url) => {
		// All four shapes are live in the operator's library -- the guard is
		// path-specific so none of them may be rejected.
		const gql = authorGql([{ name: 'A', bio: null, image: { url } }])
		const info = await new HardcoverProvider({ token: 'tok', gql }).fetchAuthorInfo('A', {
			region: 'us'
		})
		expect(info.image).toBe(url)
	})

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
		expect(
			await new HardcoverProvider({ gql: authorGql([]) }).fetchAuthorInfo('X', { region: 'us' })
		).toEqual({ image: null, bio: null, imageGenerated: false })
		const throwing: HardcoverGql = async () => {
			throw new Error('boom')
		}
		expect(
			await new HardcoverProvider({ token: 'tok', gql: throwing }).fetchAuthorInfo('X', {
				region: 'us'
			})
		).toEqual({ image: null, bio: null, imageGenerated: false })
	})
})

describe('HardcoverProvider.fetchBookByAsin', () => {
	// An edition's asin rides along on candidates for dedup and the exact-match
	// pin, so a client can be holding an ASIN whose Audible product is delisted
	// (404 on /books/:asin). Resolving it back to the edition that carries it is
	// what keeps that id servable instead of freezing the item's metadata.
	function asinGql(editionId: number | null, edition?: unknown, book?: unknown): HardcoverGql {
		return async <T>(query: string): Promise<T> => {
			if (query.includes('IncipitEditionByAsin')) {
				return { editions: editionId == null ? [] : [{ id: editionId }] } as T
			}
			if (query.includes('IncipitEditionFull')) return { editions: [edition] } as T
			return { books: [book] } as T
		}
	}

	const edition = {
		id: 32411759,
		book_id: 991,
		asin: 'B0FVG4C61Z',
		audio_seconds: 4380,
		reading_format_id: 2,
		release_date: '2025-11-03',
		cached_image: { url: 'https://assets.hardcover.app/edition/audio.jpg' },
		language: { language: 'English' },
		publisher: { name: 'Amazon Original Stories' },
		contributions: [
			{ author: { name: 'Peng Shepherd' }, contribution: null },
			{ author: { name: 'Jonathan Davis' }, contribution: 'Narrator' }
		]
	}
	const book = {
		id: 991,
		title: 'For a Limited Time Only',
		cached_image: { url: 'https://assets.hardcover.app/book.jpg' },
		contributions: [{ author: { name: 'Peng Shepherd' }, contribution: null }],
		editions: [edition]
	}

	test('resolves a delisted ASIN to the edition carrying it', async () => {
		const provider = new HardcoverProvider({ token: 'tok', gql: asinGql(32411759, edition, book) })
		const result = await provider.fetchBookByAsin('B0FVG4C61Z', { region: 'us' })
		expect(result?.title).toBe('For a Limited Time Only')
		expect(result?.authors?.[0]?.name).toBe('Peng Shepherd')
	})

	test('returns null when no edition carries the ASIN', async () => {
		const provider = new HardcoverProvider({ token: 'tok', gql: asinGql(null) })
		expect(await provider.fetchBookByAsin('B0DEADDEAD', { region: 'us' })).toBeNull()
	})

	test('returns null without a token instead of throwing', async () => {
		const provider = new HardcoverProvider({ gql: asinGql(32411759, edition, book) })
		expect(await provider.fetchBookByAsin('B0FVG4C61Z', { region: 'us' })).toBeNull()
	})
})

describe('HardcoverProvider generated-avatar detection', () => {
	const authorGql =
		(authors: unknown): HardcoverGql =>
		async <T>() =>
			({ authors }) as T

	/**
	 * Hardcover materializes a GENERATED default avatar as a first-class image
	 * asset on the author row -- same /author/{id}/{uuid} URL shape as a real
	 * photo, image_id set, no flag anywhere. Measured on Robert Harris
	 * (2026-07-26): the avatar reached Plex as his "Hardcover portrait" and the
	 * square-fit rule then preferred the perfectly-square cartoon over his real
	 * photo. The one reliable tell is the reported dimensions: generated
	 * avatars are exactly 270x270, while sampled real photos vary widely
	 * (1500x2215, 376x500, 600x600, 518x754...).
	 */

	test('flags a 270x270 image as generated', async () => {
		const gql = authorGql([
			{
				name: 'Robert Harris',
				bio: null,
				image: {
					url: 'https://assets.hardcover.app/author/61383/avatar.png',
					width: 270,
					height: 270
				}
			}
		])
		const info = await new HardcoverProvider({ token: 'tok', gql }).fetchAuthorInfo(
			'Robert Harris',
			{ region: 'us' }
		)
		expect(info.image).toBe('https://assets.hardcover.app/author/61383/avatar.png')
		expect(info.imageGenerated).toBe(true)
	})

	test('a real-dimensioned image is not flagged, nor is one with no dims', async () => {
		const real = authorGql([
			{
				name: 'Aldous Huxley',
				bio: null,
				image: { url: 'https://a/h.jpeg', width: 1500, height: 2215 }
			}
		])
		const noDims = authorGql([
			{ name: 'Aldous Huxley', bio: null, image: { url: 'https://a/h2.jpeg' } }
		])
		const p = new HardcoverProvider({ token: 'tok', gql: real })
		expect((await p.fetchAuthorInfo('Aldous Huxley', { region: 'us' })).imageGenerated).toBe(false)
		const p2 = new HardcoverProvider({ token: 'tok', gql: noDims })
		expect((await p2.fetchAuthorInfo('Aldous Huxley', { region: 'us' })).imageGenerated).toBe(false)
	})

	test('prefers a REAL photo on a duplicate row over a generated avatar on the exact row', async () => {
		// Hardcover holds several same-name rows; if any carries a real photo,
		// that beats a generated avatar however exact the avatar row's name is.
		const gql = authorGql([
			{
				name: 'Robert Harris',
				bio: null,
				image: { url: 'https://a/avatar.png', width: 270, height: 270 }
			},
			{
				name: 'Robert Harris',
				bio: null,
				image: { url: 'https://a/real.jpg', width: 600, height: 800 }
			}
		])
		const info = await new HardcoverProvider({ token: 'tok', gql }).fetchAuthorInfo(
			'Robert Harris',
			{ region: 'us' }
		)
		expect(info.image).toBe('https://a/real.jpg')
		expect(info.imageGenerated).toBe(false)
	})
})

/**
 * A non-GraphQL 200 must FAIL, not read as a clean empty.
 *
 * Cloudflare serves challenge pages and maintenance notices as 200-HTML. The
 * old `body?.errors / body?.data` chains are both undefined on a string, so
 * that page walked through as "no errors, no data" — a phantom empty that
 * cached as "Hardcover has nothing for this book" and never tripped the
 * circuit breaker. An outage must look like an outage.
 */
describe('interpretGqlBody', () => {
	test('returns data from a real GraphQL body', () => {
		expect(interpretGqlBody<{ ok: boolean }>({ data: { ok: true } })).toEqual({ ok: true })
	})

	test('throws on a GraphQL error body', () => {
		expect(() => interpretGqlBody({ errors: [{ message: 'boom' }] })).toThrow('boom')
	})

	test('throws on an HTML/string body instead of returning undefined', () => {
		expect(() => interpretGqlBody('<!DOCTYPE html><html>Checking your browser')).toThrow(
			'non-GraphQL'
		)
	})

	test('throws on null and on a data-less object', () => {
		expect(() => interpretGqlBody(null)).toThrow('non-GraphQL')
		expect(() => interpretGqlBody({ unexpected: 1 })).toThrow('non-GraphQL')
	})
})

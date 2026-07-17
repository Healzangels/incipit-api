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

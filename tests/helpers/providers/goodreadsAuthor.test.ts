import { afterEach, describe, expect, mock, test } from 'bun:test'

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { fetchGoodreadsAuthorInfo } = await import('#helpers/providers/goodreadsSeries')

/** Queue responses in call order; a `null` entry makes that call reject. */
function respond(...bodies: Array<unknown | null>) {
	fetchMock.mockReset()
	for (const body of bodies) {
		if (body === null) fetchMock.mockImplementationOnce(() => Promise.reject(new Error('boom')))
		else fetchMock.mockImplementationOnce(() => Promise.resolve({ data: body }))
	}
}

// A real Goodreads author photo URL (no /nophoto/ placeholder segment).
const PHOTO =
	'https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/authors/1492336018i/16727429._UY200_.jpg'

describe('fetchGoodreadsAuthorInfo', () => {
	afterEach(() => fetchMock.mockReset())

	test('returns the portrait + bio for a confirmed same-name author', async () => {
		respond([{ author: { id: 16727429 } }], {
			ForeignId: 16727429,
			Name: 'Jessica Townsend',
			Description: 'An Australian author.',
			ImageUrl: PHOTO
		})
		const out = await fetchGoodreadsAuthorInfo('Jessica Townsend')
		expect(out.image).toBe(PHOTO)
		expect(out.bio).toBe('An Australian author.')
	})

	test('REJECTS a different person the fuzzy search surfaced (no wrong-face false positive)', async () => {
		// /search for "Jessica Townsend" returns a book whose author is a DIFFERENT
		// Jessica — the name gate must refuse to attach her photo.
		respond([{ author: { id: 999 } }], {
			ForeignId: 999,
			Name: 'Jessica Day George',
			Description: 'A different author.',
			ImageUrl: PHOTO
		})
		expect(await fetchGoodreadsAuthorInfo('Jessica Townsend')).toEqual({ image: null, bio: null })
	})

	test('REJECTS a shared surname with a different first name', async () => {
		respond([{ author: { id: 5 } }], { ForeignId: 5, Name: 'Michael Townsend', ImageUrl: PHOTO })
		expect(await fetchGoodreadsAuthorInfo('Jessica Townsend')).toEqual({ image: null, bio: null })
	})

	test('accepts a punctuation/initial name variant (JD vs J.D.)', async () => {
		respond([{ author: { id: 7 } }], { ForeignId: 7, Name: 'J.D. Franx', ImageUrl: PHOTO })
		const out = await fetchGoodreadsAuthorInfo('JD Franx')
		expect(out.image).toBe(PHOTO)
	})

	test('treats a /nophoto/ placeholder as no image', async () => {
		respond([{ author: { id: 1 } }], {
			ForeignId: 1,
			Name: 'Jessica Townsend',
			ImageUrl: 'https://i.gr-assets.com/images/S/nophoto/user/u_200x266.png',
			Description: 'N/A'
		})
		expect(await fetchGoodreadsAuthorInfo('Jessica Townsend')).toEqual({ image: null, bio: null })
	})

	test('treats Description "N/A" as no bio but keeps a real photo', async () => {
		respond([{ author: { id: 1 } }], {
			ForeignId: 1,
			Name: 'Jessica Townsend',
			ImageUrl: PHOTO,
			Description: 'N/A'
		})
		const out = await fetchGoodreadsAuthorInfo('Jessica Townsend')
		expect(out.image).toBe(PHOTO)
		expect(out.bio).toBeNull()
	})

	test('skips a gated-out first id and uses a later confirmed one', async () => {
		respond(
			[{ author: { id: 999 } }, { author: { id: 16727429 } }],
			{ ForeignId: 999, Name: 'Someone Else', ImageUrl: PHOTO },
			{ ForeignId: 16727429, Name: 'Jessica Townsend', ImageUrl: PHOTO }
		)
		const out = await fetchGoodreadsAuthorInfo('Jessica Townsend')
		expect(out.image).toBe(PHOTO)
	})

	test('returns nulls when the search has no hits', async () => {
		respond([])
		expect(await fetchGoodreadsAuthorInfo('Nobody At All')).toEqual({ image: null, bio: null })
	})

	test('returns nulls without any fetch for an empty name', async () => {
		respond()
		const out = await fetchGoodreadsAuthorInfo('   ')
		expect(out).toEqual({ image: null, bio: null })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('degrades to nulls when the search call fails', async () => {
		respond(null)
		expect(await fetchGoodreadsAuthorInfo('Jessica Townsend')).toEqual({ image: null, bio: null })
	})
})

import { afterEach, describe, expect, mock, test } from 'bun:test'

import { fakeRedis } from '#tests/setup/fakeRedis'

// No outbound pacing in tests: the live client holds a ~1.1s gap between
// bookinfo.pro calls, which would add ~45s to this suite for no coverage.
process.env.GOODREADS_MIN_GAP_MS = '0'

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { fetchGoodreadsAuthorInfo, withGoodreadsAuthorInfo } =
	await import('#helpers/providers/goodreadsSeries')

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

describe('withGoodreadsAuthorInfo caching', () => {
	afterEach(() => fetchMock.mockReset())

	test('a second lookup is served from cache with NO further requests', async () => {
		// The whole point: Plex refreshes authors constantly, and an uncached lookup
		// costs a /search plus an /author call every time -- which is what got us
		// rate-limited (HTTP 429) off the mirror.
		const redis = fakeRedis()
		respond([{ author: { id: 16727429 } }], {
			ForeignId: 16727429,
			Name: 'Jessica Townsend',
			ImageUrl: PHOTO
		})
		const first = await withGoodreadsAuthorInfo('Jessica Townsend', redis)
		expect(first.image).toBe(PHOTO)
		const callsAfterFirst = fetchMock.mock.calls.length

		const second = await withGoodreadsAuthorInfo('Jessica Townsend', redis)
		expect(second).toEqual(first)
		expect(fetchMock.mock.calls.length).toBe(callsAfterFirst) // zero extra traffic
	})

	test('the cache entry is written with a TTL, not forever', async () => {
		// The hand-rolled two-argument fakes this replaced swallowed the `'EX', ttl`
		// pair, so a cache that forgot its expiry -- pinning "no photo" on an author
		// permanently -- would still have passed.
		const redis = fakeRedis()
		respond([{ author: { id: 1 } }], { ForeignId: 1, Name: 'Jessica Townsend', ImageUrl: PHOTO })
		await withGoodreadsAuthorInfo('Jessica Townsend', redis)
		const [key] = [...redis.store.keys()]
		expect(key).toBeDefined()
		expect(redis.expires.get(key)).toBe(86400)
	})

	test('a MISS is cached too, so a photo-less author is not re-queried forever', async () => {
		const redis = fakeRedis()
		respond([]) // no search hits
		expect(await withGoodreadsAuthorInfo('Nobody At All', redis)).toEqual({
			image: null,
			bio: null
		})
		const calls = fetchMock.mock.calls.length
		expect(await withGoodreadsAuthorInfo('Nobody At All', redis)).toEqual({
			image: null,
			bio: null
		})
		expect(fetchMock.mock.calls.length).toBe(calls)
	})

	test('the cache key is name-insensitive to case/padding', async () => {
		const redis = fakeRedis()
		respond([{ author: { id: 1 } }], { ForeignId: 1, Name: 'Jessica Townsend', ImageUrl: PHOTO })
		await withGoodreadsAuthorInfo('Jessica Townsend', redis)
		const calls = fetchMock.mock.calls.length
		const again = await withGoodreadsAuthorInfo('  jessica townsend  ', redis)
		expect(again.image).toBe(PHOTO)
		expect(fetchMock.mock.calls.length).toBe(calls)
	})

	test('works with no redis (falls straight through to the lookup)', async () => {
		respond([{ author: { id: 1 } }], { ForeignId: 1, Name: 'Jessica Townsend', ImageUrl: PHOTO })
		expect((await withGoodreadsAuthorInfo('Jessica Townsend', null)).image).toBe(PHOTO)
	})

	test('an empty name never touches redis or the network', async () => {
		const redis = fakeRedis()
		respond()
		expect(await withGoodreadsAuthorInfo('   ', redis)).toEqual({ image: null, bio: null })
		expect(fetchMock).not.toHaveBeenCalled()
		expect(redis.store.size).toBe(0)
	})
})

describe('withGoodreadsAuthorInfo miss handling', () => {
	afterEach(() => fetchMock.mockReset())

	/**
	 * Measured live on Roger Zelazny (2026-07-26): the mirror answered his very
	 * first lookup cache-cold, surfacing only a Betancourt continuation novel
	 * ("Roger Zelazny's ..."), so the name gate correctly refused it and the
	 * lookup missed -- a real answer, so it was CACHED, for the same 24h a hit
	 * gets. Minutes later the mirror knew the real author (id 3619, bio and
	 * portrait present), but the cached miss blocked every retry INCLUDING the
	 * operator's explicit ?update=1. An empty answer is not knowledge: it gets a
	 * short TTL, and an explicit update pass re-asks regardless.
	 */

	test('a full miss is cached only briefly; a hit keeps the day-long TTL', async () => {
		const redis = fakeRedis()
		respond([{ author: { id: 1 } }], { ForeignId: 1, Name: 'Somebody Else' })
		await withGoodreadsAuthorInfo('Roger Zelazny', redis)
		expect(redis.expires.get('grauthor:v1:roger zelazny')).toBe(3600)

		respond([{ author: { id: 7328 } }], {
			ForeignId: 7328,
			Name: 'Ursula K. Le Guin',
			Description: 'An American author.',
			ImageUrl: PHOTO
		})
		await withGoodreadsAuthorInfo('Ursula K. Le Guin', redis)
		expect(redis.expires.get('grauthor:v1:ursula k. le guin')).toBe(86400)
	})

	test('bypassCacheRead ignores a stale cached miss and overwrites it', async () => {
		const redis = fakeRedis()
		redis.store.set('grauthor:v1:roger zelazny', JSON.stringify({ image: null, bio: null }))
		respond([{ author: { id: 3619 } }], {
			ForeignId: 3619,
			Name: 'Roger Zelazny',
			Description: 'An American fantasy and science fiction writer.',
			ImageUrl: PHOTO
		})
		const out = await withGoodreadsAuthorInfo('Roger Zelazny', redis, undefined, {
			bypassCacheRead: true
		})
		expect(out.bio).toBe('An American fantasy and science fiction writer.')
		expect(JSON.parse(redis.store.get('grauthor:v1:roger zelazny') ?? '{}').bio).toBe(
			'An American fantasy and science fiction writer.'
		)
	})

	test('without the bypass, the cached answer still wins (mirror protection intact)', async () => {
		const redis = fakeRedis()
		redis.store.set(
			'grauthor:v1:roger zelazny',
			JSON.stringify({ image: PHOTO, bio: 'cached bio' })
		)
		fetchMock.mockReset()
		const out = await withGoodreadsAuthorInfo('Roger Zelazny', redis)
		expect(out.bio).toBe('cached bio')
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

const mockAuthorFindOne = mock()
const mockAuthorFind = mock()
const mockPaprFindOne = mock()
const mockPaprFindOneWithProjection = mock()
const mockPaprCreateOrUpdate = mock()
const mockPaprFindByName = mock()
const mockScrapeProcess = mock()
const mockRedisFindOne = mock()
const mockRedisFindOrCreate = mock()
// Resolves like the real async setOne — the caller chains .catch on it.
const mockRedisSetOne = mock(() => Promise.resolve(undefined))
const mockRedisSetExpiration = mock()
const mockRedisDeleteOne = mock()

mock.module('#config/models/Author', () => ({
	default: class AuthorModel {
		static findOne = mockAuthorFindOne
		static find = mockAuthorFind
	}
}))

mock.module('#helpers/database/papr/audible/PaprAudibleAuthorHelper', () => ({
	default: class PaprAudibleAuthorHelper {
		findOne = mockPaprFindOne
		findOneWithProjection = mockPaprFindOneWithProjection
		createOrUpdate = mockPaprCreateOrUpdate
		findByName = mockPaprFindByName
		setData = mock()
	}
}))

mock.module('#helpers/authors/audible/ScrapeHelper', () => ({
	default: class ScrapeHelper {
		process = mockScrapeProcess
	}
}))

const mockFetchGoodreadsAuthorInfo = mock()
const mockChaptarrAuthorInfo = mock()
mock.module('#helpers/providers/chaptarrAuthor', () => ({
	chaptarrAuthorInfo: mockChaptarrAuthorInfo
}))
mock.module('#helpers/providers/goodreadsSeries', () => ({
	// The helper calls the CACHED wrapper; mock it explicitly rather than relying
	// on a missing export resolving to the real (network-touching) module.
	withGoodreadsAuthorInfo: mockFetchGoodreadsAuthorInfo,
	fetchGoodreadsAuthorInfo: mockFetchGoodreadsAuthorInfo,
	withGoodreadsSeries: mock((book: unknown) => book),
	fetchGoodreadsSeries: mock()
}))

mock.module('#helpers/database/redis/RedisHelper', () => ({
	default: class RedisHelper {
		findOne = mockRedisFindOne
		findOrCreate = mockRedisFindOrCreate
		setOne = mockRedisSetOne
		setExpiration = mockRedisSetExpiration
		deleteOne = mockRedisDeleteOne
	}
}))

mock.module('@fastify/redis', () => ({}))

// The avatar-policy fixtures below are INCOMPLETE authors by design, and an
// incomplete author on an unforced pass arms the real module's 3-minute retry
// timer -- a live timer outliving the suite (and firing mid-watch-mode) is not
// this file's business. The second-chance behavior has its own test file with
// injected schedulers.
const mockSchedule = mock(() => true)
mock.module('#helpers/utils/secondChance', () => ({
	scheduleSecondChance: mockSchedule,
	pendingSecondChances: () => []
}))

import type { FastifyRedis } from '@fastify/redis'

import {
	PerformanceConfig,
	resetPerformanceConfig,
	setPerformanceConfig
} from '#config/performance'
import { ApiAuthorProfile } from '#config/types'
import { NotFoundError } from '#helpers/errors/ApiErrors'
import defaultRegistry from '#helpers/providers/registry'
import AuthorShowHelper from '#helpers/routes/AuthorShowHelper'
import {
	authorWithoutProjection,
	authorWithoutProjectionUpdatedNow,
	parsedAuthor
} from '#tests/datasets/helpers/authors'

const createTestConfig = (overrides: Partial<PerformanceConfig>): PerformanceConfig => ({
	USE_PARALLEL_SCHEDULER: false,
	USE_CONNECTION_POOLING: true,
	USE_COMPACT_JSON: true,
	USE_SORTED_KEYS: false,
	CIRCUIT_BREAKER_ENABLED: true,
	METRICS_ENABLED: true,
	MAX_CONCURRENT_REQUESTS: 50,
	SCHEDULER_CONCURRENCY: 5,
	SCHEDULER_MAX_PER_REGION: 5,
	DEFAULT_REGION: 'us',
	...overrides
})

type MockContext = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	client: any
}

let asin: string
let ctx: MockContext
let helper: AuthorShowHelper

const createMockContext = (): MockContext => {
	return {
		client: {
			get: mock(),
			set: mock(),
			del: mock(),
			ping: mock(),
			expire: mock()
		} as unknown as FastifyRedis
	}
}

beforeEach(() => {
	mock.clearAllMocks()
	asin = 'B079LRSMNN'
	helper = new AuthorShowHelper(asin, { region: 'us', update: undefined }, null)
	mockPaprCreateOrUpdate.mockResolvedValue({ data: parsedAuthor, modified: true })
	mockPaprFindOne.mockResolvedValue({ data: authorWithoutProjection, modified: false })
	mockScrapeProcess.mockResolvedValue(parsedAuthor)
	mockFetchGoodreadsAuthorInfo.mockResolvedValue({ image: null, bio: null })
	mockChaptarrAuthorInfo.mockResolvedValue({ image: null, bio: null })
	mockRedisFindOrCreate.mockResolvedValue(parsedAuthor)
	mockPaprFindOneWithProjection.mockResolvedValue({ data: parsedAuthor, modified: false })
	spyOn(helper.sharedHelper, 'sortObjectByKeys').mockReturnValue(parsedAuthor)
	spyOn(helper.sharedHelper, 'isRecentlyUpdated').mockReturnValue(false)
})

afterEach(() => {
	resetPerformanceConfig()
})

describe('AuthorShowHelper should', () => {
	test('get a author from Papr', async () => {
		await expect(helper.getDataFromPapr()).resolves.toStrictEqual(authorWithoutProjection)
	})

	test('get authors by name from Papr', async () => {
		const authors = [{ asin: 'B079LRSMNN', name: 'John Doe' }]
		const obj = { data: authors, modified: false }
		helper = new AuthorShowHelper('', { name: 'John Doe', region: 'us', update: undefined }, null)
		mockPaprFindByName.mockResolvedValue(obj)
		await expect(helper.getAuthorsByName()).resolves.toStrictEqual(authors)
	})

	test('get new author data', async () => {
		await expect(helper.getNewData()).resolves.toStrictEqual(parsedAuthor)
	})

	test('fills a dead-ASIN author from Goodreads using the supplied name', async () => {
		// Audible has no page for the ASIN (delisted/region-locked); with a name the
		// enrichment still runs and Goodreads fills the portrait/bio.
		mockScrapeProcess.mockRejectedValue(
			new NotFoundError('gone', { asin, code: 'REGION_UNAVAILABLE' })
		)
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue({
			fetchAuthorInfo: mock().mockResolvedValue({ image: null, bio: null })
		} as unknown as ReturnType<typeof defaultRegistry.get>)
		mockFetchGoodreadsAuthorInfo.mockResolvedValue({
			image: 'https://gr/mcneill.jpg',
			bio: 'A Warhammer author.'
		})
		helper = new AuthorShowHelper(
			asin,
			{ region: 'us', name: 'Graham McNeill', update: '1' } as never,
			null
		)
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.name).toBe('Graham McNeill')
		expect(out.image).toBe('https://gr/mcneill.jpg')
		expect(out.description).toBe('A Warhammer author.')
		expect(mockFetchGoodreadsAuthorInfo.mock.calls[0]?.[0]).toBe('Graham McNeill')
		getSpy.mockRestore()
	})

	test('CHAPTARR is the last fill rung: answers when even Goodreads is blind', async () => {
		// The recorded failure mode of both name-keyed rungs: a spelling variant
		// misses entirely. Chaptarr keys by the same author asin the route was
		// asked for, so it answers when Hardcover AND Goodreads return nothing.
		mockScrapeProcess.mockRejectedValue(
			new NotFoundError('gone', { asin, code: 'REGION_UNAVAILABLE' })
		)
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue({
			fetchAuthorInfo: mock().mockResolvedValue({ image: null, bio: null })
		} as unknown as ReturnType<typeof defaultRegistry.get>)
		mockFetchGoodreadsAuthorInfo.mockResolvedValue({ image: null, bio: null })
		mockChaptarrAuthorInfo.mockResolvedValue({
			image: 'https://i.gr-assets.com/tolkien.jpg',
			bio: 'An Oxford philologist.'
		})
		helper = new AuthorShowHelper(
			asin,
			{ region: 'us', name: 'J. R. R. Tolkien', update: '1' } as never,
			null
		)
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.image).toBe('https://i.gr-assets.com/tolkien.jpg')
		expect(out.description).toBe('An Oxford philologist.')
		// Keyed by ASIN, not name — the whole point of the rung.
		expect(mockChaptarrAuthorInfo.mock.calls[0]?.[0]).toBe(asin)
		getSpy.mockRestore()
	})

	test('CHAPTARR never overrides an earlier source and is skipped when whole', async () => {
		mockScrapeProcess.mockRejectedValue(
			new NotFoundError('gone', { asin, code: 'REGION_UNAVAILABLE' })
		)
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue({
			fetchAuthorInfo: mock().mockResolvedValue({ image: null, bio: null })
		} as unknown as ReturnType<typeof defaultRegistry.get>)
		mockFetchGoodreadsAuthorInfo.mockResolvedValue({
			image: 'https://gr/real.jpg',
			bio: 'A real bio.'
		})
		mockChaptarrAuthorInfo.mockResolvedValue({
			image: 'https://ct/should-not-appear.jpg',
			bio: 'Should not appear.'
		})
		helper = new AuthorShowHelper(
			asin,
			{ region: 'us', name: 'Graham McNeill', update: '1' } as never,
			null
		)
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.image).toBe('https://gr/real.jpg')
		expect(out.description).toBe('A real bio.')
		// The profile was already whole, so the rung was never even consulted.
		expect(mockChaptarrAuthorInfo).not.toHaveBeenCalled()
		getSpy.mockRestore()
	})

	test('CHAPTARR fills only the missing HALF of a partial profile', async () => {
		// The discriminating shape for the override mutation: Goodreads filled
		// the IMAGE but not the bio, so the rung runs (bio gap) while holding
		// an image it must not touch. A mutant that overrides instead of fills
		// replaces the Goodreads portrait here and nowhere else.
		mockScrapeProcess.mockRejectedValue(
			new NotFoundError('gone', { asin, code: 'REGION_UNAVAILABLE' })
		)
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue({
			fetchAuthorInfo: mock().mockResolvedValue({ image: null, bio: null })
		} as unknown as ReturnType<typeof defaultRegistry.get>)
		mockFetchGoodreadsAuthorInfo.mockResolvedValue({
			image: 'https://gr/real.jpg',
			bio: null
		})
		mockChaptarrAuthorInfo.mockResolvedValue({
			image: 'https://ct/should-not-replace.jpg',
			bio: 'Filled by Chaptarr.'
		})
		helper = new AuthorShowHelper(
			asin,
			{ region: 'us', name: 'Graham McNeill', update: '1' } as never,
			null
		)
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.image).toBe('https://gr/real.jpg')
		expect(out.description).toBe('Filled by Chaptarr.')
		getSpy.mockRestore()
	})

	test('rethrows a dead-ASIN error when NO name is supplied (no overwrite)', async () => {
		mockScrapeProcess.mockRejectedValue(
			new NotFoundError('gone', { asin, code: 'REGION_UNAVAILABLE' })
		)
		helper = new AuthorShowHelper(asin, { region: 'us', update: '1' } as never, null)
		await expect(helper.getNewData()).rejects.toThrow()
	})

	test('a transient Audible failure does NOT rename the stored author', async () => {
		// Audible maps 404/403/503 all to REGION_UNAVAILABLE, so a throttle blip lands
		// here. The caller's ?name= is the raw Plex tag (a spelling variant, or in the
		// swap case the NARRATOR) -- taking it would permanently rename the canonical
		// record that feeds the author text index.
		mockScrapeProcess.mockRejectedValue(
			new NotFoundError('blip', { asin, code: 'REGION_UNAVAILABLE' })
		)
		helper = new AuthorShowHelper(
			asin,
			{ region: 'us', name: 'Stephen Lawhead', update: '1' } as never,
			null
		)
		helper.originalData = { ...authorWithoutProjection, name: 'Stephen R. Lawhead' }
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.name).toBe('Stephen R. Lawhead')
	})

	test('an empty enrichment pass does not blank a stored portrait or bio', async () => {
		// Every source coming back empty (a Goodreads 429, a missing Hardcover token)
		// must not persist '' over what we already had -- one throttled minute during
		// a sweep would otherwise blank every author it touched.
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue({
			fetchAuthorInfo: mock().mockResolvedValue({ image: null, bio: null })
		} as unknown as ReturnType<typeof defaultRegistry.get>)
		mockFetchGoodreadsAuthorInfo.mockResolvedValue({ image: null, bio: null })
		mockScrapeProcess.mockResolvedValue({ ...parsedAuthor, image: '', description: '' })

		helper = new AuthorShowHelper(asin, { region: 'us', update: '1' } as never, null)
		helper.originalData = {
			...authorWithoutProjection,
			image: 'https://stored/portrait.jpg',
			description: 'A stored bio.'
		}
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.image).toBe('https://stored/portrait.jpg')
		expect(out.description).toBe('A stored bio.')
		getSpy.mockRestore()
	})

	test('rethrows a non-availability error even when a name is supplied', async () => {
		mockScrapeProcess.mockRejectedValue(new Error('network boom'))
		helper = new AuthorShowHelper(
			asin,
			{ region: 'us', name: 'Graham McNeill', update: '1' } as never,
			null
		)
		await expect(helper.getNewData()).rejects.toThrow('network boom')
	})

	test('create or update a author', async () => {
		await expect(helper.createOrUpdateData()).resolves.toStrictEqual(parsedAuthor)
	})

	test('backfills the description from Hardcover only when Audible left it empty', async () => {
		const fakeHc = {
			fetchAuthorInfo: mock().mockResolvedValue({ image: null, bio: 'Backfilled bio.' })
		}
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue(
			fakeHc as unknown as ReturnType<typeof defaultRegistry.get>
		)

		// Audible returned an empty description → Hardcover fills it.
		mockScrapeProcess.mockResolvedValue({ ...parsedAuthor, description: '' })
		const filled = (await helper.getNewData()) as ApiAuthorProfile
		expect(filled.description).toBe('Backfilled bio.')

		// Audible already has a description → Hardcover must NOT overwrite it.
		mockScrapeProcess.mockResolvedValue({ ...parsedAuthor, description: 'Audible bio.' })
		const kept = (await helper.getNewData()) as ApiAuthorProfile
		expect(kept.description).toBe('Audible bio.')

		getSpy.mockRestore()
	})

	test('threads per-request credentials into the Hardcover author lookup', async () => {
		const fetchAuthorInfo = mock().mockResolvedValue({ image: null, bio: null })
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue({
			fetchAuthorInfo
		} as unknown as ReturnType<typeof defaultRegistry.get>)

		// Header token present → it must reach the provider call.
		helper = new AuthorShowHelper(asin, { region: 'us', update: undefined }, null, undefined, {
			hardcover: 'user-token'
		})
		await helper.getNewData()
		expect(fetchAuthorInfo.mock.calls[0]?.[1]).toMatchObject({
			credentials: { hardcover: 'user-token' }
		})

		// No credentials → the provider sees none and falls back to its env token.
		helper = new AuthorShowHelper(asin, { region: 'us', update: undefined }, null)
		await helper.getNewData()
		expect(fetchAuthorInfo.mock.calls[1]?.[1]?.credentials).toBeUndefined()

		getSpy.mockRestore()
	})

	test('force=1 skips the recency throttle and re-fetches anyway', async () => {
		// The throttle exists for the SCHEDULER's monthly update=1 sweep; a human
		// asking force=1 is explicitly overriding it. Measured on Roger Zelazny:
		// his record froze bio-less inside the window (a cache-cold mirror answered
		// his first lookup incompletely), and no operator action could heal it --
		// update=1 returned the stale record untouched for 7 days.
		const forced = new AuthorShowHelper(asin, { region: 'us', update: '1', force: '1' }, null)
		spyOn(forced.sharedHelper, 'isRecentlyUpdated').mockReturnValue(true)
		forced.originalData = authorWithoutProjectionUpdatedNow
		const fresh = spyOn(forced, 'createOrUpdateData').mockResolvedValue(parsedAuthor)
		await expect(forced.updateActions()).resolves.toStrictEqual(parsedAuthor)
		expect(fresh).toHaveBeenCalled()
	})

	test('returns original author if it was updated recently when trying to update', async () => {
		spyOn(helper.sharedHelper, 'isRecentlyUpdated').mockReturnValue(true)
		helper.originalData = authorWithoutProjectionUpdatedNow
		await expect(helper.updateActions()).resolves.toStrictEqual(parsedAuthor)
	})

	test('isUpdatedRecently returns false if no originalAuthor is present', () => {
		expect(helper.isUpdatedRecently()).toBe(false)
	})

	test('run all update actions', async () => {
		helper.originalData = authorWithoutProjection
		await expect(helper.updateActions()).resolves.toStrictEqual(parsedAuthor)
	})

	test('run handler for a new author', async () => {
		mockPaprFindOne.mockResolvedValue({ data: null, modified: false })
		await expect(helper.handler()).resolves.toStrictEqual(parsedAuthor)
	})

	test('run handler and update an existing author', async () => {
		helper = new AuthorShowHelper(asin, { region: 'us', update: '1' }, null)
		mockPaprCreateOrUpdate.mockResolvedValue({ data: parsedAuthor, modified: true })
		mockPaprFindOne.mockResolvedValue({ data: authorWithoutProjection, modified: false })
		mockPaprFindOneWithProjection.mockResolvedValue({ data: parsedAuthor, modified: false })
		mockScrapeProcess.mockResolvedValue(parsedAuthor)
		spyOn(helper.sharedHelper, 'sortObjectByKeys').mockReturnValue(parsedAuthor)
		spyOn(helper.sharedHelper, 'isRecentlyUpdated').mockReturnValue(false)
		await expect(helper.handler()).resolves.toStrictEqual(parsedAuthor)
	})

	test('run handler for an existing author in redis', async () => {
		ctx = createMockContext()
		helper = new AuthorShowHelper(asin, { region: 'us', update: '0' }, ctx.client)
		mockRedisFindOne.mockResolvedValue(parsedAuthor)
		await expect(helper.handler()).resolves.toStrictEqual(parsedAuthor)
		expect(helper.redisHelper.findOne).toHaveBeenCalledTimes(1)
	})

	test('force=1 alone takes the update path -- never the cached body', async () => {
		// force is the operator's "heal this NOW". Without the update implication
		// a bare ?force=1 served straight from redis: the flag looked honored and
		// did nothing, which is worse than rejecting it.
		ctx = createMockContext()
		helper = new AuthorShowHelper(asin, { region: 'us', force: '1' } as never, ctx.client)
		mockRedisFindOne.mockResolvedValue(parsedAuthor)
		mockPaprFindOne.mockResolvedValue({ data: authorWithoutProjection, modified: false })
		spyOn(helper.sharedHelper, 'sortObjectByKeys').mockReturnValue(parsedAuthor)
		spyOn(helper.sharedHelper, 'isRecentlyUpdated').mockReturnValue(true)
		await expect(helper.handler()).resolves.toStrictEqual(parsedAuthor)
		// The fresh scrape ran despite the redis hit AND the recency window.
		expect(mockScrapeProcess).toHaveBeenCalled()
	})

	test('run handler for an existing author', async () => {
		mockRedisFindOrCreate.mockResolvedValue(undefined)
		await expect(helper.handler()).resolves.toStrictEqual(parsedAuthor)
	})

	test('run handler for an existing author in redis', async () => {
		await expect(helper.handler()).resolves.toStrictEqual(parsedAuthor)
	})
})

describe('AuthorShowHelper should throw error when', () => {
	test('getDataWithProjection is not a author type', async () => {
		mockPaprFindOneWithProjection.mockResolvedValue({ data: null, modified: false })
		await expect(helper.getDataWithProjection()).rejects.toThrow(
			`Data type for ${asin} is not ApiAuthorProfile`
		)
	})

	test('getDataWithProjection sorted author is not a author type', async () => {
		setPerformanceConfig(createTestConfig({ USE_SORTED_KEYS: true }))
		spyOn(helper.sharedHelper, 'sortObjectByKeys').mockReturnValue(
			null as unknown as ApiAuthorProfile
		)
		await expect(helper.getDataWithProjection()).rejects.toThrow(
			`Data type for ${asin} is not ApiAuthorProfile`
		)
	})

	test('createOrUpdateAuthor is not a author type', async () => {
		mockPaprCreateOrUpdate.mockResolvedValue({ data: null, modified: false })
		await expect(helper.createOrUpdateData()).rejects.toThrow(
			`Data type for ${asin} is not ApiAuthorProfile`
		)
	})

	test('updateActions has no originalAuthor', async () => {
		helper.originalData = null
		await expect(helper.updateActions()).rejects.toThrow(
			`Missing original author data for ASIN: ${asin}`
		)
	})

	test('updateActions fails to update', async () => {
		helper.originalData = authorWithoutProjection
		mockPaprCreateOrUpdate.mockRejectedValue(new Error('error'))
		await expect(helper.updateActions()).rejects.toThrow('error')
	})
})

afterAll(() => {
	mock.restore()
})

describe('generated Hardcover avatar policy', () => {
	/**
	 * A generated avatar must never DISPLACE a real photo, but may FILL a slot
	 * that would otherwise be empty (operator decision 2026-07-26: "I don't
	 * mind it for authors who have zero other options"). Robert Harris lost
	 * his real photo to the avatar via the Hardcover-prefer swap + the
	 * square-fit rule; Mitchel Scanlon sat with a blank tile the avatar could
	 * have filled.
	 */

	test('a generated avatar never displaces the Audible photo', async () => {
		const fakeHc = {
			fetchAuthorInfo: mock().mockResolvedValue({
				image: 'https://assets.hardcover.app/author/61383/avatar.png',
				bio: null,
				imageGenerated: true
			})
		}
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue(
			fakeHc as unknown as ReturnType<typeof defaultRegistry.get>
		)
		mockScrapeProcess.mockResolvedValue({ ...parsedAuthor })
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.image).toBe(parsedAuthor.image)
		expect(out.imageAlt ?? '').not.toContain('avatar.png')
		getSpy.mockRestore()
	})

	test('a generated avatar still fills a completely empty slot', async () => {
		const fakeHc = {
			fetchAuthorInfo: mock().mockResolvedValue({
				image: 'https://assets.hardcover.app/author/00000/avatar.png',
				bio: null,
				imageGenerated: true
			})
		}
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue(
			fakeHc as unknown as ReturnType<typeof defaultRegistry.get>
		)
		mockScrapeProcess.mockResolvedValue({ ...parsedAuthor, image: '', imageAlt: '' })
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.image).toBe('https://assets.hardcover.app/author/00000/avatar.png')
		getSpy.mockRestore()
	})
})

describe('static Hardcover avatar fallback', () => {
	/**
	 * Hardcover's website shows a hooded-figure avatar for EVERY author, but
	 * only some rows have it materialized as an image asset (the Harris class);
	 * the rest -- Mitchel Scanlon -- render it client-side and their API row
	 * says image:null, leaving a blank Plex tile. The art itself is six static
	 * files (assets.hardcover.app/static/avatars/profile1..6.png, 500x500,
	 * probed 2026-07-26), so when every source has nothing, fill with one of
	 * those -- picked by a stable name hash, mimicking Hardcover's own look.
	 */

	test('an author with nothing anywhere gets a static avatar, deterministically', async () => {
		const fakeHc = {
			fetchAuthorInfo: mock().mockResolvedValue({ image: null, bio: null, imageGenerated: false })
		}
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue(
			fakeHc as unknown as ReturnType<typeof defaultRegistry.get>
		)
		mockScrapeProcess.mockResolvedValue({ ...parsedAuthor, image: '', imageAlt: '' })
		const first = (await helper.getNewData()) as ApiAuthorProfile
		expect(first.image).toMatch(
			/^https:\/\/assets\.hardcover\.app\/static\/avatars\/profile[1-6]\.png$/
		)
		// Deterministic: the same name always lands on the same variant.
		const second = (await helper.getNewData()) as ApiAuthorProfile
		expect(second.image).toBe(first.image)
		getSpy.mockRestore()
	})

	test('a real photo from any source suppresses the static fallback', async () => {
		const fakeHc = {
			fetchAuthorInfo: mock().mockResolvedValue({ image: null, bio: null, imageGenerated: false })
		}
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue(
			fakeHc as unknown as ReturnType<typeof defaultRegistry.get>
		)
		mockScrapeProcess.mockResolvedValue({ ...parsedAuthor })
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.image).toBe(parsedAuthor.image)
		getSpy.mockRestore()
	})

	test('a MATERIALIZED generated avatar still outranks the static one', async () => {
		// Harris-class rows carry a per-author colored avatar Hardcover itself
		// rendered; that stays preferred over our hash-picked static.
		const fakeHc = {
			fetchAuthorInfo: mock().mockResolvedValue({
				image: 'https://assets.hardcover.app/author/61383/avatar.png',
				bio: null,
				imageGenerated: true
			})
		}
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue(
			fakeHc as unknown as ReturnType<typeof defaultRegistry.get>
		)
		mockScrapeProcess.mockResolvedValue({ ...parsedAuthor, image: '', imageAlt: '' })
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.image).toBe('https://assets.hardcover.app/author/61383/avatar.png')
		getSpy.mockRestore()
	})
})

describe('a persisted placeholder avatar never sticks', () => {
	/**
	 * The fill rungs run LAST so an avatar-only author still counts as
	 * incomplete on the pass that fills it -- but once PERSISTED, the avatar
	 * came back in through the front door (the minimal-profile seed and the
	 * previous-record restore), where it read as a real portrait: the Goodreads
	 * backstop was skipped and the second chance never scheduled again. The
	 * placeholder must count as EMPTY everywhere except the final fill.
	 */
	const STATIC_AVATAR = 'https://assets.hardcover.app/static/avatars/profile3.png'
	const GENERATED = 'https://assets.hardcover.app/author/61383/avatar.png'
	const GR_PHOTO =
		'https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/authors/1492336018i/16727429._UY200_.jpg'

	const noHardcover = () =>
		spyOn(defaultRegistry, 'get').mockReturnValue({
			fetchAuthorInfo: mock().mockResolvedValue({ image: null, bio: null, imageGenerated: false })
		} as unknown as ReturnType<typeof defaultRegistry.get>)

	test('a seeded static avatar does not block the Goodreads backstop', async () => {
		// The Audible-unavailable path seeds the STORED image -- which is the
		// avatar a previous pass persisted. It must not read as a portrait.
		const getSpy = noHardcover()
		helper = new AuthorShowHelper(asin, { region: 'us', name: 'Graham McNeill' } as never, null)
		helper.originalData = {
			...authorWithoutProjection,
			image: STATIC_AVATAR,
			description: ''
		} as never
		mockScrapeProcess.mockRejectedValue(new NotFoundError('gone', { code: 'REGION_UNAVAILABLE' }))
		mockFetchGoodreadsAuthorInfo.mockResolvedValue({ image: GR_PHOTO, bio: 'found later' })
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.image).toBe(GR_PHOTO)
		getSpy.mockRestore()
	})

	test('a persisted GENERATED avatar (re-identified this pass) yields to Goodreads too', async () => {
		const fakeHc = {
			fetchAuthorInfo: mock().mockResolvedValue({
				image: GENERATED,
				bio: null,
				imageGenerated: true
			})
		}
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue(
			fakeHc as unknown as ReturnType<typeof defaultRegistry.get>
		)
		helper = new AuthorShowHelper(asin, { region: 'us', name: 'Robert Harris' } as never, null)
		helper.originalData = {
			...authorWithoutProjection,
			image: GENERATED,
			description: ''
		} as never
		mockScrapeProcess.mockRejectedValue(new NotFoundError('gone', { code: 'REGION_UNAVAILABLE' }))
		mockFetchGoodreadsAuthorInfo.mockResolvedValue({ image: GR_PHOTO, bio: 'found later' })
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.image).toBe(GR_PHOTO)
		getSpy.mockRestore()
	})

	test('a real Hardcover portrait never demotes a seeded avatar into imageAlt', async () => {
		const fakeHc = {
			fetchAuthorInfo: mock().mockResolvedValue({
				image: 'https://assets.hardcover.app/author/12345/real-photo.jpg',
				bio: null,
				imageGenerated: false
			})
		}
		const getSpy = spyOn(defaultRegistry, 'get').mockReturnValue(
			fakeHc as unknown as ReturnType<typeof defaultRegistry.get>
		)
		helper = new AuthorShowHelper(asin, { region: 'us', name: 'Graham McNeill' } as never, null)
		helper.originalData = { ...authorWithoutProjection, image: STATIC_AVATAR } as never
		mockScrapeProcess.mockRejectedValue(new NotFoundError('gone', { code: 'REGION_UNAVAILABLE' }))
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(out.image).toBe('https://assets.hardcover.app/author/12345/real-photo.jpg')
		expect(out.imageAlt ?? '').not.toContain('static/avatars')
		getSpy.mockRestore()
	})

	test('an avatar restored from the previous record still counts as incomplete', async () => {
		// Scrape is fine but empty; every source misses; the previous record
		// wears the avatar. Restoring it must not satisfy the second chance --
		// the author still has no real portrait.
		const getSpy = noHardcover()
		mockScrapeProcess.mockResolvedValue({ ...parsedAuthor, image: '', imageAlt: '' })
		mockFetchGoodreadsAuthorInfo.mockResolvedValue({ image: null, bio: null })
		helper.originalData = { ...authorWithoutProjection, image: STATIC_AVATAR } as never
		mockSchedule.mockClear()
		const out = (await helper.getNewData()) as ApiAuthorProfile
		expect(mockSchedule).toHaveBeenCalledTimes(1)
		// ...and the tile is still not blank: the fill rung re-fills it.
		expect(out.image).toMatch(
			/^https:\/\/assets\.hardcover\.app\/static\/avatars\/profile[1-6]\.png$/
		)
		getSpy.mockRestore()
	})
})

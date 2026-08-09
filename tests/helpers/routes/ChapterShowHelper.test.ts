import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

const mockChapterFindOne = mock()
const mockChapterFind = mock()
const mockPaprFindOne = mock()
const mockPaprFindOneWithProjection = mock()
const mockPaprCreateOrUpdate = mock()
const mockRedisFindOne = mock()
const mockRedisFindOrCreate = mock()
// Resolves like the real async setOne — the caller chains .catch on it.
const mockRedisSetOne = mock(() => Promise.resolve(undefined))
const mockRedisSetExpiration = mock()
const mockRedisDeleteOne = mock()
const mockSharedIsObject = mock()
const mockSharedSortObjectByKeys = mock()
const mockCheckersIsApiChapter = mock()
const mockChapterHelperProcess = mock()

mock.module('#config/models/Chapter', () => ({
	default: class ChapterModel {
		static findOne = mockChapterFindOne
		static find = mockChapterFind
	}
}))
mock.module('#helpers/database/papr/audible/PaprAudibleChapterHelper', () => ({
	default: class PaprAudibleChapterHelper {
		findOne = mockPaprFindOne
		findOneWithProjection = mockPaprFindOneWithProjection
		createOrUpdate = mockPaprCreateOrUpdate
		setData = mock()
	}
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

mock.module('#helpers/utils/shared', () => ({
	isObject: mockSharedIsObject,
	sortObjectByKeys: mockSharedSortObjectByKeys
}))

mock.module('#config/typing/checkers', () => ({
	isApiChapter: mockCheckersIsApiChapter
}))

mock.module('#helpers/books/audible/ChapterHelper', () => ({
	default: class ChapterHelper {
		process = mockChapterHelperProcess
	}
}))

const mockChaptarrChapters = mock()
mock.module('#helpers/providers/chaptarrChapters', () => ({
	chaptarrChapters: mockChaptarrChapters
}))

mock.module('@fastify/redis', () => ({}))

import type { FastifyRedis } from '@fastify/redis'

import {
	PerformanceConfig,
	resetPerformanceConfig,
	setPerformanceConfig
} from '#config/performance'
import { ApiChapter } from '#config/types'
import { NotFoundError } from '#helpers/errors/ApiErrors'
import ChapterShowHelper from '#helpers/routes/ChapterShowHelper'
import {
	chaptersWithoutProjection,
	chaptersWithoutProjectionUpdatedNow,
	parsedChapters
} from '#tests/datasets/helpers/chapters'

type MockContext = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	client: any
}

let asin: string
let ctx: MockContext
let helper: ChapterShowHelper

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

beforeEach(() => {
	mockChaptarrChapters.mockResolvedValue(null)
	mock.clearAllMocks()
	asin = 'B079LRSMNN'
	helper = new ChapterShowHelper(asin, { region: 'us', update: undefined }, null)
	mockPaprCreateOrUpdate.mockResolvedValue({ data: parsedChapters, modified: true })
	mockPaprFindOne.mockResolvedValue({ data: chaptersWithoutProjection, modified: false })
	mockChapterHelperProcess.mockResolvedValue(parsedChapters)
	mockRedisFindOrCreate.mockResolvedValue(parsedChapters)
	mockPaprFindOneWithProjection.mockResolvedValue({ data: parsedChapters, modified: false })
	spyOn(helper.sharedHelper, 'sortObjectByKeys').mockReturnValue(parsedChapters)
	spyOn(helper.sharedHelper, 'isRecentlyUpdated').mockReturnValue(false)
})

afterEach(() => {
	resetPerformanceConfig()
})

describe('ChapterShowHelper should', () => {
	test('get a chapter from Papr', async () => {
		await expect(helper.getDataFromPapr()).resolves.toStrictEqual(chaptersWithoutProjection)
	})

	test('get new chapter data', async () => {
		await expect(helper.getNewData()).resolves.toStrictEqual(parsedChapters)
	})

	test('create or update a chapter', async () => {
		await expect(helper.createOrUpdateData()).resolves.toStrictEqual(parsedChapters)
	})

	test('create or update chapter and return undefined if no chapters', async () => {
		mockChapterHelperProcess.mockResolvedValue(undefined)
		await expect(helper.createOrUpdateData()).resolves.toBeUndefined()
	})

	test('returns original chapter if it was updated recently when trying to update', async () => {
		spyOn(helper.sharedHelper, 'isRecentlyUpdated').mockReturnValue(true)
		helper.originalData = chaptersWithoutProjectionUpdatedNow
		await expect(helper.updateActions()).resolves.toStrictEqual(parsedChapters)
	})

	test('isUpdatedRecently returns false if no originalData is present', () => {
		expect(helper.isUpdatedRecently()).toBe(false)
	})

	test('run all update actions', async () => {
		helper.originalData = chaptersWithoutProjection
		await expect(helper.updateActions()).resolves.toStrictEqual(parsedChapters)
	})

	test('run all update actions and return undefined if no chapters', async () => {
		mockChapterHelperProcess.mockResolvedValue(undefined)
		helper.originalData = chaptersWithoutProjection
		await expect(helper.updateActions()).resolves.toBeUndefined()
	})

	test('run handler for a new chapter', async () => {
		mockPaprFindOne.mockResolvedValue({ data: null, modified: false })
		await expect(helper.handler()).resolves.toStrictEqual(parsedChapters)
	})

	test('run handler and update an existing chapter', async () => {
		helper = new ChapterShowHelper(asin, { region: 'us', update: '1' }, null)
		mockPaprCreateOrUpdate.mockResolvedValue({ data: parsedChapters, modified: true })
		mockPaprFindOne.mockResolvedValue({ data: chaptersWithoutProjection, modified: false })
		mockPaprFindOneWithProjection.mockResolvedValue({ data: parsedChapters, modified: false })
		mockChapterHelperProcess.mockResolvedValue(parsedChapters)
		spyOn(helper.sharedHelper, 'sortObjectByKeys').mockReturnValue(parsedChapters)
		spyOn(helper.sharedHelper, 'isRecentlyUpdated').mockReturnValue(false)
		await expect(helper.handler()).resolves.toStrictEqual(parsedChapters)
	})

	test('run handler for an existing chapter in redis', async () => {
		ctx = createMockContext()
		helper = new ChapterShowHelper(asin, { region: 'us', update: '0' }, ctx.client)
		mockRedisFindOne.mockResolvedValue(parsedChapters)
		await expect(helper.handler()).resolves.toStrictEqual(parsedChapters)
		expect(helper.redisHelper.findOne).toHaveBeenCalledTimes(1)
	})

	test('run handler for an existing chapter', async () => {
		mockRedisFindOrCreate.mockResolvedValue(undefined)
		await expect(helper.handler()).resolves.toStrictEqual(parsedChapters)
	})

	test('run handler for an existing chapter in redis', async () => {
		await expect(helper.handler()).resolves.toStrictEqual(parsedChapters)
	})

	test('run handler for no chapters', async () => {
		mockRedisFindOne.mockResolvedValue(null)
		mockPaprFindOne.mockResolvedValue({ data: null, modified: false })
		mockChapterHelperProcess.mockResolvedValue(undefined)
		await expect(helper.handler()).resolves.toBeUndefined()
	})
})

describe('the CHAPTARR chapter fallback', () => {
	// Audible first, Chaptarr second, and only for the no-answer shapes —
	// pinned here because every enrichment rung's wiring bug has been
	// invisible to unit tests of the rung itself (the unwired-stage class).
	const CHAPTARR_ANSWER = { asin: 'B079LRSMNN', chapters: [{ title: 'From Chaptarr' }] }

	test('an Audible answer never consults Chaptarr', async () => {
		await helper.getNewData()
		expect(mockChaptarrChapters).not.toHaveBeenCalled()
	})

	test('Audible undefined -> Chaptarr fills, keyed by asin and region', async () => {
		mockChapterHelperProcess.mockResolvedValue(undefined)
		mockChaptarrChapters.mockResolvedValue(CHAPTARR_ANSWER)
		const out = await helper.getNewData()
		expect(out).toBe(CHAPTARR_ANSWER as never)
		expect(mockChaptarrChapters.mock.calls[0]?.[0]).toBe(asin)
		expect(mockChaptarrChapters.mock.calls[0]?.[1]).toBe('us')
	})

	test('a NotFoundError (no ADP creds / delisted) -> Chaptarr fills', async () => {
		mockChapterHelperProcess.mockRejectedValue(new NotFoundError('no creds'))
		mockChaptarrChapters.mockResolvedValue(CHAPTARR_ANSWER)
		expect(await helper.getNewData()).toBe(CHAPTARR_ANSWER as never)
	})

	test('both blind: the ORIGINAL NotFoundError propagates', async () => {
		const original = new NotFoundError('no creds')
		mockChapterHelperProcess.mockRejectedValue(original)
		mockChaptarrChapters.mockResolvedValue(null)
		await expect(helper.getNewData()).rejects.toBe(original)
	})

	test('both blind without an error stays undefined', async () => {
		mockChapterHelperProcess.mockResolvedValue(undefined)
		mockChaptarrChapters.mockResolvedValue(null)
		expect(await helper.getNewData()).toBeUndefined()
	})

	test('a NON-NotFound failure rethrows WITHOUT consulting the fallback', async () => {
		// An outage or a bug is not a gap to paper over — papering over it
		// would persist a Chaptarr record that masks the real failure.
		mockChapterHelperProcess.mockRejectedValue(new Error('audible exploded'))
		mockChaptarrChapters.mockResolvedValue(CHAPTARR_ANSWER)
		await expect(helper.getNewData()).rejects.toThrow('audible exploded')
		expect(mockChaptarrChapters).not.toHaveBeenCalled()
	})
})

/**
 * FILL-ONLY MEANS FILL-ONLY: THE FALLBACK MUST NOT OVERWRITE A STORED RECORD.
 *
 * GenericShowHelper.updateActions PRESERVES the stored record when the update
 * throws NotFoundError with code REGION_UNAVAILABLE or PRODUCT_DELISTED.
 * Catching the whole NotFoundError family here made that branch unreachable: a
 * stored record with `isAccurate: true` and real brand offsets was replaced by
 * Chaptarr's `isAccurate: false`, all-zero-brand record and persisted.
 *
 * And it is the COMMON shape, not a rare one — ChapterHelper.fetchChapter
 * swallows every failure and returns undefined, so a transient Audible
 * 500/429/timeout also arrives here as REGION_UNAVAILABLE.
 */
describe('the fallback vs the preserve branch', () => {
	const CHAPTARR_ANSWER = { asin: 'B079LRSMNN', chapters: [{ title: 'From Chaptarr' }] }
	const unavailable = (code: string) => new NotFoundError('gone', { code })

	for (const code of ['REGION_UNAVAILABLE', 'PRODUCT_DELISTED']) {
		test(`${code} with a STORED record rethrows so the preserve branch wins`, async () => {
			const err = unavailable(code)
			mockChapterHelperProcess.mockRejectedValue(err)
			mockChaptarrChapters.mockResolvedValue(CHAPTARR_ANSWER)
			helper.originalData = chaptersWithoutProjection
			await expect(helper.getNewData()).rejects.toBe(err)
			expect(mockChaptarrChapters).not.toHaveBeenCalled()
		})

		test(`${code} with NOTHING stored still falls through to Chaptarr`, async () => {
			// Nothing to preserve: filling is strictly better than 404ing.
			mockChapterHelperProcess.mockRejectedValue(unavailable(code))
			mockChaptarrChapters.mockResolvedValue(CHAPTARR_ANSWER)
			helper.originalData = null
			expect(await helper.getNewData()).toBe(CHAPTARR_ANSWER as never)
		})
	}

	test('the ADP_TOKEN-less NotFoundError (no details.code) ALWAYS fills', async () => {
		// ChapterHelper throws this one from its CONSTRUCTOR, with no details —
		// and it is the reason this fallback exists on this deployment. A
		// stored record must not gate it, or every credential-less instance
		// keeps whatever it happened to store first, forever.
		mockChapterHelperProcess.mockRejectedValue(new NotFoundError('no creds'))
		mockChaptarrChapters.mockResolvedValue(CHAPTARR_ANSWER)
		helper.originalData = chaptersWithoutProjection
		expect(await helper.getNewData()).toBe(CHAPTARR_ANSWER as never)
	})

	test('a NotFoundError with an UNRELATED code still fills', async () => {
		mockChapterHelperProcess.mockRejectedValue(new NotFoundError('nope', { code: 'NO_CHAPTERS' }))
		mockChaptarrChapters.mockResolvedValue(CHAPTARR_ANSWER)
		helper.originalData = chaptersWithoutProjection
		expect(await helper.getNewData()).toBe(CHAPTARR_ANSWER as never)
	})

	test("END TO END: updateActions returns the STORED chapters, not Chaptarr's", async () => {
		// The wiring, not just the branch: the rethrow has to reach
		// updateActions' catch and come back as the projected stored record.
		mockChapterHelperProcess.mockRejectedValue(unavailable('REGION_UNAVAILABLE'))
		mockChaptarrChapters.mockResolvedValue(CHAPTARR_ANSWER)
		helper.originalData = chaptersWithoutProjection
		await expect(helper.updateActions()).resolves.toStrictEqual(parsedChapters)
		expect(mockPaprCreateOrUpdate).not.toHaveBeenCalled()
	})
})

describe('ChapterShowHelper should throw error when', () => {
	test('getChaptersWithProjection is not a chapter type', async () => {
		mockPaprFindOneWithProjection.mockResolvedValue({ data: null, modified: false })
		await expect(helper.getDataWithProjection()).rejects.toThrow(
			`Data type for ${asin} is not ApiChapter`
		)
	})

	test('getChaptersWithProjection sorted chapters is not a chapter type', async () => {
		setPerformanceConfig(createTestConfig({ USE_SORTED_KEYS: true }))
		spyOn(helper.sharedHelper, 'sortObjectByKeys').mockReturnValue(null as unknown as ApiChapter)
		await expect(helper.getDataWithProjection()).rejects.toThrow(
			`Data type for ${asin} is not ApiChapter`
		)
	})

	test('createOrUpdateData is not a chapter type', async () => {
		mockPaprCreateOrUpdate.mockResolvedValue({ data: null, modified: false })
		await expect(helper.createOrUpdateData()).rejects.toThrow(
			`Data type for ${asin} is not ApiChapter`
		)
	})

	test('update has no originalData', async () => {
		helper.originalData = null
		await expect(helper.updateActions()).rejects.toThrow(
			`Missing original chapter data for ASIN: ${asin}`
		)
	})

	test('updateActions fails to update', async () => {
		mockPaprCreateOrUpdate.mockRejectedValue(new Error('Error'))
		helper.originalData = chaptersWithoutProjection
		await expect(helper.updateActions()).rejects.toThrow('Error')
	})
})

afterAll(() => {
	mock.restore()
})

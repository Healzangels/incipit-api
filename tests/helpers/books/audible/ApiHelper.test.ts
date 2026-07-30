import type { AxiosResponse } from 'axios'
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { FastifyBaseLogger } from 'fastify'

import {
	AudibleCategory,
	AudibleProduct,
	AudibleProductSchema,
	AudibleSeries,
	fallbackShape
} from '#config/types'
import ApiHelper from '#helpers/books/audible/ApiHelper'
import { ContentTypeMismatchError, NotFoundError } from '#helpers/errors/ApiErrors'
import * as fetchPlus from '#helpers/utils/fetchPlus'
import SharedHelper from '#helpers/utils/shared'
import { regions } from '#static/regions'
import {
	B0GFYFCX3D,
	B07BS4RKGH,
	B017V4IM1G,
	bookWithoutContentDeliveryType,
	podcast,
	podcastWithoutProgramParticipation
} from '#tests/datasets/audible/books/api'
import { apiResponse, parsedBook, parsedBookWithoutNarrators } from '#tests/datasets/helpers/books'
import { createMockLogger } from '#tests/setup/mockLogger'

mock.module('#helpers/utils/fetchPlus', () => {
	return { default: mock() }
})

mock.module('#helpers/utils/shared', () => {
	return {
		default: class SharedHelper {
			getParamString() {
				return ''
			}
			buildUrl() {
				return ''
			}
		}
	}
})

let asin: string
let helper: ApiHelper
let mockResponse: AudibleProduct
let region: string
let url: string
const deepCopy = (obj: unknown) => JSON.parse(JSON.stringify(obj))

beforeEach(async () => {
	asin = 'B079LRSMNN'
	region = 'us'
	const params =
		'category_ladders,contributors,product_desc,product_extended_attrs,product_attrs,media,rating,series&image_sizes=500,1024'
	url = `https://api.audible.com/1.0/catalog/products/${asin}/?response_groups=` + params
	mockResponse = AudibleProductSchema.parse(deepCopy(apiResponse))
	spyOn(SharedHelper.prototype, 'getParamString').mockReturnValue(params)
	spyOn(SharedHelper.prototype, 'buildUrl').mockReturnValue(url)
	spyOn(fetchPlus, 'default').mockImplementation(() =>
		Promise.resolve({ data: mockResponse, status: 200 } as AxiosResponse)
	)
	helper = new ApiHelper(asin, region)
})

describe('ApiHelper should', () => {
	test('setup constructor correctly', () => {
		expect(helper.asin).toBe(asin)
		expect(helper.requestUrl).toBe(url)
	})

	test('check required keys on parse', async () => {
		const invalidResponse = deepCopy(mockResponse)
		delete (invalidResponse.product as Record<string, unknown>).asin
		await expect(helper.parseResponse(invalidResponse)).rejects.toThrow(
			/Required key 'asin' does not exist/
		)
	})

	test('get copyright year', async () => {
		helper.audibleResponse = mockResponse.product
		expect(helper.getCopyrightYear()).toBe(2017)
	})

	test('get high res image', async () => {
		helper.audibleResponse = mockResponse.product
		expect(helper.getHighResImage()).toBe('https://m.media-amazon.com/images/I/91spdScZuIL.jpg')
	})

	test('get release date', async () => {
		helper.audibleResponse = mockResponse.product
		expect(helper.getReleaseDate()).toBeInstanceOf(Date)
	})

	test('get series', async () => {
		if (mockResponse.product.content_delivery_type !== 'MultiPartBook') return undefined
		helper.audibleResponse = mockResponse.product
		expect(helper.getSeries({ asin: '123', title: '', sequence: '1', url: '' })).toBeUndefined()
		expect(helper.getSeries(mockResponse.product.series![0])).toEqual({
			asin: 'B079YXK1GL',
			name: "Galaxy's Edge Series",
			position: '1-2'
		})
	})

	test('get series primary', async () => {
		if (mockResponse.product.content_delivery_type !== 'MultiPartBook') return undefined
		helper.audibleResponse = mockResponse.product
		expect(
			helper.getSeriesPrimary([{ asin: '123', title: '', sequence: '1', url: '' }])
		).toBeUndefined()
		expect(
			helper.getSeriesPrimary([
				{
					asin: 'B079YXK1GL',
					sequence: '1-2',
					title: "Galaxy's Edge Series",
					url: '/pd/Galaxys-Edge-Series-Audiobook/B079YXK1GL'
				}
			])
		).toEqual({
			asin: 'B079YXK1GL',
			name: "Galaxy's Edge Series",
			position: '1-2'
		})
	})

	test('get series secondary', async () => {
		if (mockResponse.product.content_delivery_type !== 'MultiPartBook') return undefined
		helper.audibleResponse = mockResponse.product
		expect(
			helper.getSeriesSecondary([{ asin: '123', title: '', sequence: '1', url: '' }])
		).toBeUndefined()
		expect(
			helper.getSeriesSecondary([
				{
					asin: 'B079YXK1GL',
					sequence: '1-2',
					title: "Galaxy's Edge Series",
					url: '/pd/Galaxys-Edge-Series-Audiobook/B079YXK1GL'
				},
				{
					asin: 'B079YXK1GL',
					sequence: '1-2',
					title: "NOT Galaxy's Edge Series",
					url: '/pd/Galaxys-Edge-Series-Audiobook/B079YXK1GL'
				}
			])
		).toEqual({
			asin: 'B079YXK1GL',
			name: "NOT Galaxy's Edge Series",
			position: '1-2'
		})
	})

	test('get series without position', async () => {
		expect(mockResponse.product.content_delivery_type).toBe('MultiPartBook')
		helper.audibleResponse = mockResponse.product
		const seriesWithoutPosition = {
			asin: 'B079YXK1GL',
			title: "Galaxy's Edge Series",
			url: '/pd/Galaxys-Edge-Series-Audiobook/B079YXK1GL'
		}
		const result = helper.getSeries(seriesWithoutPosition)
		expect(result).toEqual({
			asin: 'B079YXK1GL',
			name: "Galaxy's Edge Series"
		})
		expect(result).not.toHaveProperty('position')
	})

	test('fetch book data', async () => {
		const data = await helper.fetchBook()
		expect(data).toEqual(mockResponse)
	})

	test('parse response', async () => {
		const data = await helper.fetchBook()
		const parsed = helper.parseResponse(data)
		await expect(parsed).resolves.toEqual(parsedBook)
	})

	test('throws ContentTypeMismatchError for podcast content', async () => {
		await expect(helper.parseResponse(podcast)).rejects.toBeInstanceOf(ContentTypeMismatchError)
		await expect(helper.parseResponse(podcast)).rejects.toMatchObject({
			name: 'ContentTypeMismatchError',
			statusCode: 400,
			message: `Item is a podcast, not a book. ASIN: ${asin}`,
			details: {
				asin: asin,
				requestedType: 'book',
				actualType: 'PodcastParent'
			}
		})
	})

	test('throws ContentTypeMismatchError for podcast without program_participation', async () => {
		await expect(helper.parseResponse(podcastWithoutProgramParticipation)).rejects.toBeInstanceOf(
			ContentTypeMismatchError
		)
		await expect(helper.parseResponse(podcastWithoutProgramParticipation)).rejects.toMatchObject({
			name: 'ContentTypeMismatchError',
			statusCode: 400,
			message: `Item is a podcast, not a book. ASIN: ${asin}`,
			details: {
				asin: asin,
				requestedType: 'book',
				actualType: 'PodcastParent'
			}
		})
	})

	describe('handle region: ', () => {
		test.each(Object.keys(regions))('%s', async (region) => {
			helper = new ApiHelper('B079LRSMNN', region)
			const data = await helper.fetchBook()
			const parsed = await helper.parseResponse(data)
			expect(parsed.region).toEqual(region)
		})
	})
})

describe('ApiHelper edge cases should', () => {
	afterEach(() => {
		mock.restore()
	})

	test('parse a book with no narrators', async () => {
		const data = await helper.fetchBook()
		helper.audibleResponse = data.product
		helper.audibleResponse!.narrators = undefined

		expect(helper.getFinalData()).toEqual(parsedBookWithoutNarrators)
	})

	test('pass key check with a number value of 0', async () => {
		const data = mockResponse
		mockResponse.product.runtime_length_min = 0
		const parsed = await helper.parseResponse(data)
		expect(parsed).toBeDefined()
	})

	test('series should be undefined if no series', async () => {
		const obj = {
			asin: '123',
			title: '',
			sequence: '1'
		}
		expect(helper.getSeries(obj)).toBeUndefined()
	})

	test('getSeriesX should return undefined if not a multi part book', async () => {
		const obj = {
			asin: '123',
			title: '',
			sequence: '1'
		}
		helper.audibleResponse = mockResponse.product
		helper.audibleResponse!.content_delivery_type = 'SinglePartBook'
		expect(helper.getSeriesPrimary([obj])).toBeUndefined()
		expect(helper.getSeriesSecondary([obj])).toBeUndefined()
	})

	test('getSeriesPrimary keeps the lone series when publication_name is null', async () => {
		// MEASURED against live Audible 2026-07-30. Every Legend of Drizzt audiobook
		// has this shape:
		//   B00FRILVJO Starless Night   publication_name null, series
		//                               [{asin B00YDDXB60, "Legend of Drizzt", seq 8}]
		//   B00HFW9SUE Spine of World   ... seq 12      B00HNF85YI Sea of Swords ... seq 13
		// getSeriesPrimary only assigns when `publication_name && name === publication_name`,
		// so a null publication_name left seriesPrimary {} and the book had NO provider
		// series at all -- which is why those 14 albums depend entirely on the Goodreads
		// answer and lose their shelf whenever it is unavailable.
		const obj = { asin: 'B00YDDXB60', title: 'Legend of Drizzt', sequence: '8', url: '' }
		helper.audibleResponse = {
			...mockResponse.product,
			content_delivery_type: 'MultiPartBook',
			publication_name: undefined
		}
		expect(helper.getSeriesPrimary([obj])).toEqual({
			asin: 'B00YDDXB60',
			name: 'Legend of Drizzt',
			position: '8'
		})
	})

	test('an AMBIGUOUS series list is still refused when publication_name is null', async () => {
		// Deliberately limited to ONE candidate. With several entries and no
		// publication_name to choose by there is no evidence which is the shelf, and
		// guessing would move books off shelves they already sit on. Measured cost of
		// refusing this case: zero -- 0 of 1203 book-type records hit it.
		helper.audibleResponse = {
			...mockResponse.product,
			content_delivery_type: 'MultiPartBook',
			publication_name: undefined
		}
		expect(
			helper.getSeriesPrimary([
				{ asin: 'B00YDDXB60', title: 'First Series', sequence: '1', url: '' },
				{ asin: 'B00YDDXB61', title: 'Second Series', sequence: '2', url: '' }
			])
		).toBeUndefined()
	})

	test('publication_name still wins when it names one of several series', async () => {
		// The rescue must not outrank the real rule.
		helper.audibleResponse = {
			...mockResponse.product,
			content_delivery_type: 'MultiPartBook',
			publication_name: 'Second Series'
		}
		expect(
			helper.getSeriesPrimary([
				{ asin: 'B00YDDXB60', title: 'First Series', sequence: '1', url: '' },
				{ asin: 'B00YDDXB61', title: 'Second Series', sequence: '2', url: '' }
			])
		).toEqual({ asin: 'B00YDDXB61', name: 'Second Series', position: '2' })
	})

	test('a lone series is rescued when publication_name names a SUB-ARC', async () => {
		// THE REAL LIVE SHAPE, measured 2026-07-30 with the response groups this class
		// actually requests (publication_name is ABSENT from a narrower
		// series,product_desc,contributors fetch -- reading it there makes the field
		// look null and invites the wrong gate):
		//
		//   B00HFW9SUE  publication_name "Legend of Drizzt: Paths of Darkness"
		//               series           [{B00YDDXB60, "Legend of Drizzt", seq 12}]
		//
		// publication_name is a marketing label naming the sub-arc; the series array
		// holds the parent. They never match, so the book had no provider series at
		// all. The lone entry IS the shelf.
		helper.audibleResponse = {
			...mockResponse.product,
			content_delivery_type: 'MultiPartBook',
			publication_name: 'Legend of Drizzt: Paths of Darkness'
		}
		expect(
			helper.getSeriesPrimary([
				{ asin: 'B00YDDXB60', title: 'Legend of Drizzt', sequence: '12', url: '' }
			])
		).toEqual({ asin: 'B00YDDXB60', name: 'Legend of Drizzt', position: '12' })
	})

	test('one VALID candidate beside an unparseable entry is still rescued', async () => {
		// "Exactly one candidate" counts entries getSeries could actually parse, not
		// raw array length. A malformed sibling entry (bad asin) must not suppress a
		// shelf we can otherwise name. Pinned because counting raw entries instead
		// gives the same answer on every other case in this file.
		helper.audibleResponse = {
			...mockResponse.product,
			content_delivery_type: 'MultiPartBook',
			publication_name: 'Legend of Drizzt: Paths of Darkness'
		}
		expect(
			helper.getSeriesPrimary([
				{ asin: 'not-an-asin', title: 'Broken Entry', sequence: '1', url: '' },
				{ asin: 'B00YDDXB60', title: 'Legend of Drizzt', sequence: '12', url: '' }
			])
		).toEqual({ asin: 'B00YDDXB60', name: 'Legend of Drizzt', position: '12' })
	})

	test('the lone-series rescue does not populate the SECONDARY slot too', async () => {
		// getSeriesSecondary is gated on allSeries.length > 1, so one entry cannot
		// land in both slots. Pinned because the rescue would be actively harmful
		// if it did -- the bundle writes secondary as its own "Series: X" mood.
		const obj = { asin: 'B00YDDXB60', title: 'Legend of Drizzt', sequence: '8', url: '' }
		helper.audibleResponse = {
			...mockResponse.product,
			content_delivery_type: 'MultiPartBook',
			publication_name: undefined
		}
		expect(helper.getSeriesSecondary([obj])).toBeUndefined()
	})

	test('the rescue must not put the SAME series in both slots', async () => {
		// REGRESSION from fb058d2. The rescue counts PARSEABLE entries, but
		// getSeriesSecondary was still gated on raw allSeries.length > 1 -- so with
		// two entries of which only one parses, the lone candidate was emitted as
		// BOTH seriesPrimary and seriesSecondary. Before the rescue existed primary
		// was undefined and getFinalData emitted neither field, so this is new.
		//
		// The harm is concrete: the bundle writes seriesSecondary as its own
		// "Series: X" mood, so the album gets the same series tagged twice and moods
		// are never cleared.
		//
		// The existing test 'does not populate the SECONDARY slot too' only passes a
		// ONE-entry array, where getSeriesSecondary's own length gate already covers
		// it -- it passed throughout while this case was broken.
		const series = [
			{ asin: 'not-an-asin', title: 'Broken Entry', sequence: '1', url: '' },
			{ asin: 'B00YDDXB60', title: 'Legend of Drizzt', sequence: '12', url: '' }
		]
		helper.audibleResponse = {
			...mockResponse.product,
			content_delivery_type: 'MultiPartBook',
			publication_name: 'Legend of Drizzt: Paths of Darkness'
		}
		expect(helper.getSeriesPrimary(series)).toEqual({
			asin: 'B00YDDXB60',
			name: 'Legend of Drizzt',
			position: '12'
		})
		expect(helper.getSeriesSecondary(series)).toBeUndefined()
	})

	test('two parseable entries still yield a secondary', async () => {
		// The counterpart: the fix must not silence a legitimate secondary.
		helper.audibleResponse = {
			...mockResponse.product,
			content_delivery_type: 'MultiPartBook',
			publication_name: 'First Series'
		}
		expect(
			helper.getSeriesSecondary([
				{ asin: 'B00YDDXB60', title: 'First Series', sequence: '1', url: '' },
				{ asin: 'B00YDDXB61', title: 'Second Series', sequence: '2', url: '' }
			])
		).toEqual({ asin: 'B00YDDXB61', name: 'Second Series', position: '2' })
	})

	test('getSeriesPrimary returns undefined when content_delivery_type is Unknown', async () => {
		const obj = {
			asin: '123',
			title: 'Test Series',
			sequence: '1'
		}
		helper.audibleResponse = fallbackShape.parse({
			...mockResponse.product,
			content_delivery_type: 'Unknown'
		})
		expect(helper.getSeriesPrimary([obj])).toBeUndefined()
	})

	test('getSeriesSecondary returns undefined when content_delivery_type is Unknown', async () => {
		const obj = {
			asin: '123',
			title: 'Test Series',
			sequence: '1'
		}
		helper.audibleResponse = fallbackShape.parse({
			...mockResponse.product,
			content_delivery_type: 'Unknown'
		})
		expect(helper.getSeriesSecondary([obj])).toBeUndefined()
	})

	test('get backup lower res image', async () => {
		helper.audibleResponse = mockResponse.product
		helper.audibleResponse!.product_images![1024] = ''
		expect(helper.getHighResImage()).toBe('https://m.media-amazon.com/images/I/51OIn2FgdtL.jpg')
	})

	test('handle no image', async () => {
		helper.audibleResponse = mockResponse.product
		helper.audibleResponse!.product_images = {}
		expect(helper.getHighResImage()).toBeUndefined()
	})

	test('handle no product_images object', async () => {
		helper.audibleResponse = mockResponse.product
		helper.audibleResponse!.product_images = undefined
		expect(helper.getHighResImage()).toBeUndefined()
	})

	test('use issue_date if release_date is not available', async () => {
		helper.audibleResponse = mockResponse.product
		helper.audibleResponse!.issue_date = helper.audibleResponse!.release_date
		helper.audibleResponse!.release_date = ''
		expect(helper.getReleaseDate()).toBeInstanceOf(Date)
	})

	test('parse a book with 2 series', async () => {
		if (B017V4IM1G.product.content_delivery_type !== 'MultiPartBook') return undefined
		helper = new ApiHelper('B017V4IM1G', region)
		const data = await helper.parseResponse(B017V4IM1G)
		expect(data.seriesPrimary).toEqual({
			asin: B017V4IM1G.product.series![0].asin,
			name: B017V4IM1G.product.series![0].title,
			position: B017V4IM1G.product.series![0].sequence
		})
		expect(data.seriesSecondary).toEqual({
			asin: B017V4IM1G.product.series![1].asin,
			name: B017V4IM1G.product.series![1].title,
			position: B017V4IM1G.product.series![1].sequence
		})
	})

	test('return false on empty input to isGenre', async () => {
		expect(helper.isGenre(null)).toBeFalsy()
	})

	test('parse a book without social_media_images', async () => {
		helper = new ApiHelper('B0GFYFCX3D', region)
		const data = await helper.parseResponse(B0GFYFCX3D)
		expect(data.asin).toBe('B0GFYFCX3D')
		expect(data.title).toBe('Test Book Without Social Media Images')
		expect(data.authors).toEqual([{ asin: 'B000AP9A6K', name: 'Test Author' }])
	})

	test('parses book without content_delivery_type successfully', async () => {
		helper = new ApiHelper('B0GM8R53L2', region)
		const data = await helper.parseResponse(
			bookWithoutContentDeliveryType as unknown as AudibleProduct
		)
		expect(data.asin).toBe('B0GM8R53L2')
		expect(data.title).toBe('Test Book Without Content Delivery Type')
	})

	test('parses book with unknown content_delivery_type successfully', async () => {
		const unknownTypeResponse = deepCopy(mockResponse)
		unknownTypeResponse.product.content_delivery_type = 'UnknownType'
		const mockLogger = createMockLogger()
		helper = new ApiHelper(asin, region, mockLogger as unknown as FastifyBaseLogger)
		const data = await helper.parseResponse(unknownTypeResponse)
		expect(data.asin).toBe(asin)
		expect(mockLogger.warn).toHaveBeenCalled()
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Unknown content_delivery_type')
		)
	})

	test('throws region unavailable when baseShape also fails', async () => {
		const emptyProductResponse = { product: {} } as AudibleProduct
		await expect(helper.parseResponse(emptyProductResponse)).rejects.toThrow(
			`Item not available in region '${region}' for ASIN: ${asin}`
		)
	})

	test('throws PRODUCT_DELISTED when fetchProductState returns NOT_AVAILABLE_FOR_PURCHASE', async () => {
		const fetchProductStateSpy = spyOn(ApiHelper.prototype, 'fetchProductState').mockResolvedValue(
			'NOT_AVAILABLE_FOR_PURCHASE'
		)
		try {
			const emptyProductResponse = { product: {} } as AudibleProduct
			await expect(helper.parseResponse(emptyProductResponse)).rejects.toBeInstanceOf(NotFoundError)
			await expect(helper.parseResponse(emptyProductResponse)).rejects.toMatchObject({
				name: 'NotFoundError',
				statusCode: 404,
				message: `Item is 'NOT_AVAILABLE_FOR_PURCHASE' in region '${region}' for ASIN: ${asin}`,
				details: {
					asin,
					code: 'PRODUCT_DELISTED',
					productState: 'NOT_AVAILABLE_FOR_PURCHASE'
				}
			})
		} finally {
			fetchProductStateSpy.mockRestore()
		}
	})

	test.each([['AVAILABLE'], [undefined], ['SOME_OTHER_STATE']] as const)(
		'throws REGION_UNAVAILABLE when fetchProductState returns %s',
		async (state) => {
			const fetchProductStateSpy = spyOn(
				ApiHelper.prototype,
				'fetchProductState'
			).mockResolvedValue(state)
			try {
				const emptyProductResponse = { product: {} } as AudibleProduct
				await expect(helper.parseResponse(emptyProductResponse)).rejects.toBeInstanceOf(
					NotFoundError
				)
				await expect(helper.parseResponse(emptyProductResponse)).rejects.toMatchObject({
					name: 'NotFoundError',
					statusCode: 404,
					message: `Item not available in region '${region}' for ASIN: ${asin}`,
					details: {
						asin,
						code: 'REGION_UNAVAILABLE'
					}
				})
			} finally {
				fetchProductStateSpy.mockRestore()
			}
		}
	)
	test('throws NotFoundError with statusCode 404 for unavailable region', async () => {
		const emptyProductResponse = { product: {} } as AudibleProduct
		await expect(helper.parseResponse(emptyProductResponse)).rejects.toBeInstanceOf(NotFoundError)
		await expect(helper.parseResponse(emptyProductResponse)).rejects.toMatchObject({
			name: 'NotFoundError',
			statusCode: 404,
			message: `Item not available in region '${region}' for ASIN: ${asin}`
		})
	})
})

describe('ApiHelper should throw error when', () => {
	test('no input data', () => {
		expect(() => helper.getCategories()).toThrow('No input data')
		expect(() => helper.getGenres()).toThrow('No input data')
		expect(() => helper.getHighResImage()).toThrow('No input data')
		expect(() => helper.getReleaseDate()).toThrow('No input data')
		expect(() => helper.getSeriesPrimary(['1'] as unknown as AudibleSeries[])).toThrow(
			'No input data'
		)
		expect(() => helper.getSeriesSecondary(['1'] as unknown as AudibleSeries[])).toThrow(
			'No input data'
		)
		expect(() => helper.getTags()).toThrow('No input data')
		expect(() => helper.getFinalData()).toThrow('No input data')
	})

	test('release_date in the future is returned, not rejected', async () => {
		// A user can own a just-released/future-dated Audible edition; it must return
		// its date, not 500 the fetch (audnexus threw here; incipit-api does not).
		helper.audibleResponse = mockResponse.product
		helper.audibleResponse!.release_date = '2080-01-01'
		const date = helper.getReleaseDate()
		expect(date).toBeInstanceOf(Date)
		expect(date.getFullYear()).toBe(2080)
	})

	test('category is invalid', () => {
		const obj = {
			id: '1',
			name: ''
		} as AudibleCategory
		expect(() => helper.categoryToApiGenre(obj, 'genre')).toThrow(
			`An error occurred while parsing ApiHelper. ASIN: ${asin}`
		)
	})

	test('error fetching book data', async () => {
		spyOn(fetchPlus, 'default').mockImplementation(() =>
			Promise.reject({
				status: 403
			})
		)
		asin = ''
		helper = new ApiHelper(asin, region)
		await expect(helper.fetchBook()).rejects.toThrow(
			`An error occured while fetching data from Audible API. Response: 403, ASIN: ${asin}`
		)
	})

	test('input is undefined', async () => {
		await expect(helper.parseResponse(undefined)).rejects.toThrow(
			`An error occurred while parsing Audible API. ASIN: ${asin}`
		)
	})

	test('book has no title', async () => {
		asin = 'B07BS4RKGH'
		helper = new ApiHelper(asin, region)
		const data = B07BS4RKGH as unknown as AudibleProduct
		await expect(helper.parseResponse(data)).rejects.toThrow(
			`Required key 'title' does not exist in Audible API response for ASIN ${asin}`
		)
	})
})

afterAll(() => {
	mock.restore()
})

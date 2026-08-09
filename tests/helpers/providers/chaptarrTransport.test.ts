import { afterEach, describe, expect, mock, test } from 'bun:test'

/**
 * The Chaptarr TRANSPORT layer — the three real calls, with the real fetchPlus
 * seam mocked out.
 *
 * Everything else in this provider is exercised through injected transports, so
 * the discipline that lives IN the transports (404 handling, the time-box, one
 * attempt) had no coverage at all — and the missing 404 guard on the match leg
 * was worth a 60-second breaker outage that also took the two ASIN rescue paths
 * down with it.
 */

const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const {
	default: ChaptarrProvider,
	chaptarrGet,
	fetchChaptarrWork
} = await import('#helpers/providers/ChaptarrProvider')
const { chaptarrAuthorInfo } = await import('#helpers/providers/chaptarrAuthor')

/** The shape fetchPlus rejects with: a FetchError carrying `status`. */
function httpError(status: number): Error & { status: number } {
	return Object.assign(new Error(`Request failed with status ${status}`), { status })
}

afterEach(() => fetchMock.mockReset())

describe('the match leg', () => {
	// The work leg has always wrapped its errors; the match leg did not. A 404
	// there rejected out of search(), ProviderRegistry recorded a provider
	// failure, and six of those open the breaker for 60s.
	for (const status of [404, 410]) {
		test(`a ${status} means "no matches", not a provider failure`, async () => {
			fetchMock.mockImplementationOnce(() => Promise.reject(httpError(status)))
			const out = await new ChaptarrProvider().search({ title: 'Annihilation', region: 'us' })
			expect(out).toEqual([])
		})
	}

	for (const status of [500, 403, 429]) {
		test(`a ${status} STILL rejects — the breaker must see a real outage`, async () => {
			fetchMock.mockImplementationOnce(() => Promise.reject(httpError(status)))
			await expect(
				new ChaptarrProvider().search({ title: 'Annihilation', region: 'us' })
			).rejects.toThrow(`status ${status}`)
		})
	}

	test('a body with no matches array is not an error either', async () => {
		fetchMock.mockImplementationOnce(() => Promise.resolve({ data: {} }))
		expect(await new ChaptarrProvider().search({ title: 'X', region: 'us' })).toEqual([])
	})
})

describe('the work leg', () => {
	test('a 404 is "no such record"', async () => {
		fetchMock.mockImplementationOnce(() => Promise.reject(httpError(404)))
		expect(await fetchChaptarrWork('az:B0DEAD0000')).toBeNull()
	})

	test('a 500 rejects', async () => {
		fetchMock.mockImplementationOnce(() => Promise.reject(httpError(500)))
		await expect(fetchChaptarrWork('az:B0DEAD0000')).rejects.toThrow('status 500')
	})
})

describe('the author leg', () => {
	test('shares the 404 rule rather than keeping its own copy', async () => {
		fetchMock.mockImplementationOnce(() => Promise.reject(httpError(404)))
		expect(await chaptarrAuthorInfo('B001IGFHW6', null)).toEqual({ image: null, bio: null })
	})

	test('a 500 is caught and served empty, never thrown at the route', async () => {
		fetchMock.mockImplementationOnce(() => Promise.reject(httpError(500)))
		expect(await chaptarrAuthorInfo('B001IGFHW6', null)).toEqual({ image: null, bio: null })
	})
})

describe('every leg is bounded', () => {
	// Three enrichment paths call these transports with no registry above them,
	// so nothing else caps them: without a timeout they inherit the 30s HTTP
	// default, and without an exhausted retry counter they multiply it by the
	// whole ladder — inside a live /books/:asin request, against another
	// project's free infrastructure.
	const bounded = (call: unknown[]) => {
		const [, options, retries] = call as [string, Record<string, unknown>, number]
		expect(typeof options?.timeout).toBe('number')
		expect(options.timeout as number).toBeLessThanOrEqual(15000)
		// fetchPlus retries while `retries < 3`, so starting AT 3 is one attempt.
		expect(retries).toBe(3)
	}

	test('the work leg', async () => {
		fetchMock.mockImplementationOnce(() => Promise.resolve({ data: {} }))
		await fetchChaptarrWork('az:B00HYGYN5Q')
		bounded(fetchMock.mock.calls[0])
	})

	test('the match leg', async () => {
		fetchMock.mockImplementationOnce(() => Promise.resolve({ data: { matches: [] } }))
		await new ChaptarrProvider().search({ title: 'X', region: 'us' })
		bounded(fetchMock.mock.calls[0])
	})

	test('the author leg', async () => {
		fetchMock.mockImplementationOnce(() => Promise.resolve({ data: {} }))
		await chaptarrAuthorInfo('B001IGFHW6', null)
		bounded(fetchMock.mock.calls[0])
	})

	test('chaptarrGet is the one place that says so', async () => {
		fetchMock.mockImplementationOnce(() => Promise.resolve({ data: { ok: 1 } }))
		expect(await chaptarrGet('https://api2.chaptarr.test/x')).toEqual({ ok: 1 })
		bounded(fetchMock.mock.calls[0])
	})
})

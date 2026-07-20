import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const mockGet = mock()

mock.module('#helpers/utils/connectionPool', () => {
	return { default: { get: mockGet } }
})

const sleepDelays: number[] = []
mock.module('#helpers/utils/sleep', () => {
	return {
		default: (ms: number) => {
			sleepDelays.push(ms)
			return Promise.resolve()
		}
	}
})

import type { AxiosResponse } from 'axios'

import pooledAxios from '#helpers/utils/connectionPool'
import fetchPlus, { FetchError } from '#helpers/utils/fetchPlus'

let mockStatus: { status: number; headers?: Record<string, string> }

describe('fetchPlus should', () => {
	beforeEach(() => {
		sleepDelays.length = 0
		mockGet.mockClear()
	})

	afterEach(() => {
		mock.restore()
	})

	test('return response', async () => {
		const mockResponse = { data: 'test', status: 200 } as AxiosResponse
		mockGet.mockImplementation(() => Promise.resolve(mockResponse))
		const response = await fetchPlus('test')
		expect(response).toEqual(mockResponse)
	})

	test('return error with default retries', async () => {
		mockStatus = { status: 500 }
		mockGet.mockImplementation(() => {
			const error: Error & { response: typeof mockStatus } = Object.assign(
				new Error('Request failed'),
				{ response: mockStatus }
			)
			return Promise.reject(error)
		})

		await expect(fetchPlus('test.com')).rejects.toMatchObject({ status: 500 })
		expect(pooledAxios.get).toHaveBeenCalledTimes(4)
	})

	test('rejects with the error itself when there is no response (network failure)', async () => {
		// A timeout/DNS/socket error has no `response`; rejecting with undefined
		// made downstream `.status` reads TypeError inside their catch blocks.
		mockGet.mockImplementation(() => {
			const error: Error & { code: string } = Object.assign(new Error('timeout of 30000ms'), {
				code: 'ECONNABORTED'
			})
			return Promise.reject(error)
		})

		await expect(fetchPlus('test.com', {}, 2)).rejects.toMatchObject({
			code: 'ECONNABORTED',
			message: 'timeout of 30000ms'
		})
	})

	test('the rejected error carries no axios config/headers (no auth-token leak)', async () => {
		// An AxiosError's `config.headers` holds the caller's Authorization
		// header; rejecting it raw let pino serialize the bearer token into logs.
		const leaky = Object.assign(new Error('socket hang up'), {
			code: 'ECONNRESET',
			isAxiosError: true,
			config: { headers: { Authorization: 'Bearer SECRET_TOKEN' } }
		})
		mockGet.mockImplementation(() => Promise.reject(leaky))

		// retries=3 → reject immediately with the sanitized error.
		await expect(fetchPlus('test.com', {}, 3)).rejects.toMatchObject({
			name: 'FetchError',
			code: 'ECONNRESET'
		})
		const err = await fetchPlus('test.com', {}, 3).catch((e) => e)
		expect(err instanceof FetchError).toBe(true)
		expect((err as Record<string, unknown>).config).toBeUndefined()
		// Nothing pino could serialize (own-enumerable props + message/stack) may
		// contain the token.
		const serialized = JSON.stringify({
			...(err as object),
			message: (err as Error).message,
			stack: (err as Error).stack
		})
		expect(serialized).not.toContain('SECRET_TOKEN')
		expect(serialized).not.toContain('Authorization')
	})

	test('retry on non-200', async () => {
		mockStatus = { status: 200 }
		mockGet
			.mockRejectedValueOnce({ status: 500 })
			.mockResolvedValueOnce(mockStatus as AxiosResponse)
		await expect(fetchPlus('test.com')).resolves.toEqual(mockStatus)
	})

	test('retry the correct number of times before hard failing', async () => {
		mockStatus = { status: 500 }
		mockGet.mockImplementation(() => {
			const error: Error & { response: typeof mockStatus } = Object.assign(
				new Error('Request failed'),
				{ response: mockStatus }
			)
			return Promise.reject(error)
		})

		await expect(fetchPlus('test.com', {}, 2)).rejects.toMatchObject({ status: 500 })
		expect(pooledAxios.get).toHaveBeenCalledTimes(2)
	})

	test('retry with exponential backoff on 429 without Retry-After header', async () => {
		const mockError = {
			response: {
				status: 429,
				headers: {}
			}
		}
		const successResponse = { data: 'success', status: 200 } as AxiosResponse

		mockGet.mockRejectedValueOnce(mockError).mockResolvedValueOnce(successResponse)

		const response = await fetchPlus('test.com')
		expect(response).toEqual(successResponse)
		expect(pooledAxios.get).toHaveBeenCalledTimes(2)
		expect(sleepDelays).toEqual([1000])
	})

	test('retry with Retry-After header on 429', async () => {
		const mockError = {
			response: {
				status: 429,
				headers: { 'retry-after': '2' }
			}
		}
		const successResponse = { data: 'success', status: 200 } as AxiosResponse

		mockGet.mockRejectedValueOnce(mockError).mockResolvedValueOnce(successResponse)

		const response = await fetchPlus('test.com')

		expect(response).toEqual(successResponse)
		expect(pooledAxios.get).toHaveBeenCalledTimes(2)
		expect(sleepDelays).toEqual([2000])
	})

	test('retry with increasing exponential backoff on multiple 429s', async () => {
		const mockError = {
			response: {
				status: 429,
				headers: {}
			}
		}
		const successResponse = { data: 'success', status: 200 } as AxiosResponse

		mockGet
			.mockRejectedValueOnce(mockError)
			.mockRejectedValueOnce(mockError)
			.mockResolvedValueOnce(successResponse)

		const response = await fetchPlus('test.com')

		expect(response).toEqual(successResponse)
		expect(pooledAxios.get).toHaveBeenCalledTimes(3)
		expect(sleepDelays).toEqual([1000, 2000])
	})

	test('retry with exponential backoff on 429 with headers missing retry-after key', async () => {
		const mockError = {
			response: {
				status: 429,
				headers: { 'x-custom-header': 'value' }
			}
		}
		const successResponse = { data: 'success', status: 200 } as AxiosResponse

		mockGet.mockRejectedValueOnce(mockError).mockResolvedValueOnce(successResponse)

		const response = await fetchPlus('test.com')

		expect(response).toEqual(successResponse)
		expect(pooledAxios.get).toHaveBeenCalledTimes(2)
		expect(sleepDelays).toEqual([1000])
	})

	test('not add delay for non-429 errors', async () => {
		mockStatus = { status: 500 }
		mockGet.mockImplementation(() => {
			const error: Error & { response: typeof mockStatus } = Object.assign(
				new Error('Request failed'),
				{ response: mockStatus }
			)
			return Promise.reject(error)
		})

		await expect(fetchPlus('test.com')).rejects.toMatchObject({ status: 500 })
		expect(pooledAxios.get).toHaveBeenCalledTimes(4)
		expect(sleepDelays).toEqual([])
	})
})

afterAll(() => {
	mock.restore()
})

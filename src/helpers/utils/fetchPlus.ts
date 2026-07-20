import { AxiosError, AxiosResponse } from 'axios'

import pooledAxios from '#helpers/utils/connectionPool'
import sleep from '#helpers/utils/sleep'

/**
 * A sanitized fetch failure. Carries ONLY what consumers read (`status` for an
 * HTTP failure, `code` for a network/timeout failure, plus `message`) and NONE
 * of the axios internals — critically not `config.headers`, which holds the
 * caller's `Authorization: Bearer <hardcover-token>` and would otherwise be
 * serialized verbatim into logs by pino's default error serializer when a
 * consumer logs `{ err }` (e.g. ProviderRegistry on a provider failure).
 */
export class FetchError extends Error {
	status?: number
	code?: string
	constructor(message: string, status?: number, code?: string) {
		super(message)
		this.name = 'FetchError'
		this.status = status
		this.code = code
	}
}

/** Build a FetchError from a non-200 AxiosResponse (HTTP-status failure). */
function fromResponse(response: AxiosResponse): FetchError {
	return new FetchError('Request failed with status ' + response.status, response.status)
}

/** Build a FetchError from an AxiosError (network failure / timeout). */
function fromAxiosError(error: AxiosError): FetchError {
	// A network error has no response; carry its code (ECONNABORTED, etc.).
	return new FetchError(error.message, error.response?.status, error.code)
}

/**
 * Calculates the delay for retry attempts with exponential backoff.
 * For 429 status, uses exponential backoff starting at 1s, doubling each retry (max 8s).
 * Respects Retry-After header if present (includes delay-in-seconds and HTTP-date formats).
 * @param {number} retries The current retry count
 * @param {AxiosError} error The axios error response
 * @returns {number} The delay in milliseconds
 */
function calculateRetryDelay(retries: number, error: AxiosError): number {
	if (!error.response || !error.response.headers) {
		// No response or headers, fall back to exponential backoff
		return Math.min(1000 * Math.pow(2, retries), 8000)
	}

	const retryAfter = error.response.headers['retry-after']
	if (!retryAfter) {
		// No Retry-After header, fall back to exponential backoff
		return Math.min(1000 * Math.pow(2, retries), 8000)
	}

	// Retry-After can be a delay in seconds or an HTTP-date
	const parsedAsNumber = parseInt(retryAfter, 10)
	if (!isNaN(parsedAsNumber) && parsedAsNumber > 0) {
		return parsedAsNumber * 1000
	}

	// Try parsing as HTTP-date (e.g., "Wed, 21 Oct 2015 07:28:00 GMT")
	const parsedDate = new Date(retryAfter)
	if (!isNaN(parsedDate.getTime())) {
		const now = Date.now()
		const delay = parsedDate.getTime() - now
		if (delay > 0) {
			return delay
		}
	}

	// Invalid Retry-After value, fall back to exponential backoff
	return Math.min(1000 * Math.pow(2, retries), 8000)
}

/**
 * Fetches a url with axios and retries 3 additional times on non-200 status
 * Uses connection pooling for improved performance.
 * Implements exponential backoff for 429 (Too Many Requests) responses,
 * respecting Retry-After header when present.
 *
 * Defaults to GET. Pass `options.method: 'POST'` with `options.data` for a POST
 * (used by GraphQL providers such as Hardcover); the same 429 backoff applies,
 * which is exactly what Hardcover's 60/min limit needs.
 * @param {string} url The url to fetch
 * @param {object} options The options to pass to axios (default: {})
 * @param {number} retries The number of retries to start from (default: 0)
 * @returns {Promise<AxiosResponse>} the response from the request
 */
function fetchPlus(
	url: string,
	options: Record<string, unknown> = {},
	retries = 0
): Promise<AxiosResponse> {
	const method = typeof options.method === 'string' ? options.method.toLowerCase() : 'get'
	const dispatch = (): Promise<AxiosResponse> => {
		if (method === 'post') {
			const { data, ...rest } = options
			return pooledAxios.post(url, data, rest)
		}
		return pooledAxios.get(url, options)
	}
	return new Promise((resolve, reject) => {
		dispatch()
			.then((response: AxiosResponse) => {
				if (response.status === 200) {
					resolve(response)
				} else {
					reject(fromResponse(response))
				}
			})
			.catch(async (reason: AxiosError) => {
				if (retries < 3) {
					// Check if this is a 429 (Too Many Requests) response
					const status = reason.response?.status
					if (status === 429) {
						const delay = calculateRetryDelay(retries, reason)
						await sleep(delay)
					}

					fetchPlus(url, options, retries + 1)
						.then(resolve)
						.catch(reject)
				} else {
					// Reject with a sanitized FetchError (status/code/message only).
					// Rejecting the raw AxiosError/AxiosResponse here leaked the
					// caller's Authorization header into logs; consumers read only
					// `.status`/`.code`/`.message`, all preserved.
					reject(fromAxiosError(reason))
				}
			})
	})
}

export default fetchPlus

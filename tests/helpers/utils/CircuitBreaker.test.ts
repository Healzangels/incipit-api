import { beforeEach, describe, expect, it, mock } from 'bun:test'

import {
	PerformanceConfig,
	resetPerformanceConfig,
	setPerformanceConfig
} from '#config/performance'
import {
	CircuitBreaker,
	CircuitOpenError,
	getAudibleCircuitBreaker,
	resetAudibleCircuitBreaker
} from '#helpers/utils/CircuitBreaker'

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

describe('CircuitBreaker', () => {
	beforeEach(() => {
		resetPerformanceConfig()
		resetAudibleCircuitBreaker()
	})

	describe('basic operation', () => {
		it('should execute function successfully when CLOSED', async () => {
			const breaker = new CircuitBreaker()
			const fn = mock(() => Promise.resolve('success'))

			const result = await breaker.execute(fn)

			expect(result).toBe('success')
			expect(fn).toHaveBeenCalledTimes(1)
		})

		it('should return initial state as CLOSED', () => {
			const breaker = new CircuitBreaker()
			const stats = breaker.getStats()

			expect(stats.state).toBe('CLOSED')
			expect(stats.failures).toBe(0)
			expect(stats.successes).toBe(0)
		})

		it('should track successes', async () => {
			const breaker = new CircuitBreaker()
			const fn = mock(() => Promise.resolve('success'))

			await breaker.execute(fn)
			await breaker.execute(fn)

			const stats = breaker.getStats()
			expect(stats.successes).toBe(2)
		})

		it('should track failures', async () => {
			const breaker = new CircuitBreaker()
			const fn = mock(() => Promise.reject(new Error('failed')))

			await expect(breaker.execute(fn)).rejects.toThrow('failed')

			const stats = breaker.getStats()
			expect(stats.failures).toBe(1)
		})
	})

	describe('state transitions', () => {
		it('should transition to OPEN after failure threshold', async () => {
			const breaker = new CircuitBreaker({ failureThreshold: 3 })
			const fn = mock(() => Promise.reject(new Error('failed')))

			// Fail 3 times
			await expect(breaker.execute(fn)).rejects.toThrow()
			await expect(breaker.execute(fn)).rejects.toThrow()
			await expect(breaker.execute(fn)).rejects.toThrow()

			const stats = breaker.getStats()
			expect(stats.state).toBe('OPEN')
		})

		it('counts CONSECUTIVE failures: a success in CLOSED clears the run', async () => {
			// The threshold used to count LIFETIME failures, because `failures` was
			// only ever reset by openCircuit() or a HALF_OPEN recovery — never by an
			// ordinary success. Measured: 5 failures with 4 successes interleaved
			// tripped the circuit. These breakers live on a module-singleton
			// registry, so the count accumulated for the whole process lifetime and
			// a handful of ordinary 25s timeouts spread over hours eventually
			// disabled a healthy provider. Nothing here is 3 failures in a row, so
			// nothing here may open the circuit.
			const breaker = new CircuitBreaker({ failureThreshold: 3 })
			const failingFn = mock(() => Promise.reject(new Error('failed')))
			const successFn = mock(() => Promise.resolve('success'))

			for (let round = 0; round < 5; round++) {
				await expect(breaker.execute(failingFn)).rejects.toThrow('failed')
				await expect(breaker.execute(failingFn)).rejects.toThrow('failed')
				// The success must not merely be recorded — it must ERASE the two
				// failures before it.
				await expect(breaker.execute(successFn)).resolves.toBe('success')
				expect(breaker.getStats().failures).toBe(0)
				expect(breaker.getStats().state).toBe('CLOSED')
			}

			// 10 lifetime failures against a threshold of 3, still closed.
			expect(breaker.getStats().state).toBe('CLOSED')
			expect(successFn).toHaveBeenCalledTimes(5)
		})

		it('still opens on a genuine consecutive run after successes', async () => {
			// The other half of the same rule: resetting on success must not make the
			// breaker unable to trip.
			const breaker = new CircuitBreaker({ failureThreshold: 3 })
			const failingFn = mock(() => Promise.reject(new Error('failed')))
			const successFn = mock(() => Promise.resolve('success'))

			await expect(breaker.execute(failingFn)).rejects.toThrow('failed')
			await expect(breaker.execute(successFn)).resolves.toBe('success')
			await expect(breaker.execute(failingFn)).rejects.toThrow('failed')
			await expect(breaker.execute(failingFn)).rejects.toThrow('failed')
			expect(breaker.getStats().state).toBe('CLOSED')
			await expect(breaker.execute(failingFn)).rejects.toThrow('failed')
			expect(breaker.getStats().state).toBe('OPEN')
		})

		it('should fail fast when OPEN', async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 60000
			})
			const failingFn = mock(() => Promise.reject(new Error('failed')))

			const successFn = mock(() => Promise.resolve('success'))

			// Open the circuit
			await expect(breaker.execute(failingFn)).rejects.toThrow()

			// Should fail fast with circuit breaker error
			await expect(breaker.execute(successFn)).rejects.toThrow('Circuit breaker is OPEN')
			expect(successFn).not.toHaveBeenCalled()
		})

		it('should transition to HALF_OPEN after reset timeout', async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 10
			})
			const fn = mock(() => Promise.reject(new Error('failed')))

			// Open the circuit
			await expect(breaker.execute(fn)).rejects.toThrow()
			expect(breaker.getStats().state).toBe('OPEN')

			// Wait for timeout
			await new Promise((resolve) => setTimeout(resolve, 20))

			// Check that it can execute (transitioned to HALF_OPEN)
			expect(breaker.canExecute()).toBe(true)
		})

		it('should transition back to CLOSED after success threshold in HALF_OPEN', async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 10,
				successThreshold: 2
			})
			const failingFn = mock(() => Promise.reject(new Error('failed')))

			const successFn = mock(() => Promise.resolve('success'))

			// Open the circuit
			await expect(breaker.execute(failingFn)).rejects.toThrow()

			// Wait for timeout
			await new Promise((resolve) => setTimeout(resolve, 20))

			// Execute successfully twice
			await breaker.execute(successFn)
			expect(breaker.getStats().state).toBe('HALF_OPEN')

			await breaker.execute(successFn)
			expect(breaker.getStats().state).toBe('CLOSED')
		})

		it('should transition back to OPEN on failure in HALF_OPEN', async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 10,
				successThreshold: 2
			})
			const failingFn = mock(() => Promise.reject(new Error('failed')))

			// Open the circuit
			await expect(breaker.execute(failingFn)).rejects.toThrow()

			// Wait for timeout
			await new Promise((resolve) => setTimeout(resolve, 20))

			// Fail in HALF_OPEN
			await expect(breaker.execute(failingFn)).rejects.toThrow()
			expect(breaker.getStats().state).toBe('OPEN')
		})
	})

	describe('canExecute', () => {
		it('should return true when CLOSED', () => {
			const breaker = new CircuitBreaker()
			expect(breaker.canExecute()).toBe(true)
		})

		it('should return false when OPEN', async () => {
			const breaker = new CircuitBreaker({ failureThreshold: 1 })
			const fn = mock(() => Promise.reject(new Error('failed')))

			await expect(breaker.execute(fn)).rejects.toThrow()

			expect(breaker.canExecute()).toBe(false)
		})

		it('should return true when HALF_OPEN', async () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 10
			})
			const fn = mock(() => Promise.reject(new Error('failed')))

			await expect(breaker.execute(fn)).rejects.toThrow()
			await new Promise((resolve) => setTimeout(resolve, 20))

			expect(breaker.canExecute()).toBe(true)
		})
	})

	describe('reset', () => {
		it('should reset to CLOSED state', async () => {
			const breaker = new CircuitBreaker({ failureThreshold: 1 })
			const fn = mock(() => Promise.reject(new Error('failed')))

			await expect(breaker.execute(fn)).rejects.toThrow()
			expect(breaker.getStats().state).toBe('OPEN')

			breaker.reset()

			expect(breaker.getStats().state).toBe('CLOSED')
			expect(breaker.getStats().failures).toBe(0)
			expect(breaker.getStats().successes).toBe(0)
		})
	})

	describe('feature flag integration', () => {
		it('should never trip when CIRCUIT_BREAKER_ENABLED is false', async () => {
			setPerformanceConfig(
				createTestConfig({
					CIRCUIT_BREAKER_ENABLED: false
				})
			)

			const breaker = new CircuitBreaker({ failureThreshold: 1 })
			const fn = mock(() => Promise.reject(new Error('failed')))

			// Fail many times
			for (let i = 0; i < 10; i++) {
				await expect(breaker.execute(fn)).rejects.toThrow('failed')
			}

			// Should still be CLOSED
			expect(breaker.getStats().state).toBe('CLOSED')
		})

		it('should trip normally when CIRCUIT_BREAKER_ENABLED is true', async () => {
			setPerformanceConfig(
				createTestConfig({
					CIRCUIT_BREAKER_ENABLED: true
				})
			)

			const breaker = new CircuitBreaker({ failureThreshold: 1 })
			const fn = mock(() => Promise.reject(new Error('failed')))

			await expect(breaker.execute(fn)).rejects.toThrow()

			expect(breaker.getStats().state).toBe('OPEN')
		})
	})

	describe('global instance', () => {
		it('should return same instance from getAudibleCircuitBreaker', () => {
			const breaker1 = getAudibleCircuitBreaker()
			const breaker2 = getAudibleCircuitBreaker()

			expect(breaker1).toBe(breaker2)
		})

		it('should create new instance after reset', () => {
			const breaker1 = getAudibleCircuitBreaker()
			resetAudibleCircuitBreaker()
			const breaker2 = getAudibleCircuitBreaker()

			expect(breaker1).not.toBe(breaker2)
		})
	})

	describe('timing', () => {
		it('should track last failure time', async () => {
			const before = Date.now()
			const breaker = new CircuitBreaker({ failureThreshold: 1 })
			const fn = mock(() => Promise.reject(new Error('failed')))

			await expect(breaker.execute(fn)).rejects.toThrow()

			const stats = breaker.getStats()
			expect(stats.lastFailureTime).toBeGreaterThanOrEqual(before)
			expect(stats.lastFailureTime).toBeLessThanOrEqual(Date.now())
		})

		it('should track last success time', async () => {
			const before = Date.now()
			const breaker = new CircuitBreaker()
			const fn = mock(() => Promise.resolve('success'))

			await breaker.execute(fn)

			const stats = breaker.getStats()
			expect(stats.lastSuccessTime).toBeGreaterThanOrEqual(before)
			expect(stats.lastSuccessTime).toBeLessThanOrEqual(Date.now())
		})
	})
})

/**
 * An open circuit is "come back in N seconds", not "something broke".
 *
 * It used to throw a bare Error, which the API's error handler turned into a
 * 500. Measured on the 2026-08-05 library rebuild: five Apple-backed books took
 * 38 such responses across one scan and every one of them ended with no
 * metadata at all. A 500 tells the Plex agent nothing about WHEN to come back,
 * and its retry ladder (1/2/4s) cannot outlast a 60s breaker window by
 * guessing. The agent honours Retry-After as of bundle v1.3.187, so stating the
 * wait turns a dead end into a successful retry.
 */
describe('CircuitOpenError carries a 503 and a stated wait', () => {
	it('is thrown when the circuit is open, with a positive retryAfter', async () => {
		const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30000 })
		await breaker.execute(() => Promise.reject(new Error('boom'))).catch(() => {})
		let caught: unknown
		await breaker.execute(() => Promise.resolve('never')).catch((e) => {
			caught = e
		})
		expect(caught).toBeInstanceOf(CircuitOpenError)
		const err = caught as CircuitOpenError
		expect(err.statusCode).toBe(503)
		expect(err.retryAfter).toBeGreaterThan(0)
		expect(err.retryAfter).toBeLessThanOrEqual(30)
	})

	it('KEEPS the "Circuit breaker is OPEN" message', () => {
		// ProviderRegistry.isCircuitOpen classifies rejections by matching this
		// exact substring, and that is what separates "the breaker declined" from
		// "the provider failed" in the metrics. Changing the wording silently
		// reclassifies every skip as a failure.
		const err = new CircuitOpenError(31)
		expect(err.message).toContain('Circuit breaker is OPEN')
		expect(err.message).toContain('31')
	})

	it('is still an Error, so existing catch/rethrow paths are unaffected', () => {
		expect(new CircuitOpenError(5)).toBeInstanceOf(Error)
	})
})

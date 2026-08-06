import { getPerformanceConfig } from '#config/performance'

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

/**
 * Thrown when the breaker declines to call. Carries a 503 and the exact number
 * of seconds until it will try again.
 *
 * It used to be a bare Error, which reached the client as a 500 — "something
 * broke here", when the truth is "come back in 31 seconds". Measured on the
 * 2026-08-05 rebuild: five Apple-backed books took 38 such responses across
 * the scan and all five ended up with no metadata, because a 500 tells the
 * Plex agent nothing about WHEN to retry and its ladder (1/2/4s) cannot
 * outlast a 60s breaker window by guessing. The agent honours Retry-After as
 * of bundle v1.3.187, so stating the wait is now actionable rather than
 * decorative.
 *
 * The MESSAGE is load-bearing and must keep the "Circuit breaker is OPEN"
 * prefix: ProviderRegistry.isCircuitOpen classifies rejections by matching it,
 * and that is what separates "the breaker declined" from "the provider failed"
 * in the metrics.
 */
export class CircuitOpenError extends Error {
	readonly statusCode = 503
	readonly retryAfter: number

	constructor(retryAfter: number) {
		super(`Circuit breaker is OPEN. Retry in ${retryAfter}s`)
		this.name = 'CircuitOpenError'
		this.retryAfter = retryAfter
	}
}

export interface CircuitBreakerOptions {
	failureThreshold?: number
	resetTimeoutMs?: number
	successThreshold?: number
}

export interface CircuitBreakerStats {
	state: CircuitState
	failures: number
	successes: number
	lastFailureTime: number | null
	lastSuccessTime: number | null
}

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: Required<CircuitBreakerOptions> = {
	failureThreshold: 5,
	resetTimeoutMs: 60000,
	successThreshold: 2
}

/**
 * Maximum success count to prevent unbounded growth in CLOSED state.
 * This cap prevents integer overflow issues while maintaining sufficient
 * precision for tracking success patterns.
 */
export const MAX_SUCCESS_COUNT = 10000

/**
 * Circuit Breaker pattern implementation for external API calls
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failure threshold exceeded, requests fail fast
 * - HALF_OPEN: Testing if service has recovered
 *
 * Transitions:
 * - CLOSED -> OPEN: failures >= failureThreshold
 * - OPEN -> HALF_OPEN: resetTimeoutMs elapsed
 * - HALF_OPEN -> CLOSED: successes >= successThreshold
 * - HALF_OPEN -> OPEN: any failure
 */
export class CircuitBreaker {
	private state: CircuitState = 'CLOSED'
	private failures = 0
	private successes = 0
	private lastFailureTime: number | null = null
	private lastSuccessTime: number | null = null
	private nextAttempt: number = Date.now()

	private readonly failureThreshold: number
	private readonly resetTimeoutMs: number
	private readonly successThreshold: number

	private static normalizeOption(value: number | undefined, defaultValue: number): number {
		if (value === undefined) {
			return defaultValue
		}

		if (!Number.isFinite(value)) {
			return defaultValue
		}

		const intValue = Math.floor(value)
		return intValue >= 1 ? intValue : defaultValue
	}

	constructor(options: CircuitBreakerOptions = {}) {
		const config = getPerformanceConfig()

		// If circuit breaker is disabled via feature flag, set thresholds to never trip
		const enabled = config.CIRCUIT_BREAKER_ENABLED

		const normalizedFailureThreshold = CircuitBreaker.normalizeOption(
			options.failureThreshold,
			DEFAULT_CIRCUIT_BREAKER_OPTIONS.failureThreshold
		)
		const normalizedResetTimeoutMs = CircuitBreaker.normalizeOption(
			options.resetTimeoutMs,
			DEFAULT_CIRCUIT_BREAKER_OPTIONS.resetTimeoutMs
		)
		const normalizedSuccessThreshold = CircuitBreaker.normalizeOption(
			options.successThreshold,
			DEFAULT_CIRCUIT_BREAKER_OPTIONS.successThreshold
		)
		this.failureThreshold = enabled ? normalizedFailureThreshold : Number.MAX_SAFE_INTEGER
		this.resetTimeoutMs = normalizedResetTimeoutMs
		this.successThreshold = normalizedSuccessThreshold
	}

	/**
	 * Get current circuit breaker statistics
	 */
	getStats(): CircuitBreakerStats {
		return {
			state: this.state,
			failures: this.failures,
			successes: this.successes,
			lastFailureTime: this.lastFailureTime,
			lastSuccessTime: this.lastSuccessTime
		}
	}

	/**
	 * Check if circuit allows requests
	 */
	canExecute(): boolean {
		this.transitionState()
		return this.state !== 'OPEN'
	}

	/**
	 * Execute a function with circuit breaker protection
	 * @param fn Function to execute
	 * @returns Result of the function
	 * @throws Error if circuit is OPEN or function fails
	 */
	async execute<T>(fn: () => Promise<T>): Promise<T> {
		this.transitionState()

		if (this.state === 'OPEN') {
			const timeUntilRetry = Math.max(1, Math.ceil((this.nextAttempt - Date.now()) / 1000))
			throw new CircuitOpenError(timeUntilRetry)
		}

		const isHalfOpen = this.state === 'HALF_OPEN'

		try {
			const result = await fn()
			this.onSuccess(isHalfOpen)
			return result
		} catch (error) {
			this.onFailure(isHalfOpen)
			throw error
		}
	}

	/**
	 * Transition circuit state based on time
	 */
	private transitionState(): void {
		const now = Date.now()

		if (this.state === 'OPEN' && now >= this.nextAttempt) {
			this.state = 'HALF_OPEN'
			this.failures = 0
			this.successes = 0
		}
	}

	/**
	 * Handle successful execution
	 */
	private onSuccess(isHalfOpen: boolean): void {
		this.lastSuccessTime = Date.now()

		if (isHalfOpen) {
			this.successes++
			if (this.successes >= this.successThreshold) {
				// Service recovered, close the circuit
				this.state = 'CLOSED'
				this.failures = 0
				this.successes = 0
			}
		} else {
			// A success ENDS the failure run. Without this the threshold counts
			// LIFETIME failures, not consecutive ones: 5 failures spread across
			// hundreds of healthy calls tripped the circuit just as surely as 5 in a
			// row (measured: 5 failures with 4 successes interleaved -> OPEN). These
			// breakers live on a module-singleton registry, so the count accumulated
			// for the whole process lifetime and a handful of ordinary 25s timeouts
			// eventually disabled a perfectly healthy provider.
			this.failures = 0
			// In CLOSED state, just track success with a cap to prevent unbounded growth
			this.successes = Math.min(this.successes + 1, MAX_SUCCESS_COUNT)
		}
	}

	/**
	 * Handle failed execution
	 */
	private onFailure(isHalfOpen: boolean): void {
		this.lastFailureTime = Date.now()
		this.failures++

		if (isHalfOpen) {
			// Any failure in HALF_OPEN goes back to OPEN
			this.openCircuit()
		} else if (this.failures >= this.failureThreshold) {
			// Failure threshold exceeded in CLOSED state
			this.openCircuit()
		}
	}

	/**
	 * Open the circuit
	 */
	private openCircuit(): void {
		this.state = 'OPEN'
		this.nextAttempt = Date.now() + this.resetTimeoutMs
		this.failures = 0
		this.successes = 0
	}

	/**
	 * Reset circuit breaker to initial state (for testing)
	 */
	reset(): void {
		this.state = 'CLOSED'
		this.failures = 0
		this.successes = 0
		this.lastFailureTime = null
		this.lastSuccessTime = null
		this.nextAttempt = Date.now()
	}
}

/**
 * Global circuit breaker instance for Audible API
 * Shared across all API calls
 */
let audibleCircuitBreaker: CircuitBreaker | null = null

export function getAudibleCircuitBreaker(): CircuitBreaker {
	if (!audibleCircuitBreaker) {
		audibleCircuitBreaker = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER_OPTIONS)
	}
	return audibleCircuitBreaker
}

/**
 * Reset the global circuit breaker (for testing)
 */
export function resetAudibleCircuitBreaker(): void {
	audibleCircuitBreaker = null
}

export default CircuitBreaker

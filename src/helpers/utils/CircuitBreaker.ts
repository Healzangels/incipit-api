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

		// Whether THIS call is a recovery probe is decided on the way IN and can
		// never be re-decided by what other calls did while it was in flight —
		// see onFailure. The two sides are deliberately asymmetric: a success is
		// only news if the circuit is still open to it (state NOW), a failure is
		// the probe's own verdict (state THEN).
		const enteredHalfOpen = this.state === 'HALF_OPEN'

		try {
			const result = await fn()
			this.onSuccess()
			return result
		} catch (error) {
			this.onFailure(enteredHalfOpen)
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
	private onSuccess(): void {
		this.lastSuccessTime = Date.now()

		// READ THE STATE NOW, not at call time. execute() used to capture
		// `this.state === 'HALF_OPEN'` BEFORE its await and hand that stale
		// flag down here, so a probe that started while half-open and landed
		// after a CONCURRENT failure had already re-OPENed the circuit still
		// counted toward closing it — re-CLOSING a circuit that had just been
		// opened, and sending the next wave of traffic straight back at a
		// provider that is still down. These breakers are module singletons
		// shared by every in-flight request to a provider, so concurrent
		// probes are the normal case during a scan, not a rare interleaving.
		// A success arriving while the state is OPEN (a concurrent failure
		// re-opened the circuit under this call) correctly falls through to the
		// CLOSED-shaped branch below: openCircuit() has already zeroed the
		// counters and transitionState() re-zeros them on the next HALF_OPEN,
		// so it changes nothing observable. An explicit early return read well
		// but no mutation could kill it — dead code by proof, so it is gone.
		if (this.state === 'HALF_OPEN') {
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
	private onFailure(enteredHalfOpen: boolean): void {
		this.lastFailureTime = Date.now()
		this.failures++

		// The OPPOSITE rule to onSuccess, and deliberately so: a failed recovery
		// probe is judged on the state it ENTERED in, not the state it lands in.
		// execute() has no probe lock (it gates only on OPEN) and these breakers
		// are module singletons, so several probes enter HALF_OPEN together
		// during a scan. Reading `this.state` here meant that if two of them
		// succeeded and CLOSED the circuit first, the third's failure landed in
		// CLOSED and merely bumped `failures` to 1 of 5 — the provider that just
		// failed its recovery probe got the full traffic wave back, and the
		// `this.failures = 0` on any CLOSED success could keep it from ever
		// reaching the threshold. "HALF_OPEN -> OPEN: any failure" (class doc)
		// means any failure BY A PROBE, whenever it lands.
		if (enteredHalfOpen || this.state === 'HALF_OPEN') {
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

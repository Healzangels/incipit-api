import { beforeEach, describe, expect, test } from 'bun:test'

import {
	confidenceBand,
	getMatchMetrics,
	type MatchDecision,
	recordMatchDecision,
	resetMatchMetrics
} from '#helpers/utils/matchTelemetry'

function decision(over: Partial<MatchDecision> = {}): MatchDecision {
	return {
		title: 'Some Book',
		author: 'Some Author',
		region: 'us',
		hasDuration: true,
		authorless: false,
		matched: true,
		provider: 'audible',
		matchedTitle: 'Some Book',
		asin: 'B01234567X',
		confidence: 0.95,
		durationDeltaPct: 0.01,
		runnerUpConfidence: 0.7,
		asinPinned: false,
		durationCorroborated: true,
		widened: false,
		candidates: 5,
		accepted: 2,
		risky: false,
		...over
	}
}

describe('confidenceBand', () => {
	test('buckets on the thresholds that change behaviour', () => {
		// 0.9 auto-applies, 0.85 is the uncorroborated ceiling, 0.65 the floor.
		expect(confidenceBand(1)).toBe('0.90-1.00')
		expect(confidenceBand(0.9)).toBe('0.90-1.00')
		expect(confidenceBand(0.89)).toBe('0.85-0.90')
		expect(confidenceBand(0.85)).toBe('0.85-0.90')
		expect(confidenceBand(0.84)).toBe('0.70-0.85')
		expect(confidenceBand(0.7)).toBe('0.70-0.85')
		expect(confidenceBand(0.69)).toBe('0.65-0.70')
	})
})

describe('match telemetry aggregates', () => {
	beforeEach(() => resetMatchMetrics())

	test('starts empty', () => {
		const m = getMatchMetrics()
		expect(m.total).toBe(0)
		expect(m.matched).toBe(0)
		expect(m.avgConfidence).toBeNull()
		expect(m.recent).toEqual([])
	})

	test('counts matched vs unmatched', () => {
		recordMatchDecision(decision())
		recordMatchDecision(decision({ matched: false, confidence: null, provider: null }))
		const m = getMatchMetrics()
		expect(m.total).toBe(2)
		expect(m.matched).toBe(1)
		expect(m.unmatched).toBe(1)
	})

	test('tracks the false-positive conjunction: risky AND authorless', () => {
		// The known bad case: matched on fuzzy title alone, no author to verify.
		recordMatchDecision(decision({ risky: true, authorless: true, durationCorroborated: false }))
		// Risky but the author was present -- less dangerous, counted separately.
		recordMatchDecision(decision({ risky: true, authorless: false, durationCorroborated: false }))
		// Authorless but duration corroborated it -- not risky.
		recordMatchDecision(decision({ risky: false, authorless: true }))
		const m = getMatchMetrics()
		expect(m.risky).toBe(2)
		expect(m.riskyAuthorless).toBe(1)
		expect(m.authorless).toBe(2)
	})

	test('counts corroboration and widening flags', () => {
		recordMatchDecision(decision({ asinPinned: true, widened: true }))
		recordMatchDecision(decision({ asinPinned: false, widened: true, durationCorroborated: false }))
		const m = getMatchMetrics()
		expect(m.asinPinned).toBe(1)
		expect(m.widened).toBe(2)
		expect(m.durationCorroborated).toBe(1)
	})

	test('bands and averages confidence over MATCHED searches only', () => {
		recordMatchDecision(decision({ confidence: 0.95 }))
		recordMatchDecision(decision({ confidence: 0.75 }))
		// Unmatched contributes to neither the average nor the bands.
		recordMatchDecision(decision({ matched: false, confidence: null }))
		const m = getMatchMetrics()
		expect(m.byConfidence['0.90-1.00']).toBe(1)
		expect(m.byConfidence['0.70-0.85']).toBe(1)
		expect(m.avgConfidence).toBeCloseTo(0.85, 10)
	})

	test('recent is newest-first and capped so it cannot grow unbounded', () => {
		for (let i = 0; i < 60; i++) recordMatchDecision(decision({ title: `Book ${i}` }))
		const m = getMatchMetrics()
		expect(m.total).toBe(60)
		expect(m.recent).toHaveLength(50)
		expect(m.recent[0].title).toBe('Book 59')
		expect(m.recent[49].title).toBe('Book 10')
	})

	test('snapshot is a copy -- callers cannot mutate the store', () => {
		recordMatchDecision(decision())
		const m = getMatchMetrics()
		m.recent.length = 0
		expect(getMatchMetrics().recent).toHaveLength(1)
	})

	test('reset clears everything', () => {
		recordMatchDecision(decision({ risky: true, authorless: true }))
		resetMatchMetrics()
		const m = getMatchMetrics()
		expect(m.total).toBe(0)
		expect(m.risky).toBe(0)
		expect(m.riskyAuthorless).toBe(0)
		expect(m.byConfidence).toEqual({})
		expect(m.avgConfidence).toBeNull()
	})
})

import { beforeEach, describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'
import { getMatchMetrics, resetMatchMetrics } from '#helpers/utils/matchTelemetry'

/**
 * Stale-pin override by duration.
 *
 * Regression origin: a metadata.json sidecar carried the Rosamund Pike ASIN on a
 * Kate Reading recording of "The Great Hunt". The pin forced the Pike edition to
 * 1.0, tying the duration-corroborated Kate Reading edition and winning the
 * pinned-first tiebreak — so the book shipped the wrong narrator. The pinned
 * edition's own runtime is +6.8% off the file while Kate Reading's is exact, so
 * the pin is trusting a bad ASIN over the file's ground-truth runtime. The guard
 * withdraws the pin's override in exactly that case.
 */

const FILE_SECONDS = 95661
const FILE_MS = FILE_SECONDS * 1000

function candidate(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
	return {
		provider: 'audible',
		id: 'x',
		asin: null,
		title: 'The Great Hunt',
		authors: ['Robert Jordan'],
		narrators: [],
		audioSeconds: null,
		cover: null,
		language: null,
		...over
	}
}

function helperFor(candidates: ProviderCandidate[], options: Record<string, unknown> = {}) {
	const registry = { searchAll: async () => candidates } as unknown as ProviderRegistry
	return new BookSearchHelper(registry, {
		title: 'The Great Hunt',
		author: 'Robert Jordan',
		region: 'us',
		...options
	} as never)
}

// The pinned Rosamund Pike edition: title/author perfect, but runtime +6.8% off.
const pike = (over: Partial<ProviderCandidate> = {}): ProviderCandidate =>
	candidate({
		id: 'pike',
		asin: 'B0PIKE00000',
		narrators: ['Rosamund Pike'],
		audioSeconds: 102180,
		...over
	})

// The correct Kate Reading edition: runtime matches the file almost exactly.
const reading = (over: Partial<ProviderCandidate> = {}): ProviderCandidate =>
	candidate({
		provider: 'overdrive',
		id: 'reading',
		asin: null,
		narrators: ['Kate Reading', 'Michael Kramer'],
		audioSeconds: 95640,
		...over
	})

describe('stale-pin override by duration', () => {
	beforeEach(() => resetMatchMetrics())

	test('a pin whose runtime is wrong yields to the duration-corroborated edition', async () => {
		const out = await helperFor([pike(), reading()], {
			duration: FILE_MS,
			asin: 'B0PIKE00000'
		}).search()

		expect(out[0].id).toBe('reading')
		expect(out.find((c) => c.id === 'pike')!.confidence).toBeLessThan(out[0].confidence)
		expect(getMatchMetrics().recent[0].pinDurationOverridden).toBe(1)
		expect(getMatchMetrics().pinDurationOverriddenSearches).toBe(1)
	})

	test('a pin whose runtime DOES corroborate keeps its override', async () => {
		// The pinned edition's runtime matches the file -> it is the right edition;
		// the pin stays definitive even though another edition also corroborates.
		const out = await helperFor([pike({ audioSeconds: FILE_SECONDS }), reading()], {
			duration: FILE_MS,
			asin: 'B0PIKE00000'
		}).search()

		expect(out[0].id).toBe('pike')
		expect(getMatchMetrics().recent[0].pinDurationOverridden).toBe(0)
	})

	test('a pin is NOT overridden when no other edition corroborates the runtime', async () => {
		// Pin is off, but nothing else matches the file either -> keep the pin (it is
		// still the best identity signal we have).
		const out = await helperFor([pike(), reading({ audioSeconds: 70000 })], {
			duration: FILE_MS,
			asin: 'B0PIKE00000'
		}).search()

		expect(out[0].id).toBe('pike')
		expect(getMatchMetrics().recent[0].pinDurationOverridden).toBe(0)
	})

	test('a pin is NOT overridden when the file has no duration (nothing to contradict it)', async () => {
		const out = await helperFor([pike(), reading()], { asin: 'B0PIKE00000' }).search()

		expect(out[0].id).toBe('pike')
		expect(getMatchMetrics().recent[0].pinDurationOverridden).toBe(0)
	})

	test('REGRESSION: a pin on a DIFFERENT BOOK is caught (scored delta is null there)', async () => {
		// The guard used to read scoreCandidate's durationDeltaPct, which is null
		// whenever every scored variant clamps to 0 -- exactly what a wrong-BOOK pin
		// does. The wrong book then kept a forced 1.0 and was returned first.
		const out = await helperFor(
			[
				candidate({
					id: 'wrongbook',
					asin: 'B0PIKE00000',
					title: 'Atomic Habits',
					authors: ['James Clear'],
					narrators: ['James Clear'],
					audioSeconds: 18000
				}),
				reading()
			],
			{ duration: FILE_MS, asin: 'B0PIKE00000' }
		).search()

		expect(out[0].id).toBe('reading')
		expect(getMatchMetrics().recent[0].pinDurationOverridden).toBeGreaterThan(0)
	})

	test('REGRESSION: an AI-narrated row cannot corroborate away a real pin', async () => {
		// A Virtual Voice listing whose runtime happens to match must not be treated
		// as ground truth: it would strip the pin and then win the ranking, inverting
		// the AI-narration demotion.
		const out = await helperFor(
			[
				pike(),
				candidate({ id: 'junk', asin: null, narrators: ['Virtual Voice'], audioSeconds: 95640 })
			],
			{ duration: FILE_MS, asin: 'B0PIKE00000' }
		).search()

		expect(out[0].id).toBe('pike')
		expect(getMatchMetrics().recent[0].pinDurationOverridden).toBe(0)
	})

	test('REGRESSION: a runtime-less twin of the stale ASIN cannot resurrect the pin', async () => {
		// Hardcover audio rows routinely have a null runtime. Deciding per row let
		// that twin keep the pin and win, with the wrong narrator.
		const out = await helperFor(
			[
				pike(),
				candidate({
					provider: 'hardcover',
					id: 'hc-pike',
					asin: 'B0PIKE00000',
					narrators: ['Rosamund Pike'],
					audioSeconds: null
				}),
				reading()
			],
			{ duration: FILE_MS, asin: 'B0PIKE00000' }
		).search()

		expect(out[0].id).toBe('reading')
		expect((out[0].narrators ?? []).join(' ')).toContain('Kate Reading')
	})

	test('REGRESSION: a contradicted pin is demoted, never dropped from the results', async () => {
		// Withdrawing the pin re-exposes it to the language/dead-zone penalties, which
		// could push it under the floor -- so asking for an ASIN returned a list with
		// no row carrying it, and the operator could not pick it in Fix Match.
		const out = await helperFor(
			[pike({ language: 'de' }), reading({ language: 'en' })],
			{ duration: FILE_MS, asin: 'B0PIKE00000', region: 'us' }
		).search()

		expect(out[0].id).toBe('reading')
		expect(out.some((c) => c.asin === 'B0PIKE00000')).toBe(true)
	})

	test('an overridden pin still donates its ASIN and narrators in dedupe', async () => {
		// It is a REAL edition whose pin we distrust, not junk: folding it into the
		// junk set stripped the identity off its group's winner.
		const out = await helperFor(
			[
				pike(),
				candidate({ provider: 'apple', id: 'apple-pike', asin: null, narrators: [], audioSeconds: 102180 }),
				reading()
			],
			{ duration: FILE_MS, asin: 'B0PIKE00000' }
		).search()

		const pikeGroup = out.find((c) => c.id === 'pike' || c.id === 'apple-pike')
		expect(pikeGroup).toBeDefined()
		expect(pikeGroup!.asin).toBe('B0PIKE00000')
		expect((pikeGroup!.narrators ?? []).join(' ')).toContain('Rosamund Pike')
	})

	test('telemetry does not report an overridden pin as ASIN-confirmed', async () => {
		await helperFor([pike(), reading()], { duration: FILE_MS, asin: 'B0PIKE00000' }).search()
		const decision = getMatchMetrics().recent[0]
		expect(decision.pinDurationOverridden).toBeGreaterThan(0)
		expect(decision.asinPinned).toBe(false)
	})
})

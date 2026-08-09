import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { foldSeriesName, foldSeriesTitle } from '#helpers/providers/goodreadsSeries'

/**
 * ONE series identity, not three.
 *
 * The two volume-prefix gates each carried a private `flat` helper — byte
 * identical to each other, one spelling the apostrophes as literals and one as
 * escapes, which is how they read as different code. Both had drifted from
 * `foldSeriesName`: they folded two apostrophe characters where it folds five,
 * and neither applied NFC.
 *
 * That drift is not cosmetic. NFC in particular is a bug this module already
 * found and fixed once — the comment on foldSeriesName records that without it
 * "an NFD sub-series name never matched its NFC twin and the refusal silently
 * did not fire" — and the fix simply never reached the copies. So the same
 * provider spelling could be the same series to the rescue refusal and a
 * different series to the two gates.
 */
describe('foldSeriesTitle', () => {
	test('strips the descriptor nouns providers bolt on', () => {
		// The behaviour the local copies existed for, preserved.
		expect(foldSeriesTitle('The Sons of Valor Series')).toBe(foldSeriesTitle('Sons of Valor'))
		for (const noun of [
			'Series',
			'Thriller',
			'Thrillers',
			'Novel',
			'Novels',
			'Saga',
			'Sequence',
			'Trilogy',
			'Chronicle',
			'Chronicles'
		]) {
			expect(foldSeriesTitle(`Riyria ${noun}`)).toBe('riyria')
		}
	})

	test('folds ALL FIVE apostrophes, not the two the copies knew', () => {
		// U+02BC is the one the copies missed. The others are pinned so a future
		// widening of foldSeriesName cannot quietly stop reaching this gate.
		const canonical = foldSeriesTitle("Hoid's Travails")
		for (const apostrophe of ['‘', '’', 'ʼ', '′', '´']) {
			expect(foldSeriesTitle(`Hoid${apostrophe}s Travails`)).toBe(canonical)
		}
	})

	test('an NFD name matches its NFC twin', () => {
		// 'é' and 'é' render identically and are different strings.
		const nfd = 'Les Misérables Saga'
		const nfc = 'Les Misérables Saga'
		expect(nfd).not.toBe(nfc)
		expect(foldSeriesTitle(nfd)).toBe(foldSeriesTitle(nfc))
	})

	test('it agrees with foldSeriesName wherever no descriptor is present', () => {
		// The two must not be independent implementations — this is the property
		// that composition buys and two hand-written copies never had.
		for (const name of [
			'The Stormlight Archive',
			'Jack Ryan, Jr.',
			"Hoidʼs Travails",
			'Les Misérables',
			'  A   Wrinkle  in Time '
		]) {
			expect(foldSeriesTitle(name)).toBe(foldSeriesName(name))
		}
	})

	test('the article strip still runs, and only at the front', () => {
		expect(foldSeriesTitle('The Riyria Chronicles')).toBe('riyria')
		// "The" inside the name is not an article to strip.
		expect(foldSeriesTitle('All the Wandering Light')).toBe('all the wandering light')
	})

	test('a name that is ONLY descriptors folds to empty, and callers reject that', () => {
		// Both gates guard on falsy before comparing; an empty fold must not be
		// treated as "matches everything" via includes().
		expect(foldSeriesTitle('The Series')).toBe('')
		expect(foldSeriesTitle('Saga')).toBe('')
	})

	test('BOTH gates route through it — the drift guard', () => {
		// A unit test of this function passes whether or not either gate calls
		// it, which is precisely how two private copies survived. Pin at source.
		const src = readFileSync(
			join(import.meta.dir, '..', '..', '..', 'src', 'helpers', 'providers', 'goodreadsSeries.ts'),
			'utf8'
		)
		expect(src).toContain('const a = foldSeriesTitle(prefix)')
		expect(src).toContain('const b = foldSeriesTitle(providerSeries)')
		expect(src).toContain('const got = foldSeriesTitle(found.primary.name)')
		expect(src).toContain("const want = foldSeriesTitle(providerSeries ?? '')")
		// And no one has re-grown a private copy: the descriptor list appears
		// exactly once, in the shared constant.
		expect(src.match(/series\|thrillers\?\|novels\?/g)).toHaveLength(1)
	})
})

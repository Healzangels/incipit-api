import { describe, expect, test } from 'bun:test'

import type { ApiAuthorProfile } from '#config/types'
import AuthorShowHelper from '#helpers/routes/AuthorShowHelper'

/**
 * The second chance: a brand-new author's FIRST enrichment can catch the
 * Goodreads mirror cache-cold -- our own query is what sets it warming, and
 * minutes later the mirror knows the author (measured live on Roger Zelazny:
 * first answer surfaced only a franchise-continuation novel, the real record
 * with bio + portrait appeared minutes later). Without this, the gap waits for
 * the 1h miss TTL + the next refresh, or the monthly sweep.
 *
 * So: when a NON-forced enrichment pass produces an INCOMPLETE author (no
 * portrait or no bio), schedule exactly one delayed re-run of the forced heal
 * path. One shot, deduped per asin, never scheduled by the forced pass itself
 * (no loops), and skipped when there is no name to look up.
 */

function author(over: Partial<ApiAuthorProfile> = {}): ApiAuthorProfile {
	return {
		asin: 'B000APXZHK',
		name: 'Roger Zelazny',
		region: 'us',
		description: '',
		image: 'https://example/portrait.jpg',
		genres: [],
		similar: [],
		...over
	}
}

function helperFor(options: Record<string, unknown> = {}) {
	return new AuthorShowHelper(
		'B000APXZHK',
		{ region: 'us', update: '1', ...options } as never,
		null
	)
}

describe('AuthorShowHelper second chance', () => {
	test('a bio-less author on a non-forced pass schedules one retry', () => {
		const calls: Array<{ key: string; delay: number }> = []
		const schedule = (key: string, delay: number) => {
			calls.push({ key, delay })
			return true
		}
		const out = helperFor().maybeScheduleSecondChance(author(), schedule as never)
		expect(out).toBe(true)
		expect(calls).toHaveLength(1)
		expect(calls[0].key).toBe('author:B000APXZHK')
		expect(calls[0].delay).toBeGreaterThan(0)
	})

	test('an image-less author schedules too', () => {
		const schedule = () => true
		const out = helperFor().maybeScheduleSecondChance(
			author({ image: '', description: 'a bio' }),
			schedule as never
		)
		expect(out).toBe(true)
	})

	test('a COMPLETE author schedules nothing', () => {
		const schedule = () => true
		const out = helperFor().maybeScheduleSecondChance(
			author({ description: 'a bio' }),
			schedule as never
		)
		expect(out).toBe(false)
	})

	test('the forced pass never schedules (no retry loops)', () => {
		const schedule = () => true
		const out = helperFor({ force: '1' }).maybeScheduleSecondChance(author(), schedule as never)
		expect(out).toBe(false)
	})

	test('no name, nothing to look up, nothing scheduled', () => {
		const schedule = () => true
		const out = helperFor().maybeScheduleSecondChance(author({ name: '' }), schedule as never)
		expect(out).toBe(false)
	})
})

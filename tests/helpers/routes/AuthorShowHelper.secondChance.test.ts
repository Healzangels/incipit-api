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

describe('a stored BOOK COVER does not count as a portrait', () => {
	/**
	 * The gap that let the provider-side guard ship incomplete (2026-07-29):
	 * eight authors already had `assets.hardcover.app/books/<id>/...` PERSISTED
	 * as their photo. Rejecting book assets on the way OUT of Hardcover does
	 * nothing for them -- the stored jacket rides back in through the
	 * minimal-profile seed and reads as a complete profile, so the throttle
	 * never re-fetches and the wrong image is permanent. Verified live: all
	 * eight were unchanged after the provider fix deployed.
	 */
	const BOOK_COVER = 'https://assets.hardcover.app/books/349845/10283388-L.jpg'

	test('an author whose only image is a book cover still counts as incomplete', () => {
		const calls: string[] = []
		const schedule = (key: string) => {
			calls.push(key)
			return true
		}
		// Bio present, so the ONLY thing that can make this incomplete is the
		// image being recognised as a non-portrait.
		const out = helperFor().maybeScheduleSecondChance(
			author({ description: 'A real biography.', image: '' }),
			schedule as never
		)
		expect(out).toBe(true)
		expect(calls).toHaveLength(1)
	})

	test('the placeholder rule treats a stored book cover as NOT a portrait', async () => {
		// This is the rule that CLEARS a bad stored image so enrichment can
		// refill it. Without book assets in this set, the eight affected
		// authors keep their jackets forever.
		const { isNonPortraitImage } = await import('#helpers/routes/AuthorShowHelper')
		expect(isNonPortraitImage(BOOK_COVER)).toBe(true)
		// ...and the other two furniture kinds still qualify.
		expect(
			isNonPortraitImage(
				'https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/nophoto/user/u_200x266.png'
			)
		).toBe(true)
		// The aggregator's literal "null" string — persisted into real records
		// before pickPhoto learned to refuse it; the restore rung then brought
		// it back every pass. Any non-http value is furniture.
		expect(isNonPortraitImage('null')).toBe(true)
		expect(isNonPortraitImage('undefined')).toBe(true)
		expect(isNonPortraitImage(null)).toBe(false)
		expect(isNonPortraitImage('')).toBe(false)
		expect(
			isNonPortraitImage(
				'https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/authors/1721927489i/38550.jpg'
			)
		).toBe(false)
		expect(isNonPortraitImage('https://assets.hardcover.app/static/avatars/profile4.png')).toBe(
			true
		)
		const gen = 'https://assets.hardcover.app/author/9/generated.png'
		expect(isNonPortraitImage(gen, gen)).toBe(true)
		// A real portrait is never furniture.
		expect(isNonPortraitImage('https://assets.hardcover.app/authors/178795/7241662-L.jpg')).toBe(
			false
		)
		expect(isNonPortraitImage('https://images-na.ssl-images-amazon.com/images/S/a.jpg')).toBe(false)
	})

	test('isBookAssetUrl recognises the live shape and spares real portraits', async () => {
		const { isBookAssetUrl } = await import('#helpers/providers/HardcoverProvider')
		expect(isBookAssetUrl(BOOK_COVER)).toBe(true)
		expect(isBookAssetUrl('https://assets.hardcover.app/authors/178795/7241662-L.jpg')).toBe(false)
		expect(isBookAssetUrl('https://assets.hardcover.app/author/86158/f18a10d8.jpeg')).toBe(false)
		expect(isBookAssetUrl('https://images-na.ssl-images-amazon.com/images/S/a.jpg')).toBe(false)
		expect(isBookAssetUrl('https://i.gr-assets.com/images/S/authors/1442.jpg')).toBe(false)
		expect(isBookAssetUrl(null)).toBe(false)
		expect(isBookAssetUrl('')).toBe(false)
	})
})

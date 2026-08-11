import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { mirrorKeyFor } from '#helpers/providers/goodreadsSeries'

/**
 * THE MIRROR IS AN INPUT TO THE ANSWER, so it belongs in the cache key.
 *
 * Neither `grseries:` nor `grauthor:` carried it, so pointing
 * GOODREADS_SERIES_URL at a different backend kept serving the previous
 * one's answers for up to the hit TTL — a week on the local profile, a month
 * on the shared one. This deployment has made exactly that switch (shared
 * bookinfo.pro -> a self-hosted instance) precisely BECAUSE the two return
 * different data, which is the whole reason the stale window matters.
 *
 * The file's own convention for "cached answers are wrong at rest" is a
 * prefix change (see the v4/v5 bump comments); folding the mirror in makes a
 * switch behave the same way — old rows orphan and expire, every row
 * recomputes cold.
 */
describe('mirrorKeyFor', () => {
	test('different mirrors yield DIFFERENT keys — the whole point', () => {
		const shared = mirrorKeyFor('https://api.bookinfo.pro')
		const local = mirrorKeyFor('http://10.0.1.99:8788')
		expect(shared).not.toBe(local)
		expect(shared).toBe('api.bookinfo.pro')
		expect(local).toBe('10.0.1.99:8788')
	})

	test('the same mirror yields the SAME key across cosmetic spelling', () => {
		// A scheme or casing difference must not split one mirror's cache in
		// two — that would silently halve the hit rate on every restart where
		// the URL was typed differently.
		const canonical = mirrorKeyFor('http://10.0.1.99:8788')
		expect(mirrorKeyFor('https://10.0.1.99:8788')).toBe(canonical)
		expect(mirrorKeyFor('http://10.0.1.99:8788/')).toBe(canonical)
		expect(mirrorKeyFor('HTTP://10.0.1.99:8788')).toBe(canonical)
	})

	test('a different PORT on the same host is a different mirror', () => {
		// Two rreading-glasses containers on one box is a real deployment
		// shape, and they can hold different data.
		expect(mirrorKeyFor('http://10.0.1.99:8788')).not.toBe(mirrorKeyFor('http://10.0.1.99:8789'))
	})

	test('a malformed URL still produces a stable, non-empty key', () => {
		// Never throw and never return '' — an unparseable value must not
		// collapse every mirror into one shared key.
		expect(mirrorKeyFor('not a url')).toBeTruthy()
		expect(mirrorKeyFor('')).toBe('unknown')
		expect(mirrorKeyFor('!!!')).toBe('unknown')
	})

	test('BOTH prefixes actually carry it — the unwired-stage guard', () => {
		// mirrorKeyFor's own tests pass whether or not the prefixes use it,
		// which is the shape that has cost this repo real bugs. Pin the wiring
		// at source, the way the bundle's offer-path guard does.
		const src = readFileSync(
			join(import.meta.dir, '..', '..', '..', 'src', 'helpers', 'providers', 'goodreadsSeries.ts'),
			'utf8'
		)
		expect(src).toContain('const CACHE_PREFIX = `grseries:v6:${MIRROR_KEY}:`')
		expect(src).toContain('const AUTHOR_CACHE_PREFIX = `grauthor:v1:${MIRROR_KEY}:`')
	})

	test('the key is redis-greppable: no separators that break key parsing', () => {
		for (const url of ['https://api.bookinfo.pro', 'http://10.0.1.99:8788', 'not a url']) {
			expect(mirrorKeyFor(url)).not.toContain('/')
			expect(mirrorKeyFor(url)).not.toContain(' ')
		}
	})
})

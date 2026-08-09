import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { abridgedFrom, abridgedFromTitleSuffix } from '#helpers/providers/abridged'
import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'

/**
 * ABRIDGED LOSES TO UNABRIDGED WHEN NOTHING ELSE CAN DECIDE.
 *
 * `normalizeTitle` strips "(Abridged)"/"(Unabridged)", so the two editions of a
 * book reduce to the same string and every identity arm declines. With no
 * duration signal there was nothing left, and the winner fell through to the
 * cosmetic arms.
 *
 * That is the NORMAL first-scan state: Plex matches before it analyses, so
 * `part.duration` is -1 and the bundle withholds the hint on purpose (a partial
 * sum would veto the CORRECT edition). Measured on this library 2026-08-09,
 * four books sat on abridged records at under half the file's runtime —
 * I Shall Wear Midnight 707/262, Hannibal 758/366, Fade 588/278,
 * Dirk Gently 479/181.
 */

const SRC_DIR = join(import.meta.dir, '..', '..', '..', 'src', 'helpers')

function candidate(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
	return {
		provider: 'audible',
		id: 'x',
		asin: null,
		title: 'Hannibal',
		authors: ['Thomas Harris'],
		narrators: [],
		audioSeconds: null,
		cover: null,
		language: null,
		...over
	}
}

function helperFor(pool: ProviderCandidate[], options: Record<string, unknown> = {}) {
	const registry = {
		searchAll: async () => pool,
		fetchCandidateByAsin: async () => null
	} as unknown as ProviderRegistry
	return new BookSearchHelper(registry, {
		title: 'Hannibal',
		author: 'Thomas Harris',
		region: 'us',
		...options
	} as never)
}

describe('abridgedFrom', () => {
	test('reads both states, and UNabridged is not mistaken for abridged', () => {
		// "unabridged" contains "abridged", so a naive substring test inverts
		// every unabridged edition. This is the whole reason it is one shared fn.
		expect(abridgedFrom('abridged')).toBe(true)
		expect(abridgedFrom('unabridged')).toBe(false)
		expect(abridgedFrom('Abridged')).toBe(true)
		expect(abridgedFrom('UNABRIDGED')).toBe(false)
		expect(abridgedFrom('  unabridged  ')).toBe(false)
	})

	test('silence stays UNDEFINED — never a claim of unabridged', () => {
		// Most providers say nothing. Reading that as "unabridged" would let a
		// no-signal row beat a genuinely unabridged one.
		for (const v of [undefined, null, '', '   ', 'audiobook', 'ebook']) {
			expect(abridgedFrom(v)).toBeUndefined()
		}
	})
})

describe('abridgedFromTitleSuffix', () => {
	test('reads Apple’s suffix, both ways', () => {
		expect(abridgedFromTitleSuffix('Hannibal (Abridged)')).toBe(true)
		expect(abridgedFromTitleSuffix('Hannibal (Unabridged)')).toBe(false)
		expect(abridgedFromTitleSuffix('hannibal (unabridged)')).toBe(false)
	})

	test('a title with no suffix says nothing', () => {
		expect(abridgedFromTitleSuffix('Hannibal')).toBeUndefined()
		expect(abridgedFromTitleSuffix(undefined)).toBeUndefined()
		// Only a TRAILING suffix counts — a book actually called "Abridged Life"
		// is not an abridgement claim.
		expect(abridgedFromTitleSuffix('Abridged Life')).toBeUndefined()
	})
})

describe('the tiebreak', () => {
	test('the UNABRIDGED edition wins when nothing else separates them', async () => {
		// The measured shape: same title, same author, no narrators, NO duration
		// on either side — exactly a first-scan pool.
		const abridged = candidate({ id: 'ab', asin: 'B0ABRIDGED', abridged: true })
		const unabridged = candidate({ id: 'un', asin: 'B0UNABRIDG', abridged: false })
		const ranked = await helperFor([abridged, unabridged]).search()
		expect(ranked[0]?.id).toBe('un')
	})

	test('...whichever order the providers happened to return them in', async () => {
		const abridged = candidate({ id: 'ab', asin: 'B0ABRIDGED', abridged: true })
		const unabridged = candidate({ id: 'un', asin: 'B0UNABRIDG', abridged: false })
		const ranked = await helperFor([unabridged, abridged]).search()
		expect(ranked[0]?.id).toBe('un')
	})

	test('the abridged edition is DEMOTED, never dropped — it stays pickable', async () => {
		// An operator may genuinely own the abridged edition; Fix Match has to be
		// able to offer it.
		const abridged = candidate({ id: 'ab', asin: 'B0ABRIDGED', abridged: true })
		const unabridged = candidate({ id: 'un', asin: 'B0UNABRIDG', abridged: false })
		const ranked = await helperFor([abridged, unabridged]).search()
		expect(ranked.some((c) => c.id === 'ab')).toBe(true)
	})

	test('a provider that said NOTHING is not demoted below a stated unabridged', async () => {
		// undefined means "unstated". Only a positive abridged claim demotes, so
		// the six providers with no flag are unaffected.
		const silent = candidate({ id: 'silent', asin: 'B0SILENT00' })
		const unabridged = candidate({ id: 'un', asin: 'B0UNABRIDG', abridged: false })
		const ranked = await helperFor([silent, unabridged]).search()
		expect(ranked.map((c) => c.id).slice(0, 2).sort()).toEqual(['silent', 'un'])
	})

	test('DURATION still outranks it — an abridged file matches its abridged edition', async () => {
		// The safety property. Someone who owns the abridged copy sends its
		// runtime, and the evidence arm above must beat this cosmetic one.
		const abridged = candidate({
			id: 'ab',
			asin: 'B0ABRIDGED',
			abridged: true,
			audioSeconds: 366 * 60
		})
		const unabridged = candidate({
			id: 'un',
			asin: 'B0UNABRIDG',
			abridged: false,
			audioSeconds: 758 * 60
		})
		const ranked = await helperFor([unabridged, abridged], { duration: 366 * 60 * 1000 }).search()
		expect(ranked[0]?.id).toBe('ab')
	})
})

describe('wiring', () => {
	test('the providers that HAVE the signal actually set it', () => {
		// `abridged` is optional, unlike `language`, so nothing in the type system
		// forces these. A unit test of abridgedFrom passes whether or not anyone
		// calls it — which is exactly how this repo has lost signals before.
		const audible = readFileSync(join(SRC_DIR, 'providers', 'AudibleProvider.ts'), 'utf8')
		expect(audible).toContain('abridged: abridgedFrom(p.format_type)')
		// BOTH construction sites: search() and fetchCandidateByAsin().
		expect(audible.match(/abridged: abridgedFrom\(p\.format_type\)/g)).toHaveLength(2)
		// ...and the field must be requested from the API, or it is always undefined.
		expect(audible).toContain('product_attrs')

		const apple = readFileSync(join(SRC_DIR, 'providers', 'AppleBooksProvider.ts'), 'utf8')
		// Read from the RAW name — cleanAppleTitle strips the suffix.
		expect(apple).toContain('abridged: abridgedFromTitleSuffix(r.collectionName as string)')
	})

	test('the comparator consults it, and only on a positive claim', () => {
		const src = readFileSync(join(SRC_DIR, 'routes', 'BookSearchHelper.ts'), 'utf8')
		expect(src).toContain(
			'const byAbridged = Number(a.abridged === true) - Number(b.abridged === true)'
		)
		expect(src).toContain('if (byAbridged !== 0) return byAbridged')
	})

	test('nobody re-derives the abridged string test inline', () => {
		// A second `=== 'abridged'` is how the shared rule drifts.
		for (const f of ['providers/AudibleProvider.ts', 'providers/AppleBooksProvider.ts']) {
			const src = readFileSync(join(SRC_DIR, f), 'utf8')
			expect(src).not.toContain("=== 'abridged'")
			expect(src).not.toContain("=== 'unabridged'")
		}
	})
})

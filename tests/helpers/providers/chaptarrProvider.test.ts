import { describe, expect, test } from 'bun:test'

import ChaptarrProvider, {
	type ChaptarrWorkResponse,
	editionForAsin
} from '#helpers/providers/ChaptarrProvider'
import type { FetchBookOptions } from '#helpers/providers/types'
import fixture from '#tests/fixtures/chaptarr-work-annihilation.json'

/**
 * Chaptarr metadata service provider (api2.chaptarr.com, opened 2026-08-08).
 *
 * The fixture is a TRIMMED LIVE CAPTURE of /api/v5/book/az:B00HYGYN5Q from
 * 2026-08-08 — Annihilation, the book chosen because it is one of the two the
 * whole genre-backfill effort started from. It carries the shapes that matter:
 * an eng audiobook edition with narrator + durationSeconds + chapters, a
 * Dutch physical edition with NO asin, and a German ebook WITH an asin — so
 * the audiobook/asin/language filters all have something to discriminate.
 */

const work = fixture as unknown as ChaptarrWorkResponse
const OPTS: FetchBookOptions = { region: 'us' }

function provider(over: {
	matches?: { work_id?: string; author?: string }[]
	works?: Record<string, ChaptarrWorkResponse | null>
	matchCalls?: string[]
	workCalls?: string[]
}) {
	return new ChaptarrProvider({
		matchFetch: async (q) => {
			over.matchCalls?.push(q)
			return over.matches ?? []
		},
		workFetch: async (id) => {
			over.workCalls?.push(id)
			return over.works?.[id] ?? null
		}
	})
}

describe('search', () => {
	test('match -> work -> asin-bearing AUDIOBOOK editions only', async () => {
		const p = provider({
			matches: [{ work_id: 'hc:192491' }],
			works: { 'hc:192491': work }
		})
		const out = await p.search({ title: 'Annihilation', author: 'Jeff VanderMeer', region: 'us' })
		// The Dutch physical edition has no asin; the German EBOOK has one but is
		// not an audiobook. Exactly one candidate survives.
		expect(out.length).toBe(1)
		const c = out[0]
		expect(c.provider).toBe('chaptarr')
		expect(c.asin).toBe('B00HYGYN5Q')
		expect(c.id).toBe('B00HYGYN5Q')
		expect(c.title).toBe('Annihilation')
		expect(c.authors).toEqual(['Jeff VanderMeer'])
		expect(c.narrators).toEqual(['Carolyn McCormick'])
		expect(c.audioSeconds).toBe(22260)
		expect(c.language).toBe('en')
		expect(c.cover).toContain('media-amazon')
	})

	test('consults at most two works and dedupes work ids', async () => {
		const workCalls: string[] = []
		const p = provider({
			matches: [
				{ work_id: 'hc:1' },
				{ work_id: 'hc:1' },
				{ work_id: 'hc:2' },
				{ work_id: 'hc:3' }
			],
			works: { 'hc:1': work, 'hc:2': work, 'hc:3': work },
			workCalls
		})
		await p.search({ title: 'Annihilation', region: 'us' })
		expect(workCalls).toEqual(['hc:1', 'hc:2'])
	})

	test('an empty query asks nothing', async () => {
		const matchCalls: string[] = []
		const p = provider({ matchCalls })
		const out = await p.search({ title: '', region: 'us' })
		expect(out).toEqual([])
		expect(matchCalls).toEqual([])
	})

	test('a work fetch returning null is skipped, not fatal', async () => {
		const p = provider({
			matches: [{ work_id: 'hc:dead' }, { work_id: 'hc:192491' }],
			works: { 'hc:dead': null, 'hc:192491': work }
		})
		const out = await p.search({ title: 'Annihilation', region: 'us' })
		expect(out.length).toBe(1)
	})
})

describe('fetchBookByAsin (the rescue path)', () => {
	test('maps the exact-asin edition to a full ProviderBook', async () => {
		const p = provider({ works: { 'az:B00HYGYN5Q': work } })
		const book = await p.fetchBookByAsin('B00HYGYN5Q', OPTS)
		expect(book).not.toBeNull()
		expect(book?.asin).toBe('B00HYGYN5Q')
		expect(book?.title).toBe('Annihilation')
		expect(book?.authors).toEqual([{ name: 'Jeff VanderMeer' }])
		expect(book?.narrators).toEqual([{ name: 'Carolyn McCormick' }])
		expect(book?.publisherName).toBe('Blackstone Audio, Inc.')
		expect(book?.language).toBe('en')
		// The canonical ENGLISH series field, not the translated series[] array.
		expect(book?.seriesPrimary).toEqual({ name: 'Southern Reach', position: '1' })
	})

	test('an asin the work does not carry returns null', async () => {
		const p = provider({ works: { 'az:B0NOSUCH00': work } })
		expect(await p.fetchBookByAsin('B0NOSUCH00', OPTS)).toBeNull()
	})

	test('a regional az VARIANT still finds its edition', () => {
		const editions = [
			{
				asin: 'B00HYGYN5Q',
				providerIdsAll: { az: ['az:B00HYG9KMC', 'az:B00HYGYN5Q'] }
			}
		]
		expect(editionForAsin(editions, 'b00hyg9kmc')?.asin).toBe('B00HYGYN5Q')
		expect(editionForAsin(editions, 'B0ABSENT99')).toBeNull()
	})
})

describe('fetchCandidateByAsin (pinned-edition injection)', () => {
	test('returns the candidate shape WITH audioSeconds intact', async () => {
		const p = provider({ works: { 'az:B00HYGYN5Q': work } })
		const c = await p.fetchCandidateByAsin('B00HYGYN5Q', OPTS)
		expect(c?.audioSeconds).toBe(22260)
		expect(c?.narrators).toEqual(['Carolyn McCormick'])
	})
})

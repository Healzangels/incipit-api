import { describe, expect, test } from 'bun:test'

import { BookSearchQueryStringSchema } from '#config/types'
import { CONFIDENCE_FLOOR } from '#helpers/providers/matchScorer'
import ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { BookProvider, BookSearchQuery, ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'

// Build a candidate with sensible defaults so tests only state what they care about.
function candidate(over: Partial<ProviderCandidate>): ProviderCandidate {
	return {
		provider: 'stub',
		id: 'x',
		asin: null,
		title: 'Untitled',
		authors: [],
		narrators: [],
		audioSeconds: null,
		cover: null,
		...over
	}
}

// A provider that returns a fixed list, or throws, on demand.
function stubProvider(name: string, result: ProviderCandidate[] | Error): BookProvider {
	return {
		name,
		async search(): Promise<ProviderCandidate[]> {
			if (result instanceof Error) throw result
			return result
		}
	}
}

describe('BookSearchQueryStringSchema', () => {
	test('accepts a title and defaults region to us', () => {
		const p = BookSearchQueryStringSchema.safeParse({ title: 'A Spell for Chameleon' })
		expect(p.success).toBe(true)
		if (p.success) expect(p.data.region).toBe('us')
	})

	test('coerces duration from a query-string number (milliseconds)', () => {
		const p = BookSearchQueryStringSchema.safeParse({ title: 'Dune', duration: '75720000' })
		expect(p.success).toBe(true)
		if (p.success) expect(p.data.duration).toBe(75720000)
	})

	test('rejects a non-numeric duration', () => {
		const p = BookSearchQueryStringSchema.safeParse({ title: 'Dune', duration: 'soon' })
		expect(p.success).toBe(false)
	})

	test('rejects an invalid region', () => {
		const p = BookSearchQueryStringSchema.safeParse({ title: 'Dune', region: 'mars' })
		expect(p.success).toBe(false)
	})

	test('accepts the query alias for title', () => {
		const p = BookSearchQueryStringSchema.safeParse({ query: 'Dune' })
		expect(p.success).toBe(true)
	})
})

describe('ProviderRegistry fan-out', () => {
	const query: BookSearchQuery = { title: 'Dune', region: 'us' }

	test('flattens candidates from every provider', async () => {
		const reg = new ProviderRegistry([
			stubProvider('a', [candidate({ provider: 'a', id: '1' })]),
			stubProvider('b', [
				candidate({ provider: 'b', id: '2' }),
				candidate({ provider: 'b', id: '3' })
			])
		])
		const out = await reg.searchAll(query)
		expect(out).toHaveLength(3)
		expect(reg.names).toEqual(['a', 'b'])
	})

	test('isolates a failing provider — others still return', async () => {
		const reg = new ProviderRegistry([
			stubProvider('good', [candidate({ provider: 'good', id: '1' })]),
			stubProvider('bad', new Error('network down'))
		])
		const out = await reg.searchAll(query)
		expect(out).toHaveLength(1)
		expect(out[0].provider).toBe('good')
	})

	test('empty registry returns no candidates', async () => {
		const out = await new ProviderRegistry().searchAll(query)
		expect(out).toEqual([])
	})

	test('register() adds a provider and chains', async () => {
		const reg = new ProviderRegistry()
		const returned = reg.register(stubProvider('late', [candidate({ provider: 'late', id: '9' })]))
		expect(returned).toBe(reg)
		expect(reg.names).toEqual(['late'])
		const out = await reg.searchAll(query)
		expect(out).toHaveLength(1)
	})
})

describe('BookSearchHelper scoring and ranking', () => {
	test('drops below-floor candidates and ranks the rest best-first', async () => {
		const reg = new ProviderRegistry([
			stubProvider('p', [
				candidate({ id: 'exact', title: 'A Spell for Chameleon', authors: ['Piers Anthony'] }),
				candidate({ id: 'wrong', title: 'Something Unrelated', authors: ['Nobody'] })
			])
		])
		const helper = new BookSearchHelper(reg, {
			title: 'A Spell for Chameleon',
			author: 'Piers Anthony',
			region: 'us'
		})
		const out = await helper.search()
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('exact')
		expect(out[0].confidence).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR)
	})

	test('normalizes the incoming title like the benchmark did', async () => {
		// Series-suffixed ALBUM tag must still match the clean provider title.
		const reg = new ProviderRegistry([
			stubProvider('p', [
				candidate({ id: 'ok', title: 'Castle Roogna', authors: ['Piers Anthony'] })
			])
		])
		const helper = new BookSearchHelper(reg, {
			title: 'Castle Roogna: Xanth, Book 3',
			author: 'Piers Anthony',
			region: 'us'
		})
		const out = await helper.search()
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('ok')
	})

	test('duration vetoes a right-title wrong-edition candidate', async () => {
		// The Wandering Inn Volume 2: right title+author, 26.9% runtime mismatch.
		const reg = new ProviderRegistry([
			stubProvider('p', [
				candidate({
					id: 'wrongvol',
					title: 'The Wandering Inn',
					authors: ['pirate aba'],
					audioSeconds: 173220
				})
			])
		])
		const helper = new BookSearchHelper(reg, {
			title: 'The Wandering Inn',
			author: 'pirate aba',
			duration: 219873000,
			region: 'us'
		})
		const out = await helper.search()
		expect(out).toHaveLength(0)
	})

	test('duration corroboration keeps a matching edition and tags the delta', async () => {
		const reg = new ProviderRegistry([
			stubProvider('p', [
				candidate({
					id: 'right',
					title: 'The Stars, Like Dust',
					authors: ['Isaac Asimov'],
					audioSeconds: 29598
				})
			])
		])
		const helper = new BookSearchHelper(reg, {
			title: 'The Stars, Like Dust',
			author: 'Isaac Asimov',
			duration: 29598000,
			region: 'us'
		})
		const out = await helper.search()
		expect(out).toHaveLength(1)
		expect(out[0].durationDeltaPct).toBeLessThanOrEqual(0.05)
	})

	test('rawTitle falls back to the query alias', async () => {
		const helper = new BookSearchHelper(new ProviderRegistry(), {
			query: 'Dune',
			region: 'us'
		})
		expect(helper.rawTitle).toBe('Dune')
	})
})

describe('BookSearchHelper track-title fallback', () => {
	// A provider that only knows the real book title, not the series+number tag.
	const swellFoopProvider = stubProvider('p', [
		candidate({ id: 'swell', title: 'Swell Foop', authors: ['Piers Anthony'] })
	])

	test('falls back to the track title when the album title finds nothing', async () => {
		const helper = new BookSearchHelper(new ProviderRegistry([swellFoopProvider]), {
			title: 'Xanth 25',
			trackTitle: 'Swell Foop (The Xanth Novels)',
			author: 'Piers Anthony',
			region: 'us'
		})
		const out = await helper.search()
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('swell')
	})

	test('does not use the track title when the album title already matched', async () => {
		const exact = stubProvider('p', [
			candidate({ id: 'a', title: 'A Spell for Chameleon', authors: ['Piers Anthony'] })
		])
		const helper = new BookSearchHelper(new ProviderRegistry([exact]), {
			title: 'A Spell for Chameleon',
			trackTitle: 'Something Else Entirely',
			author: 'Piers Anthony',
			region: 'us'
		})
		const out = await helper.search()
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('a')
	})

	test('does not retry when the track title normalizes to the album title', async () => {
		let calls = 0
		const counting: BookProvider = {
			name: 'count',
			async search() {
				calls++
				return []
			}
		}
		const helper = new BookSearchHelper(new ProviderRegistry([counting]), {
			title: 'The Wandering Inn',
			trackTitle: 'The Wandering Inn',
			region: 'us'
		})
		await helper.search()
		expect(calls).toBe(1)
	})
})

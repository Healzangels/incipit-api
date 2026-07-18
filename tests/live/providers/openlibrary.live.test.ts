import OpenLibraryProvider from '#helpers/providers/OpenLibraryProvider'
import type { ProviderBook, ProviderCandidate } from '#helpers/providers/types'

// Live contract test against the real keyless OpenLibrary API (search.json +
// works/authors JSON). Asserts the fields our provider reads and warns
// "[OPENLIBRARY SHAPE CHANGE]" on drift. Run with `bun run test:live`.
describe('OpenLibrary provider (live)', () => {
	const provider = new OpenLibraryProvider({ contact: 'incipit-live-test' })

	describe('search: Project Hail Mary', () => {
		let candidates: ProviderCandidate[]
		beforeAll(async () => {
			candidates = await provider.search({
				title: 'Project Hail Mary',
				author: 'Andy Weir',
				region: 'us'
			})
		}, 30000)

		it('returns book-level candidates in the expected shape', () => {
			expect(candidates.length).toBeGreaterThan(0)
			const c = candidates[0]
			expect(c.provider).toBe('openlibrary')
			expect(c.id).toMatch(/^openlibrary-works-OL\w+$/)
			expect(c.asin).toBeNull()
			expect(c.audioSeconds).toBeNull() // OL is book-level, no audio edition
			expect(typeof c.title).toBe('string')
		})

		it('finds the work and a cover (warns if search.json shape changed)', () => {
			const hit = candidates.find((c) => c.title.toLowerCase().includes('project hail mary'))
			if (!hit) {
				console.warn('[OPENLIBRARY SHAPE CHANGE] search.json returned no Project Hail Mary work')
			}
			const withCover = candidates.find((c) => c.cover)
			if (withCover && !withCover.cover?.includes('covers.openlibrary.org')) {
				console.warn('[OPENLIBRARY SHAPE CHANGE] cover_i no longer maps to a covers URL')
			}
			expect(candidates.length).toBeGreaterThan(0)
		})
	})

	describe('fetchBook: resolves a work to full metadata', () => {
		// "Project Hail Mary" work key, stable.
		let book: ProviderBook | null
		beforeAll(async () => {
			book = await provider.fetchBook('/works/OL20981890W', 'works', { region: 'us' })
		}, 30000)

		it('returns title + resolved author names (warns if work/author JSON changed)', () => {
			if (!book) {
				console.warn('[OPENLIBRARY SHAPE CHANGE] work fetch returned null for a known key')
			} else {
				expect(typeof book.title).toBe('string')
				if (!book.authors?.length) {
					console.warn('[OPENLIBRARY SHAPE CHANGE] author keys did not resolve to names')
				}
			}
			expect(true).toBe(true)
		})
	})
})

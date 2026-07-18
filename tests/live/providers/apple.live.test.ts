import AppleBooksProvider from '#helpers/providers/AppleBooksProvider'
import type { ProviderBook, ProviderCandidate } from '#helpers/providers/types'

// Live contract test: hits the real keyless iTunes Search/Lookup API and the
// Apple Books web page. It asserts the shape our provider depends on and
// console.warns "[APPLE SHAPE CHANGE]" when a field we rely on disappears,
// without hard-failing on the soft (scrape) parts — so drift is visible in CI
// long before users see bad matches. Run with `bun run test:live`.
describe('Apple Books provider (live)', () => {
	const provider = new AppleBooksProvider()

	describe('search: Project Hail Mary', () => {
		let candidates: ProviderCandidate[]
		beforeAll(async () => {
			candidates = await provider.search({
				title: 'Project Hail Mary',
				author: 'Andy Weir',
				region: 'us'
			})
		}, 30000)

		it('returns candidates in the expected shape', () => {
			expect(candidates.length).toBeGreaterThan(0)
			const c = candidates[0]
			expect(c.provider).toBe('apple')
			expect(c.id).toMatch(/^apple-audiobook-\d+$/)
			expect(typeof c.title).toBe('string')
			expect(Array.isArray(c.authors)).toBe(true)
		})

		it('finds the book and a square mzstatic cover (warns on iTunes shape change)', () => {
			const hit = candidates.find((c) => c.title.toLowerCase().includes('project hail mary'))
			if (!hit) {
				console.warn('[APPLE SHAPE CHANGE] iTunes search returned no Project Hail Mary result')
			}
			const withCover = candidates.find((c) => c.cover)
			if (withCover && !withCover.cover?.includes('mzstatic')) {
				console.warn('[APPLE SHAPE CHANGE] cover is not an mzstatic URL')
			}
			expect(candidates.length).toBeGreaterThan(0)
		})
	})

	describe('fetchBook: narrator scrape from the Apple Books page JSON-LD', () => {
		let book: ProviderBook | null
		beforeAll(async () => {
			// "Project Hail Mary (Unabridged)" — a stable collectionId.
			book = await provider.fetchBook('1565808256', 'audiobook', { region: 'us' })
		}, 30000)

		it('returns the book with title + author', () => {
			expect(book).not.toBeNull()
			expect((book?.title ?? '').toLowerCase()).toContain('project hail mary')
			expect(book?.authors?.[0]?.name).toBeTruthy()
		})

		it('scrapes the narrator via readBy (warns if the JSON-LD changed)', () => {
			const narrator = book?.narrators?.[0]?.name
			if (!narrator) {
				console.warn(
					'[APPLE SHAPE CHANGE] readBy narrator not scraped from the Apple Books page JSON-LD'
				)
			}
			// The Search API still works without the scrape, so don't hard-fail.
			expect(book).not.toBeNull()
		})
	})
})

import LibriVoxProvider from '#helpers/providers/LibriVoxProvider'
import type { ProviderBook, ProviderCandidate } from '#helpers/providers/types'

// Live contract test: hits the real keyless LibriVox API. It asserts the shape
// our provider depends on and console.warns "[LIBRIVOX SHAPE CHANGE]" when a
// field we rely on disappears, without hard-failing on the soft parts — so drift
// is visible in CI long before users see bad matches. The shape our provider
// reads: books[] with id/title, authors[].first_name+last_name, totaltimesecs
// (0 meaning ABSENT), language as an English name, and — only under extended=1 —
// sections[].readers[].display_name. Run with `bun run test:live`.
describe('LibriVox provider (live)', () => {
	const provider = new LibriVoxProvider()

	describe('search: Pride and Prejudice', () => {
		let candidates: ProviderCandidate[]
		beforeAll(async () => {
			candidates = await provider.search({
				title: 'Pride and Prejudice',
				author: 'Jane Austen',
				region: 'us'
			})
		}, 30000)

		it('returns candidates in the expected shape', () => {
			expect(candidates.length).toBeGreaterThan(0)
			const c = candidates[0]
			expect(c.provider).toBe('librivox')
			expect(c.id).toMatch(/^librivox-\d+$/)
			expect(typeof c.title).toBe('string')
			expect(Array.isArray(c.authors)).toBe(true)
			// Public domain: no store listing, which is why this is a supplement.
			expect(c.asin).toBeNull()
		})

		it('carries a runtime and a joined author name (warns on shape change)', () => {
			const hit = candidates.find((c) => c.title.toLowerCase().includes('pride and prejudice'))
			if (!hit) {
				console.warn('[LIBRIVOX SHAPE CHANGE] search returned no Pride and Prejudice result')
				return
			}
			// first_name + last_name joined; losing either half silently halves the
			// author score on every candidate.
			if (!hit.authors.some((a) => a.toLowerCase().includes('austen'))) {
				console.warn('[LIBRIVOX SHAPE CHANGE] no Austen in authors[] -- name split changed?')
			}
			// totaltimesecs is what lets a LibriVox candidate be duration-corroborated.
			const withRuntime = candidates.find((c) => c.audioSeconds != null)
			if (!withRuntime) {
				console.warn('[LIBRIVOX SHAPE CHANGE] no candidate carried totaltimesecs')
			} else {
				expect(withRuntime.audioSeconds).toBeGreaterThan(0)
			}
			// "English" must still normalize to a code, or the language gate goes inert.
			if (hit.language !== null && hit.language !== 'en') {
				console.warn('[LIBRIVOX SHAPE CHANGE] language did not normalize to en:', hit.language)
			}
		})
	})

	describe('fetchBook: the reader cast', () => {
		let book: ProviderBook | null
		beforeAll(async () => {
			// 253 is the canonical Pride and Prejudice recording (13 readers live).
			book = await provider.fetchBook('253', 'book', { region: 'us' })
		}, 30000)

		it('resolves title, authors and the readers extended=1 supplies', () => {
			expect(book).not.toBeNull()
			expect(typeof book?.title).toBe('string')
			expect(Array.isArray(book?.authors)).toBe(true)
			expect(book?.asin).toBeNull()
			// The readers are the single reason fetchBook pays for extended=1.
			if (!book?.narrators?.length) {
				console.warn('[LIBRIVOX SHAPE CHANGE] fetchBook found no readers under sections[]')
			}
			// Descriptions are HTML upstream — assert it was flattened.
			if (book?.summary && /<[^>]+>/.test(book.summary)) {
				console.warn('[LIBRIVOX SHAPE CHANGE] description still contains HTML tags')
			}
		})
	})
})

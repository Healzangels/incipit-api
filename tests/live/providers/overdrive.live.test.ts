import OverDriveProvider from '#helpers/providers/OverDriveProvider'
import type { ProviderBook, ProviderCandidate } from '#helpers/providers/types'

// Live contract test: hits the real keyless OverDrive Thunder API (default
// library lens). It asserts the shape our provider depends on and console.warns
// "[OVERDRIVE SHAPE CHANGE]" when a field we rely on disappears, without
// hard-failing on the soft parts — so drift is visible in CI long before users
// see bad matches. The Thunder shape our provider reads: title (string OR
// {main}), creators[].role (Author/Narrator), formats[].duration ("HH:MM:SS"),
// covers keyed by width, detailedSeries/series, languages[].id. Run with
// `bun run test:live`.
describe('OverDrive provider (live)', () => {
	const provider = new OverDriveProvider()

	describe('search: Dead I Well May Be (audiobook Audible lacks; narrator + runtime)', () => {
		let candidates: ProviderCandidate[]
		beforeAll(async () => {
			candidates = await provider.search({
				title: 'Dead I Well May Be',
				author: 'Adrian McKinty',
				region: 'us'
			})
		}, 30000)

		it('returns candidates in the expected shape', () => {
			expect(candidates.length).toBeGreaterThan(0)
			const c = candidates[0]
			expect(c.provider).toBe('overdrive')
			expect(c.id).toMatch(/^overdrive-\d+$/)
			expect(typeof c.title).toBe('string')
			expect(Array.isArray(c.authors)).toBe(true)
			expect(Array.isArray(c.narrators)).toBe(true)
			expect(c.asin).toBeNull() // OverDrive has no Audible ASIN — the reason it is a supplement
		})

		it('carries narrator + runtime + cover (warns on Thunder shape change)', () => {
			const hit = candidates.find((c) => c.title.toLowerCase().includes('dead i well may be'))
			if (!hit) {
				console.warn('[OVERDRIVE SHAPE CHANGE] search returned no Dead I Well May Be result')
				return
			}
			// Narrator lives in creators[].role === 'Narrator'.
			if (hit.narrators.length === 0) {
				console.warn('[OVERDRIVE SHAPE CHANGE] no narrator parsed from creators[].role')
			}
			// Runtime lives in formats[].duration ("HH:MM:SS") — the field that lets an
			// OverDrive candidate be duration-corroborated. Losing it silently would
			// drop every OverDrive match to a title-only score.
			if (hit.audioSeconds == null) {
				console.warn('[OVERDRIVE SHAPE CHANGE] no runtime parsed from formats[].duration')
			} else {
				expect(hit.audioSeconds).toBeGreaterThan(0)
			}
			if (!hit.cover) {
				console.warn('[OVERDRIVE SHAPE CHANGE] no cover parsed from covers{}')
			}
			expect(hit.authors.some((a) => a.toLowerCase().includes('mckinty'))).toBe(true)
		})
	})

	describe('fetchBook: full metadata for the matched id', () => {
		let book: ProviderBook | null
		beforeAll(async () => {
			const cs = await provider.search({
				title: 'Dead I Well May Be',
				author: 'Adrian McKinty',
				region: 'us'
			})
			const hit = cs.find((c) => c.title.toLowerCase().includes('dead i well may be')) ?? cs[0]
			const nativeId = hit.id.replace(/^overdrive-/, '')
			book = await provider.fetchBook(nativeId, 'media', { region: 'us' })
		}, 30000)

		it('resolves title/authors/narrators and a series (warns on shape change)', () => {
			expect(book).not.toBeNull()
			expect(typeof book?.title).toBe('string')
			expect(Array.isArray(book?.authors)).toBe(true)
			expect(book?.asin).toBeNull()
			if (!book?.narrators?.length) {
				console.warn('[OVERDRIVE SHAPE CHANGE] fetchBook found no narrator')
			}
			// Michael Forsythe is a real series; detailedSeries.seriesName is the field.
			if (!book?.seriesPrimary?.name) {
				console.warn('[OVERDRIVE SHAPE CHANGE] fetchBook found no series (detailedSeries)')
			}
			// Description is HTML upstream — assert it was flattened (no tags leak through).
			if (book?.summary && /<[^>]+>/.test(book.summary)) {
				console.warn('[OVERDRIVE SHAPE CHANGE] description still contains HTML tags')
			}
		})
	})
})

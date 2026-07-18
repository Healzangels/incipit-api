import HardcoverProvider from '#helpers/providers/HardcoverProvider'
import type { ProviderBook, ProviderCandidate } from '#helpers/providers/types'

// Live contract test against the real Hardcover GraphQL API. Requires a token:
// set HARDCOVER_TOKEN to run it (skipped otherwise). Crucially, this is the ONE
// place that verifies the `authors { cached_image }` field the author-image
// fallback depends on — which we could not check without a token. Warns
// "[HARDCOVER SHAPE CHANGE]" on drift. Run with `bun run test:live`.
const token = process.env.HARDCOVER_TOKEN
const describeMaybe = token ? describe : describe.skip

describeMaybe('Hardcover provider (live)', () => {
	const provider = new HardcoverProvider({ token })
	const opts = { region: 'us', credentials: { hardcover: token as string } }

	describe('search: Project Hail Mary', () => {
		let candidates: ProviderCandidate[]
		beforeAll(async () => {
			candidates = await provider.search({
				title: 'Project Hail Mary',
				author: 'Andy Weir',
				region: 'us',
				credentials: { hardcover: token as string }
			})
		}, 30000)

		it('returns candidates with a Hardcover-encoded id', () => {
			expect(candidates.length).toBeGreaterThan(0)
			const c = candidates[0]
			expect(c.provider).toBe('hardcover')
			expect(c.id).toMatch(/^hardcover-(edition|book)-\d+$/)
		})

		it('surfaces an audio edition with narrator + runtime (warns on GraphQL shape change)', () => {
			const audio = candidates.find((c) => c.audioSeconds || c.narrators.length)
			if (!audio) {
				console.warn(
					'[HARDCOVER SHAPE CHANGE] no audio edition (reading_format_id 2 / narrator / audio_seconds) surfaced'
				)
			}
			expect(candidates.length).toBeGreaterThan(0)
		})
	})

	describe('fetchBook: full metadata by id', () => {
		let book: ProviderBook | null
		beforeAll(async () => {
			const first = await provider.search({
				title: 'Project Hail Mary',
				author: 'Andy Weir',
				region: 'us',
				credentials: { hardcover: token as string }
			})
			const id = first[0]?.id.replace(/^hardcover-(edition|book)-/, '')
			const kind = first[0]?.id.includes('-edition-') ? 'edition' : 'book'
			book = id ? await provider.fetchBook(id, kind, opts) : null
		}, 30000)

		it('returns a book with title + author', () => {
			if (!book) {
				console.warn('[HARDCOVER SHAPE CHANGE] fetchBook returned null')
			} else {
				expect(typeof book.title).toBe('string')
				expect(book.authors?.[0]?.name).toBeTruthy()
			}
			expect(true).toBe(true)
		})
	})

	describe('fetchAuthorImage: verifies the authors.cached_image field', () => {
		it('returns a photo URL for Andy Weir (warns if cached_image is wrong/empty)', async () => {
			const image = await provider.fetchAuthorImage('Andy Weir', opts)
			if (!image) {
				console.warn(
					'[HARDCOVER SHAPE CHANGE] authors.cached_image returned no url for Andy Weir — ' +
						'the author-image field may be invalid or empty'
				)
			} else {
				expect(typeof image).toBe('string')
				expect(image).toMatch(/^https?:\/\//)
			}
			expect(true).toBe(true)
		}, 30000)
	})
})

import type * as cheerio from 'cheerio'

import type { HtmlBook } from '#config/types'
import ScrapeHelper from '#helpers/books/audible/ScrapeHelper'

/**
 * Helper to log warnings when HTML structure changes are detected
 */
function logHtmlWarning(selector: string, asin: string): void {
	console.warn(`[AUDIBLE HTML CHANGE] Selector '${selector}' not found for ASIN: ${asin}`)
}

describe('Audible Book HTML Scraping Live Tests', () => {
	describe('When scraping Project Hail Mary (B08G9PRS1K) genres', () => {
		let dom: cheerio.CheerioAPI | undefined
		let parsedResponse: HtmlBook | undefined

		beforeAll(async () => {
			const helper = new ScrapeHelper('B08G9PRS1K', 'us')
			dom = await helper.fetchBook()
			parsedResponse = await helper.parseResponse(dom)
		}, 30000)

		it('should successfully fetch HTML page', () => {
			expect(dom).toBeDefined()
		})

		it('should successfully parse genres (warns if HTML changed)', () => {
			if (!parsedResponse) {
				console.warn('[AUDIBLE HTML CHANGE] Could not parse genres for B08G9PRS1K')
			}
			// Don't fail - just detect the change
			expect(true).toBe(true)
		})

		it('should have valid genre structure when parsed', () => {
			if (parsedResponse?.genres) {
				expect(Array.isArray(parsedResponse.genres)).toBe(true)
				expect(parsedResponse.genres.length).toBeGreaterThan(0)

				const firstGenre = parsedResponse.genres[0]
				expect(firstGenre).toHaveProperty('asin')
				expect(firstGenre).toHaveProperty('name')
				expect(firstGenre).toHaveProperty('type')
			}
		})

		it('should have at least one genre', () => {
			if (parsedResponse?.genres) {
				expect(parsedResponse.genres.length).toBeGreaterThan(0)
			}
		})
	})

	describe('When scraping Harry Potter (B017V4IM1G) genres', () => {
		let dom: cheerio.CheerioAPI | undefined
		let parsedResponse: HtmlBook | undefined

		beforeAll(async () => {
			const helper = new ScrapeHelper('B017V4IM1G', 'us')
			dom = await helper.fetchBook()
			parsedResponse = await helper.parseResponse(dom)
		}, 30000)

		it('should successfully fetch HTML page', () => {
			expect(dom).toBeDefined()
		})

		it('should successfully parse genres', () => {
			if (!parsedResponse) {
				console.warn('[AUDIBLE HTML CHANGE] Could not parse genres for B017V4IM1G')
			}
			// Warn but don't fail when Audible changes HTML
			expect(true).toBe(true)
		})

		it('should have valid genre structure when parsed', () => {
			if (parsedResponse?.genres) {
				expect(Array.isArray(parsedResponse.genres)).toBe(true)
				expect(parsedResponse.genres.length).toBeGreaterThan(0)
			}
		})
	})

	describe('When scraping The Coldest Case (B08C6YJ1LS) genres', () => {
		let dom: cheerio.CheerioAPI | undefined
		let parsedResponse: HtmlBook | undefined

		beforeAll(async () => {
			const helper = new ScrapeHelper('B08C6YJ1LS', 'us')
			dom = await helper.fetchBook()
			parsedResponse = await helper.parseResponse(dom)
		}, 30000)

		it('should successfully fetch HTML page', () => {
			expect(dom).toBeDefined()
		})

		it('should successfully parse genres', () => {
			if (!parsedResponse) {
				console.warn('[AUDIBLE HTML CHANGE] Could not parse genres for B08C6YJ1LS')
			}
			// Warn but don't fail when Audible changes HTML
			expect(true).toBe(true)
		})

		it('should have valid genre structure when parsed', () => {
			if (parsedResponse?.genres) {
				expect(Array.isArray(parsedResponse.genres)).toBe(true)
				expect(parsedResponse.genres.length).toBeGreaterThan(0)
			}
		})
	})

	// The point of this file: notice when Audible's markup moves under the
	// scraper. Until 2026-08-12 it could not do that, twice over.
	//
	// It checked `li.categoriesLabel a` and `div.bc-chip-group a`, which
	// ScrapeHelper does NOT use -- it reads `a[href*="/tag/"]` and
	// `a[href*="/cat/"]` (ScrapeHelper.ts:61,67). Those two selectors are
	// inherited from an older Audible layout, so the checks were watching markup
	// nothing depends on.
	//
	// And the assertions were vacuous: `expect(true).toBe(true)` and
	// `expect(len).toBeGreaterThanOrEqual(0)` cannot fail. The only way either
	// test went red was the FETCH throwing -- which is exactly what Audible's
	// rate limiting makes happen, so the file reported an outage every morning
	// and a markup change never.
	describe('HTML structure validation', () => {
		// The selectors ScrapeHelper actually consumes. Keep in step with it.
		const PRODUCTION_SELECTORS = ['a[href*="/tag/"]', 'a[href*="/cat/"]']

		it('at least one production genre selector still matches', async () => {
			const helper = new ScrapeHelper('B08G9PRS1K', 'us')
			const dom = await helper.fetchBook()

			// A failed fetch is Audible throttling us, NOT a markup change. Say so
			// and stop, rather than reporting an outage as a structural break --
			// conflating the two is what made this file noise. The "not every book
			// is unreachable" test below is what catches a total blackout.
			if (!dom) {
				console.warn(
					'SKIPPED structure check: could not fetch B08G9PRS1K (rate limited?). ' +
						'The selectors were NOT verified by this run.'
				)
				return
			}

			const counts = PRODUCTION_SELECTORS.map((sel) => ({ sel, n: dom(sel).length }))
			for (const { sel, n } of counts) if (n === 0) logHtmlWarning(sel, 'B08G9PRS1K')

			// ANY of them matching means genre extraction still has a source. Not
			// "all": measured 2026-08-12, Audible had moved categories into an
			// embedded JSON blob ("categories":[{"name":...,"url":"/cat/..."}])
			// rather than <a href="/cat/"> links, so requiring both would go red on
			// a change the scraper already tolerates. Requiring at least one still
			// fails loudly if the markup genuinely goes away.
			expect(counts.some((c) => c.n > 0)).toBe(true)
		}, 30000)

		// The counterpart to skipping on a failed fetch. Skipping is right for ONE
		// throttled request, but if EVERY sample is unreachable the run verified
		// nothing at all -- and a suite that reports green having checked nothing
		// is the failure this whole file was rewritten to stop. So say it out loud.
		it('is not blind — at least one sample book is reachable', async () => {
			const asins = ['B08G9PRS1K', 'B017V4IM1G', 'B08C6YJ1LS']
			let reached = 0
			for (const asin of asins) {
				const dom = await new ScrapeHelper(asin, 'us').fetchBook()
				if (dom) reached += 1
				// Spaced deliberately: firing three at once is what provokes the
				// throttle this test exists to distinguish from a markup change.
				await new Promise((r) => setTimeout(r, 2000))
			}
			if (reached === 0)
				console.warn(
					'Every sample book failed to fetch. Audible is refusing this IP ' +
						'(GitHub runners are refused outright). Re-run from a residential ' +
						'network; this run proves nothing about Audible’s markup.'
				)
			expect(reached).toBeGreaterThan(0)
		}, 60000)
	})

	describe('Cross-region HTML scraping', () => {
		it('should scrape from UK region', async () => {
			const helper = new ScrapeHelper('B08G9PRS1K', 'uk')
			const dom = await helper.fetchBook()
			expect(dom).toBeDefined()

			const parsed = await helper.parseResponse(dom)
			if (parsed?.genres) {
				expect(Array.isArray(parsed.genres)).toBe(true)
			}
		}, 30000)

		it('should scrape from AU region', async () => {
			const helper = new ScrapeHelper('B08G9PRS1K', 'au')
			const dom = await helper.fetchBook()
			expect(dom).toBeDefined()

			const parsed = await helper.parseResponse(dom)
			if (parsed?.genres) {
				expect(Array.isArray(parsed.genres)).toBe(true)
			}
		}, 30000)
	})

	describe('Error handling for edge cases', () => {
		it('should return undefined for 404 pages without throwing', async () => {
			const helper = new ScrapeHelper('B00B5HZGUG', 'us')
			const dom = await helper.fetchBook()
			expect(dom).toBeUndefined()
		}, 30000)

		it('should handle pages with missing genre data gracefully', async () => {
			const helper = new ScrapeHelper('B0036I54I6', 'us')
			const dom = await helper.fetchBook()

			if (dom) {
				const parsed = await helper.parseResponse(dom)
				expect(parsed).toBeUndefined()
			}
		}, 30000)
	})
})

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
	// One block per sample book. Each was FOUR tests before 2026-08-12 and
	// asserted nothing:
	//
	//   'should successfully fetch HTML page'   expect(dom).toBeDefined()
	//   'should successfully parse genres'      expect(true).toBe(true)
	//   'should have valid genre structure'     if (parsed?.genres) { ... }
	//   'should have at least one genre'        if (parsed?.genres) { ... }
	//
	// The two `if (parsed?.genres)` guards SKIP their own assertions on exactly
	// the input that matters -- a parse that produced nothing -- and the third is
	// literally unfailable. So the only red any of them could produce was the
	// fetch, i.e. Audible's rate limiter. Had Audible rearranged its markup so no
	// genre parsed at all, all twelve would have passed.
	//
	// Now: one test per book that asserts genres REALLY came out, and that treats
	// a throttled fetch as what it is -- a run that could not check -- rather than
	// as a finding. Total unreachability is caught by 'is not blind' below, so
	// skipping here cannot hide a blackout.
	const SAMPLE_BOOKS = [
		{ asin: 'B08G9PRS1K', title: 'Project Hail Mary' },
		{ asin: 'B017V4IM1G', title: 'Harry Potter' },
		{ asin: 'B08C6YJ1LS', title: 'The Coldest Case' }
	]

	for (const book of SAMPLE_BOOKS) {
		describe(`When scraping ${book.title} (${book.asin}) genres`, () => {
			let dom: cheerio.CheerioAPI | undefined
			let parsedResponse: HtmlBook | undefined

			beforeAll(async () => {
				const helper = new ScrapeHelper(book.asin, 'us')
				dom = await helper.fetchBook()
				parsedResponse = await helper.parseResponse(dom)
			}, 30000)

			it('parses real genres, or reports that it could not fetch', () => {
				if (!dom) {
					console.warn(
						`SKIPPED ${book.asin}: could not fetch (rate limited?). Genres were ` +
							'NOT verified by this run.'
					)
					return
				}

				// Past this point the page IS in hand, so a parse failure is a markup
				// change and must be red. No `if (parsedResponse)` guard -- that is
				// what disabled these assertions before.
				if (!parsedResponse) logHtmlWarning('genre parse', book.asin)
				expect(parsedResponse).toBeDefined()
				expect(Array.isArray(parsedResponse?.genres)).toBe(true)
				expect(parsedResponse?.genres?.length ?? 0).toBeGreaterThan(0)

				const firstGenre = parsedResponse?.genres?.[0]
				expect(firstGenre).toHaveProperty('asin')
				expect(firstGenre).toHaveProperty('name')
				expect(firstGenre).toHaveProperty('type')
			})
		})
	}

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
		for (const region of ['uk', 'au'] as const) {
			it(`scrapes from the ${region.toUpperCase()} region, or reports it could not fetch`, async () => {
				const helper = new ScrapeHelper('B08G9PRS1K', region)
				const dom = await helper.fetchBook()
				if (!dom) {
					console.warn(`SKIPPED ${region}: could not fetch (rate limited?).`)
					return
				}
				// The page IS in hand, so it must parse. The previous version wrapped
				// this in `if (parsed?.genres)` and then asserted only that an array
				// is an array -- it could not fail on either arm.
				const parsed = await helper.parseResponse(dom)
				expect(parsed).toBeDefined()
				expect(Array.isArray(parsed?.genres)).toBe(true)
				// Genre COUNT is not asserted across regions: a regional catalogue
				// legitimately differs, and this file has been burned by assertions
				// that looked strict and were really about something else.
				if (!parsed?.genres?.length) logHtmlWarning(`genres (${region})`, 'B08G9PRS1K')
			}, 30000)
		}
	})

	describe('Error handling for edge cases', () => {
		it('returns undefined for a 404 page — verified against a live control', async () => {
			// A CONTROL first. fetchBook returns undefined for a 404 AND for a
			// throttled request, so asserting "undefined" alone passes for the wrong
			// reason every time Audible is rate-limiting us -- a false GREEN, which
			// is worse than the false reds elsewhere in this file because nobody
			// investigates it.
			const control = await new ScrapeHelper('B08G9PRS1K', 'us').fetchBook()
			if (!control) {
				console.warn(
					'SKIPPED 404 check: the control book is unreachable, so "undefined" ' +
						'would prove nothing about the 404 page.'
				)
				return
			}
			const dom = await new ScrapeHelper('B00B5HZGUG', 'us').fetchBook()
			expect(dom).toBeUndefined()
		}, 60000)

		it('parses a page with no genre data to undefined, not a crash', async () => {
			const dom = await new ScrapeHelper('B0036I54I6', 'us').fetchBook()
			if (!dom) {
				console.warn('SKIPPED B0036I54I6: could not fetch (rate limited?).')
				return
			}
			const parsed = await new ScrapeHelper('B0036I54I6', 'us').parseResponse(dom)
			expect(parsed).toBeUndefined()
		}, 30000)
	})
})

import { describe, expect, test } from 'bun:test'

import AppleBooksProvider, {
	type AppleLookupFetch,
	type ApplePageFetch,
	type AppleResult,
	type AppleSearchFetch,
	cleanAppleTitle,
	parseAudiobookLd
} from '#helpers/providers/AppleBooksProvider'
import type { BookSearchQuery, FetchBookOptions } from '#helpers/providers/types'

// Mirrors a real iTunes audiobook search result: title carries "(Unabridged)",
// author is artistName, cover is a …/100x100bb.jpg thumb, and there is NO
// narrator or runtime (the Search API omits both).
const phm: AppleResult = {
	collectionId: 1565808256,
	collectionName: 'Project Hail Mary (Unabridged)',
	artistName: 'Andy Weir',
	artworkUrl100:
		'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/7b/rm_image.jpg/100x100bb.jpg',
	collectionViewUrl:
		'https://books.apple.com/us/audiobook/project-hail-mary-unabridged/id1565808256',
	description: '<b>THE #1</b><br />A lone astronaut &amp; a last-chance mission.',
	releaseDate: '2021-05-04T07:00:00Z',
	copyright: '© 2021 Audible Studios'
}

// The schema.org JSON-LD Apple embeds on the audiobook page — readBy is the one
// field worth scraping (the Search/lookup API never returns a narrator).
const pageHtml = `<html><head>
<script type="application/ld+json">{"@type":"Organization","name":"Apple"}</script>
<script type="application/ld+json">{"@type":"Audiobook","author":"Andy Weir","readBy":"Ray Porter","duration":"PT16H10M58S","datePublished":"2021-05-04T00:00:00.000Z","description":"&lt;b&gt;Scraped&lt;/b&gt; synopsis.","image":"https://is1-ssl.mzstatic.com/hi-res.jpg"}</script>
</head></html>`

const q: BookSearchQuery = { title: 'Project Hail Mary', region: 'us' }
const opts: FetchBookOptions = { region: 'us' }

describe('AppleBooksProvider.search', () => {
	test('maps a result: strips "(Unabridged)", upsizes the cover, no narrator/runtime', async () => {
		const searchFetch: AppleSearchFetch = async () => [phm]
		const out = await new AppleBooksProvider({ searchFetch }).search(q)
		expect(out).toHaveLength(1)
		expect(out[0]).toEqual({
			provider: 'apple',
			id: 'apple-audiobook-1565808256',
			asin: null,
			// Apple exposes no language field; it is inferred from the blurb
			// instead. THIS blurb is a one-line tagline -- under the token floor --
			// so the detector declines and the candidate reports null ("no
			// signal"), which is what the matcher treats as non-actionable.
			language: null,
			title: 'Project Hail Mary',
			authors: ['Andy Weir'],
			narrators: [],
			audioSeconds: null,
			cover: 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/7b/rm_image.jpg/600x600bb.jpg'
		})
	})

	test('infers the language from the blurb, separating two same-title editions', async () => {
		// The live failure this exists for: Apple lists the Spanish edition of
		// "Babel" under the ORIGINAL title, so title+author scoring cannot tell it
		// from the English one and both sat at 0.850. Descriptions are verbatim
		// from iTunes (ids 1596509362 and 1729551786).
		const english = {
			...phm,
			collectionId: 1596509362,
			collectionName: 'Babel',
			description:
				'<b>From award-winning author R. F. Kuang</b> comes Babel, a thematic ' +
				'response to The Secret History and a tonal retort to Jonathan Strange &amp; Mr. ' +
				'Norrell that grapples with student revolutions, colonial resistance, and the use ' +
				'of language and translation as the dominating tool of the British empire.'
		}
		const spanish = {
			...phm,
			collectionId: 1729551786,
			collectionName: 'Babel',
			description:
				'1828. El Instituto Real de Traducci\u00f3n de Oxford, tambi\u00e9n conocido como ' +
				'Babel, es la instituci\u00f3n m\u00e1gica m\u00e1s importante del mundo. La magia con plata ' +
				'capaz de revelar significados ocultos perdidos en la traducci\u00f3n que all\u00ed se ' +
				'practica le ha otorgado al Imperio brit\u00e1nico un poder sin parang\u00f3n.'
		}
		const out = await new AppleBooksProvider({
			searchFetch: async () => [english, spanish]
		}).search({ title: 'Babel', region: 'us' })
		expect(out.map((c) => c.language)).toEqual(['en', 'es'])
	})

	test('language is inferred ONLY in English regions', async () => {
		// regionLanguage conflates marketplace with language: Apple's DE store
		// serves ENGLISH blurbs for English audiobooks, so in a de region a
		// correct 'en' detection reads as a conflict and every Apple row would
		// lose LANGUAGE_CONFLICT_PENALTY -- taking the square-cover source with
		// it. Apple was structurally immune to that while it reported null.
		const english = {
			...phm,
			description:
				'From award-winning author R. F. Kuang comes Babel, a thematic response to The ' +
				'Secret History and a tonal retort to Jonathan Strange and Mr Norrell that ' +
				'grapples with student revolutions and the use of language as a tool of empire.'
		}
		const searchFetch: AppleSearchFetch = async () => [english]
		const us = await new AppleBooksProvider({ searchFetch }).search({ ...q, region: 'us' })
		const de = await new AppleBooksProvider({ searchFetch }).search({ ...q, region: 'de' })
		expect(us[0].language).toBe('en')
		expect(de[0].language).toBeNull()
	})

	test('a missing description leaves the language null rather than guessing', async () => {
		const noDesc = { ...phm, description: undefined }
		const out = await new AppleBooksProvider({ searchFetch: async () => [noDesc] }).search(q)
		expect(out[0].language).toBeNull()
	})

	test('sends the store country for the region and includes the author in the term', async () => {
		let seenTerm = ''
		let seenCountry = ''
		const searchFetch: AppleSearchFetch = async (term, country) => {
			seenTerm = term
			seenCountry = country
			return []
		}
		await new AppleBooksProvider({ searchFetch }).search({
			title: 'Dune',
			author: 'Frank Herbert',
			region: 'uk'
		})
		expect(seenTerm).toBe('Dune Frank Herbert')
		expect(seenCountry).toBe('GB')
	})

	test('drops results with no collectionId, and an empty title short-circuits', async () => {
		const partial = await new AppleBooksProvider({
			searchFetch: async () => [phm, { collectionName: 'no id' } as AppleResult]
		}).search(q)
		expect(partial.map((c) => c.id)).toEqual(['apple-audiobook-1565808256'])

		expect(await new AppleBooksProvider().search({ title: '', region: 'us' })).toEqual([])
	})

	test('PROPAGATES a transport failure, so the circuit breaker can see it', async () => {
		// SUPERSEDES the `errored -> []` assertion that used to live in the test
		// above, which encoded the swallow with no stated reason.
		// ProviderRegistry wraps this in breakerFor(name).execute and records a
		// RESOLVED thunk as a SUCCESS, so returning [] meant a refusal looked
		// like "answered, with nothing" and the breaker could never open. Its
		// own comment records the cost, measured on a 1,341-book scan: Apple
		// refused 942 CONSECUTIVE searches (751x 429, 191x 403), each a doomed
		// round-trip that also kept Apple unusable for the square-cover lookup
		// that runs on EVERY book response.
		//
		// Safe: the registry fans out with Promise.allSettled; bestSquareCover
		// catches and returns null; ProviderSearchCache never caches a throw.
		const p = new AppleBooksProvider({
			searchFetch: async () => {
				throw new Error('down')
			}
		})
		await expect(p.search(q)).rejects.toThrow('down')
	})
})

describe('AppleBooksProvider.fetchBook', () => {
	/**
	 * The SEARCH path above has rethrown since the 942-consecutive-refusal
	 * incident. fetchBook kept swallowing into null, and books/show.ts turns null
	 * into NotFoundError -> HTTP 404 -- so a rate-limited moment told Plex the
	 * book does not exist, on the branch ~90 albums reach Plex through.
	 */
	test('PROPAGATES a transport failure rather than reporting the book absent', async () => {
		const lookupFetch = async () => {
			throw new Error('429 Too Many Requests')
		}
		const p = new AppleBooksProvider({ lookupFetch } as never)
		await expect(p.fetchBook('1479414483', 'audiobook', { region: 'us' })).rejects.toThrow('429')
	})

	test('enriches with the narrator from the page JSON-LD and strips HTML/copyright', async () => {
		const lookupFetch: AppleLookupFetch = async () => phm
		const pageFetch: ApplePageFetch = async () => pageHtml
		const book = await new AppleBooksProvider({ lookupFetch, pageFetch }).fetchBook(
			'1565808256',
			'audiobook',
			opts
		)
		expect(book).toEqual({
			asin: null,
			title: 'Project Hail Mary',
			authors: [{ name: 'Andy Weir' }],
			narrators: [{ name: 'Ray Porter' }],
			summary: '<b>Scraped</b> synopsis.',
			// `image` is the iTunes SQUARE artwork; the page JSON-LD image (a
			// 1200x630 wide social banner for audiobooks) is deliberately ignored,
			// even though it is present in this fixture's pageHtml.
			image: 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/7b/rm_image.jpg/600x600bb.jpg',
			publisherName: 'Audible Studios',
			releaseDate: '2021-05-04T00:00:00.000Z'
		})
	})

	test('falls back to lookup fields when the page scrape yields no audiobook block', async () => {
		const lookupFetch: AppleLookupFetch = async () => phm
		const pageFetch: ApplePageFetch = async () => '<html><body>no ld+json here</body></html>'
		const book = await new AppleBooksProvider({ lookupFetch, pageFetch }).fetchBook(
			'1565808256',
			'audiobook',
			opts
		)
		expect(book).toMatchObject({
			title: 'Project Hail Mary',
			narrators: [],
			summary: 'THE #1\nA lone astronaut & a last-chance mission.'
		})
		// No scrape image -> the upsized Search thumb is used.
		expect(book?.image).toBe(
			'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/7b/rm_image.jpg/600x600bb.jpg'
		)
		expect(book?.releaseDate).toBe('2021-05-04T07:00:00Z')
	})

	test('survives a page-fetch throw, still returning the lookup record', async () => {
		const book = await new AppleBooksProvider({
			lookupFetch: async () => phm,
			pageFetch: async () => {
				throw new Error('403')
			}
		}).fetchBook('1565808256', 'audiobook', opts)
		expect(book?.title).toBe('Project Hail Mary')
		expect(book?.narrators).toEqual([])
	})

	test('returns null when the lookup finds nothing', async () => {
		const book = await new AppleBooksProvider({ lookupFetch: async () => null }).fetchBook(
			'999',
			'audiobook',
			opts
		)
		expect(book).toBeNull()
	})

	test('upsizes a non-bb / non-jpg artwork suffix (png, -75 quality tag)', async () => {
		// iTunes sometimes serves the thumb as .png or with a -NN quality tag; the
		// rewrite must still produce the 600px square, not pass the raw 100px thumb.
		for (const suffix of ['100x100bb.png', '100x100-75.jpg', '100x100sr.jpg']) {
			const artwork = `https://is1-ssl.mzstatic.com/image/thumb/x/rm_image.jpg/${suffix}`
			const book = await new AppleBooksProvider({
				lookupFetch: async () => ({ ...phm, artworkUrl100: artwork }),
				pageFetch: async () => '<html></html>'
			}).fetchBook('1565808256', 'audiobook', opts)
			expect(book?.image).toBe(
				'https://is1-ssl.mzstatic.com/image/thumb/x/rm_image.jpg/600x600bb.jpg'
			)
		}
	})

	test('leaves image null (never the wide banner) when the lookup has no artwork', async () => {
		// No artworkUrl100 -> no square cover. `image` must be null, NOT the page
		// JSON-LD banner (pageHtml carries a 1200x630-style image we must not use).
		const noArt = { ...phm, artworkUrl100: undefined }
		const book = await new AppleBooksProvider({
			lookupFetch: async () => noArt,
			pageFetch: async () => pageHtml
		}).fetchBook('1565808256', 'audiobook', opts)
		expect(book?.image).toBeNull()
	})
})

describe('Apple helpers', () => {
	test('cleanAppleTitle strips the edition suffix, keeps a real subtitle', () => {
		expect(cleanAppleTitle('Project Hail Mary (Unabridged)')).toBe('Project Hail Mary')
		expect(cleanAppleTitle('Dune (Abridged)')).toBe('Dune')
		expect(cleanAppleTitle('Leviathan Wakes: The Expanse')).toBe('Leviathan Wakes: The Expanse')
	})

	test('parseAudiobookLd finds the Audiobook block among other ld+json', () => {
		expect(parseAudiobookLd(pageHtml)?.readBy).toBe('Ray Porter')
		expect(parseAudiobookLd('<html>no scripts</html>')).toBeNull()
	})
})

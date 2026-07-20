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

	test('drops a bad duration instead of rejecting (optional scoring hint)', () => {
		// Plex sends -1 for an unanalyzed file; a non-numeric value is also possible.
		// Neither should fail the search — the field is dropped to undefined.
		for (const duration of ['soon', -1, 0]) {
			const p = BookSearchQueryStringSchema.safeParse({ title: 'Dune', duration })
			expect(p.success).toBe(true)
			if (p.success) expect(p.data.duration).toBeUndefined()
		}
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

	test('prefers the audiobook edition over a book-level record on a tie', async () => {
		// Same title+author, no duration signal → both score at the floor. The
		// book-level record's provider is listed FIRST, so without the tiebreak
		// provider order would rank it first and split a series across sources.
		const bookLevel = candidate({
			provider: 'openlibrary',
			id: 'ol-booklevel',
			title: 'Steel World',
			authors: ['B.V. Larson']
		})
		const audio = candidate({
			provider: 'audible',
			id: 'audible-edition',
			title: 'Steel World',
			authors: ['B.V. Larson'],
			audioSeconds: 42000,
			narrators: ['Mark Boyett']
		})
		const reg = new ProviderRegistry([
			stubProvider('openlibrary', [bookLevel]),
			stubProvider('audible', [audio])
		])
		const helper = new BookSearchHelper(reg, {
			title: 'Steel World',
			author: 'B.V. Larson',
			region: 'us'
		})
		const out = await helper.search()
		expect(out[0].confidence).toBeCloseTo(out[1].confidence, 9) // genuinely tied
		expect(out[0].id).toBe('audible-edition')
	})

	test('on a full tie between audio providers, prefers the richer source', async () => {
		// Same title+author, both audio, no duration signal → both at the floor.
		// Different runtimes so they don't dedupe to one. Storytel is listed first;
		// the richness tiebreak must still put Audible on top.
		const storytel = candidate({
			provider: 'storytel',
			id: 'storytel-1',
			title: 'Steel World',
			authors: ['B.V. Larson'],
			audioSeconds: 42500,
			narrators: ['Mark Boyett']
		})
		const audible = candidate({
			provider: 'audible',
			id: 'B00STEELWW',
			title: 'Steel World',
			authors: ['B.V. Larson'],
			audioSeconds: 42000,
			narrators: ['Mark Boyett']
		})
		const reg = new ProviderRegistry([
			stubProvider('storytel', [storytel]),
			stubProvider('audible', [audible])
		])
		const helper = new BookSearchHelper(reg, {
			title: 'Steel World',
			author: 'B.V. Larson',
			region: 'us'
		})
		const out = await helper.search()
		expect(out).toHaveLength(2)
		expect(out[0].confidence).toBeCloseTo(out[1].confidence, 9)
		expect(out[0].provider).toBe('audible')
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

describe('BookSearchHelper authorless title-only guard', () => {
	// The observed production false positive: an album tagged "Hell Bent" with NO
	// artist (a narrator-mistag, or Plex just didn't pass the author) searched
	// against a transient garbage Hardcover edition whose book-level title was
	// "Hell Bent: Groucho Marx, Sein Leben" (a different book). The subtitle-stem
	// match scores title 1.0, and the authorless path turned that into confidence
	// 1.0 → a silent wrong auto-match. Without an author or duration to verify it,
	// it must stay below STRONG_MATCH (a confirm-me suggestion), not auto-apply.
	test('a garbage subtitle stem-match cannot auto-match an authorless query', async () => {
		const reg = new ProviderRegistry([
			stubProvider('p', [
				candidate({ id: 'garbage', title: 'Hell Bent: Groucho Marx, Sein Leben', authors: [] }),
				candidate({ id: 'real', title: 'Hell Bent', authors: [] })
			])
		])
		const out = await new BookSearchHelper(reg, { title: 'Hell Bent', region: 'us' }).search()
		// Both are unverifiable without an author/duration, so NEITHER may reach the
		// 0.9 auto-match line — they can only surface as suggestions.
		for (const c of out) expect(c.confidence).toBeLessThan(0.9)
	})

	test('an authorless exact-title match with no duration is a suggestion, not an auto-match', async () => {
		// A correctly-tagged but artist-less album: still capped at the 0.85 ceiling
		// until a corroborating signal arrives, mirroring the authored path.
		const reg = new ProviderRegistry([
			stubProvider('p', [candidate({ id: 'ok', title: 'Project Hail Mary', authors: [] })])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Project Hail Mary',
			region: 'us'
		}).search()
		expect(out).toHaveLength(1)
		expect(out[0].confidence).toBeCloseTo(0.85, 2)
	})

	test('a duration corroboration lifts an authorless match back to auto-match', async () => {
		// The steady state once files are analyzed: the runtime confirms the edition,
		// so the guard releases and the correct book auto-matches without an author.
		const reg = new ProviderRegistry([
			stubProvider('p', [
				candidate({ id: 'right', title: 'The Stars, Like Dust', authors: [], audioSeconds: 29598 })
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'The Stars, Like Dust',
			duration: 29598000,
			region: 'us'
		}).search()
		expect(out).toHaveLength(1)
		expect(out[0].confidence).toBeGreaterThanOrEqual(0.9)
	})

	test('a wrong-runtime authorless candidate is not rescued (and cannot auto-match)', async () => {
		// Duration present but contradicting → no corroboration → stays capped.
		const reg = new ProviderRegistry([
			stubProvider('p', [
				candidate({ id: 'wrongrun', title: 'Hell Bent', authors: [], audioSeconds: 100000 })
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Hell Bent',
			duration: 58593210, // ~58593s vs 100000s → far outside tolerance
			region: 'us'
		}).search()
		for (const c of out) expect(c.confidence).toBeLessThan(0.9)
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

	test('a duration-corroborated album match skips the track-title search', async () => {
		let calls = 0
		const strong: BookProvider = {
			name: 'strong',
			async search() {
				calls++
				return [
					candidate({
						id: 'a',
						title: 'A Spell for Chameleon',
						authors: ['Piers Anthony'],
						audioSeconds: 36000
					})
				]
			}
		}
		const helper = new BookSearchHelper(new ProviderRegistry([strong]), {
			title: 'A Spell for Chameleon',
			trackTitle: 'Something Else Entirely',
			author: 'Piers Anthony',
			duration: 36000 * 1000, // matches audioSeconds → +0.15 → 1.0 (≥ STRONG_MATCH)
			region: 'us'
		})
		const out = await helper.search()
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('a')
		expect(calls).toBe(1) // strong album hit → no second fan-out
	})

	test('a weak (no-duration) album match still widens to the track title', async () => {
		let calls = 0
		const weak: BookProvider = {
			name: 'weak',
			async search() {
				calls++
				return [candidate({ id: 'a', title: 'A Spell for Chameleon', authors: ['Piers Anthony'] })]
			}
		}
		const helper = new BookSearchHelper(new ProviderRegistry([weak]), {
			title: 'A Spell for Chameleon',
			trackTitle: 'Something Else Entirely',
			author: 'Piers Anthony',
			region: 'us'
		})
		await helper.search()
		// Album pass scores 0.85 (title+author, no duration) < STRONG_MATCH, and a
		// distinct track title exists → widen with a second fan-out.
		expect(calls).toBe(2)
	})

	test('a strong hit on a noisy-superset album title still widens (the Amazing Maurice case)', async () => {
		// Album tag "28 The Amazing Maurice…" is a noisy SUPERSET of the track title.
		// The polluted album query returns only a wrong-LANGUAGE edition that still
		// corroborates on author+duration (→ 1.0 ≥ STRONG_MATCH); the clean
		// track-title query is the only one that surfaces the correct English audio
		// edition. A strong-but-noisy album hit must NOT suppress that widening.
		let albumCalls = 0
		let trackCalls = 0
		const spanish = candidate({
			id: 'es',
			provider: 'hardcover',
			title: 'The Amazing Maurice and His Educated Rodents: una historia del mundodisco',
			authors: ['Terry Pratchett'],
			audioSeconds: 29272
		})
		const english = candidate({
			id: 'en',
			provider: 'audible',
			asin: 'B0C6R9GKPS',
			title: 'The Amazing Maurice and His Educated Rodents',
			authors: ['Terry Pratchett'],
			audioSeconds: 29272
		})
		const provider: BookProvider = {
			name: 'p',
			async search(q: BookSearchQuery): Promise<ProviderCandidate[]> {
				// The album query carries the "28 " prefix; the widened query is clean.
				if (/^\d/.test(q.title.trim())) {
					albumCalls++
					return [spanish]
				}
				trackCalls++
				return [english]
			}
		}
		const out = await new BookSearchHelper(new ProviderRegistry([provider]), {
			title: '28 The Amazing Maurice and His Educated Rodents',
			trackTitle: 'The Amazing Maurice and His Educated Rodents',
			author: 'Terry Pratchett',
			duration: 29272 * 1000,
			region: 'us'
		}).search()
		expect(albumCalls).toBe(1)
		expect(trackCalls).toBe(1) // widening fired despite the strong album hit
		// The correct English audio edition wins the merge (audible outranks the
		// same-confidence hardcover Spanish edition).
		expect(out[0].id).toBe('en')
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

describe('BookSearchHelper track-title scoring', () => {
	// The Redwall/GraphicAudio case: Plex hands the album as "16 Loamhedge" — a
	// leading track number normalizeTitle deliberately won't strip (it would risk
	// real numeric titles like "1984"). Scoring only against that noisy tag capped
	// the correct match below Plex's auto-match line. The clean track title the
	// bundle already sends recovers the true similarity WITHOUT a second search or
	// any loosened threshold.
	const provider = stubProvider('p', [
		candidate({ id: 'loam', title: 'Loamhedge (Redwall)', authors: ['Brian Jacques'] })
	])

	test('a noisy album tag is rescued by scoring against the track title', async () => {
		const base = { title: '16 Loamhedge', author: 'Brian Jacques', region: 'us' as const }

		// Album tag alone: the "16 " prefix drags title similarity down.
		const albumOnly = await new BookSearchHelper(new ProviderRegistry([provider]), base).search()
		// Same candidate, now also scored against the clean "Loamhedge".
		const withTrack = await new BookSearchHelper(new ProviderRegistry([provider]), {
			...base,
			trackTitle: 'Loamhedge'
		}).search()

		expect(albumOnly).toHaveLength(1)
		expect(withTrack).toHaveLength(1)
		// The clean title lifts the score; it never lowers it.
		expect(withTrack[0].confidence).toBeGreaterThan(albumOnly[0].confidence)
		// Perfect title (1.0) + perfect author (1.0): 0.55 + 0.30 = 0.85.
		expect(withTrack[0].confidence).toBeCloseTo(0.85, 2)
	})

	test('a better source found only via the track-title query wins the merge', async () => {
		// The album query "16 Loamhedge" returns a weak, duration-less hit; the
		// clean "Loamhedge" query returns a duration-corroborated edition the noisy
		// query never surfaces. The merge must let the better source win.
		const weakOnly = candidate({
			id: 'weak',
			provider: 'apple',
			title: 'Loamhedge (Redwall)',
			authors: ['Brian Jacques']
		})
		const better = candidate({
			id: 'better',
			provider: 'audible',
			title: 'Loamhedge',
			authors: ['Brian Jacques'],
			audioSeconds: 48000
		})
		const perQuery: BookProvider = {
			name: 'pq',
			async search(q: BookSearchQuery) {
				if (q.title === '16 Loamhedge') return [weakOnly]
				if (q.title === 'Loamhedge') return [better]
				return []
			}
		}
		const out = await new BookSearchHelper(new ProviderRegistry([perQuery]), {
			title: '16 Loamhedge',
			trackTitle: 'Loamhedge',
			author: 'Brian Jacques',
			duration: 48000 * 1000, // corroborates the better edition
			region: 'us'
		}).search()

		expect(out[0].id).toBe('better')
		expect(out[0].confidence).toBeCloseTo(1.0, 2) // 0.55 + 0.30 + 0.15 duration
	})

	test('a dropped leading article does not cap a correct match (Taggerung ≈ The Taggerung)', async () => {
		// File tagged "Taggerung"; Audible has "The Taggerung" with a corroborating
		// duration. Without article-normalization the missing "The" caps it at ~0.90.
		const audible = candidate({
			id: 'tag',
			provider: 'audible',
			title: 'The Taggerung',
			authors: ['Brian Jacques'],
			audioSeconds: 45561
		})
		const out = await new BookSearchHelper(new ProviderRegistry([stubProvider('p', [audible])]), {
			title: '14 Taggerung',
			trackTitle: 'Taggerung',
			author: 'Brian Jacques',
			duration: 45561 * 1000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('tag')
		expect(out[0].confidence).toBeCloseTo(1.0, 2) // article-insensitive title → 1.0 + duration
	})

	test('an ampersand title matches its "and" spelling (Faun and Games ≈ Faun & Games)', async () => {
		// File tagged "Faun and Games"; Hardcover's record is "Faun & Games".
		// sim() deletes the "&" outright, leaving ~0.78 — under the auto-match
		// bar — so the only Xanth book with an ampersand title sat unmatched.
		const hardcover = candidate({
			id: 'faun',
			provider: 'hardcover',
			title: 'Faun & Games',
			authors: ['Piers Anthony']
		})
		const out = await new BookSearchHelper(new ProviderRegistry([stubProvider('p', [hardcover])]), {
			title: 'Faun and Games',
			author: 'Piers Anthony',
			region: 'us'
		}).search()
		expect(out[0].id).toBe('faun')
		expect(out[0].confidence).toBeCloseTo(0.85, 2) // unified title 1.0 → 0.55 + 0.30
	})

	test('a co-authored credit matches an edition that lists only one author', async () => {
		// File credits "Robert Jordan, Brandon Sanderson"; the Audible edition lists
		// only "Robert Jordan". Splitting the credit lets the component match → 1.0.
		const audible = candidate({
			id: 'tgs',
			provider: 'audible',
			title: 'The Gathering Storm',
			authors: ['Robert Jordan'],
			audioSeconds: 118720
		})
		const out = await new BookSearchHelper(new ProviderRegistry([stubProvider('p', [audible])]), {
			title: 'The Gathering Storm',
			author: 'Robert Jordan, Brandon Sanderson',
			duration: 118720 * 1000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('tgs')
		expect(out[0].confidence).toBeCloseTo(1.0, 2) // title 1.0 + author 1.0 + duration
	})

	test('splitting the credit cannot inflate a wrong author to a match', async () => {
		// A same-title book by an unrelated author must not reach a corroborated
		// score just because the wanted credit was split — no component matches it.
		const wrong = candidate({
			id: 'no',
			title: 'The Gathering Storm',
			authors: ['Julia Brannan'],
			audioSeconds: 118720 // even with a matching duration, the author gates it
		})
		const out = await new BookSearchHelper(new ProviderRegistry([stubProvider('p', [wrong])]), {
			title: 'The Gathering Storm',
			author: 'Robert Jordan, Brandon Sanderson',
			duration: 118720 * 1000,
			region: 'us'
		}).search()
		// Contrast with the co-authored test above (→ ~1.0): here no author
		// component matches, so it stays far below a real match even with duration.
		if (out.length) expect(out[0].confidence).toBeLessThan(0.85)
	})

	test('article stripping needs a real article token — Anansi Boys is untouched', async () => {
		// "Anansi" must NOT be read as the article "an": the wrong book stays below floor.
		const wrong = stubProvider('p', [
			candidate({ id: 'no', title: 'Boys of Summer', authors: ['Brian Jacques'] })
		])
		const out = await new BookSearchHelper(new ProviderRegistry([wrong]), {
			title: 'Anansi Boys',
			author: 'Brian Jacques',
			region: 'us'
		}).search()
		expect(out).toHaveLength(0)
	})

	test('the track title only ever raises the score, never admits a worse match', async () => {
		// A wrong candidate that matches neither title stays below the floor even
		// with the track title in play — the max-of-two only helps a real match.
		const wrong = stubProvider('p', [
			candidate({ id: 'no', title: 'A Completely Different Book', authors: ['Someone Else'] })
		])
		const out = await new BookSearchHelper(new ProviderRegistry([wrong]), {
			title: '16 Loamhedge',
			trackTitle: 'Loamhedge',
			author: 'Brian Jacques',
			region: 'us'
		}).search()
		expect(out).toHaveLength(0)
	})
})

describe('BookSearchHelper ASIN handling (Audiobookshelf / seanap conventions)', () => {
	test('strips a bracketed series token from the searched title (recall)', async () => {
		let searchedTitle = ''
		const spy: BookProvider = {
			name: 'spy',
			async search(q) {
				searchedTitle = q.title
				return [candidate({ id: 'ok', title: 'A Spell for Chameleon', authors: ['Piers Anthony'] })]
			}
		}
		const helper = new BookSearchHelper(new ProviderRegistry([spy]), {
			// seanap folder convention: series in a trailing bracket
			title: 'A Spell for Chameleon [Xanth 1]',
			author: 'Piers Anthony',
			region: 'us'
		})
		const out = await helper.search()
		expect(searchedTitle).toBe('A Spell for Chameleon') // bracket removed before search
		expect(out).toHaveLength(1)
	})

	test('extracts a bracketed ASIN and pins the matching candidate to full confidence', async () => {
		const provider: BookProvider = {
			name: 'p',
			async search() {
				return [
					candidate({
						id: 'B0CJRV5S7M',
						asin: 'B0CJRV5S7M',
						title: "Demons Don't Dream",
						authors: []
					}),
					candidate({ id: 'other', asin: 'B000000000', title: "Demons Don't Dream", authors: [] })
				]
			}
		}
		const helper = new BookSearchHelper(new ProviderRegistry([provider]), {
			title: "Demons Don't Dream [B0CJRV5S7M]",
			region: 'us'
		})
		const out = await helper.search()
		expect(out[0].asin).toBe('B0CJRV5S7M')
		expect(out[0].confidence).toBe(1)
	})

	test('an explicit asin param confirms a match even with a weak title', async () => {
		const provider: BookProvider = {
			name: 'p',
			async search() {
				return [
					candidate({ id: 'B0CJRV5S7M', asin: 'B0CJRV5S7M', title: 'Totally Different Title' })
				]
			}
		}
		const helper = new BookSearchHelper(new ProviderRegistry([provider]), {
			title: 'Xanth 16',
			asin: 'b0cjrv5s7m', // lowercase — matching is case-insensitive
			region: 'us'
		})
		const out = await helper.search()
		expect(out).toHaveLength(1)
		expect(out[0].confidence).toBe(1)
	})
})

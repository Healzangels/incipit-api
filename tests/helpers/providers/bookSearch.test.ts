import { describe, expect, test } from 'bun:test'

import { BookSearchQueryStringSchema } from '#config/types'
import { CONFIDENCE_FLOOR } from '#helpers/providers/matchScorer'
import ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { BookProvider, BookSearchQuery, ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper, { titleExtendsQuery } from '#helpers/routes/BookSearchHelper'

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

	test("an authorless exact-title match with no duration stays under PLEX'S auto-apply bar", async () => {
		// A correctly-tagged but artist-less album: capped until a corroborating
		// signal arrives. The cap sits at 0.79 -- one point UNDER Plex's own
		// auto-apply threshold of 80 -- because the old 0.85 still cleared it:
		// measured live 2026-07-26, five tagless mis-named files ("Manna from
		// Heaven (1..5).m4b", ~96 hours of audio) each auto-applied to the real
		// 5-hour short-story collection at 85, with no author and no duration to
		// contradict anything. A wholly-unverified match may only ever be a
		// suggestion; session telemetry showed the ONLY automatic authorless
		// matches were exactly this junk class.
		const reg = new ProviderRegistry([
			stubProvider('p', [candidate({ id: 'ok', title: 'Project Hail Mary', authors: [] })])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Project Hail Mary',
			region: 'us'
		}).search()
		expect(out).toHaveLength(1)
		expect(out[0].confidence).toBeCloseTo(0.79, 2)
		// The invariant that matters, stated directly: rounds below 80.
		expect(Math.round(out[0].confidence * 100)).toBeLessThan(80)
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

describe('bundle and foreign-edition demotion', () => {
	// Measured on a 1341-book scan: a bundle carries the queried title as a
	// substring, so it scores like the single book it contains. "Siege of
	// Darkness" matched "Legacy of the Drow Gift Set" at 0.66, and "Leviathan
	// Wakes" matched "Expanse Box Set Books 1-3" at 1.0 because a stale sidecar
	// ASIN pinned it there.
	const corey = (title: string, asin: string | null = null) =>
		candidate({ id: asin ?? title, asin, title, authors: ['James S.A. Corey'] })

	test('a box set loses to the single book it contains', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [corey('Expanse Box Set Books 1-3'), corey('Leviathan Wakes')])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Leviathan Wakes',
			author: 'James S.A. Corey',
			region: 'us'
		}).search()
		expect(out[0].title).toBe('Leviathan Wakes')
	})

	test('a PINNED box set still loses -- a bundle is not the single book', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				corey('Expanse Box Set Books 1-3', 'B00BOXSET1'),
				corey('Leviathan Wakes')
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Leviathan Wakes',
			author: 'James S.A. Corey',
			region: 'us',
			asin: 'B00BOXSET1'
		}).search()
		expect(out[0].title).toBe('Leviathan Wakes')
	})

	test('a bundle is still findable when the query asks for one', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				candidate({
					id: 'au',
					title: 'Arcanum Unbounded: The Cosmere Collection',
					authors: ['Brandon Sanderson']
				})
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Arcanum Unbounded: The Cosmere Collection',
			author: 'Brandon Sanderson',
			region: 'us'
		}).search()
		expect(out.length).toBeGreaterThan(0)
		expect(out[0].title).toContain('Arcanum Unbounded')
	})

	test('a title-marked foreign edition loses even with a null language field', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				candidate({
					id: 'es',
					title: 'Everfound (Spanish Edition)',
					authors: ['Neal Shusterman'],
					language: null
				}),
				candidate({ id: 'en', title: 'Everfound', authors: ['Neal Shusterman'], language: null })
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Everfound',
			author: 'Neal Shusterman',
			region: 'us'
		}).search()
		expect(out[0].title).toBe('Everfound')
	})
})

describe('provider circuit breaker', () => {
	// Measured on a 1341-book scan: Apple rate-limited us six minutes in, then
	// refused 942 consecutive searches (751x 429, 191x 403). Every one was a
	// doomed round-trip that also kept Apple unusable for the square-cover
	// lookups running on every book response.
	test('a repeatedly failing provider stops being called, others keep working', async () => {
		let appleCalls = 0
		const flaky: BookProvider = {
			name: 'apple',
			async search(): Promise<ProviderCandidate[]> {
				appleCalls += 1
				throw new Error('Request failed with status code 429')
			}
		}
		const reg = new ProviderRegistry([
			flaky,
			stubProvider('audible', [candidate({ id: 'ok', title: 'Dune', authors: ['Frank Herbert'] })])
		])
		for (let i = 0; i < 20; i += 1) {
			const out = await reg.searchAll({ title: 'Dune', author: 'Frank Herbert', region: 'us' })
			// The healthy provider is unaffected on every single call.
			expect(out).toHaveLength(1)
		}
		// Default failureThreshold is 5, so the circuit opens and the rest are skipped
		// without a request -- rather than all 20 hitting the rate-limited source.
		expect(appleCalls).toBeLessThanOrEqual(6)
		expect(appleCalls).toBeGreaterThan(0)
	})
})

describe('numeric-title mismatch demotion', () => {
	/**
	 * Year-titled books are textually near-identical to a similarity scorer:
	 * measured live on Clarke's Space Odyssey shelf (2026-07-26), a search for
	 * "2010" ranked "2001: A Space Odyssey" at 0.713 -- ABOVE every actual
	 * "2010: Odyssey Two" edition -- because sim('2010','2001') is high while
	 * the books share nothing but an author. When BOTH the wanted title's stem
	 * and the candidate's stem are pure numbers and they differ, they are
	 * different books, period -- same class as the volume-mismatch guard, and
	 * applied the same way: consumer-side, never touching the Gate-0-pinned
	 * scoreCandidate.
	 */
	const clarke = (title: string) => candidate({ id: title, title, authors: ['Arthur C. Clarke'] })

	test('a different numeric title is demoted below the true numeric match', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [clarke('2001: A Space Odyssey'), clarke('2010: Odyssey Two')])
		])
		const out = await new BookSearchHelper(reg, {
			title: '2010',
			author: 'Arthur C. Clarke',
			region: 'us'
		}).search()
		expect(out[0].title).toBe('2010: Odyssey Two')
		// The wrong year is not merely second -- the demotion drops it below the
		// acceptance floor, so it cannot lead a weak list either.
		expect(out.some((c) => c.title === '2001: A Space Odyssey')).toBe(false)
	})

	test('the same numeric stem is never penalized', async () => {
		const reg = new ProviderRegistry([stubProvider('audible', [clarke('2010: Odyssey Two')])])
		const out = await new BookSearchHelper(reg, {
			title: '2010',
			author: 'Arthur C. Clarke',
			region: 'us'
		}).search()
		expect(out[0]?.title).toBe('2010: Odyssey Two')
		expect(out[0].confidence).toBeGreaterThanOrEqual(0.7)
	})

	test('non-numeric stems are untouched by the guard', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				candidate({ id: 'f', title: 'Fahrenheit 451', authors: ['Ray Bradbury'] })
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Fahrenheit 451',
			author: 'Ray Bradbury',
			region: 'us'
		}).search()
		expect(out[0]?.title).toBe('Fahrenheit 451')
	})

	test('a numeric query does not demote a non-numeric candidate stem', async () => {
		// "2010" vs "The Year We Make Contact" -- different naming, same book
		// perhaps; the guard only fires on number-vs-DIFFERENT-number, where the
		// evidence is unambiguous.
		const reg = new ProviderRegistry([
			stubProvider('audible', [clarke('The Year We Make Contact')])
		])
		const out = await new BookSearchHelper(reg, {
			title: '2010',
			author: 'Arthur C. Clarke',
			region: 'us'
		}).search()
		// Not asserting it MATCHES (title sim is low anyway) -- asserting no crash
		// and no spurious demotion bookkeeping.
		expect(Array.isArray(out)).toBe(true)
	})

	test('a junk numeric track index does not poison the want-side stems', async () => {
		// A colon-less rip tag ("2001 A Space Odyssey") contributes no stem, and
		// the tagger's leftover disc index rides in as the track title because it
		// differs from the album tag. "04" is not a title claim -- without the
		// track-side filter it becomes the ONLY wanted stem and the correctly
		// matched candidate eats the mismatch demotion from its own disc number.
		const reg = new ProviderRegistry([stubProvider('audible', [clarke('2001: A Space Odyssey')])])
		const out = await new BookSearchHelper(reg, {
			title: '2001 A Space Odyssey',
			author: 'Arthur C. Clarke',
			region: 'us',
			trackTitle: '04'
		}).search()
		expect(out[0]?.title).toBe('2001: A Space Odyssey')
		expect(out[0].confidence).toBeGreaterThanOrEqual(0.7)
	})

	test('a four-digit track title still feeds the guard', async () => {
		// The case the track side exists for: the album tag carries a subtitle
		// form with no stem, the track title is the bare year. A year is a title
		// claim; a 2-3 digit index is not.
		const reg = new ProviderRegistry([
			stubProvider('audible', [clarke('2001: A Space Odyssey'), clarke('2010: Odyssey Two')])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Odyssey Two',
			author: 'Arthur C. Clarke',
			region: 'us',
			trackTitle: '2010'
		}).search()
		expect(out[0]?.title).toBe('2010: Odyssey Two')
		expect(out.some((c) => c.title === '2001: A Space Odyssey')).toBe(false)
	})
})

describe('narrator-branded edition preference', () => {
	/**
	 * Measured live on the Harry Potter shelf (2026-07-27): a library holds
	 * BOTH narrations of each book, and the Stephen Fry copies searched with
	 * narrator=Stephen Fry kept landing on the PLAIN 2015 editions -- the
	 * narrator arm cannot separate two Fry editions, and the exact-title arm
	 * then dings the "(Narrated by Stephen Fry)" branding for not being the
	 * tag's exact title. When the file itself names a narrator, the edition
	 * whose TITLE names that same narrator is the purpose-built match: prefer
	 * it on ties. Dale copies are untouched (no Dale-branded titles exist).
	 */
	const fry = (id: string, title: string) =>
		candidate({ id, title, authors: ['J.K. Rowling'], narrators: ['Stephen Fry'] })

	test('the edition whose title names the requested narrator wins the tie', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				fry('plain', 'Harry Potter and the Goblet of Fire'),
				fry('branded', 'Harry Potter and the Goblet of Fire (Narrated by Stephen Fry)')
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Harry Potter and the Goblet of Fire',
			author: 'J.K. Rowling',
			narrator: 'Stephen Fry',
			region: 'us'
		}).search()
		expect(out[0].id).toBe('branded')
	})

	test('without a narrator hint the exact title still wins', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				fry('branded', 'Harry Potter and the Goblet of Fire (Narrated by Stephen Fry)'),
				fry('plain', 'Harry Potter and the Goblet of Fire')
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Harry Potter and the Goblet of Fire',
			author: 'J.K. Rowling',
			region: 'us'
		}).search()
		expect(out[0].id).toBe('plain')
	})

	test('a DIFFERENT narrator named in the title earns no preference', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				candidate({
					id: 'dale-branded',
					title: 'Harry Potter and the Goblet of Fire (Narrated by Jim Dale)',
					authors: ['J.K. Rowling'],
					narrators: ['Jim Dale']
				}),
				fry('plain', 'Harry Potter and the Goblet of Fire')
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Harry Potter and the Goblet of Fire',
			author: 'J.K. Rowling',
			narrator: 'Stephen Fry',
			region: 'us'
		}).search()
		expect(out[0].id).toBe('plain')
	})
})

describe('duration-rounding tie collapse', () => {
	/**
	 * Measured live on the Nevermoor shelf (2026-07-27): every provider lists
	 * the SAME recording with a differently-rounded runtime (OverDrive to the
	 * second, Audible to the minute), all tie at confidence 1.0, and the
	 * duration-delta arm then decides the match on 3-24 SECONDS of rounding
	 * noise -- so book 1 landed on a full-title record and books 2-4 on
	 * short-title records, purely by luck. When both deltas sit inside the
	 * rounding epsilon the delta is meaningless: prefer the fuller form of
	 * the same title (never unrelated long junk), tunable via
	 * DURATION_TIE_TITLE_PREFERENCE for operators who want the library-named
	 * row instead. Genuinely different editions (deltas past the epsilon)
	 * keep the closest-runtime behavior untouched.
	 */
	// Real rows on this shelf are catalogued audio editions and carry asins
	// (the Wundersmith full-title row's is an Australian ISBN-shaped one);
	// the fuller-title preference requires that, so the fixture mirrors it.
	const townsend = (id: string, title: string, audioSeconds: number) =>
		candidate({
			id,
			title,
			asin: id,
			provider: 'audible',
			authors: ['Jessica Townsend'],
			audioSeconds
		})

	const silverbornShelf = () =>
		new ProviderRegistry([
			stubProvider('audible', [
				townsend('short', 'Silverborn', 65598),
				townsend('full', 'Silverborn: The Mystery of Morrigan Crow', 65580)
			])
		])

	test('within the epsilon the fuller form of the same title wins', async () => {
		// These two rows carry DIFFERENT ASINs, so under the distinct-listings
		// rule (2026-07-28, the 2015-vs-2024 Fry case) the prefix merge leaves
		// them separately pickable and the fuller-title arm arbitrates the
		// rounding tie -- the original contract of this test, back in force.
		const out = await new BookSearchHelper(silverbornShelf(), {
			title: 'Silverborn',
			author: 'Jessica Townsend',
			duration: 65604000,
			region: 'us'
		}).search()
		expect(out).toHaveLength(2)
		expect(out[0].id).toBe('full')
	})

	test('past the epsilon the closest runtime still wins', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				townsend('short', 'Silverborn', 65598),
				townsend('full', 'Silverborn: The Mystery of Morrigan Crow', 65304)
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Silverborn',
			author: 'Jessica Townsend',
			duration: 65604000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('short')
	})

	test('unrelated long titles earn nothing from the collapse', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				townsend('other', 'A Completely Different Saga Entirely', 65580),
				townsend('short', 'Silverborn', 65598)
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Silverborn',
			author: 'Jessica Townsend',
			duration: 65604000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('short')
	})

	test('DURATION_TIE_TITLE_PREFERENCE=query keeps the library-named row', async () => {
		// Distinct listings (different ASINs) stay unmerged, so the env
		// preference decides between them again -- the original contract.
		const prior = process.env.DURATION_TIE_TITLE_PREFERENCE
		process.env.DURATION_TIE_TITLE_PREFERENCE = 'query'
		try {
			const out = await new BookSearchHelper(silverbornShelf(), {
				title: 'Silverborn',
				author: 'Jessica Townsend',
				duration: 65604000,
				region: 'us'
			}).search()
			expect(out[0].id).toBe('short')
		} finally {
			if (prior === undefined) delete process.env.DURATION_TIE_TITLE_PREFERENCE
			else process.env.DURATION_TIE_TITLE_PREFERENCE = prior
		}
	})

	test('no duration at all leaves the Apex exact-title behavior untouched', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				candidate({
					id: 'tail',
					title: 'Apex: A Fantasy LitRPG Adventure',
					authors: ['Seth Ring']
				}),
				candidate({ id: 'plain', title: 'Apex', authors: ['Seth Ring'] })
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Apex',
			author: 'Seth Ring',
			region: 'us'
		}).search()
		expect(out[0].id).toBe('plain')
	})

	test('EQUAL rounded runtimes inside the epsilon also collapse to the fuller title', async () => {
		// The live Wundersmith holdout: distinct listings (different ASINs)
		// stay unmerged under the 2026-07-28 rule, so equal deltas inside the
		// epsilon fall to the fuller-title arm -- the original contract.
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				townsend('od-short', 'Wundersmith', 42660),
				townsend('b0-short', 'Wundersmith', 42600),
				townsend('full', 'Wundersmith: The Calling of Morrigan Crow', 42600)
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Wundersmith',
			author: 'Jessica Townsend',
			duration: 42672000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('full')
	})
})

describe('runtime evidence outranks cosmetic arms', () => {
	/**
	 * The 2026-07-28 review, verified against the real comparator. Two
	 * regressions from the same evening's tiebreak work:
	 *
	 * 1. The rounding-epsilon collapse suppressed the duration-delta arm for
	 *    EVERY pair whose gaps were both inside the epsilon, not just for
	 *    ties -- so a 0s-off row could lose to an 88s-off row on nothing but
	 *    provider fan-out order. The epsilon must license the fuller-title
	 *    PREFERENCE, never discard the runtime ordering behind it.
	 * 2. The narrator-branding arm sat ABOVE the delta arm with no duration
	 *    guard, so a branded edition 22.8 minutes off beat the byte-exact
	 *    recording. Branding is cosmetic; runtime is evidence.
	 */
	const hp = (id: string, title: string, audioSeconds: number, narrator = 'Stephen Fry') =>
		candidate({
			id,
			title,
			asin: id,
			authors: ['J.K. Rowling'],
			narrators: [narrator],
			audioSeconds
		})

	test('the closest runtime still wins inside the epsilon', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				hp('off88', 'Harry Potter and the Chamber of Secrets', 34880),
				hp('exact', 'Harry Potter and the Chamber of Secrets', 34968)
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Harry Potter and the Chamber of Secrets',
			author: 'J.K. Rowling',
			duration: 34968000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('exact')
	})

	test('a branded edition does not beat the byte-exact runtime', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				hp('branded', 'Harry Potter and the Chamber of Secrets (Narrated by Stephen Fry)', 33600),
				hp('plain', 'Harry Potter and the Chamber of Secrets', 34968)
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Harry Potter and the Chamber of Secrets',
			author: 'J.K. Rowling',
			narrator: 'Stephen Fry',
			duration: 34968000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('plain')
	})

	test('branding still wins when runtime cannot separate the editions', async () => {
		// The Fry case this arm was written for: same recording, rounded
		// differently by two providers.
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				hp('plain', 'Harry Potter and the Chamber of Secrets', 34980),
				hp('branded', 'Harry Potter and the Chamber of Secrets (Narrated by Stephen Fry)', 34968)
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Harry Potter and the Chamber of Secrets',
			author: 'J.K. Rowling',
			narrator: 'Stephen Fry',
			duration: 34968000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('branded')
	})

	test('a subtitle extends the query title; a different word does not', () => {
		// Tested directly, because at search level a prefix-sharing DIFFERENT
		// book is eliminated by title similarity long before this arm -- which
		// is exactly what made the first version of this guard vacuous (the
		// mutation survived the whole suite). The rule itself is the contract.
		expect(titleExtendsQuery('Silverborn: The Mystery of Morrigan Crow', 'Silverborn')).toBe(true)
		expect(titleExtendsQuery('Dune - Special Edition', 'Dune')).toBe(true)
		expect(
			titleExtendsQuery('The Invisible Man (AmazonClassics Edition)', 'The Invisible Man')
		).toBe(true)
		for (const [full, base] of [
			['Dune Messiah', 'Dune'],
			['Wintering', 'Winter'],
			['Ender in Exile', 'Ender'],
			['Dune', 'Dune']
		]) {
			expect(titleExtendsQuery(full, base)).toBe(false)
		}
	})

	test('the preference is a per-candidate key, not a relation (transitivity)', () => {
		// The relational first cut made the comparator intransitive: with a
		// third, prefix-unrelated title all six input orders produced three
		// different winners, so the match depended on provider fan-out order.
		// A key cannot do that.
		const key = (t: string) => titleExtendsQuery(t, 'Silverborn')
		expect(key('Silverborn')).toBe(false)
		expect(key('The Silverborn')).toBe(false)
		expect(key('Silverborn: The Mystery of Morrigan Crow')).toBe(true)
	})

	test('a print/work row with a GRAFTED asin cannot win on its prettier title', async () => {
		// dedupeCandidates grafts a donor's asin onto a group winner that
		// lacks one, so `asin` alone stopped proving "catalogued audio
		// edition" (verified 2026-07-28). The provider cannot be grafted.
		const reg = new ProviderRegistry([
			stubProvider('hardcover', [
				candidate({
					id: 'print',
					asin: 'B0GRAFTED1',
					provider: 'hardcover',
					title: 'The Amazing Maurice and His Educated Rodents: una historia del mundodisco',
					authors: ['Terry Pratchett'],
					audioSeconds: 29272
				})
			]),
			stubProvider('audible', [
				candidate({
					id: 'audio',
					asin: 'B0C6R9GKPS',
					provider: 'audible',
					title: 'The Amazing Maurice and His Educated Rodents',
					authors: ['Terry Pratchett'],
					audioSeconds: 29272
				})
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'The Amazing Maurice and His Educated Rodents',
			author: 'Terry Pratchett',
			duration: 29272000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('audio')
	})
})

describe('a file PART is not a series volume', () => {
	/**
	 * Verified 2026-07-28 against the real helper: album tag "Catch 22" with
	 * the only listing titled "Catch-22, Part 1" returned ZERO results -- the
	 * correct book was unmatchable, not merely ranked low. Fahrenheit 451,
	 * Apollo 13 and Slaughterhouse 5 all landed at 0.650, under Plex's 0.80
	 * auto-apply bar, so they scan as unmatched.
	 *
	 * Cause: the want side reads any title ending in 1-3 digits as a volume
	 * ("Catch 22" -> volume 22), and the candidate side read the "Part 1" of
	 * a multi-part release as a volume too -- disjoint sets, so the
	 * volume-conflict penalty fired between a book and ITSELF.
	 *
	 * A part number is a file split, not a series position. Multi-part
	 * releases are routine on Audible and OverDrive.
	 */
	const listing = (title: string) =>
		candidate({
			id: 'real',
			asin: 'B0REAL0001',
			provider: 'audible',
			title,
			authors: ['An Author'],
			audioSeconds: 30000
		})

	async function search(album: string, candTitle: string) {
		const reg = new ProviderRegistry([stubProvider('audible', [listing(candTitle)])])
		return new BookSearchHelper(reg, {
			title: album,
			author: 'An Author',
			region: 'us'
		}).search()
	}

	test('a numeric title still matches its own multi-part listing', async () => {
		const out = await search('Catch 22', 'Catch-22, Part 1')
		expect(out.length).toBeGreaterThan(0)
		expect(out[0].confidence).toBeGreaterThan(0.8)
	})

	test('the whole numeric-title class clears the auto-apply bar', async () => {
		for (const [album, cand] of [
			['Fahrenheit 451', 'Fahrenheit 451, Part 2'],
			['Apollo 13', 'Apollo 13: Part 2'],
			['Slaughterhouse 5', 'Slaughterhouse 5, Part 1']
		]) {
			const out = await search(album, cand)
			expect(out.length).toBeGreaterThan(0)
			expect(out[0].confidence).toBeGreaterThan(0.8)
		}
	})

	test('a genuine numbered sibling is still separated', async () => {
		// The guard must not go so far that book 1 matches book 10.
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				candidate({
					id: 'ten',
					asin: 'B0TEN00001',
					provider: 'audible',
					title: 'Defiance of the Fall, Book 10',
					authors: ['An Author'],
					audioSeconds: 30000
				})
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Defiance of the Fall',
			author: 'An Author',
			seriesPosition: '1',
			region: 'us'
		}).search()
		expect(out.length === 0 || out[0].confidence < 0.8).toBe(true)
	})
})

describe('duration evidence belongs to the EDITION, not the row', () => {
	/**
	 * Tier 1.1, reproduced against the real helper 2026-07-28.
	 *
	 * The duration veto is applied per ROW, but edition identity is per ASIN.
	 * A vetoed 7200s abridgement under B0WRONG001 was correctly filtered out
	 * on its own -- and adding a Hardcover row for the SAME ASIN with a null
	 * runtime (which this file's own comments note is routine for Hardcover
	 * audio rows) brought it back at 0.850, i.e. Plex score 85: above the
	 * measured 0.80 auto-apply bar, applied automatically, and sticky.
	 *
	 * The runtime is a property of the EDITION the ASIN names, so a row that
	 * reports none inherits what its twins report. This is the same shape the
	 * pin path already uses ("decide the contradiction ONCE ... over every row
	 * carrying it, rather than per row"), generalized beyond the pinned ASIN.
	 */
	const WRONG = 'B0WRONG001'
	const dune = (over: Partial<ProviderCandidate>) =>
		candidate({ title: 'Dune', authors: ['Frank Herbert'], ...over })

	async function search(rows: ProviderCandidate[][]) {
		const reg = new ProviderRegistry(
			rows.map((r, i) => stubProvider(i === 0 ? 'audible' : 'hardcover', r))
		)
		return new BookSearchHelper(reg, {
			title: 'Dune',
			author: 'Frank Herbert',
			duration: 36000000,
			region: 'us'
		}).search()
	}

	test('the vetoed edition alone is rejected', async () => {
		const out = await search([[dune({ id: 'abridged', asin: WRONG, audioSeconds: 7200 })]])
		expect(out).toHaveLength(0)
	})

	test('a null-runtime twin of the same asin cannot resurrect it', async () => {
		const out = await search([
			[dune({ id: 'abridged', asin: WRONG, audioSeconds: 7200 })],
			[dune({ id: 'twin', provider: 'hardcover', asin: WRONG, audioSeconds: null })]
		])
		const twin = out.find((r) => r.id === 'twin')
		expect(twin === undefined || twin.confidence < 0.8).toBe(true)
	})

	test('a null-runtime row of a DIFFERENT asin is untouched', async () => {
		// Inheritance must be scoped to the edition, not applied library-wide.
		const out = await search([
			[dune({ id: 'abridged', asin: WRONG, audioSeconds: 7200 })],
			[dune({ id: 'other', provider: 'hardcover', asin: 'B0RIGHT001', audioSeconds: null })]
		])
		const other = out.find((r) => r.id === 'other')
		expect(other).toBeDefined()
		expect(other!.confidence).toBeGreaterThan(0.8)
	})

	test('a corroborated twin does not drag down its own edition', async () => {
		// When the edition's runtime AGREES with the file, the null-runtime row
		// inherits agreement, not a penalty.
		const out = await search([
			[dune({ id: 'right', asin: 'B0RIGHT001', audioSeconds: 36000 })],
			[dune({ id: 'righttwin', provider: 'hardcover', asin: 'B0RIGHT001', audioSeconds: null })]
		])
		expect(out.length).toBeGreaterThan(0)
		expect(out[0].confidence).toBeGreaterThan(0.8)
	})
})

describe('a revoked pin cannot return on a grafted asin', () => {
	/**
	 * Tier 1.2, reproduced against the real helper 2026-07-28.
	 *
	 * The pinned-first arm keys on `c.asin`; the three exclusion sets
	 * (pinOverriddenIds, aiNarratedIds, bundleDemotedIds) key on `c.id`. But
	 * `dedupeCandidates` runs AFTER the per-row scoring pass and GRAFTS a
	 * donor's asin onto a group winner that lacks one -- so a row that had no
	 * asin when the pin was evaluated acquires the stale one afterwards, is
	 * never in the override set, and is ranked FIRST as a valid pin.
	 *
	 * Measured: file 10000s, sidecar pin B0STALE001 whose Audible row reports
	 * 12000s (16.7% off, so the duration override revokes the pin). An
	 * OverDrive row with no asin merges with it and inherits B0STALE001 --
	 * then ranks first at 0.676, ahead of the correct 1.000 edition, while
	 * telemetry reported the match asinPinned and risky:false. The guard fired
	 * and its own instrumentation then declared the result clean.
	 */
	const cand = (o: Partial<ProviderCandidate>): ProviderCandidate =>
		candidate({ title: 'A Book', authors: ['An Author'], ...o })

	test('the donee row does not outrank the corroborated edition', async () => {
		const STALE = 'B0STALE001'
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				cand({ id: 'pinned', asin: STALE, audioSeconds: 12000 }),
				cand({ id: 'right', asin: 'B0RIGHT001', audioSeconds: 10000 })
			]),
			stubProvider('overdrive', [
				cand({ id: 'od', provider: 'overdrive', asin: null, audioSeconds: 11990 })
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'A Book',
			author: 'An Author',
			asin: STALE,
			duration: 10000000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('right')
	})

	test('a pin that is NOT stale still wins', async () => {
		// The revocation must not become a blanket demotion of pinned rows.
		const GOOD = 'B0GOOD0001'
		const reg = new ProviderRegistry([
			stubProvider('audible', [
				cand({ id: 'other', asin: 'B0OTHER001', audioSeconds: 10000 }),
				cand({ id: 'pinned', asin: GOOD, audioSeconds: 10000 })
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'A Book',
			author: 'An Author',
			asin: GOOD,
			duration: 10000000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('pinned')
	})
})

describe('the witness that revokes a pin must be a plausible candidate', () => {
	/**
	 * Tier 1.5, reproduced against the real helper 2026-07-28.
	 *
	 * `corroboratedNonPinExists` accepts ANY row in the raw pool as the
	 * witness that invalidates a pin -- no title check, no author check, not
	 * even a requirement that the row clear the acceptance floor.
	 *
	 * Measured: file 36000s, pin B0PINPINPI on the CORRECT edition whose
	 * Audible listing drifts to 33000s (9% -- ordinary listing drift, inside
	 * the graded dead zone). Alone, the pin holds at 1.000. Add an OpenLibrary
	 * row titled "A Completely Different Book About Ducks" that happens to
	 * report 36000s, and the correct pinned edition drops to 0.789 -- under
	 * Plex's 0.80 bar, so the right book goes unmatched. The duck row is
	 * itself filtered out by the floor, so the operator never sees the cause.
	 */
	const cand = (o: Partial<ProviderCandidate>): ProviderCandidate =>
		candidate({ title: 'A Book', authors: ['An Author'], narrators: ['A Narrator'], ...o })
	const PIN = 'B0PINPINPI'

	async function run(witnesses: ProviderCandidate[]) {
		const reg = new ProviderRegistry([
			stubProvider('audible', [cand({ id: 'pinned', asin: PIN, audioSeconds: 33000 })]),
			stubProvider('openlibrary', witnesses)
		])
		return new BookSearchHelper(reg, {
			title: 'A Book',
			author: 'An Author',
			asin: PIN,
			duration: 36000000,
			region: 'us'
		}).search()
	}

	test('an unrelated book with a coincidental runtime does not revoke the pin', async () => {
		const out = await run([
			cand({
				id: 'ducks',
				provider: 'openlibrary',
				asin: null,
				title: 'A Completely Different Book About Ducks',
				authors: ['Someone Else'],
				audioSeconds: 36000
			})
		])
		const pinned = out.find((r) => r.id === 'pinned')
		expect(pinned).toBeDefined()
		expect(pinned!.confidence).toBeGreaterThan(0.8)
	})

	test('a REAL rival edition of the same book still revokes a stale pin', async () => {
		// The guard must not neuter the override it protects: a genuine
		// same-book edition whose runtime matches the file still wins.
		const out = await run([
			cand({
				id: 'realrival',
				provider: 'openlibrary',
				asin: 'B0RIVAL001',
				title: 'A Book',
				audioSeconds: 36000
			})
		])
		expect(out[0].id).toBe('realrival')
	})
})

describe('a foreign edition named in the TITLE loses on identity', () => {
	/**
	 * Tier 1.4, reproduced against the real helper 2026-07-28.
	 *
	 * A foreign-edition marker in the title is treated as evidence the
	 * language FIELD failed to carry, and costs LANGUAGE_CONFLICT_PENALTY
	 * (0.15) -- which exactly cancels the +0.15 duration corroboration bonus.
	 * So "Everfound (Spanish Edition)" with a matching runtime lands at 0.850,
	 * precisely tying an uncorroborated English row, and the winner falls to
	 * arms below that know nothing about language: `byLanguage` consults only
	 * `c.language`, so a null field makes the Spanish row invisible to it.
	 *
	 * Language is an identity property -- the wrong-language edition is the
	 * wrong BOOK -- so the ranking arm must see the title marker too, and the
	 * result must not depend on provider fan-out order.
	 */
	const cand = (o: Partial<ProviderCandidate>): ProviderCandidate =>
		candidate({ title: 'Everfound', authors: ['Neal Shusterman'], narrators: ['A Narrator'], ...o })

	const spanish = () =>
		cand({
			id: 'spanish',
			asin: 'B0SPANISH1',
			title: 'Everfound (Spanish Edition)',
			audioSeconds: 36000
		})
	const english = () =>
		cand({
			id: 'english',
			provider: 'hardcover',
			asin: 'B0ENGLISH1',
			title: 'Everfound',
			language: 'en' as never,
			audioSeconds: null
		})

	async function run(first: ProviderCandidate, second: ProviderCandidate) {
		const reg = new ProviderRegistry([
			stubProvider('audible', [first]),
			stubProvider('hardcover', [second])
		])
		return new BookSearchHelper(reg, {
			title: 'Everfound',
			author: 'Neal Shusterman',
			duration: 36000000,
			region: 'us'
		}).search()
	}

	test('the English edition wins regardless of provider order', async () => {
		for (const [a, b] of [
			[spanish(), english()],
			[english(), spanish()]
		]) {
			const out = await run(a, b)
			expect(out[0].id).toBe('english')
		}
	})

	test('the marker does not fire when the QUERY itself asks for that edition', async () => {
		const reg = new ProviderRegistry([
			stubProvider('audible', [spanish()]),
			stubProvider('hardcover', [english()])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'Everfound (Spanish Edition)',
			author: 'Neal Shusterman',
			duration: 36000000,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('spanish')
	})
})

describe('ranking determinism', () => {
	// Two look-alike audio editions with nothing to separate them: same
	// title/author, no duration hint, different ASINs and runtime buckets (so
	// dedupe keeps both), from two UNKNOWN providers that share the default
	// provider rank. Every comparator arm declines; only the terminal identity
	// arm can decide. Before it existed the stable sort fell through to arrival
	// order, so the winner flipped with registry/cache/timeout accidents — the
	// measured ~5% of tops that drifted between full-library runs.
	const twinA = () =>
		candidate({
			provider: 'zeta',
			id: 'z9',
			asin: 'B0AAAAAAA1',
			title: 'Light Bringer',
			authors: ['Pierce Brown'],
			audioSeconds: 108480
		})
	const twinB = () =>
		candidate({
			provider: 'eta',
			id: 'e1',
			asin: 'B0BBBBBBB2',
			title: 'Light Bringer',
			authors: ['Pierce Brown'],
			audioSeconds: 108600
		})

	async function rank(order: 'ab' | 'ba'): Promise<string[]> {
		const providers =
			order === 'ab'
				? [stubProvider('zeta', [twinA()]), stubProvider('eta', [twinB()])]
				: [stubProvider('eta', [twinB()]), stubProvider('zeta', [twinA()])]
		const helper = new BookSearchHelper(new ProviderRegistry(providers), {
			title: 'Light Bringer',
			author: 'Pierce Brown',
			region: 'us'
		})
		return (await helper.search()).map((c) => c.id)
	}

	test('an evidence-proof tie ranks identically whatever the arrival order', async () => {
		const ab = await rank('ab')
		const ba = await rank('ba')
		expect(ab).toHaveLength(2)
		expect(ba).toEqual(ab)
		// And the winner is the canonical one (identity key "eta e1..." sorts
		// before "zeta z9..."), not whoever arrived first.
		expect(ab[0]).toBe('e1')
	})
})

describe('ISBN-derived pins rank on merits', () => {
	/**
	 * The live He Who Fights with Monsters case (2026-07-28): the ABS sidecar
	 * carries "asin": "1774248182" -- the ISBN-10 twin of its own isbn field,
	 * not a store ASIN -- and the ISBN resolves through Hardcover to the
	 * deluxe-hardcover "Vol. 1" edition record, which the full pin privilege
	 * then auto-matched over the standard listing sitting 14s from the file.
	 *
	 * An ISBN names a BOOK; which listing a provider resolves it to is
	 * data-dependent. So an ISBN-derived identity is still fetched, offered
	 * and group-protected, but ranks on its merits -- the closest-runtime and
	 * exact-title arms decide. A B0 store ASIN keeps absolute privilege.
	 */
	const file = 104195134 // ms

	const bare = () =>
		candidate({
			provider: 'overdrive',
			id: 'overdrive-bare',
			title: 'He Who Fights with Monsters',
			authors: ['Shirtaloon'],
			narrators: ['Heath Miller'],
			audioSeconds: 104181
		})
	const isbnListed = () =>
		candidate({
			provider: 'hardcover',
			id: 'hardcover-vol1',
			asin: '1774248182',
			title: 'He Who Fights With Monsters, Vol. 1',
			authors: ['Shirtaloon'],
			narrators: ['Heath Miller'],
			audioSeconds: 104160
		})

	test('the closer-runtime tag-exact row beats the ISBN row; both stay offered', async () => {
		const reg = new ProviderRegistry([stubProvider('x', [isbnListed(), bare()])])
		const out = await new BookSearchHelper(reg, {
			title: 'He Who Fights with Monsters',
			author: 'Shirtaloon',
			duration: file,
			isbn: '9781774248188',
			region: 'us'
		}).search()
		expect(out[0].id).toBe('overdrive-bare')
		expect(out.map((c) => c.id)).toContain('hardcover-vol1')
	})

	test('the ISBN row still wins when it is the only corroborated listing', async () => {
		// The Lost Stories Collection shape ISBN pinning was built for: the
		// ISBN-10 IS the audio product id and nothing else corroborates.
		const reg = new ProviderRegistry([
			stubProvider('x', [
				isbnListed(),
				candidate({
					provider: 'openlibrary',
					id: 'ol-book',
					title: 'He Who Fights with Monsters',
					authors: ['Shirtaloon']
				})
			])
		])
		const out = await new BookSearchHelper(reg, {
			title: 'He Who Fights with Monsters',
			author: 'Shirtaloon',
			duration: file,
			isbn: '9781774248188',
			region: 'us'
		}).search()
		expect(out[0].id).toBe('hardcover-vol1')
	})

	test('a B0 store ASIN keeps absolute privilege over closer runtime', async () => {
		const pinnedVol1 = { ...isbnListed(), asin: 'B08V3XQ7LK' }
		const reg = new ProviderRegistry([stubProvider('x', [pinnedVol1, bare()])])
		const out = await new BookSearchHelper(reg, {
			title: 'He Who Fights with Monsters',
			author: 'Shirtaloon',
			duration: file,
			asin: 'B08V3XQ7LK',
			region: 'us'
		}).search()
		expect(out[0].asin).toBe('B08V3XQ7LK')
	})
})

describe('same-narration branding window', () => {
	/**
	 * The live Fry Order of the Phoenix case (2026-07-28): the plain 2015-era
	 * listing sits 46s from the file, the branded 2024 listing 286s -- a 240s
	 * inter-listing gap, outside the 90s rounding epsilon, so the branding
	 * arm never ran and closest-runtime seated the unbranded listing on top.
	 * Both rows match the hinted narrator and both corroborate: that gap is
	 * mastering variance of ONE narration, not identity evidence, so within
	 * the 600s window the branded release wins. The 22.8-minute case that
	 * proved branding must NOT beat real runtime evidence stays outside the
	 * window and keeps losing.
	 */
	const file = 104745754 // ms

	const plain2015 = () =>
		candidate({
			provider: 'hardcover',
			id: 'hc-plain',
			title: 'Harry Potter and the Order of the Phoenix',
			authors: ['J.K. Rowling'],
			narrators: ['Stephen Fry'],
			audioSeconds: 104700 // 46s off
		})
	const branded2024 = () =>
		candidate({
			provider: 'audible',
			id: 'audible-branded',
			asin: 'B0D1CVZ22J',
			title: 'Harry Potter and the Order of the Phoenix (Narrated by Stephen Fry)',
			authors: ['J.K. Rowling'],
			narrators: ['Stephen Fry'],
			audioSeconds: 104460 // 286s off
		})

	test('the branded release wins inside the window despite a closer rival', async () => {
		const reg = new ProviderRegistry([stubProvider('x', [plain2015(), branded2024()])])
		const out = await new BookSearchHelper(reg, {
			title: 'Harry Potter and the Order of the Phoenix (Narrated by Stephen Fry)',
			author: 'J.K. Rowling',
			narrator: 'Stephen Fry',
			duration: file,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('audible-branded')
		expect(out.map((c) => c.id)).toContain('hc-plain')
	})

	test('outside the window the closest runtime still decides (the 22.8-minute rule)', async () => {
		const farBranded = { ...branded2024(), audioSeconds: 104746 - 1368 } // 22.8 min off
		const reg = new ProviderRegistry([stubProvider('x', [plain2015(), farBranded])])
		const out = await new BookSearchHelper(reg, {
			title: 'Harry Potter and the Order of the Phoenix (Narrated by Stephen Fry)',
			author: 'J.K. Rowling',
			narrator: 'Stephen Fry',
			duration: file,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('hc-plain')
	})

	test('without a narrator hint the window never engages', async () => {
		const reg = new ProviderRegistry([stubProvider('x', [plain2015(), branded2024()])])
		const out = await new BookSearchHelper(reg, {
			title: 'Harry Potter and the Order of the Phoenix',
			author: 'J.K. Rowling',
			duration: file,
			region: 'us'
		}).search()
		expect(out[0].id).toBe('hc-plain')
	})
})

describe('DURATION_TIE_TITLE_PREFERENCE=query is an active tag preference', () => {
	// Live Apex (2026-07-28): inside the rounding band the 'fuller' default
	// hands the tie to the marketing-subtitled listing even when the tag row
	// sits in the same band. 'query' now actively prefers the row titled what
	// the library calls the book -- and stays inert when runtime genuinely
	// separates the pair.
	const file = 41946000

	const bare = () =>
		candidate({
			provider: 'overdrive',
			id: 'od-bare',
			title: 'Apex',
			authors: ['Seth Ring'],
			narrators: ['Pavi Proczko'],
			audioSeconds: 41976 // 30s off -- FARTHER than the subtitled row
		})
	const subtitled = () =>
		candidate({
			provider: 'audible',
			id: 'audible-sub',
			asin: 'B0APEXQRY01',
			title: 'Apex: A Fantasy LitRPG Adventure',
			authors: ['Seth Ring'],
			narrators: ['Pavi Proczko'],
			audioSeconds: 41956 // 10s off
		})

	async function searchWith(pref) {
		const prior = process.env.DURATION_TIE_TITLE_PREFERENCE
		if (pref === undefined) delete process.env.DURATION_TIE_TITLE_PREFERENCE
		else process.env.DURATION_TIE_TITLE_PREFERENCE = pref
		try {
			const reg = new ProviderRegistry([stubProvider('x', [bare(), subtitled()])])
			return await new BookSearchHelper(reg, {
				title: 'Apex',
				author: 'Seth Ring',
				duration: file,
				region: 'us'
			}).search()
		} finally {
			if (prior === undefined) delete process.env.DURATION_TIE_TITLE_PREFERENCE
			else process.env.DURATION_TIE_TITLE_PREFERENCE = prior
		}
	}

	test("'query' seats the tag-titled row despite a slightly-closer subtitled rival", async () => {
		const out = await searchWith('query')
		expect(out[0].id).toBe('od-bare')
		expect(out.map((c) => c.id)).toContain('audible-sub')
	})

	test("the default 'fuller' keeps its Nevermoor behavior on the same pair", async () => {
		const out = await searchWith(undefined)
		expect(out[0].id).toBe('audible-sub')
	})

	test("'query' never overrides runtime that genuinely separates", async () => {
		const prior = process.env.DURATION_TIE_TITLE_PREFERENCE
		process.env.DURATION_TIE_TITLE_PREFERENCE = 'query'
		try {
			const farBare = { ...bare(), audioSeconds: 41946 + 1200 } // 20 min off
			const reg = new ProviderRegistry([stubProvider('x', [farBare, subtitled()])])
			const out = await new BookSearchHelper(reg, {
				title: 'Apex',
				author: 'Seth Ring',
				duration: file,
				region: 'us'
			}).search()
			expect(out[0].id).toBe('audible-sub')
		} finally {
			if (prior === undefined) delete process.env.DURATION_TIE_TITLE_PREFERENCE
			else process.env.DURATION_TIE_TITLE_PREFERENCE = prior
		}
	})
})

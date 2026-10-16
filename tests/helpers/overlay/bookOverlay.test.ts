import { describe, expect, test } from 'bun:test'

import { AWARD_RECORDING, baseFile, edition, record, work } from './fixtures'

import { ApiGenreSchema } from '#config/types'
import {
	applyBookOverlay,
	compileOverlay,
	findOverlay,
	overlayGenres,
	type OverlayTable,
	overlayTitleKey
} from '#helpers/overlay/bookOverlay'
import {
	OVERLAY_GENRE_CONTAINERS,
	OVERLAY_GENRE_VOCABULARY
} from '#helpers/overlay/genreVocabulary'
import { namesToGenres } from '#helpers/providers/hardcoverGenres'

type Json = Record<string, unknown>

const compiled = (file: Json): OverlayTable => {
	const r = compileOverlay(file)
	if (!r.ok) throw new Error(`fixture refused: ${r.errors.join('; ')}`)
	return r.table
}

const refusal = (file: Json): string[] => {
	const r = compileOverlay(file)
	if (r.ok) throw new Error('expected the gate to REFUSE this file, and it accepted it')
	return r.errors
}

/** A deep copy of the base file with one edit applied. */
const mutate = (edit: (f: Json & { works: Json; editions: Json }) => void): Json => {
	const f = structuredClone(baseFile()) as Json & { works: Json; editions: Json }
	edit(f)
	return f
}

describe('compileOverlay — the load gate', () => {
	test('a valid file compiles: approved entries served, drafts and held ones not', () => {
		const t = compiled(baseFile())
		expect([...t.byId.keys()].sort()).toEqual([
			'B0SYNTH001',
			'B0SYNTH002',
			'B0SYNTH003',
			'hardcover-book-424242'
		])
		expect(t.report).toMatchObject({ served: 4, drafts: 1, held: ['B0SYNTHHLD'] })
	})

	test('two approved entries for ONE narration are a collision: the whole file is refused', () => {
		const errors = refusal(
			mutate((f) => {
				f.editions.B0SYNTH009 = edition('lantern-road', {
					title: 'The Lantern Road',
					author: 'Ada Quill',
					narrator: 'Ben Reader'
				})
			})
		)
		expect(errors.join('\n')).toContain('collides with B0SYNTH001')
	})

	test('two narrations of one title: the PLAIN key is refused for both, never granted to one', () => {
		const t = compiled(baseFile())
		const tide = overlayTitleKey('The Tide Clock', 'Ada Quill')
		expect(t.byTitle.has(tide)).toBe(false)
		expect(t.report.refusedTitleKeys).toEqual([
			{ key: tide, editions: ['B0SYNTH002', 'B0SYNTH003'] }
		])
		// The control: a book with ONE narration keeps its plain key, so the
		// refusal above is the ambiguity rule and not a key that never forms.
		expect(t.byTitle.get(overlayTitleKey('The Lantern Road', 'Ada Quill'))?.id).toBe('B0SYNTH001')
	})

	test('a DRAFT second narration still makes the plain key ambiguous', () => {
		// The file knows about the other recording even though it is not
		// approved; granting the key would hand this text to it on a re-match.
		const t = compiled(
			mutate((f) => {
				f.editions.B0SYNTHDR2 = edition(
					'lantern-road',
					{ title: 'The Lantern Road', author: 'Ada Quill', narrator: 'Other Narrator' },
					{ status: 'draft' }
				)
			})
		)
		expect(t.byTitle.has(overlayTitleKey('The Lantern Road', 'Ada Quill'))).toBe(false)
		expect(t.byId.has('B0SYNTHDR2')).toBe(false)
	})

	test('a genre outside the approved vocabulary is refused', () => {
		for (const bad of ['Fantasy & Magic', 'Science Fiction & Fantasy', 'fantasy']) {
			const errors = refusal(
				mutate((f) => {
					;(f.works['lantern-road'] as Json).genres = ['Fantasy', 'Epic Fantasy', 'Adventure', bad]
				})
			)
			expect(errors.join('\n')).toContain(`"${bad}" is not in the approved vocabulary`)
		}
	})

	test('a draft is validated but never served, not even by its own id', () => {
		const t = compiled(baseFile())
		expect(t.byId.has('B0SYNTHDRF')).toBe(false)
		expect(
			findOverlay(
				record({ title: 'Paper Moon', narrators: [{ name: 'Hal Draft' }] }),
				'B0SYNTHDRF',
				t
			)
		).toBeNull()
	})

	test('every other gate refuses the file and names the reason', () => {
		const cases: [string, (f: Json & { works: Json; editions: Json }) => void, string][] = [
			['missing work', (f) => ((f.editions.B0SYNTH001 as Json).work = 'nope'), 'no work "nope"'],
			[
				'no approval stamp',
				(f) => delete (f.editions.B0SYNTH001 as Json).approved_on,
				'approved without an approved_on'
			],
			[
				'open gate-2 question on an approved entry',
				(f) => ((f.editions.B0SYNTH001 as Json).gate2_open = 'verify the quote'),
				'open Gate 2 question'
			],
			[
				'a nomination is not a juried result',
				(f) =>
					((f.editions.B0SYNTH001 as Json).awards = [{ ...AWARD_RECORDING, result: 'nominee' }]),
				'awards'
			],
			[
				'a recording award filed on the work',
				(f) => ((f.works['lantern-road'] as Json).awards = [AWARD_RECORDING]),
				'scoped to a recording'
			],
			[
				'a placeholder quote',
				(f) =>
					((f.editions.B0SYNTH001 as Json).praise = [
						{ text: '(quote pending approval)', source: 'A Review', year: 2021 }
					]),
				'placeholder'
			],
			[
				'three quotes for a template that shows two',
				(f) =>
					((f.editions.B0SYNTH001 as Json).praise = [1, 2, 3].map((n) => ({
						text: `Quote ${n}.`,
						source: 'A Review',
						year: 2021
					}))),
				'3 praise quotes'
			],
			[
				'markup in operator prose',
				(f) => ((f.works['lantern-road'] as Json).hook = 'A <b>bold</b> hook.'),
				'plain text'
			],
			[
				'an undecoded entity in operator prose',
				(f) => ((f.works['lantern-road'] as Json).hook = 'Rock &amp; roll.'),
				'plain text'
			],
			[
				'a typo in a field name (strict objects)',
				(f) => ((f.works['lantern-road'] as Json).series_totl = 3),
				'series_totl'
			],
			[
				'a region-suffixed id',
				(f) => (f.editions.B0SYNTH001_us = f.editions.B0SYNTH001),
				'not a bare record id'
			],
			[
				'fewer than four genres',
				(f) => ((f.works['lantern-road'] as Json).genres = ['Fantasy']),
				'genres'
			],
			['wrong schema version', (f) => (f.schema = 2), 'schema']
		]
		for (const [name, edit, reason] of cases) {
			const errors = refusal(mutate(edit))
			if (!errors.join('\n').includes(reason))
				throw new Error(`${name}: refused, but not for "${reason}": ${errors.join('; ')}`)
		}
	})

	test('a held id stays out even when an approved entry exists for it', () => {
		const t = compiled(baseFile())
		expect(t.byId.has('B0SYNTHHLD')).toBe(false)
		expect(
			findOverlay(
				record({ title: 'Paper Moon Held', narrators: [{ name: 'Ivy Held' }] }),
				'B0SYNTHHLD',
				t
			)
		).toBeNull()
	})

	test("a held RECORD gets no overlay through another entry's key either", () => {
		// The held record carries a title and narration that key to B0SYNTH001.
		const t = compiled(baseFile())
		expect(findOverlay(record(), 'B0SYNTHHLD', t)).toBeNull()
		// Control: the same record under any other id is matched by that key.
		expect(findOverlay(record(), 'B0OTHER000', t)?.via).toBe('narration')
	})
})

describe('key precedence: id, then (title, author, narrator), then the plain key', () => {
	const t = compiled(baseFile())

	test('the record id wins over keys that point at a different entry', () => {
		// Title and narrator key to B0SYNTH003 (The Tide Clock, Dan Voice); the id
		// is B0SYNTH001. The id is exact and must decide.
		const m = findOverlay(
			record({ title: 'The Tide Clock', narrators: [{ name: 'Dan Voice' }] }),
			'B0SYNTH001',
			t
		)
		expect(m?.via).toBe('id')
		expect(m?.entry.id).toBe('B0SYNTH001')
	})

	test('an unknown id falls to the narration key, which keeps the recording items', () => {
		const m = findOverlay(record(), 'B0REMATCH1', t)
		expect(m?.via).toBe('narration')
		expect(m?.entry.id).toBe('B0SYNTH001')
		expect(m?.edition).not.toBeNull()
	})

	test('the narration key beats the plain key when both would answer', () => {
		// Both keys reach B0SYNTH001; the narration key must be the one that
		// answers, because only it may carry recording-scoped items.
		const m = findOverlay(record(), 'B0REMATCH1', t)
		expect(m?.via).toBe('narration')
	})

	test('another narration of a single-narration book matches the WORK only', () => {
		const m = findOverlay(record({ narrators: [{ name: 'Someone Else' }] }), 'B0REMATCH2', t)
		expect(m?.via).toBe('title')
		expect(m?.entry.workKey).toBe('lantern-road')
		expect(m?.edition).toBeNull()
	})

	test('a re-match to an UNKNOWN narration of a two-narration book gets no overlay', () => {
		// Never the wrong one: neither stored narration is this recording, and the
		// plain key was refused, so there is nothing safe to serve.
		const m = findOverlay(
			record({ title: 'The Tide Clock', narrators: [{ name: 'Jo Unknown' }] }),
			'B0REMATCH3',
			t
		)
		expect(m).toBeNull()
	})

	test('a re-match to a KNOWN narration of that book finds it through the edition table', () => {
		// Same narrator as B0SYNTH002, title without the qualifier: the narration
		// key folds "(Narrated by Cora Voice)" away and lands on the right edition.
		const m = findOverlay(
			record({ title: 'The Tide Clock', narrators: [{ name: 'Cora Voice' }] }),
			'B0REMATCH4',
			t
		)
		expect(m?.via).toBe('narration')
		expect(m?.entry.id).toBe('B0SYNTH002')
	})

	test('a record whose narrators reach TWO entries gets no overlay', () => {
		const m = findOverlay(
			record({
				title: 'The Tide Clock',
				narrators: [{ name: 'Cora Voice' }, { name: 'Dan Voice' }]
			}),
			'B0REMATCH5',
			t
		)
		expect(m).toBeNull()
	})

	test('a key match is refused on a record in another language; an id match is not', () => {
		const french = record({ language: 'french' })
		expect(findOverlay(french, 'B0REMATCH6', t)).toBeNull()
		expect(findOverlay({ ...french, narrators: [] }, 'B0REMATCH6', t)).toBeNull()
		expect(findOverlay(french, 'B0SYNTH001', t)?.via).toBe('id')
	})

	test('a provider id is an exact id like an ASIN', () => {
		const m = findOverlay(
			record({ title: 'Unrelated', authors: [{ name: 'Nobody' }] }),
			'hardcover-book-424242',
			t
		)
		expect(m?.entry.workKey).toBe('glass-orchard')
	})

	test('no id, no key: no overlay', () => {
		expect(
			findOverlay(record({ title: 'Some Other Book', narrators: [{ name: 'X' }] }), 'B0NOTHING0', t)
		).toBeNull()
	})
})

describe('applyBookOverlay — only summary and genres move', () => {
	const t = compiled(baseFile())

	test('an overlaid record differs from the served one in summary and genres ONLY', () => {
		const served = record({
			subtitle: 'A Subtitle',
			seriesSecondary: { name: 'A Tag Series', position: '7' },
			image: 'https://example.invalid/c.jpg',
			description: 'provider description'
		})
		const out = applyBookOverlay(served, served, 'B0SYNTH001', t) as Json
		const changed = Object.keys({ ...served, ...out }).filter(
			(k) => JSON.stringify(out[k]) !== JSON.stringify((served as Json)[k])
		)
		expect(changed.sort()).toEqual(['genres', 'summary'])
		expect((out.genres as { name: string }[]).map((g) => g.name)).toEqual([
			'Fantasy',
			'Epic Fantasy',
			'High Fantasy',
			'Adventure'
		])
		expect(out.summary).toContain('A synthetic hook about a lantern road.')
		// The served record itself is never mutated.
		expect(served.summary).toBe('<p>The provider blurb.</p>')
	})

	test('genres are REPLACED, never merged with the provider list', () => {
		const out = applyBookOverlay(record(), record(), 'B0SYNTH001', t) as Json
		const names = (out.genres as { name: string }[]).map((g) => g.name)
		expect(names).not.toContain('Science Fiction & Fantasy')
	})

	test('with the overlay switched off the served object comes back untouched — the SAME object', () => {
		const served = record()
		expect(applyBookOverlay(served, served, 'B0SYNTH001', null)).toBe(served)
		expect(applyBookOverlay(served, served, 'B0SYNTH001', undefined)).toBe(served)
		// And with the overlay ON, a book that has no entry is also the same object.
		const other = record({ title: 'No Entry', narrators: [{ name: 'Nobody' }] })
		expect(applyBookOverlay(other, other, 'B0NOENTRY0', t)).toBe(other)
	})

	test('keys come from the PRE-pin record; the text renders from the SERVED one', () => {
		// A pin rewrote the title (displayTitle) and the shelf. The lookup must
		// still find the book by its pre-pin title, and the Series line must state
		// the shelf actually served.
		const prePin = record({ title: 'The Lantern Road' })
		const served = record({
			title: 'The Lantern Road: Pinned Display Title',
			seriesPrimary: { name: 'Pinned Shelf', position: '3' }
		})
		const out = applyBookOverlay(served, prePin, 'B0REMATCH7', t) as Json
		expect(out.title).toBe('The Lantern Road: Pinned Display Title')
		expect(out.summary).toContain('Series: Pinned Shelf, Book 3 of 3')
		// Keyed off the served (post-pin) title instead, it would have missed.
		expect(applyBookOverlay(served, served, 'B0REMATCH7', t)).toBe(served)
	})

	test('a work-only match leaves out the recording-scoped award', () => {
		const other = record({ narrators: [{ name: 'Someone Else' }] })
		const out = applyBookOverlay(other, other, 'B0REMATCH8', t) as Json
		expect(out.summary).toContain('Lantern Prize 2020: Best Novel (winner)')
		expect(out.summary).not.toContain('Voice Medal')
		const own = applyBookOverlay(record(), record(), 'B0SYNTH001', t) as Json
		expect(own.summary).toContain('Voice Medal 2021: Best Narration (finalist)')
	})
})

describe('the approved genre vocabulary', () => {
	test('every name serves as a schema-valid genre, exactly as spelled', () => {
		const names = [...OVERLAY_GENRE_VOCABULARY]
		const genres = overlayGenres(names)
		expect(genres.map((g) => g.name)).toEqual(names)
		for (const g of genres) expect(ApiGenreSchema.safeParse(g).success).toBe(true)
	})

	test('the community mapper serves every approved name exactly as the overlay does', () => {
		// This pinned the opposite until 2026-10-16: namesToGenres dropped these
		// two as noise (31 characters; five words), which was the reason given for
		// the bypass. It now exempts the approved list, so the two paths agree,
		// synthetic ids included, on every name.
		for (const n of ['Fairy Tales, Folk Tales & Myths', 'Movie, TV & Video Game Tie-Ins'])
			expect(OVERLAY_GENRE_VOCABULARY.has(n)).toBe(true)
		for (const n of OVERLAY_GENRE_VOCABULARY) expect(namesToGenres([n])).toEqual(overlayGenres([n]))
	})

	test('no umbrella container and no case-duplicate is in the list', () => {
		for (const c of OVERLAY_GENRE_CONTAINERS) expect(OVERLAY_GENRE_VOCABULARY.has(c)).toBe(false)
		const folded = [...OVERLAY_GENRE_VOCABULARY].map((n) => n.toLowerCase())
		expect(new Set(folded).size).toBe(folded.length)
		// The two context rules' targets (PLAN-v2 4.4) must be servable.
		for (const n of ['Epic Fantasy', 'Epic Poetry', 'Historical Fantasy', 'Historical Fiction'])
			expect(OVERLAY_GENRE_VOCABULARY.has(n)).toBe(true)
	})

	test('a fixture work with its own genres is accepted (the gate is not over-tight)', () => {
		const t = compiled(
			mutate((f) => {
				f.works['lantern-road'] = work({
					genres: [
						'Classics',
						'Poetry',
						'Epic Poetry',
						'Ancient World',
						'Fairy Tales, Folk Tales & Myths'
					]
				})
			})
		)
		expect(t.byId.has('B0SYNTH001')).toBe(true)
	})
})

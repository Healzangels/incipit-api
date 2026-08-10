import { describe, expect, test } from 'bun:test'

import {
	dedupeKey,
	isGenericShelf,
	isNoiseShelf,
	isSelfReference,
	MAX_MERGED_GENRES,
	mergeGenres,
	normalizeDisplay,
	splitJoinedShelf
} from '#helpers/providers/genreNormalize'
import { namesToGenres } from '#helpers/providers/hardcoverGenres'

/**
 * EVERY CASE HERE IS A REAL VALUE, sampled from Chaptarr against 14 books in
 * the live library on 2026-08-09. The community feed is user-authored shelves,
 * so the failure mode is not "wrong genre" but "not a genre at all" — and the
 * pre-existing cleaning chain caught none of these, because none of them
 * differs from a good name by case or emoji.
 */

const g = (name: string) => ({ asin: '1000000001', name, type: 'genre' as const })

describe('splitJoinedShelf', () => {
	test('a semicolon-joined shelf is FOUR genres, not one', () => {
		// Measured on Fallen Sepulchre.
		expect(splitJoinedShelf('Epic; Action & Adventure; Dark Fantasy; Sword & Sorcery')).toEqual([
			'Epic',
			'Action & Adventure',
			'Dark Fantasy',
			'Sword & Sorcery'
		])
	})

	test('a BISAC path splits into its parts', () => {
		// Measured on Split Infinity. "General" is dropped downstream as noise.
		expect(splitJoinedShelf('Fiction / Fantasy / General')).toEqual([
			'Fiction',
			'Fantasy',
			'General'
		])
	})

	test('COMMAS ARE NOT SPLIT — real categories contain them', () => {
		// The same reason the bundle refuses to split the files' own ©gen tags.
		expect(splitJoinedShelf('Mystery, Thriller & Suspense')).toEqual([
			'Mystery, Thriller & Suspense'
		])
	})
})

describe('dedupeKey', () => {
	test('a trailing "fiction" is NOT stripped — that fold belongs in the table', () => {
		// It was stripped here once, and it collapsed Audible's "Science Fiction"
		// onto "science", colliding a major genre with the unrelated "Science".
		// The pairs that really are the same genre are named in the canonical
		// table instead; Audible's own distinct pair proves why a blanket rule
		// cannot work — it lists "Historical" AND "Historical Fiction".
		expect(dedupeKey('Science Fiction')).not.toBe(dedupeKey('Science'))
		expect(dedupeKey('Historical Fiction')).not.toBe(dedupeKey('Historical'))
		// Casing and punctuation still fold, which is all this key promises.
		expect(dedupeKey('Science fiction')).toBe(dedupeKey('Science Fiction'))
	})

	test('collapses English plurals, including -ies', () => {
		// "Anthologies" and "Anthology" both arrived as NEW on Sharp Ends.
		expect(dedupeKey('Anthologies')).toBe(dedupeKey('Anthology'))
		expect(dedupeKey('childrens')).toBe(dedupeKey('Children'))
	})

	test('never reduces a standalone genre to nothing', () => {
		// The "fiction" strip is guarded on a remainder; without the guard the
		// genre "Fiction" keys to '' and every book sharing that key collapses.
		expect(dedupeKey('Fiction')).toBe('fiction')
		expect(dedupeKey('Fiction')).not.toBe('')
	})

	test('distinct genres keep distinct keys', () => {
		const keys = ['Fantasy', 'Horror', 'Romance', 'Mystery', 'Dark Academia'].map(dedupeKey)
		expect(new Set(keys).size).toBe(5)
	})
})

describe('isNoiseShelf', () => {
	test('drops the noise the live sample actually produced', () => {
		for (const name of [
			'Ebooks', // a format
			'Intercontinental ballistic missiles', // a subject heading, 35 chars
			'Growing Up & Facts of Life', // shelf prose, 5 real words
			'Colecção Suspense', // a Portuguese collection
			'General', // BISAC filler
			'to read', // reading status
			'1980s' // shelving by decade
		]) {
			expect(isNoiseShelf(name)).toBe(true)
		}
	})

	test('KEEPS the genres that make this change worth making', () => {
		for (const name of [
			'Dark Academia',
			'Epic Fantasy',
			'High Fantasy',
			'Historical Fiction',
			'Espionage',
			'Enemies to lovers',
			'Fantasy romance',
			'Science Fiction & Fantasy', // 25 chars, three real words
			'Mystery, Thriller & Suspense' // 28 chars — a real Audible category
		]) {
			expect(isNoiseShelf(name)).toBe(false)
		}
	})
})

describe('what the FULL-LIBRARY diff exposed that a 14-book sample did not', () => {
	// Everything here comes from running the merge across all 1,758 cached books
	// on 2026-08-09. The sample-derived rules above passed every one of these
	// through; scale is what found them.

	test('pipe- and colon-joined shelves split like the others', () => {
		expect(splitJoinedShelf('Literature & Fiction|Mystery')).toEqual([
			'Literature & Fiction',
			'Mystery'
		])
		expect(splitJoinedShelf('Literature & Fiction:Classics')).toEqual([
			'Literature & Fiction',
			'Classics'
		])
	})

	test('a parenthetical qualifier is a catalogue entity, never a genre', () => {
		for (const name of [
			'Frodo (Fictitious character)',
			'Discworld (Imaginary place)',
			'Belfast (Northern Ireland)',
			'Adirondack Mountains (N.Y.)'
		]) {
			expect(isNoiseShelf(name)).toBe(true)
		}
	})

	test('spelled-out "and" marks a subject heading; "&" marks a real genre', () => {
		// The discriminator between the two vocabularies, and the reason
		// "Detective and mystery stories" survived the word-count rule: "and" was
		// treated as a connector and not counted.
		for (const lcsh of [
			'Detective and mystery stories',
			'Imaginary wars and battles',
			'Free will and determinism',
			'Adventure and adventurers'
		]) {
			expect(isNoiseShelf(lcsh)).toBe(true)
		}
		for (const real of ['Science Fiction & Fantasy', 'Comics & Graphic Novels']) {
			expect(isNoiseShelf(real)).toBe(false)
		}
	})

	test('a year anywhere means a reading list', () => {
		expect(isNoiseShelf('Read Next 2024')).toBe(true)
	})

	test('LCSH format headings are dropped', () => {
		expect(isNoiseShelf('Chinese language materials')).toBe(true)
	})
})

describe('canonical spelling across books', () => {
	// Within a book dedupeKey already collapsed these. ACROSS books nothing did,
	// so Plex's genre filter would have listed "Fantasy" and "Fantasy fiction"
	// as two tags. All 20 pairs came from the full-library diff.
	const canonicalOf = (name: string) => namesToGenres([name])[0]?.name

	test('every spelling of a genre resolves to ONE display name', () => {
		for (const [a, b] of [
			['Fantasy', 'Fantasy fiction'],
			['Classics', 'Classic'],
			['Children', 'Childrens'],
			['Thriller', 'Thrillers'],
			['Military', 'Military Fiction'],
			['Apocalyptic', 'Apocalyptic fiction'],
			['Graphic novels', 'Graphic Novel'],
			['African Americans', 'African American'],
			['Art', 'Arts'],
			['Craft', 'Crafts'],
			['Family', 'Families']
		]) {
			expect(canonicalOf(a)).toBe(canonicalOf(b) as string)
		}
	})

	test("Audible's own spelling is the one adopted where it has one", () => {
		expect(canonicalOf('Fantasy fiction')).toBe('Fantasy')
		expect(canonicalOf('Military Fiction')).toBe('Military')
		expect(canonicalOf('Science fiction')).toBe('Science Fiction')
		expect(canonicalOf('Anthology')).toBe('Anthologies')
	})

	test('an Audible genre is NEVER merged into another Audible genre', () => {
		// Audible lists "Historical" and "Historical Fiction" as separate
		// categories, so folding one into the other would destroy a real
		// distinction. This is why the "X fiction" pairs are enumerated rather
		// than derived — the extras table is consulted only for keys Audible has
		// no entry for.
		expect(canonicalOf('Historical Fiction')).toBe('Historical Fiction')
		expect(canonicalOf('Historical')).toBe('Historical')
		expect(canonicalOf('Animal fiction')).toBe('Animal Fiction')
	})

	test('an unlisted genre keeps its own name', () => {
		// The table is only the collisions the diff produced; everything else is
		// left alone rather than guessed at.
		expect(canonicalOf('Dark Academia')).toBe('Dark Academia')
		expect(canonicalOf('Espionage')).toBe('Espionage')
	})
})

describe('normalizeDisplay', () => {
	test('title-cases an all-lowercase shelf', () => {
		expect(normalizeDisplay('dragons')).toBe('Dragons')
	})

	test('leaves anything already carrying a capital alone', () => {
		// Rewriting these would be worse than the casing it fixes.
		for (const name of ['YA', 'Sci-Fi', 'Dark Academia', 'iRobot']) {
			expect(normalizeDisplay(name)).toBe(name)
		}
	})
})

describe('isSelfReference', () => {
	test('a series shelved as a genre on its own book is dropped', () => {
		// "Harry Potter" arrived as a genre on Goblet of Fire.
		expect(
			isSelfReference('Harry Potter', { title: 'Harry Potter and the Goblet of Fire' })
		).toBe(true)
		expect(isSelfReference('Wheel of Time', { series: 'The Wheel of Time' })).toBe(true)
	})

	test('a real genre is never mistaken for the book', () => {
		expect(isSelfReference('Fantasy', { title: 'Harry Potter and the Goblet of Fire' })).toBe(
			false
		)
		// A ONE-WORD key is never containment-matched, or "Fire" would eat itself
		// out of any title containing it.
		expect(isSelfReference('Fire', { title: 'Harry Potter and the Goblet of Fire' })).toBe(false)
	})
})

describe('namesToGenres end to end', () => {
	test('the joined shelf yields its usable parts and drops the filler', () => {
		const out = namesToGenres(['Fiction / Fantasy / General']).map((x) => x.name)
		expect(out).toContain('Fantasy')
		expect(out).not.toContain('General')
	})

	test('near-duplicates within one feed collapse to the CANONICAL spelling', () => {
		// Not "the first spelling" — that was the rule before the canonical table
		// existed, and it made the winner depend on the order the feed happened to
		// list them in, which is exactly how the same genre ended up under two
		// names on neighbouring books. Audible writes "Anthologies", so both
		// spellings land there regardless of which arrived first.
		expect(namesToGenres(['Anthology', 'Anthologies']).map((x) => x.name)).toEqual([
			'Anthologies'
		])
		expect(namesToGenres(['Anthologies', 'Anthology']).map((x) => x.name)).toEqual([
			'Anthologies'
		])
		expect(namesToGenres(['Fantasy fiction', 'Fantasy']).map((x) => x.name)).toEqual(['Fantasy'])
	})

	test('self-reference needs the book context to be caught', () => {
		const names = ['Harry Potter', 'Fantasy']
		expect(namesToGenres(names).map((x) => x.name)).toContain('Harry Potter')
		expect(
			namesToGenres(names, { title: 'Harry Potter and the Goblet of Fire' }).map((x) => x.name)
		).toEqual(['Fantasy'])
	})
})

describe('mergeGenres', () => {
	test("Audible's genres survive verbatim, in order, with their ids", () => {
		// The bundle replaces the album's genres wholesale from this list, so a
		// re-order churns Plex tags on every refresh for no gain.
		const existing = [
			{ asin: '18580606011', name: 'Science Fiction & Fantasy', type: 'genre' as const },
			{ asin: '18580628011', name: 'Science Fiction', type: 'tag' as const }
		]
		const merged = mergeGenres(existing, [g('Dark Academia')])
		expect(merged.slice(0, 2)).toEqual(existing)
		expect(merged[2]?.name).toBe('Dark Academia')
	})

	test('an incoming name that folds onto an existing one is dropped', () => {
		const merged = mergeGenres([g('Fantasy')], [g('Fantasy fiction'), g('Epic Fantasy')])
		expect(merged.map((x) => x.name)).toEqual(['Fantasy', 'Epic Fantasy'])
	})

	test('the cap never truncates what the record already had', () => {
		// A record can arrive with more genres than the cap; dropping Audible's own
		// to make room for community shelves would be a regression, not a merge.
		const existing = Array.from({ length: 12 }, (_, i) => g(`Native ${i}`))
		const merged = mergeGenres(existing, [g('Dark Academia')])
		expect(merged).toHaveLength(12)
		expect(merged.every((x) => x.name.startsWith('Native'))).toBe(true)
	})

	test('the merged total is capped', () => {
		const merged = mergeGenres(
			[g('Fantasy')],
			Array.from({ length: 20 }, (_, i) => g(`Extra ${i}`))
		)
		expect(merged).toHaveLength(MAX_MERGED_GENRES)
	})
})

describe('generic umbrellas never outrank specific genres, from ANY source', () => {
	// Measured live 2026-08-10, the second forced refresh after deploy: Fourth
	// Wing was served Hardcover's frequency-ordered eight — with the umbrella
	// "Fiction" at position four — which took every slot before Chaptarr's
	// "High Fantasy" and "Magic" could reach the cap. The album ended up with
	// MORE genres and FEWER useful ones. Chaptarr had been demoted since it was
	// added; Hardcover never was, on the grounds that its frequency order is
	// evidence. Frequency is evidence of what people TAG, not of what is worth
	// showing, and a stable partition keeps that order among the specifics.
	test('Hardcover frequency order is preserved among the real genres', () => {
		const out = namesToGenres([
			'Fantasy',
			'Romantasy',
			'Romance',
			'Fiction',
			'Adventure',
			'High Fantasy',
			'Magic'
		]).map((g) => g.name)
		// The order among the specifics is untouched, and the umbrella is gone
		// entirely rather than parked at the end.
		expect(out).toEqual([
			'Fantasy',
			'Romantasy',
			'Romance',
			'Adventure',
			'High Fantasy',
			'Magic'
		])
	})

	test('a specific genre is never evicted by an umbrella at the cap', () => {
		// Eight specifics plus an umbrella: the umbrella never competes at all.
		// Dropping rather than demoting is what makes this structural — it can
		// only ever free a slot, never take one.
		const names = ['Fiction', 'A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8']
		const out = namesToGenres(names).map((g) => g.name)
		expect(out).not.toContain('Fiction')
		expect(out).toEqual(['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8'])
	})
})

describe('the generic list contains ONLY umbrellas', () => {
	// I added 'classic' to this set while moving it between modules, on the
	// assumption it was umbrella-ish. It is not: "Classics" is a real genre, and
	// demoting it dropped it off The Da Vinci Code below the cap while the shelf
	// "Russian" took the freed slot (measured live 2026-08-10). The list it was
	// moved FROM never contained it. Nothing joins the set without a measured
	// case, and these are the names that must never be in it.
	test('real genres are never demoted as umbrellas', () => {
		for (const real of [
			'Classics',
			'Classic',
			'Historical Fiction',
			'Literary Fiction',
			'Science Fiction',
			'Genre Fiction',
			'Humorous Fiction',
			'Crime Fiction'
		]) {
			expect(isGenericShelf(real)).toBe(false)
		}
	})

	test('the umbrellas themselves still demote', () => {
		for (const umbrella of ['Fiction', 'fiction', 'Nonfiction', 'General', 'Adult', 'Novels']) {
			expect(isGenericShelf(umbrella)).toBe(true)
		}
	})

	test('Classics survives the cap on a real feed', () => {
		// The exact shelf list Chaptarr returns for The Da Vinci Code.
		const out = namesToGenres([
			'adult', 'Adventure', 'Classics', 'Crime', 'Cryptographers', 'Fiction',
			'General', 'Historical Fiction', 'Museum', 'Mystery', 'Mystery Thriller',
			'Novels', 'Russian', 'Suspense', 'Thriller', 'Young Adult'
		]).map((g) => g.name)
		expect(out).toContain('Classics')
		expect(out).not.toContain('Fiction')
	})
})

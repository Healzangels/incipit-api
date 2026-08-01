import { describe, expect, test } from 'bun:test'

import {
	isWrongLanguage,
	languageConflict,
	normalizeLanguage,
	preferLanguage,
	regionLanguage,
	titleEditionLanguage
} from '#helpers/utils/language'

describe('normalizeLanguage', () => {
	test('accepts the three notations providers actually use', () => {
		// Hardcover reports names, Storytel ISO-639-1, OpenLibrary ISO-639-2/MARC.
		expect(normalizeLanguage('German')).toBe('de')
		expect(normalizeLanguage('de')).toBe('de')
		expect(normalizeLanguage('ger')).toBe('de')
		expect(normalizeLanguage('deu')).toBe('de')
	})

	test('is case and whitespace tolerant, and handles native names', () => {
		expect(normalizeLanguage('  ENGLISH  ')).toBe('en')
		expect(normalizeLanguage('Deutsch')).toBe('de')
		expect(normalizeLanguage('Français')).toBe('fr')
		expect(normalizeLanguage('svenska')).toBe('sv')
	})

	test('reduces locale tags to the primary subtag', () => {
		expect(normalizeLanguage('en-GB')).toBe('en')
		expect(normalizeLanguage('pt_BR')).toBe('pt')
	})

	test('a bare 2-letter code counts as ISO-639-1 only as the WHOLE value', () => {
		// Alone (or as a locale tag) it is a code…
		expect(normalizeLanguage('it')).toBe('it')
		expect(normalizeLanguage('no')).toBe('no')
		expect(normalizeLanguage('it-IT')).toBe('it')
		// …but as a word inside a longer value it is just an English word: the
		// per-word probe must not resolve 'it'→Italian, 'no'→Norwegian, 'in'→etc.
		expect(normalizeLanguage('not it')).toBeNull()
		expect(normalizeLanguage('no idea')).toBeNull()
		expect(normalizeLanguage('made in usa')).toBeNull()
		// Full language names still win per-word next to a stray 2-letter word.
		expect(normalizeLanguage('in English')).toBe('en')
	})

	test('returns null for absent or unrecognized input rather than guessing', () => {
		expect(normalizeLanguage(null)).toBeNull()
		expect(normalizeLanguage(undefined)).toBeNull()
		expect(normalizeLanguage('')).toBeNull()
		expect(normalizeLanguage('   ')).toBeNull()
		expect(normalizeLanguage('Klingon')).toBeNull()
		expect(normalizeLanguage('xyz')).toBeNull()
	})
})

describe('regionLanguage', () => {
	test('maps the supported regions', () => {
		expect(regionLanguage('us')).toBe('en')
		expect(regionLanguage('uk')).toBe('en')
		expect(regionLanguage('de')).toBe('de')
		expect(regionLanguage('jp')).toBe('ja')
		expect(regionLanguage('IT')).toBe('it')
	})

	test('null for unknown/absent region', () => {
		expect(regionLanguage('zz')).toBeNull()
		expect(regionLanguage(null)).toBeNull()
		expect(regionLanguage(undefined)).toBeNull()
	})
})

describe('preferLanguage', () => {
	// The ONE shared region-language filter. It used to exist per-provider and
	// drifted: Storytel's copy missed the null-keeping fix and kept dropping
	// untagged results whenever any tagged match existed. These pin the shared
	// semantics; each provider test then only pins its own wiring.
	const items = [
		{ id: 1, lang: 'English' as string | null },
		{ id: 2, lang: 'French' },
		{ id: 3, lang: null }
	]
	const lang = (i: { lang: string | null }): string | null => i.lang

	test('keeps the preferred language AND untagged items', () => {
		expect(preferLanguage(items, 'us', lang).map((i) => i.id)).toEqual([1, 3])
	})

	test('drops a foreign-tagged item but keeps the untagged one', () => {
		expect(preferLanguage(items.slice(1), 'us', lang).map((i) => i.id)).toEqual([3])
	})

	test('falls back to ALL items when nothing matches even the loose filter', () => {
		const frOnly = [{ id: 2, lang: 'French' }]
		expect(preferLanguage(frOnly, 'us', lang)).toEqual(frOnly)
	})

	test('unknown region filters nothing', () => {
		expect(preferLanguage(items, 'zz', lang)).toEqual(items)
	})

	test('compares across notations (raw values are normalized)', () => {
		// A Storytel-style ISO code must match `want` just like a Hardcover name.
		const iso = [
			{ id: 1, lang: 'en' },
			{ id: 2, lang: 'fr' }
		]
		expect(preferLanguage(iso, 'us', lang).map((i) => i.id)).toEqual([1])
	})
})

describe('languageConflict', () => {
	test('the same language in DIFFERENT notations is never a conflict', () => {
		// The whole point of normalizing: Hardcover "English", OpenLibrary "eng"
		// and Storytel "en" describe one language and must agree.
		expect(languageConflict('English', 'eng')).toBe(false)
		expect(languageConflict('en', 'English')).toBe(false)
		expect(languageConflict('ger', 'Deutsch')).toBe(false)
	})

	test('flags a genuine clash', () => {
		expect(languageConflict('English', 'German')).toBe(true)
		expect(languageConflict('eng', 'spa')).toBe(true)
		expect(languageConflict('en', 'ja')).toBe(true)
	})

	test('UNKNOWN never counts as a conflict (load-bearing)', () => {
		// Provider language data is patchy and real English audio editions often
		// carry no tag. Treating absent as a mismatch would demote correct
		// editions and lose books entirely, so it must stay non-actionable.
		expect(languageConflict(null, 'English')).toBe(false)
		expect(languageConflict('English', null)).toBe(false)
		expect(languageConflict(null, null)).toBe(false)
		expect(languageConflict('Klingon', 'English')).toBe(false)
		expect(languageConflict('', 'de')).toBe(false)
	})

	test('Norwegian macrolanguage: nb/nn/nob/nno/Bokmål all fold to no — never self-conflict', () => {
		// One provider tags 'nb', another 'Bokmål' for the SAME narration; a
		// positive conflict here made dedupe refuse to merge identical-language
		// editions and byLanguage treat them as rivals.
		expect(normalizeLanguage('nb')).toBe('no')
		expect(normalizeLanguage('nn')).toBe('no')
		expect(normalizeLanguage('nob')).toBe('no')
		expect(normalizeLanguage('Bokmål')).toBe('no')
		expect(languageConflict('nb', 'Bokmål')).toBe(false)
		expect(languageConflict('nn', 'Norwegian')).toBe(false)
	})

	test('multi-word provider names resolve instead of silently missing', () => {
		expect(normalizeLanguage('Norwegian Bokmål')).toBe('no')
		expect(normalizeLanguage('Simplified Chinese')).toBe('zh')
		expect(normalizeLanguage('Brazilian Portuguese')).toBe('pt')
	})

	test('NFD input and ASCII-folded spellings both resolve', () => {
		// macOS-originated metadata arrives NFD: 'a' + combining ring (U+030A),
		// spelled explicitly so these literals cannot be silently NFC.
		expect(normalizeLanguage('bokma\u030al')).toBe('no')
		expect(normalizeLanguage('i\u0301slenska')).toBe('is')
		// ASCII-folded catalog spellings, including the entries whose hand-added
		// twins were missing before key folding became automatic at module init.
		expect(normalizeLanguage('Islenska')).toBe('is')
		expect(normalizeLanguage('Slovencina')).toBe('sk')
		expect(normalizeLanguage('Slovenscina')).toBe('sl')
	})
})

/**
 * THE wrong-language rule, in one place.
 *
 * The scorer's demotion and the ranker's tiebreak each carried their own copy
 * of "the language field conflicts OR the title carries a foreign-edition
 * marker", and the copies had drifted: the tiebreak's had lost the ASIN-pin
 * exemption, and NEITHER conditioned the marker leg on the language actually
 * wanted. For a German-region query that flagged the CORRECT German edition as
 * wrong-language while an untagged English row sailed through.
 */
describe('titleEditionLanguage', () => {
	test('reads the language a marker NAMES, in both spellings', () => {
		expect(titleEditionLanguage('Dune (German Edition)')).toBe('de')
		expect(titleEditionLanguage('Dune (Spanish Version)')).toBe('es')
		expect(titleEditionLanguage('Dune: Ungekürzte Ausgabe')).toBe('de')
		expect(titleEditionLanguage('Duna: edición completa')).toBe('es')
		expect(titleEditionLanguage('Dune: edizione integrale')).toBe('it')
		// ASCII "edition française". The accented "édition" spelling is NOT matched
		// — `\b` is ASCII-only, so it never fires before "é" — an inherited quirk of
		// the marker pattern, carried over unchanged rather than widened here.
		expect(titleEditionLanguage('Dune: edition française')).toBe('fr')
	})

	test('stays narrow: an ordinary title, or a merely foreign-looking one, names nothing', () => {
		// A bare foreign word must not count, or legitimately foreign-titled
		// English books get flagged.
		expect(titleEditionLanguage('Dune')).toBeNull()
		expect(titleEditionLanguage('Das Boot')).toBeNull()
		expect(titleEditionLanguage('The Girl with the Dragon Tattoo')).toBeNull()
		expect(titleEditionLanguage(null)).toBeNull()
		expect(titleEditionLanguage('')).toBeNull()
	})
})

describe('isWrongLanguage', () => {
	const want = 'en'

	test('a conflicting language FIELD is wrong-language', () => {
		expect(isWrongLanguage({ language: 'de', title: 'Dune' }, want, 'Dune', false)).toBe(true)
		expect(isWrongLanguage({ language: 'en', title: 'Dune' }, want, 'Dune', false)).toBe(false)
		// Unknown is never a conflict — provider language data is patchy.
		expect(isWrongLanguage({ language: null, title: 'Dune' }, want, 'Dune', false)).toBe(false)
	})

	test('a title marker naming ANOTHER language is wrong-language', () => {
		// The case the marker exists for: the field is null or mislabeled and only
		// the title betrays the translation.
		expect(
			isWrongLanguage({ language: null, title: 'Dune (Spanish Edition)' }, want, 'Dune', false)
		).toBe(true)
	})

	test('a title marker naming the WANTED language is not', () => {
		// The defect: for region=de, "Ausgabe"/"German Edition" IS the wanted
		// edition. Flagging it seated the correct German audio edition last.
		expect(
			isWrongLanguage({ language: null, title: 'Dune (German Edition)' }, 'de', 'Dune', false)
		).toBe(false)
		expect(
			isWrongLanguage({ language: null, title: 'Dune: Ungekürzte Ausgabe' }, 'de', 'Dune', false)
		).toBe(false)
		// ...and the same row IS wrong for an English-region query.
		expect(
			isWrongLanguage({ language: null, title: 'Dune (German Edition)' }, 'en', 'Dune', false)
		).toBe(true)
	})

	test('an ASIN pin is exempt from BOTH legs', () => {
		// The exemption the tiebreak's copy had lost. An exact ASIN is an identity
		// the caller named, so honour it even when its language differs.
		expect(isWrongLanguage({ language: 'de', title: 'Dune' }, want, 'Dune', true)).toBe(false)
		expect(
			isWrongLanguage({ language: null, title: 'Dune (Spanish Edition)' }, want, 'Dune', true)
		).toBe(false)
	})

	test('a query that ASKED for an edition marker is not contradicted by one', () => {
		expect(
			isWrongLanguage(
				{ language: null, title: 'Dune (Spanish Edition)' },
				want,
				'Dune (Spanish Edition)',
				false
			)
		).toBe(false)
	})

	test('no language expectation means nothing to conflict with', () => {
		expect(
			isWrongLanguage({ language: 'de', title: 'Dune (German Edition)' }, null, 'Dune', false)
		).toBe(false)
	})
})

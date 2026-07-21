import { describe, expect, test } from 'bun:test'

import { languageConflict, normalizeLanguage, regionLanguage } from '#helpers/utils/language'

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

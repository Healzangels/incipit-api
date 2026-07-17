import { describe, expect, test } from 'bun:test'

import {
	decodeProviderId,
	encodeHardcoverBook,
	encodeHardcoverEdition,
	encodeOpenLibraryWork,
	isAsin
} from '#helpers/providers/providerId'

describe('provider id encoding', () => {
	test('encodings are GUID-safe (no colon or slash) and underscore-free', () => {
		const ids = [
			encodeHardcoverEdition(31501578),
			encodeHardcoverBook(119295),
			encodeOpenLibraryWork('/works/OL80870W')
		]
		for (const id of ids) {
			expect(id).not.toMatch(/[:/_]/)
		}
	})

	test('OpenLibrary work key strips the /works/ prefix', () => {
		expect(encodeOpenLibraryWork('/works/OL80870W')).toBe('openlibrary-works-OL80870W')
		expect(encodeOpenLibraryWork('works/OL80870W')).toBe('openlibrary-works-OL80870W')
	})
})

describe('provider id round-trips', () => {
	const cases: Array<[string, ReturnType<typeof decodeProviderId>]> = [
		[
			encodeHardcoverEdition(31501578),
			{ provider: 'hardcover', kind: 'edition', nativeId: '31501578' }
		],
		[encodeHardcoverBook(119295), { provider: 'hardcover', kind: 'book', nativeId: '119295' }],
		[
			encodeOpenLibraryWork('/works/OL80870W'),
			{ provider: 'openlibrary', kind: 'works', nativeId: '/works/OL80870W' }
		]
	]
	for (const [id, expected] of cases) {
		test(`decode("${id}")`, () => {
			expect(decodeProviderId(id)).toEqual(expected)
		})
	}
})

describe('ASINs are pass-through, not provider ids', () => {
	test('a plain ASIN decodes to null (handled by the audnexus path)', () => {
		expect(decodeProviderId('B08G9PRS1K')).toBeNull()
		expect(isAsin('B08G9PRS1K')).toBe(true)
	})

	test('non-ASIN, non-encoded strings decode to null', () => {
		expect(decodeProviderId('not-an-id')).toBeNull()
		expect(decodeProviderId('')).toBeNull()
		expect(isAsin('hardcover-book-1')).toBe(false)
	})
})

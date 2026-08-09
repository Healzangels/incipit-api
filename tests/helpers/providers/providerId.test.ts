import { describe, expect, test } from 'bun:test'

import {
	decodeProviderId,
	encodeAppleAudiobook,
	encodeHardcoverBook,
	encodeHardcoverEdition,
	encodeOpenLibraryWork,
	encodeStorytel,
	isAsin
} from '#helpers/providers/providerId'

describe('provider id encoding', () => {
	test('encodings are GUID-safe (no colon or slash) and underscore-free', () => {
		const ids = [
			encodeHardcoverEdition(31501578),
			encodeHardcoverBook(119295),
			encodeOpenLibraryWork('/works/OL80870W'),
			encodeAppleAudiobook(1565808256)
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
		],
		[
			encodeAppleAudiobook(1565808256),
			{ provider: 'apple', kind: 'audiobook', nativeId: '1565808256' }
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

describe('the decoder refuses ids it never minted', () => {
	// The decoded nativeId is interpolated UNENCODED into an outbound URL
	// (`${OL_BASE}${nativeId}.json`) on a route reachable by anyone who can
	// reach the port, so `(.+)` made the id decoder a path-injection and
	// outbound-request amplifier. Refused ids fall through to the ASIN rule,
	// which 400s them.
	test('a traversal / query / absolute URL is not an OpenLibrary id', () => {
		expect(decodeProviderId('openlibrary-works-../../etc/passwd')).toBeNull()
		expect(decodeProviderId('openlibrary-works-OL1W?x=1')).toBeNull()
		expect(decodeProviderId('openlibrary-works-https://evil.invalid/x')).toBeNull()
		expect(decodeProviderId('openlibrary-works-OL1W/../../x')).toBeNull()
		expect(decodeProviderId('openlibrary-works-')).toBeNull()
	})

	test('real OpenLibrary ids still decode, all three id types', () => {
		expect(decodeProviderId('openlibrary-works-OL80870W')).toEqual({
			provider: 'openlibrary',
			kind: 'works',
			nativeId: '/works/OL80870W'
		})
		expect(decodeProviderId('openlibrary-works-OL123M')?.nativeId).toBe('/works/OL123M')
		expect(decodeProviderId('openlibrary-works-OL7A')?.nativeId).toBe('/works/OL7A')
	})

	test('Storytel ids may be opaque but never carry a separator', () => {
		expect(decodeProviderId('storytel-14117566')?.nativeId).toBe('14117566')
		expect(decodeProviderId('storytel-abc_123-x')?.nativeId).toBe('abc_123-x')
		expect(decodeProviderId('storytel-../../x')).toBeNull()
		expect(decodeProviderId('storytel-a/b')).toBeNull()
		expect(decodeProviderId('storytel-a.b')).toBeNull()
	})

	test('a round trip through the ENCODER always decodes', () => {
		// The guard must never refuse an id this codebase itself mints.
		expect(decodeProviderId(encodeOpenLibraryWork('/works/OL80870W'))).not.toBeNull()
		expect(decodeProviderId(encodeStorytel(14117566))).not.toBeNull()
	})
})

import { describe, expect, test } from 'bun:test'

import OverDriveProvider, { type OverDriveFetch } from '#helpers/providers/OverDriveProvider'
import { decodeProviderId, encodeOverdrive } from '#helpers/providers/providerId'

// A Thunder search item, shaped as the live API returns it (verified against
// thunder.api.overdrive.com): title as a string, creators with roles, runtime
// inside formats[].duration, covers keyed by width, series as a string.
const deadItem = {
	id: 265555,
	title: 'Dead I Well May Be',
	creators: [
		{ name: 'Adrian McKinty', role: 'Author' },
		{ name: 'Gerard Doyle', role: 'Narrator' }
	],
	formats: [{ id: 'audiobook-overdrive', duration: '11:09:00' }, { id: 'audiobook-mp3' }],
	covers: {
		cover150Wide: { href: 'https://od-cdn/150.jpg', width: 150 },
		cover510Wide: { href: 'https://od-cdn/510.jpg', width: 510 }
	},
	series: 'Michael Forsythe',
	languages: [{ id: 'en', name: 'English' }]
}

const search =
	(items: unknown[]): OverDriveFetch =>
	async () => ({ items })

const q = { title: 'Dead I Well May Be', author: 'Adrian McKinty', region: 'us' }

describe('OverDriveProvider search', () => {
	test('maps an audiobook to a candidate with narrator, runtime, and the widest cover', async () => {
		const p = new OverDriveProvider({ fetchThunder: search([deadItem]) })
		const [c] = await p.search(q)
		expect(c.provider).toBe('overdrive')
		expect(c.id).toBe('overdrive-265555')
		expect(c.asin).toBeNull()
		expect(c.title).toBe('Dead I Well May Be')
		expect(c.authors).toEqual(['Adrian McKinty'])
		expect(c.narrators).toEqual(['Gerard Doyle'])
		expect(c.audioSeconds).toBe(11 * 3600 + 9 * 60) // "11:09:00" -> 40140s
		expect(c.cover).toBe('https://od-cdn/510.jpg')
		expect(c.language).toBe('en')
	})

	test('the id round-trips through the provider-id codec to a fetchable media id', () => {
		expect(decodeProviderId(encodeOverdrive(265555))).toEqual({
			provider: 'overdrive',
			kind: 'media',
			nativeId: '265555'
		})
	})

	test('handles the object title shape and a missing narrator/runtime', async () => {
		const p = new OverDriveProvider({
			fetchThunder: search([
				{ id: 1, title: { main: 'A Book' }, creators: [{ name: 'X', role: 'Author' }] }
			])
		})
		const [c] = await p.search(q)
		expect(c.title).toBe('A Book')
		expect(c.narrators).toEqual([])
		expect(c.audioSeconds).toBeNull() // no formats -> no duration signal, not a contradiction
		expect(c.cover).toBeNull()
	})

	test('targets the configured library and one keyword query (no structured author filter)', async () => {
		let seen = ''
		const p = new OverDriveProvider({
			library: 'mylib',
			fetchThunder: async (url) => {
				seen = url
				return { items: [] }
			}
		})
		await p.search(q)
		expect(seen).toContain('/libraries/mylib/media?')
		expect(seen).toContain('query=Dead+I+Well+May+Be+Adrian+McKinty')
		expect(seen).toContain('format=audiobook-overdrive')
	})

	test('returns [] on a transport failure rather than throwing', async () => {
		const p = new OverDriveProvider({
			fetchThunder: async () => {
				throw new Error('down')
			}
		})
		expect(await p.search(q)).toEqual([])
	})

	test('returns [] for an empty query title', async () => {
		const p = new OverDriveProvider({ fetchThunder: search([deadItem]) })
		expect(await p.search({ title: '', region: 'us' })).toEqual([])
	})
})

describe('OverDriveProvider fetchBook', () => {
	const detail = {
		id: 265555,
		title: 'Dead I Well May Be',
		creators: [
			{ name: 'Adrian McKinty', role: 'Author' },
			{ name: 'Gerard Doyle', role: 'Narrator' }
		],
		covers: { cover510Wide: { href: 'https://od-cdn/510.jpg', width: 510 } },
		detailedSeries: { seriesId: 535510, seriesName: 'Michael Forsythe', readingOrder: '1' },
		description: '<p><strong>Irish bad-boy thriller.</strong>&nbsp;New York City.</p>',
		starRating: 4.1,
		publishDate: '2003-01-01T00:00:00Z',
		publisher: { name: 'Blackstone Publishing' },
		languages: [{ id: 'en', name: 'English' }]
	}

	test('resolves full metadata: series+position, stripped description, rating, language', async () => {
		const p = new OverDriveProvider({ fetchThunder: async () => detail })
		const b = await p.fetchBook('265555', 'media', { region: 'us' })
		expect(b?.title).toBe('Dead I Well May Be')
		expect(b?.narrators).toEqual([{ name: 'Gerard Doyle' }])
		expect(b?.seriesPrimary).toEqual({ name: 'Michael Forsythe', position: '1' })
		expect(b?.summary).toBe('Irish bad-boy thriller. New York City.')
		expect(b?.rating).toBe('4.1')
		expect(b?.image).toBe('https://od-cdn/510.jpg')
		expect(b?.publisherName).toBe('Blackstone Publishing')
		expect(b?.language).toBe('en')
		expect(b?.asin).toBeNull()
	})

	test('falls back to the plain series string when detailedSeries is absent', async () => {
		const p = new OverDriveProvider({
			fetchThunder: async () => ({ id: 2, title: 'B', series: 'Some Series' })
		})
		const b = await p.fetchBook('2', 'media', { region: 'us' })
		expect(b?.seriesPrimary).toEqual({ name: 'Some Series' })
	})

	test('returns null on a transport failure', async () => {
		const p = new OverDriveProvider({
			fetchThunder: async () => {
				throw new Error('down')
			}
		})
		expect(await p.fetchBook('265555', 'media', { region: 'us' })).toBeNull()
	})
})

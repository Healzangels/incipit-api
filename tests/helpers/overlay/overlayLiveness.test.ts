import { describe, expect, test } from 'bun:test'

import { baseFile } from './fixtures'

import { compileOverlay, overlayNarrationKey, overlayTitleKey } from '#helpers/overlay/bookOverlay'
import {
	albumsByTitleKey,
	decodeXmlAttr,
	overlayLiveness,
	plexAlbumRows
} from '#helpers/overlay/overlayLiveness'

const table = (() => {
	const r = compileOverlay(baseFile())
	if (!r.ok) throw new Error(r.errors.join('; '))
	return r.table
})()

/** One album row in the shape Plex really serves it: the FULL agent prefix, a
 *  region suffix, the artist's parentGuid on the same row, a titleSort. */
const row = (id: string, title: string, artist: string) =>
	`<Directory ratingKey="1" guid="com.plexapp.agents.incipit://${id}_us?lang=en" ` +
	`parentGuid="com.plexapp.agents.incipit://B000ARTIST?lang=en" type="album" ` +
	`title="${title}" titleSort="Shelf, Book 1 - ${title}" parentTitle="${artist}">`

describe('plexAlbumRows', () => {
	test('reads id, title and artist — never the parentGuid, parentTitle or titleSort', () => {
		const xml = `<MediaContainer>${row('B0SYNTH001', 'The Lantern Road', 'Ada Quill')}${row(
			'hardcover-book-424242',
			'Rock &amp; Roll &#39;Tale&#39;',
			'Fen Writer'
		)}</MediaContainer>`
		expect(plexAlbumRows(xml)).toEqual([
			{ id: 'B0SYNTH001', title: 'The Lantern Road', artist: 'Ada Quill' },
			{ id: 'hardcover-book-424242', title: "Rock & Roll 'Tale'", artist: 'Fen Writer' }
		])
	})

	test('attribute ORDER does not matter: a parentGuid written first is still not the album', () => {
		const xml =
			'<Directory parentGuid="com.plexapp.agents.incipit://B000ARTIST?lang=en" ' +
			'parentTitle="Ada Quill" titleSort="x" ' +
			'guid="com.plexapp.agents.incipit://B0SYNTH001_us?lang=en" title="The Lantern Road">'
		expect(plexAlbumRows(xml)).toEqual([
			{ id: 'B0SYNTH001', title: 'The Lantern Road', artist: 'Ada Quill' }
		])
	})

	test('decodes numeric and named entities', () => {
		expect(decodeXmlAttr('Jim Dale&#39;s &quot;Phoenix&quot; &#xE9; &amp;')).toBe(
			'Jim Dale\'s "Phoenix" é &'
		)
	})
})

describe('overlayLiveness', () => {
	test('live by id, live by key only, dead', () => {
		const rows = plexAlbumRows(
			row('B0SYNTH001', 'The Lantern Road', 'Ada Quill') +
				// B0SYNTH002 is absent; its narration key reaches a re-matched album.
				row('B0OTHER002', 'The Tide Clock', 'Ada Quill')
		)
		const byKey = albumsByTitleKey(rows)
		byKey.set(overlayNarrationKey('The Tide Clock', 'Ada Quill', 'Cora Voice'), ['B0OTHER002'])
		const r = overlayLiveness(
			table,
			rows.map((x) => x.id),
			byKey
		)
		expect(r.total).toBe(4)
		expect(r.live).toEqual(['B0SYNTH001', 'B0SYNTH002'])
		expect(r.byKeyOnly).toEqual(['B0SYNTH002'])
		expect(r.dead).toEqual(['B0SYNTH003', 'hardcover-book-424242'])
		expect(r.ambiguous).toEqual([])
	})

	test('a served key reaching two albums is AMBIGUOUS; a withheld key is not reported', () => {
		const rows = plexAlbumRows(
			row('B0SYNTH001', 'The Lantern Road', 'Ada Quill') +
				row('B0DUPE0001', 'The Lantern Road', 'Ada Quill') +
				// Two Tide Clock albums: their plain key was WITHHELD at load, so it
				// can reach nothing and is not an ambiguity.
				row('B0SYNTH002', 'The Tide Clock', 'Ada Quill') +
				row('B0SYNTH003', 'The Tide Clock', 'Ada Quill')
		)
		const r = overlayLiveness(
			table,
			rows.map((x) => x.id),
			albumsByTitleKey(rows)
		)
		expect(r.ambiguous).toEqual([
			{
				key: overlayTitleKey('The Lantern Road', 'Ada Quill'),
				albums: ['B0DUPE0001', 'B0SYNTH001']
			}
		])
	})
})

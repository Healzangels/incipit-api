import { describe, expect, it } from 'bun:test'

import {
	PARALLEL_LISTING_PHRASE,
	foldListingName,
	parallelListingIds,
	parallelListingNames
} from '#helpers/providers/goodreadsParallelListings'

// Structurally faithful excerpts of LIVE descriptions, mirror 10.0.1.99:8788,
// 2026-09-05. The hrefs and block breaks are the real ones; prose is trimmed.

const FARSEER = `<b>Also known as:</b>
*<i>刺客正传</i> (Chinese, simplified)
*<i>La Trilogia dei Lungavista</i>
*<i>Näkijän taru</i>

Blue Boots is a short story which follows kitchen girl Timbal.

<b>Editions with different numbering:</b>
Containing 5 volumes in total:
*<i>刺客正傳</i> (Chinese, traditional; sans book #1, each book is split into two volumes.)
*<i><a href="http://www.goodreads.com/series/65022-a-saga-do-assassino">A Saga do Assassino</a></i> (Portuguese)
*<i><a href="http://www.goodreads.com/series/167238-farseer-czech">Farseer</a></i> (Czech; published in 9 volumes)
*<i><a href="https://www.goodreads.com/series/174690-vatidico">Vatídico</a></i> (Spanish)

This series also receives a separate numbering and is combined with the <a href="https://www.goodreads.com/series/45182-tawny-man">Tawny Man</a> trilogy in French under the name: <a href="https://www.goodreads.com/series/89770-l-assassin-royal">L'assassin royal</a>.`

const LEGEND_OF_DRIZZT = `The Legend of Drizzt is the overarching series within the <a href="http://www.goodreads.com/series/49136">Forgotten Realms</a> detailing the exploits of the dark elf Drizzt.

The various series which make up this larger series are listed below in the order they were written:
* <a href="http://www.goodreads.com/series/49133">The Icewind Dale trilogy</a>
* <a href="http://www.goodreads.com/series/49135">The Dark Elf trilogy</a>
* <a href="http://www.goodreads.com/series/49177">Legacy of the Drow</a>`

const LEGACY_OF_THE_DROW = `This is part of the larger <a href="http://www.goodreads.com/series/49134-the-legend-of-drizzt">Legend of Drizzt</a> series set in the <a href="http://www.goodreads.com/series/49136-forgotten-realms">Forgotten Realms</a>.`

const RAIN_WILD = `The fourth series in Robin Hobbs epic tales that takes part in the fantastic world of the Elderlings

Series also known as:
* <i>Rain Wild Chronicles</i>
* <i>Cronache delle Giungle delle Piogge [Italian]</i>`

describe('parallelListingIds', () => {
	it('denies the three translations Farseer links, and NOT the Tawny Man sibling in the same sentence', () => {
		const ids = parallelListingIds(FARSEER)
		expect(ids).toEqual(expect.arrayContaining([65022, 167238, 174690, 89770]))
		// The load-bearing negative: Tawny Man (45182) is linked in the SAME
		// sentence as L'assassin royal, before "under the name:". Denying it would
		// strip Fool's Fate of its correct shelf.
		expect(ids).not.toContain(45182)
		expect(ids).toHaveLength(4)
	})

	it('the phrase form takes exactly the link after "under the name:", never an earlier one', () => {
		const one = `combined with the <a href="/series/45182-tawny-man">Tawny Man</a> trilogy in French under the name: <a href="/series/89770-l-assassin-royal">L'assassin royal</a>.`
		expect(parallelListingIds(one)).toEqual([89770])
	})

	it('steps over inline tags between the colon and the anchor, but not over a second anchor', () => {
		expect(
			parallelListingIds(`under the name: <i><b><a href="/series/1234-x">X</a></b></i>`)
		).toEqual([1234])
		expect(
			parallelListingIds(
				`under the name: <a href="/series/1-y">Y</a> and <a href="/series/2-z">Z</a>`
			)
		).toEqual([1])
	})

	it('a parent that LISTS its arcs is not denying them: Legend of Drizzt yields nothing', () => {
		// "The various series which make up this larger series" is the parent
		// direction. Legacy of the Drow (49177) must survive as a candidate.
		expect(parallelListingIds(LEGEND_OF_DRIZZT)).toEqual([])
	})

	it('a child that names its parent is not denying it: Legacy of the Drow yields nothing', () => {
		// The mutual-link trap: naive "deny every link" would take Legend of
		// Drizzt (49134) here AND Legacy of the Drow from the parent, denying both.
		expect(parallelListingIds(LEGACY_OF_THE_DROW)).toEqual([])
	})

	it('a plain-text "also known as" block with no hrefs yields nothing (Rain Wild)', () => {
		expect(parallelListingIds(RAIN_WILD)).toEqual([])
	})

	it('a heading block ends at the first blank line', () => {
		const d = `Also known as:
* <a href="/series/10-a">A</a>

Unrelated paragraph linking <a href="/series/20-b">B</a>.`
		expect(parallelListingIds(d)).toEqual([10])
	})

	it('empty and null are empty', () => {
		expect(parallelListingIds('')).toEqual([])
		expect(parallelListingIds(null)).toEqual([])
		expect(parallelListingIds(undefined)).toEqual([])
	})

	it('the phrase regex is global, so it can be reused across calls without stale lastIndex', () => {
		// A /g regex used with matchAll must not leak lastIndex between inputs.
		const a = parallelListingIds(`under the name: <a href="/series/7-a">A</a>`)
		const b = parallelListingIds(`under the name: <a href="/series/8-b">B</a>`)
		expect(a).toEqual([7])
		expect(b).toEqual([8])
		expect(PARALLEL_LISTING_PHRASE.global).toBe(true)
	})
})

describe('foldListingName: one fold for slugs, anchors and titles', () => {
	it('slug hyphens, anchor apostrophes and title diacritics collapse to one string', () => {
		expect(foldListingName('l-assassin-royal')).toBe('l assassin royal')
		expect(foldListingName("L'Assassin royal")).toBe('l assassin royal')
		expect(foldListingName('Les cit\u00e9s des Anciens')).toBe('les cites des anciens')
		expect(foldListingName('les-cites-des-anciens')).toBe('les cites des anciens')
		expect(foldListingName('O Regresso do Assassino')).toBe('o regresso do assassino')
	})
})

describe('parallelListingNames: the linked NAMES, so a duplicated listing is still denied', () => {
	// The live Tawny Man sentence: the Portuguese re-listing is linked as 65016, but the
	// work Fool's Errand carried a duplicate listing under 311441 with the same name.
	const TAWNY = `This trilogy has also been published with a different numbering (each book is split into two separately numbered parts, with the exception of the first book) in Portuguese, under the name: <a href="http://www.goodreads.com/series/65016-o-regresso-do-assassino">O Regresso do Assassino</a>`
	it('the phrase form yields the slug AND the anchor text, folded', () => {
		expect(parallelListingNames(TAWNY)).toEqual(['o regresso do assassino'])
		expect(parallelListingIds(TAWNY)).toEqual([65016])
	})
	it('a heading block yields every linked name', () => {
		const d = `Also known as:\n* <a href="/series/1-das-magische-baumhaus">Das magische Baumhaus</a>\n* <a href="/series/2-la-cabane-magique"><i>La Cabane Magique</i></a>\n\nUnrelated: <a href="/series/3-unrelated">x</a>`
		expect(parallelListingNames(d)).toEqual(['das magische baumhaus', 'la cabane magique'])
	})
	it('a link with no slug still yields its anchor text; an empty anchor yields nothing', () => {
		expect(parallelListingNames('Also known as: <a href="/series/9">Plain Name</a>')).toEqual([
			'plain name'
		])
		expect(parallelListingNames('Also known as: <a href="/series/9"></a>')).toEqual([])
	})
	it('empty and undeclared descriptions yield []', () => {
		expect(parallelListingNames('')).toEqual([])
		expect(
			parallelListingNames('Just prose with <a href="/series/5-x">a link</a> but no declaration.')
		).toEqual([])
	})
})

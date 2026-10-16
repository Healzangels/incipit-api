import { describe, expect, test } from 'bun:test'

import type { OverlayEdition, OverlayWork } from '#helpers/overlay/overlaySchema'
import {
	creditsLine,
	hoursMinutes,
	type OverlayRecord,
	releaseYear,
	renderOverlaySummary
} from '#helpers/overlay/renderOverlay'

/**
 * The description template per kind of book (audiobooks PLAN-v2 section 4.2),
 * on SYNTHETIC books. Each kind is the variant the research renderer printed for
 * a real album; the expected strings here pin the same shapes.
 */

const W = (over: Partial<OverlayWork> = {}): OverlayWork => ({
	hook: 'A synthetic hook.',
	genres: ['Fantasy', 'Epic Fantasy', 'High Fantasy', 'Adventure'],
	...over
})
const E = (over: Partial<OverlayEdition> = {}): OverlayEdition => ({
	work: 'w',
	keys: { title: 'T', author: 'A', narrator: 'N' },
	status: 'approved',
	approved_on: '2026-10-16',
	...over
})
const R = (over: Partial<OverlayRecord> = {}): OverlayRecord => ({
	title: 'A Synthetic Book',
	authors: [{ name: 'Ada Quill' }],
	narrators: [{ name: 'Ben Reader' }],
	formatType: 'unabridged',
	runtimeLengthMin: 786,
	publisherName: 'Synthetic Audio',
	releaseDate: '2007-05-01T00:00:00.000Z',
	...over
})

describe('the template, kind by kind', () => {
	test('literary fiction, standalone: hook, setting paragraph, credits; no series line', () => {
		expect(
			renderOverlaySummary(
				W({ setting: 'A synthetic setting line.' }),
				E(),
				R({ seriesPrimary: null })
			)
		).toBe(
			[
				'A synthetic hook.',
				'',
				'A synthetic setting line.',
				'',
				'Narrated by Ben Reader · Unabridged · 13 h 06 min · Synthetic Audio, 2007'
			].join('\n')
		)
	})

	test('series fantasy: "Book N of M" when the work states the series is complete', () => {
		const text = renderOverlaySummary(
			W({ series_total: 14 }),
			E(),
			R({ seriesPrimary: { name: 'The Synthetic Wheel', position: '5' } })
		)
		expect(text.split('\n\n')[1].split('\n')[0]).toBe('Series: The Synthetic Wheel, Book 5 of 14')
	})

	test('an open series: "Book N" with no total', () => {
		const text = renderOverlaySummary(
			W(),
			E(),
			R({ seriesPrimary: { name: 'The Synthetic Cycle', position: '2' } })
		)
		expect(text).toContain('Series: The Synthetic Cycle, Book 2\n')
	})

	test('a self-titled one-book shelf is a standalone: no series line (Q12)', () => {
		const text = renderOverlaySummary(
			W({ series_total: 1 }),
			E(),
			R({ title: 'The Lone Mission', seriesPrimary: { name: 'Lone Mission', position: '1' } })
		)
		expect(text).not.toContain('Series:')
	})

	test('a shelf with no position gets no series line', () => {
		expect(
			renderOverlaySummary(W(), E(), R({ seriesPrimary: { name: 'Somewhere' } }))
		).not.toContain('Series:')
	})

	test('non-fiction: same template, the subject lives in the hook', () => {
		expect(
			renderOverlaySummary(W({ hook: 'Two synthetic historians tell a story.' }), E(), R())
		).toBe(
			'Two synthetic historians tell a story.\n\nNarrated by Ben Reader · Unabridged · 13 h 06 min · Synthetic Audio, 2007'
		)
	})

	test('memoir: "Read by the author" when the narrator IS the author', () => {
		expect(creditsLine(E(), R({ narrators: [{ name: 'Ada Quill' }] }))).toBe(
			'Read by the author · Unabridged · 13 h 06 min · Synthetic Audio, 2007'
		)
		// …and on the operator's word when the record spells the name differently.
		expect(
			creditsLine(E({ read_by_author: true }), R({ narrators: [{ name: 'A. Quill' }] }))
		).toMatch(/^Read by the author · /)
		// The control: an ordinary narration stays "Narrated by".
		expect(creditsLine(E(), R())).toMatch(/^Narrated by Ben Reader · /)
	})

	test("children's: an age band only when stated", () => {
		const withBand = renderOverlaySummary(W({ age_band: '8-12' }), E(), R())
		expect(withBand).toContain('Synthetic Audio, 2007\nAges 8-12')
		expect(renderOverlaySummary(W(), E(), R())).not.toContain('Ages')
	})

	test('full cast: the production replaces the narrators AND the abridgement', () => {
		const text = renderOverlaySummary(
			W({ series_total: 3 }),
			E({ production: 'Synthetic dramatized adaptation, full cast' }),
			R({
				narrators: Array.from({ length: 15 }, (_, i) => ({ name: `Actor ${i}` })),
				seriesPrimary: { name: 'Synthetic Sand', position: '2' },
				runtimeLengthMin: 311,
				releaseDate: '2020-01-01'
			})
		)
		expect(text.split('\n\n')[1]).toBe(
			'Series: Synthetic Sand, Book 2 of 3\nSynthetic dramatized adaptation, full cast · 5 h 11 min · Synthetic Audio, 2020'
		)
	})

	test('poetry/classic: translator and introduction on their own line after the credits', () => {
		const text = renderOverlaySummary(
			W(),
			E({ credits: ['Translated by A. Translator', 'Introduction by B. Scholar'] }),
			R()
		)
		expect(text.split('\n\n')[1]).toBe(
			'Narrated by Ben Reader · Unabridged · 13 h 06 min · Synthetic Audio, 2007\nTranslated by A. Translator · Introduction by B. Scholar'
		)
	})

	test('a story collection: the Contents line, in order, after the credits', () => {
		const text = renderOverlaySummary(
			W({ contents: ['First Tale', 'Second Tale', 'Third Tale'] }),
			E(),
			R()
		)
		expect(text.endsWith('Contents: First Tale; Second Tale; Third Tale')).toBe(true)
	})

	test('praise (at most two, the recording first) and awards (work first) close the text', () => {
		const text = renderOverlaySummary(
			W({
				praise: [{ text: 'A work quote.', source: 'Work Review', year: 2001 }],
				awards: [
					{
						award: 'Work Prize',
						year: 2002,
						category: 'Best Novel',
						result: 'shortlist',
						sources: ['https://example.invalid/a']
					}
				]
			}),
			E({
				praise: [{ text: 'A narration quote.', source: 'Audio Review', year: 2008 }],
				awards: [
					{
						award: 'Audio Prize',
						year: 2009,
						category: 'Narration',
						result: 'winner',
						sources: ['https://example.invalid/b']
					}
				]
			}),
			R()
		)
		const paragraphs = text.split('\n\n')
		expect(paragraphs.slice(-2)).toEqual([
			'Praise\n“A narration quote.” — Audio Review, 2008\n“A work quote.” — Work Review, 2001',
			'Awards\nWork Prize 2002: Best Novel (shortlist)\nAudio Prize 2009: Narration (winner)'
		])
	})

	test('a work-only render (edition null) drops every recording-scoped item', () => {
		const text = renderOverlaySummary(W(), null, R())
		expect(text).toBe(
			'A synthetic hook.\n\nNarrated by Ben Reader · Unabridged · 13 h 06 min · Synthetic Audio, 2007'
		)
	})
})

describe('the credits line is the served record, cleaned', () => {
	test('runtime: hours unpadded, minutes two digits', () => {
		expect(hoursMinutes(1023)).toBe('17 h 03 min')
		expect(hoursMinutes(59)).toBe('0 h 59 min')
		expect(hoursMinutes(2187)).toBe('36 h 27 min')
	})

	test("year: the ISO date's own year, for a string and a Date, in every timezone", () => {
		expect(releaseYear('2000-12-31T00:00:00.000Z')).toBe(2000)
		expect(releaseYear(new Date('2000-12-31T00:00:00.000Z'))).toBe(2000)
		expect(releaseYear(new Date('2001-01-01T00:30:00.000Z'))).toBe(2001)
		expect(releaseYear('2017-10-12')).toBe(2017)
		expect(releaseYear('')).toBeNull()
		expect(releaseYear(null)).toBeNull()
		expect(releaseYear(new Date('not a date'))).toBeNull()
	})

	test('entities decoded and markup removed: no "<" can reach Plex', () => {
		const text = renderOverlaySummary(
			W(),
			E(),
			R({
				publisherName: 'Simon &amp; Schuster <b>Audio</b>',
				narrators: [{ name: 'Ren&eacute;e <i>Voice</i>' }],
				seriesPrimary: { name: 'A &lt;Strange&gt; Shelf', position: '1' }
			})
		)
		expect(text).toContain('Narrated by Renée Voice')
		expect(text).toContain('Simon & Schuster Audio, 2007')
		expect(text).not.toContain('<')
		expect(text).not.toContain('&amp;')
	})

	test('more than three narrators: the first three "and others"', () => {
		expect(
			creditsLine(E(), R({ narrators: ['A', 'B', 'C', 'D'].map((name) => ({ name })) }))
		).toMatch(/^Narrated by A, B, C and others · /)
		expect(creditsLine(E(), R({ narrators: ['A', 'B', 'C'].map((name) => ({ name })) }))).toMatch(
			/^Narrated by A, B, C · /
		)
	})

	test('a thin record (Hardcover: no narrator, runtime or date) drops those pieces, never prints "undefined"', () => {
		expect(
			creditsLine(
				E(),
				R({ narrators: [], formatType: null, runtimeLengthMin: 0, releaseDate: null })
			)
		).toBe('Synthetic Audio')
		expect(renderOverlaySummary(W(), E(), { title: 'Bare' })).toBe('A synthetic hook.')
	})

	test('abridged is said so', () => {
		expect(creditsLine(E(), R({ formatType: 'abridged' }))).toContain(' · Abridged · ')
	})
})

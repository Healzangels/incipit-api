import { describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'

/**
 * A stated seriesPosition is a volume claim, and must break sibling ties.
 *
 * The volume machinery only fires when the QUERY TITLE advertises a number
 * (volumeConflict returns false whenever want is empty). Book 1 of a series is
 * normally titled bare -- "Defiance of the Fall" -- so a search for it declares
 * no volume, and a sibling titled "Defiance of the Fall, Book 10" escapes the
 * mismatch penalty entirely. Worse, normalizeTitle strips "Book 10" as series
 * noise, so that sibling scores an EXACT title match and ties book 1 at 0.85,
 * leaving the winner to provider order.
 *
 * Measured live 2026-07-26 on TheFirstDefier / "Defiance of the Fall": the fresh
 * library scan matched book 1's file to BOOK 10. Reproduced against the live API
 * -- without duration, "Defiance of the Fall, Book 10" and "Defiance of the Fall"
 * both score 0.85 and Book 10 sorts first. Note the asymmetry that hid it: a
 * BARE-numbered sibling ("Defiance of the Fall 7") keeps its digit through
 * normalizeTitle and lands at 0.824, so only the marker-style "Book N" form ties.
 *
 * Why it hits every rebuild: Plex has not analysed the files during a fresh scan,
 * so duration is -1 and never reaches the API. Duration is what separates these
 * candidates (book 1 reaches 1.0 with it), so on a rebuild every numbered series
 * whose sibling normalizes to the same stem is decided by a coin flip.
 *
 * The agent has been sending seriesPosition on every one of these searches and
 * the scorer ignored it. Using it is penalise-only and integers-only: a stated
 * position never BOOSTS its sibling (sidecar positions are not trustworthy
 * enough to promote on), and a fractional novella position like 1.5 or 12.5 is
 * ignored rather than guessed at.
 */

function candidate(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
	return {
		provider: 'audible',
		id: 'x',
		asin: null,
		title: 'Defiance of the Fall',
		authors: ['TheFirstDefier'],
		narrators: [],
		audioSeconds: null,
		cover: null,
		language: null,
		...over
	}
}

const book1 = candidate({ id: 'B094JZYWLG', asin: 'B094JZYWLG' })
const book10 = candidate({
	id: 'B0C78G69ZW',
	asin: 'B0C78G69ZW',
	title: 'Defiance of the Fall, Book 10'
})

function helperFor(candidates: ProviderCandidate[], options: Record<string, unknown> = {}) {
	const registry = {
		searchAll: async () => candidates,
		fetchBookByAsin: async () => null
	} as unknown as ProviderRegistry
	return new BookSearchHelper(registry, {
		title: 'Defiance of the Fall',
		author: 'TheFirstDefier',
		series: 'Defiance of the Fall',
		region: 'us',
		...options
	} as never)
}

describe('seriesPosition as a volume claim', () => {
	test('a stated position demotes a conflicting sibling', async () => {
		const ranked = await helperFor([book10, book1], { seriesPosition: '1' }).search()
		expect(ranked[0]?.asin).toBe('B094JZYWLG')
	})

	test('the conflicting sibling is demoted, not deleted', async () => {
		// Still offered in Fix Match -- a wrong sidecar position must not hide the
		// edition the operator may actually want.
		const ranked = await helperFor([book10, book1], { seriesPosition: '1' }).search()
		expect(ranked.some((c) => c.asin === 'B0C78G69ZW')).toBe(true)
	})

	test('the MATCHING sibling is never boosted, only rivals demoted', async () => {
		// Position 10 with only book 10 present: it must still score on its own
		// merits (title+author, no duration => 0.85), not be promoted to certainty
		// on the strength of a sidecar number.
		const ranked = await helperFor([book10], { seriesPosition: '10' }).search()
		expect(ranked[0]?.confidence).toBeCloseTo(0.85, 2)
	})

	test('without a stated position the tie is unchanged', async () => {
		// The pre-existing behaviour, pinned: no position claimed, no demotion.
		const ranked = await helperFor([book10, book1]).search()
		const ten = ranked.find((c) => c.asin === 'B0C78G69ZW')
		expect(ten?.confidence).toBeCloseTo(0.85, 2)
	})

	test('a fractional position is ignored', async () => {
		// Novellas ("1.5 - Mitosis", "12.5 - Extraction") are real in this library
		// and do not describe an integer volume. Guessing at them would demote the
		// legitimate siblings around them.
		const ranked = await helperFor([book10, book1], { seriesPosition: '1.5' }).search()
		const ten = ranked.find((c) => c.asin === 'B0C78G69ZW')
		expect(ten?.confidence).toBeCloseTo(0.85, 2)
	})

	test('a non-numeric position is ignored', async () => {
		const ranked = await helperFor([book10, book1], { seriesPosition: 'Prequel' }).search()
		const ten = ranked.find((c) => c.asin === 'B0C78G69ZW')
		expect(ten?.confidence).toBeCloseTo(0.85, 2)
	})

	test('a volume in the TITLE still wins over the stated position', async () => {
		// The title is the stronger claim: it is what the operator's file says.
		// Searching "Defiance of the Fall, Book 10" must match book 10 even if a
		// stale sidecar position says 1.
		const ranked = await helperFor([book10, book1], {
			title: 'Defiance of the Fall, Book 10',
			seriesPosition: '1'
		}).search()
		expect(ranked[0]?.asin).toBe('B0C78G69ZW')
	})
})

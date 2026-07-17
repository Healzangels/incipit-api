import { describe, expect, test } from 'bun:test'

import { dedupeCandidates } from '#helpers/providers/dedupe'
import type { ScoredCandidate } from '#helpers/providers/types'

function scored(over: Partial<ScoredCandidate>): ScoredCandidate {
	return {
		provider: 'x',
		id: 'x',
		asin: null,
		title: 'Untitled',
		authors: [],
		narrators: [],
		audioSeconds: null,
		cover: null,
		confidence: 0.85,
		durationDeltaPct: null,
		...over
	}
}

describe('dedupeCandidates', () => {
	test('collapses the same ASIN across providers, keeping the richer one', () => {
		const audible = scored({
			provider: 'audible',
			asin: 'B08G9PRS1K',
			narrators: ['Ray Porter'],
			audioSeconds: 58200,
			cover: 'a.jpg'
		})
		const hardcover = scored({
			provider: 'hardcover',
			asin: 'B08G9PRS1K',
			audioSeconds: 58200,
			cover: 'hc.jpg'
		})
		const out = dedupeCandidates([hardcover, audible])
		expect(out).toHaveLength(1)
		// same confidence -> richer (has narrator) wins
		expect(out[0].provider).toBe('audible')
	})

	test('does NOT merge different editions of the same book (different ASINs)', () => {
		const a = scored({ asin: 'B08GB58KD5', title: 'Project Hail Mary', audioSeconds: 58200 })
		const b = scored({ asin: 'B08G9PRS1K', title: 'Project Hail Mary', audioSeconds: 58253 })
		expect(dedupeCandidates([a, b])).toHaveLength(2)
	})

	test('collapses book-level duplicates of a title with no audio edition', () => {
		const hardcover = scored({
			provider: 'hardcover',
			title: 'A Spell for Chameleon',
			authors: ['Piers Anthony'],
			cover: 'hc.jpg'
		})
		const openlibrary = scored({
			provider: 'openlibrary',
			title: 'A Spell for Chameleon',
			authors: ['Piers Anthony'],
			cover: null
		})
		const out = dedupeCandidates([openlibrary, hardcover])
		expect(out).toHaveLength(1)
		// tie on confidence -> the one with a cover wins
		expect(out[0].provider).toBe('hardcover')
	})

	test('higher confidence always wins regardless of richness', () => {
		const rich = scored({ asin: null, title: 'X', authors: ['A'], cover: 'c.jpg', confidence: 0.7 })
		const better = scored({ asin: null, title: 'X', authors: ['A'], confidence: 0.95 })
		const out = dedupeCandidates([rich, better])
		expect(out).toHaveLength(1)
		expect(out[0].confidence).toBe(0.95)
	})

	test('buckets near-identical runtimes without ASINs to the same edition', () => {
		const a = scored({ asin: null, title: 'Y', authors: ['A'], audioSeconds: 36000 })
		const b = scored({ asin: null, title: 'Y', authors: ['A'], audioSeconds: 36020 }) // <1 min apart
		expect(dedupeCandidates([a, b])).toHaveLength(1)
	})

	test('keeps distinct titles apart', () => {
		const a = scored({ title: 'Book One', authors: ['A'] })
		const b = scored({ title: 'Book Two', authors: ['A'] })
		expect(dedupeCandidates([a, b])).toHaveLength(2)
	})
})

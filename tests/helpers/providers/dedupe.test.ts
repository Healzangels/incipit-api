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

	test('does NOT merge different editions of the same book (different runtimes)', () => {
		// Different ASINs AND runtimes a minute apart (970 vs 971) → genuinely
		// distinct editions the duration signal is meant to choose between.
		const a = scored({ asin: 'B08GB58KD5', title: 'Project Hail Mary', audioSeconds: 58200 })
		const b = scored({ asin: 'B08G9PRS1K', title: 'Project Hail Mary', audioSeconds: 58253 })
		expect(dedupeCandidates([a, b])).toHaveLength(2)
	})

	test('collapses same title+author+runtime editions across different ASINs (re-releases)', () => {
		// The "Horns" case: one audiobook re-listed under three store ASINs, all
		// the identical 49800s runtime — same audio content, must collapse to one.
		const a = scored({
			provider: 'audible',
			asin: 'B0036KOD4U',
			title: 'Horns',
			authors: ['Joe Hill'],
			narrators: ['Fred Berman'],
			audioSeconds: 49800
		})
		const b = scored({
			provider: 'hardcover',
			asin: 'B00545O098',
			title: 'Horns',
			authors: ['Joe Hill'],
			audioSeconds: 49800
		})
		const c = scored({
			provider: 'hardcover',
			asin: 'B00FGG1TK8',
			title: 'Horns',
			authors: ['Joe Hill'],
			audioSeconds: 49800
		})
		const out = dedupeCandidates([a, b, c])
		expect(out).toHaveLength(1)
		expect(out[0].provider).toBe('audible') // richest (narrator) wins the group
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

	test('does NOT merge editions whose languages positively conflict, even in the same runtime bucket', () => {
		// A German narration of an untranslated title ("Dune") can run within a
		// minute of the English one. Merging them deletes one language from the
		// results BEFORE the ranker's language preference runs — and the richer
		// (cover-bearing) foreign edition used to be the one kept.
		const en = scored({
			id: 'en',
			title: 'Dune',
			authors: ['Frank Herbert'],
			audioSeconds: 49800,
			language: 'en'
		})
		const de = scored({
			id: 'de',
			title: 'Dune',
			authors: ['Frank Herbert'],
			audioSeconds: 49810,
			language: 'de',
			cover: 'de.jpg',
			narrators: ['Jemand Anderes']
		})
		expect(dedupeCandidates([de, en])).toHaveLength(2)
	})

	test('an UNKNOWN language still merges with a tagged one (absence is not a conflict)', () => {
		const tagged = scored({ title: 'Y', authors: ['A'], audioSeconds: 36000, language: 'en' })
		const untagged = scored({ title: 'Y', authors: ['A'], audioSeconds: 36010, language: null })
		expect(dedupeCandidates([tagged, untagged])).toHaveLength(1)
	})

	test('an UNKNOWN-language candidate cannot bridge two conflicting languages into one group', () => {
		// Union-find is transitive while pairwise compatibility is not: with the
		// old occupant-only check, en merged with the untagged candidate and de
		// then merged through it — one group, one language deleted, and the
		// output depended on provider order. The conflict check is now against
		// the whole group's known languages.
		// en is strictly richer than unk so whichever group unk joins, the
		// LANGUAGE-BEARING member wins it and the assertion below is stable.
		const en = scored({
			id: 'en',
			title: 'Dune',
			authors: ['Frank Herbert'],
			audioSeconds: 49800,
			language: 'en',
			narrators: ['Someone']
		})
		const unk = scored({ id: 'unk', title: 'Dune', authors: ['Frank Herbert'], audioSeconds: 49805, language: null })
		const de = scored({
			id: 'de',
			title: 'Dune',
			authors: ['Frank Herbert'],
			audioSeconds: 49810,
			language: 'de',
			cover: 'de.jpg',
			narrators: ['Jemand Anderes']
		})
		// Every arrival order: en and de must NEVER share a group, so at least
		// two groups always survive (the unknown may legitimately join either).
		const orders = [
			[en, unk, de],
			[de, unk, en],
			[unk, en, de],
			[en, de, unk],
			[de, en, unk],
			[unk, de, en]
		]
		for (const order of orders) {
			const out = dedupeCandidates(order)
			expect(out.length).toBeGreaterThanOrEqual(2)
			const langs = out.map((c) => c.language)
			expect(langs).toContain('en')
			expect(langs).toContain('de')
		}
	})

	test('a PINNED candidate wins its dedupe group even against a richer rival', () => {
		// The ranker's pinned-first tiebreak runs AFTER dedupe: if the pinned
		// edition loses its group here (richness) it is deleted before that
		// tiebreak exists, and the graft does not fire when the rival carries
		// its own ASIN. The pin must outrank richness inside the group.
		const pinned = scored({
			provider: 'openlibrary',
			id: 'pinned',
			asin: 'B0PINNED01',
			title: 'Horns',
			authors: ['Joe Hill'],
			audioSeconds: 49800,
			confidence: 1
		})
		const richerRival = scored({
			provider: 'audible',
			id: 'rival',
			asin: 'B0RIVAL001',
			title: 'Horns',
			authors: ['Joe Hill'],
			audioSeconds: 49800, // same minute bucket -> same group
			narrators: ['Fred Berman'],
			cover: 'a.jpg',
			confidence: 1
		})
		const out = dedupeCandidates([richerRival, pinned], 'B0PINNED01')
		expect(out).toHaveLength(1)
		expect(out[0].asin).toBe('B0PINNED01')
		// Without the pin, the richer rival still wins as before.
		const unpinned = dedupeCandidates([richerRival, pinned])
		expect(unpinned[0].asin).toBe('B0RIVAL001')
	})

	test('grafts the store ASIN onto a group winner that lacks one', () => {
		// The ASIN-less candidate is richer (narrator + cover) and wins the group,
		// but the losing member carries the one identity key the caller can act
		// on — emitting the winner with asin:null would discard it.
		const withAsin = scored({
			provider: 'audible',
			asin: 'B0GRAFT001',
			title: 'Horns',
			authors: ['Joe Hill'],
			audioSeconds: 49800
		})
		const richerNoAsin = scored({
			provider: 'hardcover',
			asin: null,
			title: 'Horns',
			authors: ['Joe Hill'],
			audioSeconds: 49800,
			narrators: ['Fred Berman'],
			cover: 'hc.jpg'
		})
		const out = dedupeCandidates([withAsin, richerNoAsin])
		expect(out).toHaveLength(1)
		expect(out[0].provider).toBe('hardcover') // richer still wins the group
		expect(out[0].asin).toBe('B0GRAFT001') // but the ASIN survives
	})
})

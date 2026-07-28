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
		const unk = scored({
			id: 'unk',
			title: 'Dune',
			authors: ['Frank Herbert'],
			audioSeconds: 49805,
			language: null
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

	test('a multi-key candidate cannot drag its group into a conflicting-language group', () => {
		// One level deeper than the occupant-group check: the bridge carries BOTH
		// an asin: and a dur: key but no language tag. Its asin joins it to the en
		// group, then its dur: key used to merge that WHOLE group into the fr
		// group — the old check compared the fr group against the bridge's own
		// (null) tag only, never against the en it had already absorbed.
		const en = scored({
			id: 'en',
			asin: 'B0BRIDGE01',
			title: 'Dune',
			authors: ['Frank Herbert'],
			language: 'en',
			narrators: ['Someone'],
			cover: 'en.jpg'
		})
		const bridge = scored({
			id: 'bridge',
			asin: 'B0BRIDGE01',
			title: 'Dune',
			authors: ['Frank Herbert'],
			audioSeconds: 49805,
			language: null
		})
		const fr = scored({
			id: 'fr',
			title: 'Dune',
			authors: ['Frank Herbert'],
			audioSeconds: 49800, // same minute bucket as the bridge
			language: 'fr',
			narrators: ["Quelqu'un"]
		})
		// Orders where fr's dur: key pairs with the bridge BEFORE the bridge's
		// asin joins it to en are excluded: at that decision point the bridge's
		// group has no known language (permissive by design) and the later asin:
		// merge is unconditional.
		const orders = [
			[en, bridge, fr],
			[en, fr, bridge],
			[fr, en, bridge],
			[bridge, en, fr]
		]
		for (const order of orders) {
			const out = dedupeCandidates(order)
			expect(out.length).toBeGreaterThanOrEqual(2)
			const langs = out.map((c) => c.language)
			expect(langs).toContain('en')
			expect(langs).toContain('fr')
		}
		// Same shape with matching languages on both sides still collapses: the
		// block is a language conflict, not the extra key.
		const en2 = scored({
			id: 'en2',
			title: 'Dune',
			authors: ['Frank Herbert'],
			audioSeconds: 49800,
			language: 'en'
		})
		expect(dedupeCandidates([en, en2, bridge])).toHaveLength(1)
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

describe('dedupe grafts metadata from a collapsed member', () => {
	// Measured live on "The Blade Itself": a sidecar pinned a Hardcover edition
	// with NO narrator, which collapsed the same-runtime Audible record narrated
	// by Steven Pacey. The richer row was deleted outright -- the book matched
	// with no narrator, and the Pacey edition could not even be picked from Fix
	// Match, because dedupe had already removed it.
	const at = (over: Partial<ScoredCandidate>): ScoredCandidate =>
		({
			provider: 'stub',
			id: 'x',
			asin: null,
			title: 'The Blade Itself',
			authors: ['Joe Abercrombie'],
			narrators: [],
			audioSeconds: 80100,
			cover: null,
			confidence: 0.85,
			durationDeltaPct: null,
			...over
		}) as ScoredCandidate

	test('a pinned winner inherits the narrator of the row it collapsed', () => {
		const out = dedupeCandidates(
			[
				at({ id: 'hardcover-edition-31604983', asin: 'B014LLTNGK', confidence: 1 }),
				at({ id: 'B014LL6R5U', asin: 'B014LL6R5U', narrators: ['Steven Pacey'] })
			],
			'B014LLTNGK'
		)
		expect(out).toHaveLength(1)
		expect(out[0].asin).toBe('B014LLTNGK')
		expect(out[0].narrators).toEqual(['Steven Pacey'])
	})

	test("the winner's own metadata is never overwritten", () => {
		const out = dedupeCandidates(
			[
				at({
					id: 'a',
					asin: 'B0KEEP',
					confidence: 1,
					narrators: ['Real Narrator'],
					cover: 'a.jpg'
				}),
				at({ id: 'b', asin: 'B0OTHER', narrators: ['Wrong Narrator'], cover: 'b.jpg' })
			],
			'B0KEEP'
		)
		expect(out[0].narrators).toEqual(['Real Narrator'])
		expect(out[0].cover).toBe('a.jpg')
	})

	test('a missing cover is grafted too', () => {
		const out = dedupeCandidates([
			at({ id: 'a', asin: 'B0A', confidence: 0.9 }),
			at({ id: 'b', asin: 'B0B', cover: 'art.jpg' })
		])
		expect(out).toHaveLength(1)
		expect(out[0].cover).toBe('art.jpg')
	})

	test('a print-source cover yields to audiobook art in the same group', () => {
		// Mirrors Davis Ashura's "A Warrior's Knowledge": an OpenLibrary work won
		// on confidence carrying a PORTRAIT scan of the print edition, while a
		// same-book Apple row carried the square audiobook art. The match was
		// right and the picture was wrong.
		const out = dedupeCandidates([
			scored({
				provider: 'openlibrary',
				id: 'ol',
				confidence: 0.85,
				cover: 'https://covers.openlibrary.org/b/id/10500107-L.jpg'
			}),
			scored({
				provider: 'apple',
				id: 'ap',
				confidence: 0.768,
				cover: 'https://is1-ssl.mzstatic.com/image/thumb/x/1400x1400bb.jpg'
			})
		])
		expect(out).toHaveLength(1)
		// Identity still belongs to the higher-confidence winner...
		expect(out[0].provider).toBe('openlibrary')
		// ...but the artwork comes from the audio edition.
		expect(out[0].cover).toContain('mzstatic')
	})

	test('an audiobook winner keeps its own cover', () => {
		// The override is one-directional: audiobook art displaces a print scan,
		// never the reverse, and never another audiobook cover.
		const out = dedupeCandidates([
			scored({
				provider: 'audible',
				id: 'a',
				asin: 'B0A',
				audioSeconds: 66300,
				confidence: 0.9,
				cover: 'audible.jpg'
			}),
			scored({
				provider: 'apple',
				id: 'b',
				audioSeconds: 66300,
				confidence: 0.7,
				cover: 'apple.jpg'
			})
		])
		expect(out).toHaveLength(1)
		expect(out[0].cover).toBe('audible.jpg')
	})
})

describe('dedupeCandidates: demoted junk (AI "Virtual Voice") ids', () => {
	// Same edition/book (shared dur: bucket) as a real one, flagged junk via the
	// third arg. It must not win the group by pin OR by confidence, must not donate
	// its identity metadata, but its cover (real book art) may still fill a gap.
	const bucketed = (over: Partial<ScoredCandidate>): ScoredCandidate =>
		scored({ title: 'X', authors: ['A'], audioSeconds: 36000, ...over }) // dur:x|a|600

	test('a real edition beats junk in a merged group even at LOWER confidence', () => {
		const junk = bucketed({ id: 'j', asin: 'B0JUNK00000', confidence: 0.8 })
		const human = bucketed({ id: 'h', asin: null, confidence: 0.7 })
		// junk is BOTH pinned and demoted; neither the pin nor its higher score wins.
		const out = dedupeCandidates([junk, human], 'B0JUNK00000', new Set(['j']))
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('h')
	})

	test('junk is still emitted when it is the only member of its group', () => {
		const junk = bucketed({ id: 'j', confidence: 0.8, narrators: ['Virtual Voice'] })
		const out = dedupeCandidates([junk], null, new Set(['j']))
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('j')
	})

	test('junk does not donate its asin or narrators to the real winner', () => {
		const junk = bucketed({
			id: 'j',
			asin: 'B0JUNK00000',
			narrators: ['Virtual Voice'],
			confidence: 0.8
		})
		const human = bucketed({ id: 'h', asin: null, narrators: [], confidence: 0.9 })
		const out = dedupeCandidates([junk, human], null, new Set(['j']))
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('h')
		expect(out[0].asin).toBeNull() // junk store identity not grafted
		expect(out[0].narrators).toEqual([]) // no "Virtual Voice" graft
	})

	test('junk MAY donate its cover (real book art) to a cover-less winner', () => {
		const junk = bucketed({
			id: 'j',
			provider: 'audible',
			cover: 'book.jpg',
			confidence: 0.8
		})
		const human = bucketed({ id: 'h', cover: null, confidence: 0.9 })
		const out = dedupeCandidates([junk, human], null, new Set(['j']))
		expect(out).toHaveLength(1)
		expect(out[0].id).toBe('h')
		expect(out[0].cover).toBe('book.jpg') // cover is NOT skipped for junk
	})
})

describe('determinism: arrival order must never matter', () => {
	// The mixed shape a real fan-out produces: an ASIN re-release cluster, a
	// book-level duplicate pair, a full-tie same-provider pair, a language pair
	// that must NOT merge, and a singleton. Fresh objects per call so no test
	// can leak mutations into another.
	const rows = (): ScoredCandidate[] => [
		scored({
			provider: 'audible',
			id: 'a1',
			asin: 'B0036KOD4U',
			title: 'Horns',
			authors: ['Joe Hill'],
			narrators: ['Fred Berman'],
			audioSeconds: 49800
		}),
		scored({
			provider: 'hardcover',
			id: 'h1',
			asin: 'B00545O098',
			title: 'Horns',
			authors: ['Joe Hill'],
			audioSeconds: 49800
		}),
		scored({ provider: 'hardcover', id: 'h2', title: 'Chameleon', authors: ['Piers Anthony'] }),
		scored({ provider: 'openlibrary', id: 'OL9W', title: 'Chameleon', authors: ['Piers Anthony'] }),
		scored({ provider: 'openlibrary', id: 'OL1W', title: 'Twin', authors: ['A'] }),
		scored({ provider: 'openlibrary', id: 'OL2W', title: 'Twin', authors: ['A'] }),
		scored({
			provider: 'x',
			id: 'en1',
			title: 'Bilingual',
			authors: ['B'],
			audioSeconds: 36000,
			language: 'en'
		}),
		scored({
			provider: 'x',
			id: 'de1',
			title: 'Bilingual',
			authors: ['B'],
			audioSeconds: 36010,
			language: 'de'
		}),
		scored({ provider: 'apple', id: 'solo', title: 'Loner', authors: ['C'], cover: 'l.jpg' })
	]

	test('every arrival order produces the identical result, in the identical order', () => {
		const baseline = dedupeCandidates(rows())
		// Sanity: groups actually formed (Horns merged, Chameleon merged, Twin
		// merged, the language pair did NOT).
		expect(baseline.map((c) => c.title).sort()).toEqual([
			'Bilingual',
			'Bilingual',
			'Chameleon',
			'Horns',
			'Loner',
			'Twin'
		])
		const base = rows()
		const perms: ScoredCandidate[][] = [[...base].reverse()]
		for (let k = 1; k < base.length; k++) perms.push([...base.slice(k), ...base.slice(0, k)])
		for (const perm of perms) {
			expect(dedupeCandidates(perm)).toEqual(baseline)
		}
	})

	test('a FULL tie (same confidence, same richness) has one canonical winner', () => {
		// Before the canonical-order fix the incumbent (first arrival) won this
		// tie, so the surviving id flipped with arrival order.
		const a = scored({ provider: 'openlibrary', id: 'OL1W', title: 'Twin', authors: ['A'] })
		const b = scored({ provider: 'openlibrary', id: 'OL2W', title: 'Twin', authors: ['A'] })
		const ab = dedupeCandidates([a, b])
		const ba = dedupeCandidates([b, a])
		expect(ab).toHaveLength(1)
		expect(ba).toHaveLength(1)
		expect(ab[0].id).toBe(ba[0].id)
		expect(ab[0].id).toBe('OL1W') // lowest identity key, always
	})
})

describe('prefix-extension merge', () => {
	// The Nevermoor/Apex shape: one recording, two title forms ("Apex" vs
	// "Apex: A Fantasy LitRPG Adventure"), runtimes differing only by provider
	// rounding -- sometimes straddling a minute boundary, so the dur: key
	// leaves them as two look-alike rows the ranker had to arbitrate between.
	// They merge now, and the OPERATOR's title policy (2026-07-28) decides
	// what the merged row is called: the library's own tag form when any
	// member carries it, else the winner's title.
	const subtitled = () =>
		scored({
			provider: 'audible',
			id: 'audible-1',
			asin: 'B0APEX00XX',
			title: 'Apex: A Fantasy LitRPG Adventure',
			authors: ['Seth Ring'],
			narrators: ['Neil Hellegers'],
			audioSeconds: 43230,
			cover: 'audible.jpg'
		})
	const bare = () =>
		scored({
			provider: 'overdrive',
			id: 'overdrive-1',
			title: 'Apex',
			authors: ['Seth Ring'],
			narrators: ['Neil Hellegers'],
			audioSeconds: 43208
		})

	test('merges the subtitled and bare forms of one recording', () => {
		// 22s apart across a minute boundary: the dur: key alone cannot merge
		// these (buckets 720 vs 721 differ).
		const out = dedupeCandidates([subtitled(), bare()])
		expect(out).toHaveLength(1)
	})

	test('the merged row is called what the library calls it (short tag)', () => {
		const out = dedupeCandidates([subtitled(), bare()], null, new Set(), new Set(), ['Apex'])
		expect(out).toHaveLength(1)
		// The richer Audible row wins the group; the TITLE comes from the tag.
		expect(out[0].asin).toBe('B0APEX00XX')
		expect(out[0].title).toBe('Apex')
	})

	test('the merged row is called what the library calls it (fuller tag)', () => {
		const out = dedupeCandidates([subtitled(), bare()], null, new Set(), new Set(), [
			'Apex: A Fantasy LitRPG Adventure'
		])
		expect(out).toHaveLength(1)
		expect(out[0].title).toBe('Apex: A Fantasy LitRPG Adventure')
	})

	test('no tag match leaves the winner titled as-is', () => {
		const out = dedupeCandidates([subtitled(), bare()], null, new Set(), new Set(), [
			'A Completely Different Name'
		])
		expect(out).toHaveLength(1)
		expect(out[0].title).toBe('Apex: A Fantasy LitRPG Adventure')
	})

	test('a volume-claiming remainder never merges', () => {
		// Two volumes of a series can coincidentally run close in length; a
		// subtitle that NUMBERS the work is an identity claim, not marketing.
		const one = scored({
			title: 'Defiance of the Fall',
			authors: ['TheFirstDefier'],
			audioSeconds: 90000
		})
		const ten = scored({
			id: 'y',
			title: 'Defiance of the Fall, Book 10',
			authors: ['TheFirstDefier'],
			audioSeconds: 90040
		})
		expect(dedupeCandidates([one, ten])).toHaveLength(2)
	})

	test('runtimes outside the rounding window never merge', () => {
		const a = subtitled()
		const b = { ...bare(), audioSeconds: 43230 + 300 }
		expect(dedupeCandidates([a, b])).toHaveLength(2)
	})

	test('a book-level row (no runtime) never merges by prefix', () => {
		// Without the runtime witness a prefix match is just two similar names
		// -- "Dune" the book record must not vanish into "Dune: Book One".
		const a = subtitled()
		const b = { ...bare(), audioSeconds: null }
		expect(dedupeCandidates([a, b])).toHaveLength(2)
	})

	test('a language conflict blocks the merge', () => {
		const a = { ...subtitled(), language: 'english' }
		const b = { ...bare(), language: 'german' }
		expect(dedupeCandidates([a, b])).toHaveLength(2)
	})

	test('a bare-space extension is not a subtitle', () => {
		// "Dune Messiah" is not the fuller form of "Dune" -- same boundary
		// rule as the ranker's titleExtendsQuery.
		const a = { ...subtitled(), title: 'Dune', authors: ['Frank Herbert'] }
		const b = {
			...bare(),
			title: 'Dune Messiah',
			authors: ['Frank Herbert'],
			audioSeconds: 43230
		}
		expect(dedupeCandidates([a, b])).toHaveLength(2)
	})

	test('junk never donates the tag title', () => {
		// Same rule as every identity donor: an AI-narrated row's fields must
		// not graft onto the human edition it merged with.
		const junkBare = { ...bare(), id: 'junk-1' }
		const out = dedupeCandidates([subtitled(), junkBare], null, new Set(['junk-1']), new Set(), [
			'Apex'
		])
		expect(out).toHaveLength(1)
		expect(out[0].title).toBe('Apex: A Fantasy LitRPG Adventure')
	})

	test('different authors never merge', () => {
		const a = subtitled()
		const b = { ...bare(), authors: ['Somebody Else'] }
		expect(dedupeCandidates([a, b])).toHaveLength(2)
	})
})

describe('prefix-extension merge author gate', () => {
	// The 2026-07-28 candidate-level audit found the one merge the first cut
	// missed: He Who Fights with Monsters 12, both rows 69960s and 1.0, shown
	// twice because one provider leads with the pen name and the other with
	// the legal name plus the narrator-as-coauthor. Author agreement is
	// any-overlap on the folded sets; identity still rests on the title
	// boundary and the runtime window.
	const subtitled = () =>
		scored({
			provider: 'audible',
			id: 'audible-hwfwm',
			asin: 'B0HWFWM12X',
			title: 'He Who Fights with Monsters 12: A LitRPG Adventure',
			authors: ['Shirtaloon', 'Travis Deverell'],
			audioSeconds: 69960
		})
	const bare = () =>
		scored({
			provider: 'overdrive',
			id: 'overdrive-hwfwm',
			title: 'He Who Fights with Monsters 12',
			authors: ['Travis Deverell', 'Shirtaloon', 'Heath Miller'],
			audioSeconds: 69960
		})

	test('author ORDER and extra co-authors do not block the merge', () => {
		expect(dedupeCandidates([subtitled(), bare()])).toHaveLength(1)
	})

	test('the merged row still takes the tag title', () => {
		const out = dedupeCandidates(
			[subtitled(), bare()],
			null,
			new Set(),
			new Set(),
			['He Who Fights with Monsters 12']
		)
		expect(out).toHaveLength(1)
		expect(out[0].title).toBe('He Who Fights with Monsters 12')
		expect(out[0].asin).toBe('B0HWFWM12X')
	})

	test('fully disjoint author sets still never merge', () => {
		const other = { ...bare(), authors: ['Somebody Else Entirely'] }
		expect(dedupeCandidates([subtitled(), other])).toHaveLength(2)
	})

	test('authorless rows never merge by prefix', () => {
		// An empty folded set overlaps nothing -- without any author witness
		// a prefix title plus a close runtime is not the same-recording bar.
		const anon = { ...bare(), authors: [] }
		expect(dedupeCandidates([subtitled(), anon])).toHaveLength(2)
	})
})

describe('agreeing-volume subtitle merge', () => {
	// The live He Who Fights with Monsters book 1 (2026-07-28): the sidecar
	// pins the hardcover listing titled "He Who Fights With Monsters, Vol. 1"
	// while OverDrive lists the same recording bare (21s of rounding apart).
	// ", Vol. 1" read as an identity claim and blocked the merge -- but the
	// book IS volume 1: a claim that AGREES with the query's own number is
	// publisher styling, not a different volume, so the runtime gate decides.
	// A DISAGREEING claim still blocks unconditionally.
	const volOne = () =>
		scored({
			provider: 'hardcover',
			id: 'hardcover-hwfwm1',
			asin: 'B08V3XQ7LK',
			title: 'He Who Fights With Monsters, Vol. 1',
			authors: ['Shirtaloon', 'Travis Deverell'],
			narrators: ['Heath Miller'],
			audioSeconds: 104160
		})
	const bare = () =>
		scored({
			provider: 'overdrive',
			id: 'overdrive-hwfwm1',
			title: 'He Who Fights with Monsters',
			authors: ['Shirtaloon'],
			narrators: ['Heath Miller'],
			audioSeconds: 104181
		})

	test('a claim agreeing with the query volume merges, pinned and tag-titled', () => {
		// The whole live shape at once: the pin keeps the sidecar identity as
		// the winner AND the tag graft names the merged row what the library
		// calls it -- pinned identity, correct display title.
		const out = dedupeCandidates(
			[volOne(), bare()],
			'B08V3XQ7LK',
			new Set(),
			new Set(),
			['He Who Fights with Monsters'],
			90,
			new Set([1])
		)
		expect(out).toHaveLength(1)
		expect(out[0].asin).toBe('B08V3XQ7LK')
		expect(out[0].title).toBe('He Who Fights with Monsters')
	})

	test('without the query volume the claim still blocks', () => {
		const out = dedupeCandidates(
			[volOne(), bare()],
			null,
			new Set(),
			new Set(),
			[],
			90,
			new Set()
		)
		expect(out).toHaveLength(2)
	})

	test('a DISAGREEING claim always blocks', () => {
		// Stated position 1, candidate subtitled Book 2 with a coincidentally
		// close runtime: the exact hazard the guard exists for.
		const two = {
			...volOne(),
			id: 'x2',
			asin: null,
			title: 'He Who Fights With Monsters, Vol. 2'
		}
		const out = dedupeCandidates(
			[two, bare()],
			null,
			new Set(),
			new Set(),
			[],
			90,
			new Set([1])
		)
		expect(out).toHaveLength(2)
	})
})

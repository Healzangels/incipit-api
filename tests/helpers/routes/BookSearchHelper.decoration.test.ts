import { describe, expect, test } from 'bun:test'

import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderCandidate } from '#helpers/providers/types'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'

/**
 * A FOLDER-FORM TITLE MUST NOT WIN A DEAD TIE ON ARRIVAL ORDER.
 *
 * Measured live, 2026-08-07, on the .99 library: Hardcover's community data
 * carries two editions of the same Xanth book — one titled the folder form
 * ("Xanth 19 - Roc and a Hard Place"), one clean ("Roc and a Hard Place").
 * Both have no asin, no narrators, no duration; both score 0.850. Every
 * identity arm in the comparator correctly declines, and byExactTitle cannot
 * separate them either, because normalizeTitle strips the "Xanth 19 - "
 * decoration — both normalize to the SAME name (verified directly). The tie
 * fell to arrival order, Hardcover listed the decorated one first, and the
 * bundle's Fix Match score is confidence-minus-index, so the operator saw the
 * junk title win 85 to 84 — for the folder-form query AND the clean one.
 *
 * The fix is a per-candidate cosmetic key (transitive by construction, like
 * every arm since the transitivity lesson): among rows the evidence cannot
 * tell apart, prefer the title with FEWER decoration characters — the raw
 * form closest to its own normalized name. It sits at the very bottom of the
 * comparator, after every identity arm has declined, so it can only choose
 * between rows that are otherwise indistinguishable.
 *
 * Deliberately NOT a dedupe merge: the operator rule is that edition variants
 * stay listed and pickable ("different metadata = different listings") — this
 * only fixes which one arrives first.
 */

function candidate(over: Partial<ProviderCandidate> = {}): ProviderCandidate {
	return {
		provider: 'hardcover',
		id: 'x',
		asin: null,
		title: 'Roc and a Hard Place',
		authors: ['Piers Anthony'],
		narrators: [],
		audioSeconds: null,
		cover: null,
		language: null,
		...over
	}
}

function helperFor(candidates: ProviderCandidate[], queryTitle: string) {
	const registry = { searchAll: async () => candidates } as unknown as ProviderRegistry
	return new BookSearchHelper(registry, {
		title: queryTitle,
		author: 'Piers Anthony',
		region: 'us'
	} as never)
}

// Ids chosen ADVERSARIALLY: the comparator's last-resort deterministic key
// orders by id, and 'a-decorated' sorts before 'z-clean' — so without the
// decoration arm, the junk title wins every case below (verified: this is
// exactly how live Hardcover ids fall). A friendly id choice masked the bug
// in this test's first draft.
const decorated = () => candidate({ id: 'a-decorated', title: 'Xanth 19 - Roc and a Hard Place' })
const clean = () => candidate({ id: 'z-clean', title: 'Roc and a Hard Place' })

describe('folder-form decoration loses dead ties', () => {
	for (const queryTitle of ['Xanth 19 - Roc and a Hard Place', 'Roc and a Hard Place']) {
		for (const [label, order] of [
			['decorated listed first', [decorated(), clean()]],
			['clean listed first', [clean(), decorated()]]
		] as const) {
			test(`query ${JSON.stringify(queryTitle)}, ${label}: clean title ranks first`, async () => {
				const out = await helperFor([...order], queryTitle)
				const results = await out.search()
				expect(results.length).toBe(2)
				// Both stay listed (operator rule: variants remain pickable)...
				expect(new Set(results.map((r) => r.id))).toEqual(new Set(['z-clean', 'a-decorated']))
				// ...but the undecorated form arrives first, regardless of input
				// order and regardless of which form the query used.
				expect(results[0].id).toBe('z-clean')
			})
		}
	}
})

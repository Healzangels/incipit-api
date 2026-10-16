/**
 * The book-enrichment overlay: an operator-approved description and genre list
 * served IN PLACE OF the provider's, for specific editions, so Incipit stays the
 * single source of truth and a forced Plex refresh delivers it (the bundle
 * already writes `summary` and replaces `genres` on a forced refresh; no bundle
 * change). Design: docs/design/spec-book-enrichment-overlay.md.
 *
 * This module is the compiled-in half: the load-time GATE (compileOverlay), the
 * KEYS, the LOOKUP and the serve step. The data is a private runtime file
 * (overlayStore.ts), because the public repository must not carry operator
 * prose or review quotes.
 *
 * KEYS, tried in order — the first that answers wins:
 *   1. the served record id, exact (ASIN or provider id);
 *   2. a (title, author, narrator) key: the same narration under another id;
 *   3. pinKey(title, author), ONLY when the loader proved it unambiguous: no
 *      other edition in the file, of any status, shares it. Two narrations of
 *      one title (the two Harry Potter 5 recordings) refuse it for both.
 * A key match is a WORK match at heart, so it never borrows another recording's
 * identity: the title key serves the work's text only (no narration praise, no
 * recording awards, no edition credits), and either key is refused on a record
 * in another language than the hook's. A lookup that reaches two different
 * entries answers "no overlay" — never the wrong one.
 */
import type { ApiGenre } from '#config/types'
import { OVERLAY_GENRE_VOCABULARY } from '#helpers/overlay/genreVocabulary'
import {
	EDITION_ID,
	type OverlayEdition,
	type OverlayFile,
	OverlayFileSchema,
	type OverlayWork
} from '#helpers/overlay/overlaySchema'
import { type OverlayRecord, renderOverlaySummary } from '#helpers/overlay/renderOverlay'
import { syntheticGenreAsin } from '#helpers/providers/hardcoverGenres'
import { foldKeyPart, pinKey } from '#helpers/series/pinKey'

/** One edition the table SERVES (approved, not held). */
export interface ServedEdition {
	id: string
	workKey: string
	work: OverlayWork
	edition: OverlayEdition
}

export interface OverlayReport {
	/** Approved, not held: what the table serves. */
	served: number
	drafts: number
	/** Ids kept out by `held`, whatever their status. */
	held: string[]
	/** Served editions whose keys could not be formed (an all-symbol title):
	 *  reachable by id only. */
	idOnly: string[]
	/** Title keys withheld because more than one edition shares them. */
	refusedTitleKeys: { key: string; editions: string[] }[]
}

export interface OverlayTable {
	byId: ReadonlyMap<string, ServedEdition>
	byNarration: ReadonlyMap<string, ServedEdition>
	byTitle: ReadonlyMap<string, ServedEdition>
	/** Record ids on a STOP card: never overlaid, by id or by any key. */
	held: ReadonlySet<string>
	/** Every key each served edition is filed under, for check:overlay. */
	keysByEdition: ReadonlyMap<string, { narration: string | null; title: string | null }>
	report: OverlayReport
}

export type CompileResult = { ok: true; table: OverlayTable } | { ok: false; errors: string[] }

/** "(Narrated by Stephen Fry)", "[Read by the Author]": a qualifier that names
 *  the RECORDING, not the book. Folded out of every key's title so the two
 *  narrations of one book collide on the plain key — which is exactly how the
 *  loader learns that the plain key is ambiguous. */
const NARRATION_QUALIFIER = /\s*[([]\s*(?:narrated|read|performed)\s+by\b[^)\]]*[)\]]/gi

/**
 * The plain (title, author) key, narration qualifier folded out.
 * @param {string | null | undefined} title the PRE-pin title
 * @param {string | null | undefined} author one author's name
 * @returns {string} the key, or '' when it cannot be formed
 */
export function overlayTitleKey(
	title: string | null | undefined,
	author: string | null | undefined
): string {
	if (!title) return ''
	return pinKey(String(title).replace(NARRATION_QUALIFIER, ''), author)
}

/**
 * The (title, author, narrator) key.
 * @param {string | null | undefined} title the PRE-pin title
 * @param {string | null | undefined} author one author's name
 * @param {string | null | undefined} narrator one narrator's name
 * @returns {string} the key, or '' when any half is missing
 */
export function overlayNarrationKey(
	title: string | null | undefined,
	author: string | null | undefined,
	narrator: string | null | undefined
): string {
	const base = overlayTitleKey(title, author)
	const n = narrator ? foldKeyPart(String(narrator)) : ''
	return base && n ? `${base}|${n}` : ''
}

/**
 * The genres an overlay serves: the approved names, in the approved order, with
 * the same synthetic ids every community genre carries (the schema needs 10-12
 * digits; the bundle reads only the name).
 *
 * NOT through namesToGenres, deliberately: that mapper normalises free text
 * (alias fold, self-reference drop, a cap). It used to DROP two approved names
 * as noise, "Fairy Tales, Folk Tales & Myths" (too long) and "Movie, TV & Video
 * Game Tie-Ins" (too many words); it now exempts the approved list and keeps
 * both. The vocabulary is closed and checked at load, so there is nothing left
 * to normalise.
 * @param {readonly string[]} names approved vocabulary names
 * @returns {ApiGenre[]} schema-valid genres, one per name
 */
export function overlayGenres(names: readonly string[]): ApiGenre[] {
	return names.map((name) => ({ asin: syntheticGenreAsin(name), name, type: 'genre' }))
}

const zodErrors = (issues: { path: PropertyKey[]; message: string }[]): string[] =>
	issues.map((i) => `${i.path.map(String).join('.') || '(file)'}: ${i.message}`)

/**
 * Validate a parsed overlay file and compile its lookup tables — the mintPins
 * gate, run at load. ANY failure refuses the whole file: the caller keeps its
 * last good table, so a half-valid file can never be half-served.
 * @param {unknown} raw the parsed JSON
 * @returns {CompileResult} the table, or every reason the file was refused
 */
export function compileOverlay(raw: unknown): CompileResult {
	const parsed = OverlayFileSchema.safeParse(raw)
	if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error.issues) }
	const file: OverlayFile = parsed.data
	const errors: string[] = []
	const held = new Set(Object.keys(file.held ?? {}))

	for (const [key, work] of Object.entries(file.works)) {
		const seen = new Set<string>()
		for (const g of work.genres) {
			if (!OVERLAY_GENRE_VOCABULARY.has(g))
				errors.push(`works.${key}.genres: "${g}" is not in the approved vocabulary`)
			if (seen.has(g)) errors.push(`works.${key}.genres: "${g}" listed twice`)
			seen.add(g)
		}
		for (const a of work.awards ?? [])
			if (a.scope && a.scope !== 'work')
				errors.push(`works.${key}.awards: "${a.award}" is scoped to a recording, not the work`)
	}

	const served: ServedEdition[] = []
	let drafts = 0
	for (const [id, edition] of Object.entries(file.editions)) {
		// The id is looked up EXACTLY, so a key the route can never be asked for
		// ("B0…_us", with the bundle's region suffix) is a dead entry: refuse it.
		if (!EDITION_ID.test(id)) errors.push(`editions.${id}: not a bare record id`)
		const work = Object.hasOwn(file.works, edition.work) ? file.works[edition.work] : undefined
		if (!work) {
			errors.push(`editions.${id}.work: no work "${edition.work}"`)
			continue
		}
		for (const a of edition.awards ?? [])
			if (a.scope && a.scope !== 'this-recording')
				errors.push(`editions.${id}.awards: "${a.award}" is scoped to the work; file it there`)
		if (edition.status !== 'approved') {
			drafts += 1
			continue
		}
		if (!edition.approved_on) errors.push(`editions.${id}: approved without an approved_on stamp`)
		if (edition.gate2_open) errors.push(`editions.${id}: approved with an open Gate 2 question`)
		// The template shows at most two quotes. More than two approved means the
		// operator approved text the reader will never see, which is a mistake to
		// surface, not to truncate silently.
		const quotes = (edition.praise?.length ?? 0) + (work.praise?.length ?? 0)
		if (quotes > 2) errors.push(`editions.${id}: ${quotes} praise quotes; the template shows 2`)
		if (held.has(id)) continue
		served.push({ id, workKey: edition.work, work, edition })
	}

	// Title-key multiplicity over EVERY edition in the file, drafts and held ones
	// included: a narration the file knows about but has not approved is still
	// a second narration, and granting the plain key to the approved one would
	// hand its text to the other the moment a library matched it.
	const titleOwners = new Map<string, Set<string>>()
	for (const [id, edition] of Object.entries(file.editions)) {
		const k = overlayTitleKey(edition.keys.title, edition.keys.author)
		if (k) titleOwners.set(k, (titleOwners.get(k) ?? new Set()).add(id))
	}

	const byId = new Map<string, ServedEdition>()
	const byNarration = new Map<string, ServedEdition>()
	const byTitle = new Map<string, ServedEdition>()
	const keysByEdition = new Map<string, { narration: string | null; title: string | null }>()
	const idOnly: string[] = []
	for (const s of served) {
		byId.set(s.id, s)
		const { title, author, narrator } = s.edition.keys
		const nk = overlayNarrationKey(title, author, narrator)
		if (nk) {
			// A COLLISION, not an ambiguity to route around: two approved entries
			// claiming one narration is two texts for one recording, and only the
			// operator can say which is right.
			const other = byNarration.get(nk)
			if (other) errors.push(`editions.${s.id}: narration key "${nk}" collides with ${other.id}`)
			else byNarration.set(nk, s)
		}
		const tk = overlayTitleKey(title, author)
		const owners = tk ? (titleOwners.get(tk)?.size ?? 0) : 0
		if (tk && owners === 1) byTitle.set(tk, s)
		keysByEdition.set(s.id, { narration: nk || null, title: tk && owners === 1 ? tk : null })
		if (!nk && !tk) idOnly.push(s.id)
	}

	if (errors.length) return { ok: false, errors }
	const refusedTitleKeys = [...titleOwners]
		.filter(([, ids]) => ids.size > 1)
		.map(([key, ids]) => ({ key, editions: [...ids].sort() }))
		.sort((a, b) => a.key.localeCompare(b.key))
	return {
		ok: true,
		table: {
			byId,
			byNarration,
			byTitle,
			held,
			keysByEdition,
			report: {
				served: served.length,
				drafts,
				held: [...held].sort(),
				idOnly: idOnly.sort(),
				refusedTitleKeys
			}
		}
	}
}

/** What the lookup reads off the record: the PRE-pin title (a pin's
 *  displayTitle would otherwise decide which text a book gets), its people, and
 *  its language. */
export interface OverlayKeySource {
	title?: string | null
	authors?: ReadonlyArray<{ name?: string | null } | null | undefined> | null
	narrators?: ReadonlyArray<{ name?: string | null } | null | undefined> | null
	language?: string | null
}

export interface OverlayMatch {
	via: 'id' | 'narration' | 'title'
	entry: ServedEdition
	/** The edition whose recording-scoped items render; null on a title match. */
	edition: OverlayEdition | null
}

/** A key match is refused on a record in another language: the hook is written
 *  for one, and Hyperion's French record folds to the same title key as the
 *  English one ("Hypérion" -> "hyperion"). An unknown language is not a
 *  conflict. */
const languageAllows = (rec: OverlayKeySource, work: OverlayWork): boolean => {
	const lang = typeof rec.language === 'string' ? rec.language.trim().toLowerCase() : ''
	return !lang || lang === (work.language ?? 'english').toLowerCase()
}

/** The DISTINCT entries a set of keys reached. More than one means the record
 *  could be either book, and serving one of them would be a guess. */
const reached = (hits: ReadonlyArray<ServedEdition | undefined>): ServedEdition[] => {
	const found = new Map<string, ServedEdition>()
	for (const h of hits) if (h) found.set(h.id, h)
	return [...found.values()]
}

const people = (list: OverlayKeySource['authors']): string[] =>
	(list ?? []).map((p) => p?.name).filter((n): n is string => typeof n === 'string' && !!n)

/**
 * Find the overlay entry for a served record.
 * @param {OverlayKeySource} book the record BEFORE pins (pre-pin title)
 * @param {string | null | undefined} recordId the id the record is served under
 * @param {OverlayTable} table the compiled table
 * @returns {OverlayMatch | null} the match, or null for "no overlay"
 */
export function findOverlay(
	book: OverlayKeySource,
	recordId: string | null | undefined,
	table: OverlayTable
): OverlayMatch | null {
	// A HELD record stays out entirely — not only its own entry, but any other
	// entry its keys would reach. That is what a STOP card means.
	if (recordId && table.held.has(recordId)) return null
	// Own-property semantics for free: a Map never answers "constructor".
	const exact = recordId ? table.byId.get(recordId) : undefined
	if (exact) return { via: 'id', entry: exact, edition: exact.edition }

	const authors = people(book.authors)
	const narrators = people(book.narrators)
	const narration = reached(
		authors.flatMap((a) =>
			narrators.map((n) => table.byNarration.get(overlayNarrationKey(book.title, a, n)))
		)
	)
	// Two narration entries reached: the record could be either recording.
	if (narration.length > 1) return null
	if (narration.length === 1)
		return languageAllows(book, narration[0].work)
			? { via: 'narration', entry: narration[0], edition: narration[0].edition }
			: null

	const title = reached(authors.map((a) => table.byTitle.get(overlayTitleKey(book.title, a))))
	if (title.length === 1 && languageAllows(book, title[0].work))
		return { via: 'title', entry: title[0], edition: null }
	return null
}

/**
 * Serve the overlay: replace `summary` with the rendered text and `genres` with
 * the approved list (REPLACE, never merge — merging would put the provider's
 * "Science Fiction & Fantasy" back beside the curated names). Every other field
 * is left exactly as served, and a book with no entry comes back as the SAME
 * object.
 *
 * Runs LAST in the route, after applyShelfPolicy(applyPins(...)), so the Series
 * line states the shelf the book is actually served on.
 * @param {T} served the record as it will be served (post-pin, post-policy)
 * @param {OverlayKeySource} prePin the record before pins, for the keys
 * @param {string | null | undefined} recordId the requested record id
 * @param {OverlayTable | null | undefined} table the compiled table; null or
 *   undefined switches the overlay off (the A/B's arm A)
 * @returns {T} the served record, overlaid when an entry matches
 */
export function applyBookOverlay<T extends OverlayRecord>(
	served: T,
	prePin: OverlayKeySource,
	recordId: string | null | undefined,
	table: OverlayTable | null | undefined
): T {
	if (!table) return served
	const match = findOverlay(prePin, recordId, table)
	if (!match) return served
	return {
		...served,
		summary: renderOverlaySummary(match.entry.work, match.edition, served),
		genres: overlayGenres(match.entry.work.genres)
	}
}

/**
 * The book-enrichment overlay FILE format (schema 1). Compiled in, like the pin
 * machinery; the data itself is a private runtime file (see overlayStore.ts and
 * docs/design/spec-book-enrichment-overlay.md).
 *
 * TWO LEVELS, so one approved text serves every edition of a book:
 * - `works` hold what all editions share: the hook, an optional setting
 *   paragraph, the genres, work-scoped awards and praise, an optional
 *   `series_total` and a Contents list;
 * - `editions` hold one RECORDING: the id it is served under, its keys, the
 *   narration praise, recording-scoped awards (Audie, Earphones, Grammy),
 *   translator/production credits and its approval stamp.
 *
 * What is NOT here is as deliberate: the credits line (narrators, abridgement,
 * runtime, publisher, year) and the Series line are rendered from the SERVED
 * record at serve time, so a corrected match or a new pin fixes them by itself.
 *
 * Every object is STRICT: an unknown field is a refusal, not a silently ignored
 * typo — `series_totl` would otherwise drop "of 14" with nothing to show for it.
 */
import { z } from 'zod'

/** Operator prose must be plain text, exactly as Plex will show it. The rule is
 * the reference renderer's (overlay_render.py): no `<` at all, and `&` only
 * before whitespace ("Simon & Schuster" yes, `&amp;` or `&#8212;` no), so an
 * entity can never reach Plex undecoded — the bundle decodes nothing. */
export const isPlainText = (s: string): boolean => !s.includes('<') && !/&(?!\s)/.test(s)

const Plain = z
	.string()
	.trim()
	.min(1)
	.refine(isPlainText, 'must be plain text: no "<", and "&" only before a space')

/** One line of the rendered text; a newline here would break the template. */
const Line = Plain.refine((s) => !/[\r\n]/.test(s), 'must be a single line')

const Year = z.number().int().min(1000).max(2999)

/** A juried result only: PLAN-v2 4.2 serves winners, finalists and shortlists,
 * never poll placements or plain nominations. Anything else is a refusal at
 * load rather than a silent filter at render, so a "nominee" in an approved
 * entry is caught by the operator, not quietly dropped. */
const Award = z.strictObject({
	award: Line,
	year: Year,
	category: Line,
	result: z.enum(['winner', 'finalist', 'shortlist']),
	scope: z.enum(['work', 'this-recording']).optional(),
	/** Verified means sourced: at least one URL per award. */
	sources: z.array(z.url()).min(1),
	notes: z.string().optional()
})

const Praise = z.strictObject({
	text: Line.refine(
		(s) => !s.startsWith('('),
		'reads like a placeholder ("(quote pending approval)"), not an approved quote'
	),
	source: Line,
	year: Year,
	url: z.string().optional(),
	scope: z.enum(['work', 'this-recording']).optional()
})

export const OverlayWorkSchema = z.strictObject({
	/** Documentation only ("series fantasy", "memoir"): never rendered. */
	kind: z.string().optional(),
	notes: z.string().optional(),
	hook: Plain,
	setting: Plain.optional(),
	/** 4-6 names from the approved vocabulary, broad to specific (PLAN-v2 4.4).
	 *  Vocabulary membership is checked by the loader, which owns the list. */
	genres: z.array(z.string()).min(4).max(6),
	awards: z.array(Award).optional(),
	praise: z.array(Praise).optional(),
	/** The series' length, only when it is COMPLETE ("Book 5 of 14"). */
	series_total: z.number().int().positive().optional(),
	/** Story titles for a collection, in order. */
	contents: z.array(Line).min(1).optional(),
	/** Only when the publisher states one; never invented (PLAN-v2 4.2). */
	age_band: Line.optional(),
	/** The language the hook is written for; a KEY match (not an id match) is
	 *  refused on a record in another language. Defaults to english. */
	language: z.string().optional()
})
export type OverlayWork = z.infer<typeof OverlayWorkSchema>

export const OverlayEditionSchema = z.strictObject({
	work: z.string().min(1),
	keys: z.strictObject({ title: Line, author: Line, narrator: Line }),
	status: z.enum(['approved', 'draft']),
	/** The approval stamp, YYYY-MM-DD. Required for an approved entry. */
	approved_on: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	praise: z.array(Praise).optional(),
	awards: z.array(Award).optional(),
	/** Replaces "Narrated by … · Unabridged" for a production credited as a whole
	 *  ("GraphicAudio dramatized adaptation, full cast"); the cast stays in Plex
	 *  styles. */
	production: Line.optional(),
	/** One extra credits line, joined with " · " ("Translated by Robert Fagles",
	 *  "Introduction by Bernard Knox"). */
	credits: z.array(Line).min(1).optional(),
	/** "Read by the author" for a recording the record does not reveal as one
	 *  (its first narrator is spelled differently from the author). */
	read_by_author: z.boolean().optional(),
	notes: z.string().optional(),
	/** An open Gate 2 question. Allowed on a draft only: an approved entry with
	 *  an unanswered question is a contradiction the loader refuses. */
	gate2_open: z.string().optional()
})
export type OverlayEdition = z.infer<typeof OverlayEditionSchema>

/** A served record id: an ASIN or a provider id (`hardcover-book-…`), bare —
 *  never the bundle's `_us` region suffix, which the lookup does not strip. */
export const EDITION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/

export const OverlayFileSchema = z.strictObject({
	schema: z.literal(1),
	about: z.string().optional(),
	works: z.record(z.string().min(1), OverlayWorkSchema),
	editions: z.record(z.string().min(1), OverlayEditionSchema),
	/** Editions deliberately kept out, with the reason (a STOP card). An id here
	 *  is never served even when an approved entry exists for it. */
	held: z.record(z.string(), z.string()).optional()
})
export type OverlayFile = z.infer<typeof OverlayFileSchema>

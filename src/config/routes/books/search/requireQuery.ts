/**
 * True when a book search carries no usable query at all.
 *
 * Zod makes `title`, `query` and `keywords` individually optional, so the
 * route enforces "at least one". `keywords` was missing from that check even
 * though `BookSearchHelper` resolves `title ?? query ?? keywords` — and
 * `types.ts` records why the alias exists: "Plex's Audible album search falls
 * back to a bare `keywords` param when it has no artist name". So the one
 * case the alias was added for (the authorless / phantom-artist album) was
 * rejected with a 400 before it ever reached the helper. Verified live
 * 2026-07-28: `?keywords=Mistborn` → 400, `?query=Mistborn` → results.
 *
 * A function so the rule is testable on its own; the mutation sweep showed
 * that guards living inline in a route handler go unenforced.
 */
export default function searchRequiresATitle(options: {
	title?: string
	query?: string
	keywords?: string
}): boolean {
	return !options.title && !options.query && !options.keywords
}

/**
 * Whether a provider's stated release date is still in the future.
 *
 * Exists because a PRE-ORDER is not a match candidate: nobody's library holds a
 * file of a book that has not been published, so a future-dated listing competing
 * on title and author can only ever displace the edition actually on disk. The
 * Plex bundle has carried a guard for exactly this since audnexus
 * (`check_if_preorder`), but it only runs when the search result carries a date,
 * and the incipit-api candidate path supplies none — so it has been inert for the
 * whole life of this deployment. Measured on prod 2026-08-14: 3 of 1313 matched
 * ASINs were unreleased, one of them a book five weeks out.
 *
 * SEARCH ONLY. Fetching a pre-order BY ASIN must still return its metadata — see
 * the note in `ApiHelper.getReleaseDate`, which deliberately does not reject
 * future dates because a pre-order already sitting in someone's library still
 * needs to resolve. Excluding a candidate from a competition and refusing to
 * describe a book are different things; do not collapse them.
 *
 * FAILS OPEN. An absent, empty or unparseable date returns false — the same rule
 * `language: null` follows, where absence means "unknown" and never "mismatch".
 * A provider that stops sending dates must lose the guard, not its whole catalog.
 *
 * Compared as CALENDAR DAYS in UTC, not instants: a book released today is
 * released. Comparing timestamps would make a release-day listing appear and
 * disappear depending on the hour the scan ran and the server's timezone.
 * @param {string | null | undefined} value the provider's stated release date
 * @param {Date} now the instant to judge against, injected so tests need no clock
 * @returns {boolean} true only when the date is definitely a future day
 */
export function isUnreleased(value: string | null | undefined, now: Date): boolean {
	if (typeof value !== 'string' || !value.trim()) return false
	const parsed = new Date(value)
	if (Number.isNaN(parsed.getTime())) return false
	const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
	return day(parsed) > day(now)
}

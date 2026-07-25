/**
 * Guess the language of a prose blurb from its function words.
 *
 * WHY THIS EXISTS
 * Apple Books is the one provider with no language field at all, and it serves
 * localized editions under the ORIGINAL title: the Spanish audiobook of R. F.
 * Kuang's "Babel" is titled exactly "Babel". So the Spanish edition and the
 * English one score identically (0.850 each on title+author), languageConflict
 * cannot fire on a null, and FOREIGN_EDITION_RE finds no "(Spanish Edition)"
 * marker to latch onto. Nothing in the scorer can tell them apart, and the
 * Spanish one wins whenever the tiebreaks happen to favour it. Measured live:
 * "Babel" and Margaret Atwood's "Oryx and Crake" both landed on Spanish
 * editions in a 1,400-book library.
 *
 * The description IS in the search payload — Apple returns it alongside the
 * title — so the signal was there and simply unused. Classifying it lets the
 * existing LANGUAGE_CONFLICT_PENALTY do its job.
 *
 * WHY STOPWORDS RATHER THAN A LIBRARY
 * A publisher blurb is 50-300 words of ordinary prose, which is the easiest
 * case there is: function words ("the/and/of" vs "el/los/que") are the highest
 * frequency tokens in any of these languages and barely overlap across them.
 * Validated against 1,395 real audiobook summaries from the live library: it
 * flagged exactly the two known Spanish editions and produced no false
 * positives. A dependency would buy accuracy this job does not need.
 *
 * DELIBERATELY CONSERVATIVE
 * Returns null — "no signal", exactly what the provider passed before — unless
 * the text is long enough to judge AND one language wins clearly. A wrong
 * foreign label is the expensive error: it would demote a legitimate English
 * edition by LANGUAGE_CONFLICT_PENALTY. A missed detection only restores the
 * old behaviour.
 */

// Function words per language, chosen for frequency and for NOT being ordinary
// English words — "die"/"la"/"as"/"no"/"in"/"on" are excluded for that reason,
// as an English blurb contains them constantly.
const STOPWORDS: Record<string, string[]> = {
	en: 'the and of to in a is for with that on as by from at his her it this an but was were'.split(
		' '
	),
	es: 'el los las del que con por para una unos unas pero son fue como cuando donde muy sus'.split(
		' '
	),
	de: 'der das den dem des und ist mit von auf ein eine einen einem nicht sich auch aber sie'.split(
		' '
	),
	fr: 'les des une dans pour par sur avec sont est qui ne pas aux cette leur mais tout plus'.split(
		' '
	),
	it: 'gli della delle degli nel sul con per non come sono anche questo quella suo dei alla'.split(
		' '
	),
	pt: 'dos das uma que com por para nao mais como seu sua mas quando onde muito seus suas'.split(
		' '
	),
	nl: 'het een van en is dat op te met voor zijn niet aan door maar ook deze werd naar'.split(' ')
}

// Below this many tokens a blurb is a tagline, not prose, and the counts are
// noise. Live distribution: 18 of 1,413 summaries fell under it.
const MIN_TOKENS = 25

// The winner must beat English by this factor. A translated blurb scores its own
// language many times higher, so the bar costs nothing real while ruling out a
// stray "el"/"von" in an English text (a Spanish place name, a German surname).
const MARGIN = 1.5

// At least this many function-word hits, so a short text that happens to contain
// two foreign tokens cannot win on a technicality.
const MIN_HITS = 4

const TOKEN_RE = /[a-zà-öø-ÿ']+/g

/**
 * The ISO-639-1 code a blurb appears to be written in, or null when unsure.
 * @param {string | null | undefined} text prose to classify (a publisher blurb)
 * @returns {string | null} 'en', 'es', 'de', ... or null for "no signal"
 */
export default function detectTextLanguage(text: string | null | undefined): string | null {
	if (!text) return null
	const tokens = text.toLowerCase().match(TOKEN_RE)
	if (!tokens || tokens.length < MIN_TOKENS) return null

	const counts = new Map<string, number>()
	for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)

	let best: string | null = null
	let bestScore = 0
	let englishScore = 0
	for (const [lang, words] of Object.entries(STOPWORDS)) {
		let score = 0
		for (const w of words) score += counts.get(w) ?? 0
		if (lang === 'en') englishScore = score
		if (score > bestScore) {
			bestScore = score
			best = lang
		}
	}

	if (best == null || bestScore < MIN_HITS) return null
	// English is the library's default expectation, so it only has to win, while
	// any other language has to beat English by the margin to be acted on.
	if (best === 'en') return 'en'
	return bestScore > englishScore * MARGIN ? best : null
}

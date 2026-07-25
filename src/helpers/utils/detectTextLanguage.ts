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

import { foldDiacritics } from '#helpers/utils/foldDiacritics'

// Function words per language, each list holding that language's OWN
// highest-frequency words -- including ones that collide with English.
//
// The first version excluded collisions ("a", "in", "as", "on") from the
// non-English lists so English prose would not score as Italian. That inverted
// the problem: Italian's top words ARE "il/la/di/che/e/un", and omitting them
// left Italian scoring 1 while English scored 6 on the Italian text's own "a"
// and "in" -- so real Italian blurbs returned 'en', which is both the bug the
// feature exists to fix and a demotion of the CORRECT edition in an it/fr/de
// region library. Measured on a 66-token Italian blurb: en=6, it=1.
//
// Overlap is not a defect here, it is the mechanism. A word common to two
// languages adds to both and cancels; discrimination comes from the words that
// are NOT shared, of which every language has plenty. So each list is simply
// that language's real function-word set.
const STOPWORDS: Record<string, string[]> = {
	en: ('the and of to in a is for with that on as by from at his her it this an but was were ' +
		'not are have has had he she they you we all one out so what when who will there their').split(
		' '
	),
	es: ('el la los las de del y en un una que con por para su como pero es son fue no se al lo ' +
		'mas este esta cuando donde muy sus ha han sobre entre').split(' '),
	de: ('der die das den dem des und ist im mit von auf ein eine einen einem nicht sich als auch ' +
		'er sie es zu fur aus bei nach uber wird war hat dass').split(' '),
	fr: ('le la les des du de et en un une que dans pour par sur avec est sont il elle ce qui ne ' +
		'pas au aux son sa ses plus tout comme mais ou').split(' '),
	it: ('il lo la gli le di del della e in un una che con per non si come piu sono anche questo ' +
		'quella suo dei alla da al ma nel sul suoi').split(' '),
	pt: ('o a os as de do da dos das e em um uma que com por para nao se mais como seu sua mas ' +
		'quando onde muito ao pelo pela').split(' '),
	nl: ('de het een en van in is dat op te met voor zijn niet aan door maar ook deze werd naar ' +
		'hij zij uit over bij').split(' ')
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
 * Tokens, lowercased and diacritic-folded.
 *
 * Folding is what lets the tables above stay ASCII: real prose tokenizes to
 * "mas"/"piu"/"nao" only after the accents come off, so an unfolded lookup
 * silently disables every accented function word. The first version listed a
 * bare "nao" against text that always tokenizes as "n-a-o-tilde", making that
 * entry unreachable -- one dead word in eighteen, invisible because the
 * remaining seventeen still summed to a plausible score.
 * @param {string} text prose to tokenize
 * @returns {string[]} lowercased, accent-folded tokens
 */
function tokens(text: string): string[] {
	return foldDiacritics(text.toLowerCase()).match(TOKEN_RE) ?? []
}

/**
 * The ISO-639-1 code a blurb appears to be written in, or null when unsure.
 * @param {string | null | undefined} text prose to classify (a publisher blurb)
 * @returns {string | null} 'en', 'es', 'de', ... or null for "no signal"
 */
export default function detectTextLanguage(text: string | null | undefined): string | null {
	if (!text) return null
	const words = tokens(text)
	if (words.length < MIN_TOKENS) return null

	const counts = new Map<string, number>()
	for (const t of words) counts.set(t, (counts.get(t) ?? 0) + 1)

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

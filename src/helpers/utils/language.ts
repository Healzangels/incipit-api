/**
 * Language normalization, shared by every provider and the matcher.
 *
 * Providers report language in three different notations — Hardcover uses
 * English names ("German"), Storytel ISO-639-1 ("de"), OpenLibrary ISO-639-2/B
 * a.k.a. MARC ("ger") — so nothing can be compared until it is reduced to one
 * canonical form. Everything here normalizes to lowercase **ISO-639-1**.
 *
 * Why this matters: a foreign edition of a book whose title does not translate
 * ("Dune", "It", "1984") scores identically to the English one on title+author,
 * and a translation's runtime usually lands inside the duration veto's dead
 * zone. Without a language signal the winner is decided by provider order.
 *
 * Also the single region→language table. It previously existed twice (Hardcover
 * in names, Storytel in codes), which is the mirror-drift pattern where adding a
 * region means editing N files and missing one.
 */

import { foldDiacritics } from '#helpers/utils/foldDiacritics'

/** Canonical language names → ISO-639-1. Lowercased keys; accents included. */
const NAME_TO_CODE: Record<string, string> = {
	english: 'en',
	german: 'de',
	deutsch: 'de',
	spanish: 'es',
	castilian: 'es',
	espanol: 'es',
	español: 'es',
	french: 'fr',
	français: 'fr',
	francais: 'fr',
	italian: 'it',
	italiano: 'it',
	japanese: 'ja',
	portuguese: 'pt',
	português: 'pt',
	dutch: 'nl',
	nederlands: 'nl',
	swedish: 'sv',
	svenska: 'sv',
	norwegian: 'no',
	norsk: 'no',
	danish: 'da',
	dansk: 'da',
	finnish: 'fi',
	suomi: 'fi',
	polish: 'pl',
	polski: 'pl',
	russian: 'ru',
	chinese: 'zh',
	mandarin: 'zh',
	korean: 'ko',
	czech: 'cs',
	turkish: 'tr',
	greek: 'el',
	hebrew: 'he',
	arabic: 'ar',
	hindi: 'hi',
	hungarian: 'hu',
	romanian: 'ro',
	ukrainian: 'uk',
	catalan: 'ca',
	lithuanian: 'lt',
	latin: 'la',
	// Less-common but real catalog languages. The failure mode of a MISSING entry
	// is silent: normalizeLanguage returns null, "unknown" never conflicts, and
	// the wrong-language demotion simply doesn't fire for that provider — while
	// the same language as a bare ISO code ("vi") sails through. So err broad.
	vietnamese: 'vi',
	thai: 'th',
	indonesian: 'id',
	malay: 'ms',
	tagalog: 'tl',
	filipino: 'tl',
	icelandic: 'is',
	íslenska: 'is',
	slovak: 'sk',
	slovenčina: 'sk',
	slovenian: 'sl',
	slovene: 'sl',
	slovenščina: 'sl',
	bulgarian: 'bg',
	serbian: 'sr',
	srpski: 'sr',
	croatian: 'hr',
	hrvatski: 'hr',
	bosnian: 'bs',
	estonian: 'et',
	latvian: 'lv',
	persian: 'fa',
	farsi: 'fa',
	afrikaans: 'af',
	swahili: 'sw',
	welsh: 'cy',
	irish: 'ga',
	galician: 'gl',
	basque: 'eu',
	bengali: 'bn',
	tamil: 'ta',
	urdu: 'ur',
	// Native names that reach us in the language's own script/diacritics.
	bokmål: 'no',
	bokmal: 'no',
	nynorsk: 'no',
	čeština: 'cs',
	cestina: 'cs',
	magyar: 'hu',
	română: 'ro',
	romana: 'ro',
	українська: 'uk',
	русский: 'ru',
	türkçe: 'tr',
	turkce: 'tr',
	ελληνικά: 'el',
	עברית: 'he',
	العربية: 'ar',
	中文: 'zh',
	日本語: 'ja',
	한국어: 'ko'
}

/** ISO-639-2/B + /T (MARC, as OpenLibrary reports) → ISO-639-1. */
const THREE_TO_CODE: Record<string, string> = {
	eng: 'en',
	ger: 'de',
	deu: 'de',
	spa: 'es',
	fre: 'fr',
	fra: 'fr',
	ita: 'it',
	jpn: 'ja',
	por: 'pt',
	dut: 'nl',
	nld: 'nl',
	swe: 'sv',
	nor: 'no',
	dan: 'da',
	fin: 'fi',
	pol: 'pl',
	rus: 'ru',
	chi: 'zh',
	zho: 'zh',
	kor: 'ko',
	cze: 'cs',
	ces: 'cs',
	tur: 'tr',
	gre: 'el',
	ell: 'el',
	heb: 'he',
	ara: 'ar',
	hin: 'hi',
	hun: 'hu',
	rum: 'ro',
	ron: 'ro',
	ukr: 'uk',
	cat: 'ca',
	lit: 'lt',
	lat: 'la',
	// Companions to the NAME_TO_CODE additions — both /B (MARC) and /T forms.
	vie: 'vi',
	tha: 'th',
	ind: 'id',
	may: 'ms',
	msa: 'ms',
	tgl: 'tl',
	fil: 'tl',
	ice: 'is',
	isl: 'is',
	slo: 'sk',
	slk: 'sk',
	slv: 'sl',
	bul: 'bg',
	srp: 'sr',
	hrv: 'hr',
	bos: 'bs',
	est: 'et',
	lav: 'lv',
	per: 'fa',
	fas: 'fa',
	afr: 'af',
	swa: 'sw',
	wel: 'cy',
	cym: 'cy',
	gle: 'ga',
	glg: 'gl',
	baq: 'eu',
	eus: 'eu',
	ben: 'bn',
	tam: 'ta',
	urd: 'ur',
	nob: 'no',
	nno: 'no'
}

/**
 * Region → the language we expect its catalog to be in, ISO-639-1.
 * THE single source of truth; providers must not keep private copies.
 */
const REGION_LANGUAGE: Record<string, string> = {
	us: 'en',
	uk: 'en',
	ca: 'en',
	au: 'en',
	in: 'en',
	de: 'de',
	es: 'es',
	fr: 'fr',
	it: 'it',
	jp: 'ja'
}

// Macrolanguage folding for BARE ISO codes: Bokmål (nb/nob) and Nynorsk
// (nn/nno) are both "Norwegian" for edition-matching purposes. Without this,
// one provider's 'nb' and another's 'Bokmål' (→ 'no') POSITIVELY CONFLICT for
// the same narration — dedupe refuses to merge and byLanguage treats
// identical-language editions as rivals. Applied after every lookup so the
// name tables and passthrough all converge on one code.
const CODE_FOLD: Record<string, string> = {
	nb: 'no',
	nn: 'no'
}

/** One table probe: exact name, then 3-letter MARC, then bare ISO-639-1. */
function lookupToken(token: string, wholeInput: boolean): string | null {
	if (NAME_TO_CODE[token]) return NAME_TO_CODE[token]
	if (token.length === 3 && THREE_TO_CODE[token]) return THREE_TO_CODE[token]
	// A bare 2-letter token is ISO-639-1 only when it IS the whole value; during
	// per-word probes a stray 2-letter English word ("it", "no", "in") would
	// otherwise win as Italian/Norwegian/….
	if (wholeInput && /^[a-z]{2}$/.test(token)) return token
	return null
}

// Register the ASCII-folded twin of every diacritic-bearing name at module
// init ("slovenščina" → "slovenscina"), instead of hand-adding twins per entry
// — the hand-added set had already drifted (some entries got twins, some
// didn't), and a missed twin fails SILENTLY (null → no conflict → no
// demotion). Folding the KEYS here plus the TOKEN at lookup covers both
// directions with one rule.
for (const [name, code] of Object.entries(NAME_TO_CODE)) {
	const folded = foldDiacritics(name)
	if (folded !== name && !(folded in NAME_TO_CODE)) NAME_TO_CODE[folded] = code
}

/**
 * Reduce any provider's language notation to a canonical ISO-639-1 code.
 * Accepts an English/native name ("German", "Deutsch"), an ISO-639-1 code
 * ("de"), or an ISO-639-2/MARC code ("ger"/"deu"). Handles locale tags
 * ("en-GB" → "en"), multi-word names ("Norwegian Bokmål", "Brazilian
 * Portuguese" — each word is probed, so the qualifying adjective can't hide
 * the language), NFD input and ASCII-folded spellings ("Islenska"), and is
 * whitespace/case tolerant.
 * @param {string | null | undefined} raw the provider-reported language
 * @returns {string | null} the ISO-639-1 code, or null when unknown/absent
 */
export function normalizeLanguage(raw: string | null | undefined): string | null {
	if (!raw) return null
	// NFC first: macOS-originated metadata arrives NFD, where "bokmål" is
	// 'a'+combining-ring and never matches an NFC object key.
	const cleaned = raw.normalize('NFC').trim().toLowerCase().split(/[-_]/)[0].trim()
	if (!cleaned) return null
	// Probe the full string, then each whitespace-separated word ("Simplified
	// Chinese" → "chinese"), each also retried diacritic-folded. The failure
	// mode of a miss is SILENT (unknown never conflicts, so the wrong-language
	// demotion just doesn't fire), so err toward resolving.
	const tokens = [cleaned, ...cleaned.split(/\s+/)]
	for (const token of tokens) {
		const wholeInput = token === cleaned
		const hit = lookupToken(token, wholeInput) ?? lookupToken(foldDiacritics(token), wholeInput)
		if (hit) return CODE_FOLD[hit] ?? hit
	}
	return null
}

/**
 * The language a region's catalog is expected to be in.
 * @param {string | null | undefined} region the request region (e.g. "de")
 * @returns {string | null} the ISO-639-1 code, or null for an unknown region
 */
export function regionLanguage(region: string | null | undefined): string | null {
	if (!region) return null
	return REGION_LANGUAGE[region.trim().toLowerCase()] ?? null
}

/**
 * Keep items in the region's preferred language AND items whose language is
 * unknown; fall back to ALL items when nothing matches even that. The
 * null-keeping is deliberate: provider language data is patchy and a real
 * English audio edition often carries no language tag, so dropping untagged
 * items (in favor of a worse tagged one, or losing the book entirely)
 * regressed matching. Shared by providers so the semantics can't drift.
 * @param {T[]} items the provider results to filter
 * @param {string | null | undefined} region the request region (e.g. "us")
 * @param {(item: T) => string | null | undefined} language reads an item's raw language
 * @returns {T[]} the preferred-or-untagged items, or all when none qualify
 */
export function preferLanguage<T>(
	items: T[],
	region: string | null | undefined,
	language: (item: T) => string | null | undefined
): T[] {
	const want = regionLanguage(region)
	if (!want) return items
	const inLang = items.filter((item) => {
		const lang = normalizeLanguage(language(item))
		return lang === want || lang == null
	})
	return inLang.length ? inLang : items
}

/**
 * True only when both languages are KNOWN and different.
 *
 * The null-tolerance is deliberate and load-bearing: provider language data is
 * patchy, and a real English audio edition frequently carries no language tag.
 * Treating "unknown" as a mismatch would demote correct editions and lose books
 * outright — so an absent signal must never count as a contradiction. Only a
 * positively-known clash is actionable.
 * @param {string | null} a first language (any notation)
 * @param {string | null} b second language (any notation)
 * @returns {boolean} true when both are known and they differ
 */
export function languageConflict(a: string | null, b: string | null): boolean {
	const left = normalizeLanguage(a)
	const right = normalizeLanguage(b)
	if (left == null || right == null) return false
	return left !== right
}

// A translated edition whose language field is NULL or mislabeled dodges the
// language check entirely -- but says so in its own title: "Everfound (Spanish
// Edition)" and "Medio rey [Half a King]" both won on the same scan, and
// Hardcover's French Dungeon Crawler Carl edition is tagged "en" at source.
// Deliberately narrow: an explicit "<Language> Edition/Version" tail or a
// native edition word -- not a bare foreign word, which would flag legitimately
// foreign-titled English books.
const NAMED_EDITION_RE =
	/\b(spanish|french|german|italian|portuguese|dutch|polish|russian|japanese|chinese|swedish|norwegian|danish|finnish|czech|turkish|korean)\s+(?:edition|version)\b/i
// Native-language edition words. Each one NAMES its language, which is what
// makes the marker usable as evidence rather than as a blanket "foreign" flag.
const NATIVE_EDITION_MARKERS: readonly [RegExp, string][] = [
	[/\bedici[oó]n\b/i, 'es'],
	[/\b[ée]dition\s+fran[cç]aise\b/i, 'fr'],
	[/\bausgabe\b/i, 'de'],
	[/\bedizione\b/i, 'it']
]

/**
 * The language a foreign-edition marker in a TITLE names, or null when the
 * title carries no such marker.
 *
 * The language matters, not merely the marker's presence: "Ausgabe" is evidence
 * of a GERMAN edition, which is the WANTED edition for a German-region query.
 * Treating any marker as "wrong language" made the correct German edition lose
 * to an untagged English row (`language: null`, so nothing flagged it) — measured
 * end-to-end, with the marker as the sole differing input.
 * @param {string | null | undefined} title the candidate title
 * @returns {string | null} the marker's ISO-639-1 language, or null for no marker
 */
export function titleEditionLanguage(title: string | null | undefined): string | null {
	if (!title) return null
	const named = NAMED_EDITION_RE.exec(title)
	if (named) return normalizeLanguage(named[1])
	for (const [re, code] of NATIVE_EDITION_MARKERS) if (re.test(title)) return code
	return null
}

/**
 * THE wrong-language test, for both the scoring demotion and the ranking
 * tiebreak.
 *
 * One predicate on purpose. The two sites each carried their own copy of
 * "language field conflicts OR the title carries a foreign-edition marker", and
 * the copies had already drifted — the tiebreak's had lost the ASIN-pin
 * exemption. Same rule, one reader.
 *
 * Both legs are conditioned on `wantLanguage`, including the marker: the marker
 * is evidence of which language the edition is IN, not that it is foreign to
 * whoever asked.
 * @param {{ language?: string | null; title?: string | null }} candidate the candidate
 * @param {string | null} wantLanguage the language the request wants
 * @param {string} primaryTitle the query title (a marker there exempts the marker leg)
 * @param {boolean} effectivePin true when an ASIN pin names this exact edition
 * @returns {boolean} true when this candidate is in the wrong language
 */
export function isWrongLanguage(
	candidate: { language?: string | null; title?: string | null },
	wantLanguage: string | null,
	primaryTitle: string,
	effectivePin: boolean
): boolean {
	// An exact ASIN is a definitive identity the caller asked for by name, so
	// honour it even when its language differs.
	if (effectivePin) return false
	if (languageConflict(candidate.language ?? null, wantLanguage)) return true
	// The query itself asked for an edition marker: a candidate carrying one is
	// not anomalous.
	if (titleEditionLanguage(primaryTitle) != null) return false
	return languageConflict(titleEditionLanguage(candidate.title), wantLanguage)
}

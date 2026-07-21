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
	'bokmål': 'no',
	bokmal: 'no',
	nynorsk: 'no',
	'čeština': 'cs',
	cestina: 'cs',
	magyar: 'hu',
	'română': 'ro',
	romana: 'ro',
	'українська': 'uk',
	'русский': 'ru',
	'türkçe': 'tr',
	turkce: 'tr',
	'ελληνικά': 'el',
	'עברית': 'he',
	'العربية': 'ar',
	'中文': 'zh',
	'日本語': 'ja',
	'한국어': 'ko'
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

/**
 * Reduce any provider's language notation to a canonical ISO-639-1 code.
 * Accepts an English/native name ("German", "Deutsch"), an ISO-639-1 code
 * ("de"), or an ISO-639-2/MARC code ("ger"/"deu"). Handles locale tags
 * ("en-GB" → "en") and is whitespace/case tolerant.
 * @param {string | null | undefined} raw the provider-reported language
 * @returns {string | null} the ISO-639-1 code, or null when unknown/absent
 */
export function normalizeLanguage(raw: string | null | undefined): string | null {
	if (!raw) return null
	// Locale tags and underscores: "en-GB" / "pt_BR" -> primary subtag.
	const cleaned = raw.trim().toLowerCase().split(/[-_]/)[0].trim()
	if (!cleaned) return null
	if (NAME_TO_CODE[cleaned]) return NAME_TO_CODE[cleaned]
	if (cleaned.length === 3 && THREE_TO_CODE[cleaned]) return THREE_TO_CODE[cleaned]
	// A bare 2-letter token is already ISO-639-1.
	if (/^[a-z]{2}$/.test(cleaned)) return cleaned
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

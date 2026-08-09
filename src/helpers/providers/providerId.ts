/**
 * Encoding and decoding of provider-native book ids.
 *
 * A candidate id becomes a Plex GUID (`com.plexapp.agents.incipit://{id}?lang=en`)
 * and later the path of a data lookup (`GET /books/{id}`), so it must be:
 *  - GUID-safe: no colons or slashes (they break Plex GUID parsing);
 *  - underscore-free: the bundle splits `id_region` on the first underscore;
 *  - reversible: the data-lookup route decodes it to re-query the source provider.
 *
 * Audible ASINs are used verbatim — they are already GUID-safe and are served by
 * the existing audnexus path. Everything else is namespaced by provider.
 */

const ASIN_RE = /^B[0-9A-Z]{9}$/

export interface DecodedProviderId {
	provider: 'hardcover' | 'openlibrary' | 'storytel' | 'apple' | 'overdrive' | 'librivox'
	kind: 'edition' | 'book' | 'works' | 'audiobook' | 'media'
	nativeId: string
}

/** Storytel consumable -> "storytel-14117566". */
export function encodeStorytel(consumableId: number | string): string {
	return `storytel-${consumableId}`
}

/** Apple Books audiobook collection -> "apple-audiobook-1565808256". */
export function encodeAppleAudiobook(collectionId: number | string): string {
	return `apple-audiobook-${collectionId}`
}

/** LibriVox catalogue id -> "librivox-253". */
export function encodeLibrivox(id: number | string): string {
	return `librivox-${id}`
}

/** OverDrive (Thunder) media id -> "overdrive-265555". */
export function encodeOverdrive(id: number | string): string {
	return `overdrive-${id}`
}

/** Hardcover audio edition -> "hardcover-edition-31501578". */
export function encodeHardcoverEdition(id: number | string): string {
	return `hardcover-edition-${id}`
}

/** Hardcover book (no audio edition) -> "hardcover-book-119295". */
export function encodeHardcoverBook(id: number | string): string {
	return `hardcover-book-${id}`
}

/** OpenLibrary work key "/works/OL80870W" -> "openlibrary-works-OL80870W". */
export function encodeOpenLibraryWork(workKey: string): string {
	const olid = workKey.replace(/^\/?works\//, '')
	return `openlibrary-works-${olid}`
}

/**
 * Decode an encoded id back to its provider and native id, or null when the id is
 * a plain ASIN (which the existing audnexus lookup handles).
 * @param {string} id the candidate/GUID id
 * @returns {DecodedProviderId | null} the decoded provider id, or null for an ASIN
 */
export function decodeProviderId(id: string): DecodedProviderId | null {
	if (!id || ASIN_RE.test(id)) return null

	const hc = id.match(/^hardcover-(edition|book)-(\d+)$/)
	if (hc) return { provider: 'hardcover', kind: hc[1] as 'edition' | 'book', nativeId: hc[2] }

	// SHAPE-CONSTRAINED, not `(.+)`. The decoded nativeId is interpolated
	// UNENCODED into an outbound URL (`${OL_BASE}${nativeId}.json`), and this
	// route is reachable by anyone who can reach the port — so `.+` accepted
	// `../`, a query string, or a whole second URL and turned the id decoder
	// into a path-injection and outbound-request amplifier. A real OpenLibrary
	// id is OL<digits><type-letter> (OL80870W works, OL…M editions, OL…A
	// authors); anything else is not an id we minted and falls through to the
	// ASIN rule, which refuses it with a 400.
	const ol = id.match(/^openlibrary-works-(OL\d+[A-Z])$/)
	if (ol) return { provider: 'openlibrary', kind: 'works', nativeId: `/works/${ol[1]}` }

	// Same rule, same reason: Storytel consumable ids are opaque but never
	// carry a path separator, a dot or a query.
	const st = id.match(/^storytel-([A-Za-z0-9_-]+)$/)
	if (st) return { provider: 'storytel', kind: 'book', nativeId: st[1] }

	const ap = id.match(/^apple-audiobook-(\d+)$/)
	if (ap) return { provider: 'apple', kind: 'audiobook', nativeId: ap[1] }

	const od = id.match(/^overdrive-(\d+)$/)
	if (od) return { provider: 'overdrive', kind: 'media', nativeId: od[1] }

	const lv = id.match(/^librivox-(\d+)$/)
	if (lv) return { provider: 'librivox', kind: 'book', nativeId: lv[1] }

	return null
}

/** True when the id is a plain Audible ASIN (served by the audnexus path). */
export function isAsin(id: string): boolean {
	return ASIN_RE.test(id)
}

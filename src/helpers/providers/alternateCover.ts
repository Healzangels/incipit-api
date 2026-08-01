/**
 * A SECOND MARKETPLACE'S COVER, offered as an extra art choice.
 *
 * Audible sells the same recording in several marketplaces and frequently
 * commissions different art for each, so a book matched in `us` can have a
 * perfectly good alternative cover sitting in `uk` that nothing ever surfaces.
 *
 * MEASURED 2026-08-01 over the 16 library ASINs that resolve in BOTH regions:
 * 7 of 15 comparable pairs carry a genuinely different cover asset, and 13 of
 * 15 share the same narrator. So roughly half the time there is a real extra
 * option, and it is usually the same recording.
 *
 * THE NARRATOR CHECK IS THE WHOLE SAFETY PROPERTY. "Fever Dream" (B003GXDDYS)
 * returns a DIFFERENT narrator in the two marketplaces — a different recording
 * sold under one ASIN. Borrowing its art would put another edition's cover on
 * the book. Runtime cannot substitute: across that sample the uk records return
 * `runtimeLengthMin: null` almost everywhere, so the narrator set is the only
 * corroborating signal that exists across regions.
 *
 * This only ever ADDS a candidate. It never replaces `image` or `imageSquare`,
 * so a wrong-but-plausible alternate is a spare tile, not a changed poster.
 */

/** The marketplace most likely to share an ASIN with `region`. */
const SIBLING: Record<string, string> = { us: 'uk', uk: 'us' }

/**
 * The region to consult for an alternate cover, or undefined when there is
 * none worth spending a lookup on.
 *
 * Deliberately only us/uk: those are the two measured to share ASINs across a
 * real library. Adding ca/au/de on the assumption they behave the same would
 * spend a request per book per region on an unevidenced guess — and the ASIN
 * probe showed 86 of 171 already delisted in both measured regions, so extra
 * marketplaces are more likely to add latency than covers.
 * @param {string} region the region the book was matched in
 * @returns {string | undefined} the sibling marketplace, when one is known
 */
export function siblingRegion(region: string | null | undefined): string | undefined {
	return SIBLING[(region ?? '').trim()]
}

/**
 * An Audible/Amazon cover host. BOTH sides must be one, because the
 * sibling-region lookup runs through the provider registry and HARDCOVER
 * answers for an Audible ASIN: the first deployment (2026-08-01) offered print
 * jackets as "alternate marketplace art" -- Leviathan Wakes got
 * `assets.hardcover.app/edition/30572103/...`, Theft of Swords the same shape.
 *
 * The narrator check did not catch it and never could: Hardcover's record
 * carries the same narrators, so it says the RECORDING is right while saying
 * nothing about the KIND of image. A portrait print jacket is precisely what
 * the squareCover machinery exists to keep out of a square Plex poster slot, so
 * offering one as a bonus tile works against the rest of the system.
 */
const AMAZON_ASSET_RE = /\/\/m\.media-amazon\.com\/images\//i

/** A record carrying the two fields this decision needs. */
interface CoverCandidate {
	image?: string | null
	narrators?: { name?: string | null }[] | null
}

/**
 * Strip an Amazon size modifier so two URLs for ONE picture compare equal.
 * `._SL500_.jpg` and `._SX450_.jpg` are the same asset at different sizes;
 * offering both would add a duplicate tile to a picker that already carries
 * several (Local Media Assets contributes 2-3 per album on its own).
 */
function coverAsset(url: string): string {
	return url.replace(/\._[A-Z0-9,]+_\.(jpg|jpeg|png)(?=$|\?)/i, '.$1')
}

/**
 * Case- and order-insensitive narrator key, so "ANN DOWD" == "Ann Dowd".
 *
 * Returns '' when the record names no narrators — which the caller rejects
 * along with a mismatch, because nothing then corroborates that the two
 * marketplaces are selling the same recording. An explicit `if (!names.length)
 * return null` here was an EQUIVALENT MUTANT: '' is already falsy, so the guard
 * below caught it and no test could tell the two versions apart.
 */
function narratorKey(rec: CoverCandidate): string {
	const names = (rec.narrators ?? [])
		.map((n) => (n?.name ?? '').trim().toLowerCase())
		.filter(Boolean)
	return [...names].sort().join('|')
}

/**
 * The sibling region's cover URL when it is worth offering as an extra option,
 * otherwise null.
 *
 * Offers only when BOTH records name narrators, those narrator sets are equal,
 * both carry an image, and the underlying assets differ.
 * @param {CoverCandidate} current the record served to the caller
 * @param {CoverCandidate} alternate the same ASIN looked up in the sibling region
 * @returns {string | null} the alternate cover URL, or null
 */
export function alternateCoverWorthOffering(
	current: CoverCandidate,
	alternate: CoverCandidate
): string | null {
	if (!current || !alternate) return null
	const here = current.image
	const there = alternate.image
	if (!here || !there) return null
	// Same KIND of art on both sides -- see AMAZON_ASSET_RE.
	if (!AMAZON_ASSET_RE.test(here) || !AMAZON_ASSET_RE.test(there)) return null
	const a = narratorKey(current)
	const b = narratorKey(alternate)
	if (!a || !b || a !== b) return null
	if (coverAsset(here) === coverAsset(there)) return null
	return there
}

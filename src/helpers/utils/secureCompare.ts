import crypto from 'crypto'

/**
 * Constant-time secret comparison that does not leak LENGTH.
 *
 * `crypto.timingSafeEqual` throws on unequal-length buffers, so every caller
 * guards it with a length check first — and that guard is itself observable:
 * a wrong-length token returns immediately while a right-length one pays for
 * the compare. It is a weak oracle (network jitter dwarfs it, and both tokens
 * here are operator-set), but it is free to remove and the guard reads as
 * constant-time while not being it.
 *
 * Hashing both sides to a fixed-width digest first makes the comparison
 * length-independent by construction: every input becomes 32 bytes, so there
 * is no length branch left to observe, and timingSafeEqual then compares
 * equal-length buffers exactly as it is designed to.
 * @param {string | undefined | null} candidate the value supplied by the caller
 * @param {string | undefined | null} secret the configured secret
 * @returns {boolean} true when both are present and identical
 */
export function secureEquals(
	candidate: string | undefined | null,
	secret: string | undefined | null
): boolean {
	// An absent secret must never be satisfiable, and an absent candidate can
	// never match: both are configuration/omission facts, not timing ones.
	if (!candidate || !secret) return false
	const a = crypto.createHash('sha256').update(candidate).digest()
	const b = crypto.createHash('sha256').update(secret).digest()
	return crypto.timingSafeEqual(a, b)
}

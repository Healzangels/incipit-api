/**
 * Environment-variable parsing shared by the tunable knobs.
 *
 * Exists because each knob grew its own parser and they disagreed about the
 * edge cases -- most damagingly about the empty string: `Number('')` is 0 and
 * `Number.isInteger(0)` is true, so a declared-but-unset compose variable
 * (`- IMAGES_SIMILAR_MAX_DISTANCE=${X}` with X unset, or a trailing `KEY=` in
 * .env) read as an explicit 0 and silently disabled the feature it was meant
 * to tune, with no log line. One parser, one set of decisions.
 */

/**
 * An integer env override, clamped to [min, max], or the fallback.
 *
 * Absent, empty, whitespace-only, non-numeric, fractional and out-of-range
 * values all yield the fallback. An explicit "0" inside the range is honoured.
 * @param {string | undefined} raw the raw environment value
 * @param {number} fallback the value to use when raw is unusable
 * @param {number} min smallest accepted value
 * @param {number} max largest accepted value
 * @returns {number} the parsed override, or the fallback
 */
export function envInt(
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number
): number {
	if (raw == null || raw.trim() === '') return fallback
	const value = Number(raw)
	if (Number.isInteger(value) && value >= min && value <= max) return value
	return fallback
}

/**
 * Ratcliff-Obershelp string similarity, a faithful port of Python's
 * `difflib.SequenceMatcher.ratio()`.
 *
 * The audiobook match benchmark (Gate 0) validated its accept/reject thresholds
 * against this exact metric — 75 real albums, 0 false positives. Levenshtein or
 * any other ratio would move every score and invalidate those thresholds, so the
 * port reproduces difflib's block-matching (and its tie-breaking) rather than
 * approximating it. Autojunk is intentionally omitted: it only engages for
 * sequences of length >= 200, and audiobook titles never reach that.
 */

interface Match {
	a: number
	b: number
	size: number
}

/**
 * Longest matching block within a[alo:ahi] and b[blo:bhi].
 * Mirrors SequenceMatcher.find_longest_match: on ties it returns the block that
 * begins earliest in a, and among those, earliest in b — which is what makes the
 * total match count deterministic.
 * @param {string} a first sequence
 * @param {string} b second sequence
 * @param {Map<string, number[]>} b2j map of each char in b to its ascending indices
 */
function findLongestMatch(
	a: string,
	b: string,
	b2j: Map<string, number[]>,
	alo: number,
	ahi: number,
	blo: number,
	bhi: number
): Match {
	let besti = alo
	let bestj = blo
	let bestsize = 0
	let j2len = new Map<number, number>()

	for (let i = alo; i < ahi; i++) {
		const newj2len = new Map<number, number>()
		const indices = b2j.get(a[i])
		if (indices) {
			for (const j of indices) {
				if (j < blo) continue
				if (j >= bhi) break
				const k = (j2len.get(j - 1) || 0) + 1
				newj2len.set(j, k)
				if (k > bestsize) {
					besti = i - k + 1
					bestj = j - k + 1
					bestsize = k
				}
			}
		}
		j2len = newj2len
	}

	return { a: besti, b: bestj, size: bestsize }
}

/**
 * Total size of all matching blocks between a and b (Ratcliff-Obershelp
 * recursive decomposition). Equivalent to summing SequenceMatcher's
 * get_matching_blocks() sizes.
 * @param {string} a first sequence
 * @param {string} b second sequence
 */
function matchingCharCount(a: string, b: string): number {
	// b2j: char -> ascending list of indices in b
	const b2j = new Map<string, number[]>()
	for (let j = 0; j < b.length; j++) {
		const arr = b2j.get(b[j])
		if (arr) arr.push(j)
		else b2j.set(b[j], [j])
	}

	let matches = 0
	const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]]
	while (queue.length) {
		const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number]
		const m = findLongestMatch(a, b, b2j, alo, ahi, blo, bhi)
		if (m.size) {
			matches += m.size
			if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b])
			if (m.a + m.size < ahi && m.b + m.size < bhi)
				queue.push([m.a + m.size, ahi, m.b + m.size, bhi])
		}
	}
	return matches
}

/**
 * Similarity ratio in [0, 1], matching difflib's `ratio()`: 2*M / T where M is
 * the total matched-char count and T is the combined length.
 * @param {string} a first sequence
 * @param {string} b second sequence
 * @returns {number} 0.0 - 1.0
 */
export function ratcliffObershelp(a: string, b: string): number {
	const total = a.length + b.length
	if (total === 0) return 1.0
	return (2.0 * matchingCharCount(a, b)) / total
}

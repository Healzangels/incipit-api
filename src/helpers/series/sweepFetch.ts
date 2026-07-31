/**
 * Reading one record's served shelf answer, for the drift sweep.
 *
 * Extracted from scripts/seriesSweep.ts because the distinction it encodes is a
 * DECISION, not plumbing: a 429 is the api asking us to slow down, while a 404
 * is the api answering that it has nothing for this record. Scoring them alike
 * makes the sweep's own concurrency look like missing data — and because
 * unavailable rows are (correctly) never queued for review, those records fall
 * out of drift detection entirely, silently. Two consecutive full sweeps on
 * 2026-07-31 both reported exactly 121 unavailable records: a stable number is
 * the fingerprint of a limiter, not of transient loss.
 */

export interface Answer {
	primary: string | null
	secondary: string | null
}

export interface ServedAnswer extends Answer {
	available: boolean
}

interface Series {
	name?: string
	position?: string | null
}

export interface FetchServedOptions {
	fetchImpl?: typeof fetch
	sleep?: (ms: number) => Promise<void>
	/** Retries granted to a 429 only. */
	retries?: number
	region?: string
}

const show = (s: Series | null | undefined): string | null =>
	s?.name ? `${s.name} #${s.position ?? '-'}` : null

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Read a record's currently-served series answer.
 *
 * Retries ONLY on 429, honouring Retry-After when the limiter states it and
 * backing off geometrically when it does not. Every other outcome — 404, any
 * other non-OK status, a network throw — is returned as unavailable on the
 * first attempt, because retrying cannot change it.
 * @param {string} api base url of the incipit api
 * @param {string} id the record id (asin or provider-encoded)
 * @param {FetchServedOptions} opts injection points for tests plus retry budget
 * @returns {Promise<ServedAnswer>} the answer, or an UNAVAILABLE marker
 */
export async function fetchServedAnswer(
	api: string,
	id: string,
	opts: FetchServedOptions = {}
): Promise<ServedAnswer> {
	const doFetch = opts.fetchImpl ?? fetch
	const sleep = opts.sleep ?? defaultSleep
	const retries = opts.retries ?? 5
	const region = opts.region ?? 'us'
	const url = `${api}/books/${encodeURIComponent(id)}?region=${region}`

	for (let attempt = 0; ; attempt += 1) {
		let r: Response
		try {
			r = await doFetch(url)
		} catch {
			return { primary: 'UNAVAILABLE(error)', secondary: null, available: false }
		}
		if (r.status === 429) {
			if (attempt >= retries) {
				return { primary: 'UNAVAILABLE(429)', secondary: null, available: false }
			}
			const stated = Number(r.headers.get('retry-after'))
			// Geometric, not linear: the bucket refills on a window, so a fixed
			// short retry just burns the budget again on the same window.
			const wait = Number.isFinite(stated) && stated > 0 ? stated * 1000 : 2000 * 2 ** attempt
			await sleep(wait)
			continue
		}
		if (!r.ok) {
			return { primary: `UNAVAILABLE(${r.status})`, secondary: null, available: false }
		}
		const d = (await r.json()) as { seriesPrimary?: Series; seriesSecondary?: Series }
		return { primary: show(d.seriesPrimary), secondary: show(d.seriesSecondary), available: true }
	}
}

import ChaptarrProvider, {
	type ChaptarrEdition,
	type ChaptarrMatchFetch,
	type ChaptarrWorkFetch,
	type ChaptarrWorkResponse,
	editionStoreIds,
	fetchChaptarrWork
} from '#helpers/providers/ChaptarrProvider'

/**
 * A canary for Chaptarr's wire: does the service still send what ChaptarrProvider
 * reads, and does our parser still read it?
 *
 * Chaptarr publishes no docs, version or changelog (checked 2026-10-10), and its
 * fields have moved under us once already: between the 2026-08-08 capture and
 * 2026-09-25 it renamed providerIdsAll, formatType and language, and for weeks
 * every variant id answered 404 and every chaptarr row was language-unknown
 * before anyone looked (docs/design/spec-chaptarr-wire-drift.md). This checks one
 * known work -- Ninth House, whose regional ids the regional-pin rule was built
 * on -- on the raw wire (which field moved) and through the provider itself
 * (whether we still read it), so the next drift shows up the day it happens.
 *
 * Run daily from the homelab with `bun run check:chaptarr` inside the API
 * container; the live test runs the same function.
 */

/** The work, its own-asin English audiobook edition, and audible.com's listing of it. */
export const REFERENCE = {
	work: 'hc:427736',
	title: 'Ninth House',
	author: 'Leigh Bardugo',
	ownAsin: 'B07LH8GF23',
	storeListing: 'B07LHB5ZJ6'
} as const

export interface WireCheck {
	name: string
	ok: boolean
	detail: string
}

export interface WireReport {
	/** The reference work could not be fetched at all: an outage, not a drift. */
	unreachable: boolean
	ok: boolean
	checks: WireCheck[]
}

const isAudiobook = (e: ChaptarrEdition): boolean =>
	e.format === 'audiobook' || e.formatType === 'audiobook' || e.readingFormatId === 2

/**
 * Run the canary.
 * @param {{ matchFetch?: ChaptarrMatchFetch; workFetch?: ChaptarrWorkFetch }} [deps]
 *   the service calls; the real ones by default, fixtures in tests
 * @returns {Promise<WireReport>} every check, and whether the work was reachable
 */
export async function runChaptarrWireCheck(
	deps: { matchFetch?: ChaptarrMatchFetch; workFetch?: ChaptarrWorkFetch } = {}
): Promise<WireReport> {
	const workFetch = deps.workFetch ?? fetchChaptarrWork
	const checks: WireCheck[] = []
	const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

	let body: ChaptarrWorkResponse | null
	try {
		body = await workFetch(REFERENCE.work)
	} catch (err) {
		return {
			unreachable: true,
			ok: false,
			checks: [{ name: 'reach the reference work', ok: false, detail: String(err).slice(0, 160) }]
		}
	}
	if (!body) {
		return {
			unreachable: true,
			ok: false,
			checks: [
				{
					name: 'reach the reference work',
					ok: false,
					detail: `${REFERENCE.work} answered nothing`
				}
			]
		}
	}

	// The raw wire: name the field that moved, in every spelling it has had.
	const editions = Array.isArray(body.editions) ? body.editions : []
	const audio = editions.filter(isAudiobook)
	check(
		'work title and authors',
		Boolean(body.work?.title) && Boolean(body.authors?.[0]?.name),
		'work.title, authors[].name'
	)
	check('editions', editions.length > 0, `${editions.length} editions`)
	check(
		'audiobook format marker',
		audio.length > 0,
		'format | formatType == "audiobook", or readingFormatId == 2'
	)
	check(
		'edition asin',
		audio.some((e) => typeof e.asin === 'string' && e.asin.length > 0),
		'editions[].asin'
	)
	check(
		'store ids',
		audio.some((e) => editionStoreIds(e).length > 1),
		'provider_ids_all.az | asins | providerIdsAll.az'
	)
	check(
		'edition language',
		audio.some((e) => typeof (e.languageCode ?? e.language) === 'string'),
		'languageCode | language'
	)
	check(
		'runtime',
		audio.some((e) => typeof e.durationSeconds === 'number' && e.durationSeconds > 0),
		'durationSeconds'
	)
	check(
		'narrators',
		audio.some((e) => Array.isArray(e.narratorNames) && e.narratorNames.length > 0),
		'narratorNames'
	)

	// Through the provider: does our parser still read it end to end?
	const provider = new ChaptarrProvider({ matchFetch: deps.matchFetch, workFetch })
	try {
		const rows = await provider.search({
			title: REFERENCE.title,
			author: REFERENCE.author,
			region: 'us'
		})
		const own = rows.find((c) => c.asin?.toUpperCase() === REFERENCE.ownAsin)
		check('search finds the reference edition', own != null, `${rows.length} chaptarr rows`)
		if (own) {
			check('parsed runtime', (own.audioSeconds ?? 0) > 0, `audioSeconds ${own.audioSeconds}`)
			check('parsed narrators', own.narrators.length > 0, own.narrators.join(', ') || 'none')
			check('parsed language', own.language === 'en', `language ${own.language}`)
			check(
				'parsed store ids name the store listing',
				(own.asinAliases ?? []).includes(REFERENCE.storeListing),
				`${(own.asinAliases ?? []).length} aliases`
			)
		}
		const served = await provider.fetchBookByAsin(REFERENCE.storeListing, { region: 'us' })
		check('a regional id is served', served != null, `fetchBookByAsin(${REFERENCE.storeListing})`)
	} catch (err) {
		check('provider path', false, String(err).slice(0, 160))
	}
	return { unreachable: false, ok: checks.every((c) => c.ok), checks }
}

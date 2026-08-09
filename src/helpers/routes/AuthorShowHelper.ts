import { FastifyRedis } from '@fastify/redis'
import type { FastifyBaseLogger } from 'fastify'

import type { AuthorDocument } from '#config/models/Author'
import type { ApiAuthorProfile, ApiBook, ApiChapter } from '#config/types'
import { ApiQueryString } from '#config/types'
import {
	collapseInitialVariants,
	dedupeAuthorsByName,
	searchAudibleAuthors
} from '#helpers/authors/audible/AudibleAuthorSearch'
import PaprAudibleAuthorHelper from '#helpers/database/papr/audible/PaprAudibleAuthorHelper'
import { NotFoundError } from '#helpers/errors/ApiErrors'
import { chaptarrAuthorInfo } from '#helpers/providers/chaptarrAuthor'
import { GOODREADS_NOPHOTO_RE, withGoodreadsAuthorInfo } from '#helpers/providers/goodreadsSeries'
import type HardcoverProvider from '#helpers/providers/HardcoverProvider'
import { isBookAssetUrl } from '#helpers/providers/HardcoverProvider'
import defaultRegistry from '#helpers/providers/registry'
import GenericShowHelper from '#helpers/routes/GenericShowHelper'
import { isSameAuthor } from '#helpers/utils/authorNameMatch'
import { scheduleSecondChance } from '#helpers/utils/secondChance'

export { isSameAuthor }

// How long the second chance waits before re-running the forced heal. Long
// enough for the mirror's upstream fetch (triggered by our own first query) to
// land -- Zelazny's record was whole within minutes -- short enough that the
// author is usually complete before anyone looks at the artist page.
const SECOND_CHANCE_DELAY_MS = 3 * 60 * 1000

// Hardcover's default hooded-figure avatars: six static 500x500 files (probed
// 2026-07-26). Their website shows one for EVERY author, but only some rows
// have it materialized as an image asset; the rest render it client-side and
// the API says image:null -- leaving a blank Plex tile (Mitchel Scanlon). When
// every source has nothing, fill with one of these, picked by a stable name
// hash so each author keeps the same color forever, mimicking Hardcover's own
// look. Fetched once per author by the agent, then stored by Plex; if the
// files ever move, the fill degrades to a blank tile, never an error.
const STATIC_AVATAR_COUNT = 6

/** The static avatar URL for a name -- stable, so the color never changes. */
export function staticAvatarFor(name: string): string {
	let hash = 5381
	for (let i = 0; i < name.length; i += 1) {
		hash = (hash * 33 + name.charCodeAt(i)) >>> 0
	}
	return `https://assets.hardcover.app/static/avatars/profile${(hash % STATIC_AVATAR_COUNT) + 1}.png`
}

/**
 * True for one of the six static Hardcover avatars staticAvatarFor deals out.
 * A placeholder is display furniture, not knowledge: once persisted it comes
 * back through the minimal-profile seed and the previous-record restore
 * LOOKING like a portrait, and every gap check downstream (the Goodreads
 * backstop, the second chance) would stop running for that author forever.
 */
export function isStaticAvatar(url: string | null | undefined): boolean {
	return Boolean(url && /assets\.hardcover\.app\/static\/avatars\/profile\d+\.png$/i.test(url))
}

/**
 * True when a URL is display FURNITURE or the wrong subject rather than a real
 * portrait: one of the six static avatars, a Hardcover BOOK asset, or the
 * generated avatar this pass just identified.
 *
 * Exported (and covered) because getting this set wrong is silent and
 * permanent: a non-portrait persisted by an earlier pass rides back in through
 * the minimal-profile seed looking like a real photo, the profile then reads
 * COMPLETE, and every downstream gap check -- the Goodreads backstop, the
 * second chance -- stops running for that author forever. Measured 2026-07-29:
 * eight authors were stuck on book jackets for exactly this reason, and the
 * provider-side guard alone did not move any of them.
 * @param {string | null | undefined} url the stored image URL
 * @param {string | null} generatedAvatar the avatar identified this pass, if any
 * @returns {boolean} true when the URL must not be treated as a portrait
 */
export function isNonPortraitImage(
	url: string | null | undefined,
	generatedAvatar: string | null = null
): boolean {
	return (
		// A non-empty value that is not an http(s) URL is never a portrait —
		// the aggregator's literal string "null" reached STORED records before
		// pickPhoto learned to refuse it, and the keep-what-we-had restore then
		// faithfully restored the poison on every later pass (measured live:
		// Rigby and AlwaysRollsAOne stayed on "null" while Scanlon healed).
		// One scheme rule here retires the class at the rulebook level:
		// clearing, restore and every fill all consult this same function.
		Boolean(url && !/^https?:\/\//i.test(url)) ||
		isStaticAvatar(url) ||
		isGoodreadsNoPhoto(url) ||
		isBookAssetUrl(url) ||
		(generatedAvatar != null && url === generatedAvatar)
	)
}

/**
 * Goodreads' own "no photo" placeholder (a grey silhouette). Slipped through
 * on the Chaptarr author rung's first live run (2026-08-08): all three
 * avatar-only authors "gained" a photo whose URL contained /nophoto/ — worse
 * than our deliberate avatar, and read as a REAL portrait, which freezes
 * every downstream gap check for those authors. Same trap class as the
 * static avatars; same rulebook.
 *
 * ONE rule, GOODREADS_NOPHOTO_RE, shared with the Goodreads leg that has
 * always had it and with the Chaptarr photo picker. This gate briefly carried
 * its own `goodreads\.com\/.*nophoto` spelling, which is strictly narrower and
 * missed the host the repo's own fixture uses (i.gr-assets.com) — the exact
 * shape it was written to catch.
 */
export function isGoodreadsNoPhoto(url: string | null | undefined): boolean {
	return Boolean(url && GOODREADS_NOPHOTO_RE.test(url))
}

export default class AuthorShowHelper extends GenericShowHelper {
	credentials?: Record<string, string>
	/** Kept for the Goodreads author cache (the base class only keeps a RedisHelper). */
	private redisClient: FastifyRedis | null

	constructor(
		asin: string,
		options: ApiQueryString,
		redis: FastifyRedis | null,
		logger?: FastifyBaseLogger,
		credentials?: Record<string, string>
	) {
		super(asin, options, redis, 'author', logger)
		this.credentials = credentials
		this.redisClient = redis
	}

	/**
	 * Build the author profile, then PREFER Hardcover's curated portrait.
	 *
	 * Audible's author image is unreliable — for many (often indie) authors it is
	 * the book cover, not a photo (e.g. Craig Alanson's is his Expeditionary Force
	 * cover). Hardcover carries real author portraits, so when it has one we use it
	 * and keep Audible's as `imageAlt` (a secondary poster option); when Hardcover
	 * has none we fall back to Audible's image as-is.
	 *
	 * READ THIS BEFORE CHANGING THE ORDER: `image` vs `imageAlt` is a
	 * SOURCE-QUALITY ranking, not a display preference, and the Plex bundle
	 * INVERTS it on purpose. The bundle offers both to Plex's poster container
	 * and its two-key `validate_keys` selects the SECOND one -- so `imageAlt`
	 * (Audible) is what a freshly scanned author actually DISPLAYS, while
	 * `image` (Hardcover) is the more trustworthy portrait and the one the
	 * `authors_prefer_hardcover` pin targets. Both halves are deliberate: rank
	 * by trustworthiness here, choose by fit there. Tracing that inversion from
	 * one side alone has cost real debugging time more than once.
	 *
	 * When a portrait or bio is
	 * STILL missing (Audible had none and Hardcover — Wikipedia-sourced — doesn't
	 * carry the author, e.g. Jessica Townsend), Goodreads fills the gap, since it
	 * covers far more authors. Apple Books is deliberately not consulted — its
	 * author pages carry no portrait. Best-effort: any failure leaves the current
	 * value in place rather than breaking the update.
	 * @returns {Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined>}
	 */
	/** True when the Audible author page is permanently unavailable (not a blip). */
	private isAudibleUnavailable(err: unknown): boolean {
		return (
			err instanceof NotFoundError &&
			(err.details?.code === 'REGION_UNAVAILABLE' || err.details?.code === 'PRODUCT_DELISTED')
		)
	}

	/**
	 * A bare author profile carrying only the caller-supplied name, preserving any
	 * fields an earlier scrape left behind. The starting point when Audible has no
	 * page for the ASIN but the enrichment below can still fill a portrait/bio.
	 */
	private minimalAuthorProfile(name: string): ApiAuthorProfile {
		const base = this.originalData as AuthorDocument | null
		return {
			asin: this.asin,
			// The STORED name wins. Audible answers 404/403/503 all as
			// REGION_UNAVAILABLE, so a mere throttle blip lands here -- and the caller's
			// ?name= is the raw Plex artist tag, which may be a spelling variant or (in
			// the documented swap case) the NARRATOR. Taking it would rename the
			// canonical record that feeds the author text index, permanently, on a
			// transient failure. The supplied name is only the seed when we have none.
			name: base?.name || name,
			region: this.options.region,
			description: base?.description ?? '',
			image: base?.image ?? '',
			imageAlt: base?.imageAlt ?? '',
			genres: base?.genres ?? [],
			similar: base?.similar ?? []
		}
	}

	async getNewData(): Promise<ApiAuthorProfile | ApiBook | ApiChapter | undefined> {
		let data: ApiAuthorProfile | ApiBook | ApiChapter | undefined
		try {
			data = await super.getNewData()
		} catch (err) {
			// A dead or region-locked Audible ASIN throws here, which would leave the
			// author with no name and no portrait — and because it throws, Hardcover
			// and Goodreads never run. With a caller-supplied ?name= we build a bare
			// profile and let the enrichment below fill it (the fix for Black Library /
			// delisted authors whose Audible page is gone, e.g. Graham McNeill). Any
			// other error keeps the existing handling (updateActions preserves the
			// record on REGION_UNAVAILABLE, rethrows otherwise).
			const fallbackName = this.options.name?.trim()
			if (fallbackName && this.isAudibleUnavailable(err)) {
				data = this.minimalAuthorProfile(fallbackName)
			} else {
				throw err
			}
		}
		if (!data || !('image' in data)) return data

		const author = data as ApiAuthorProfile
		// A scrape can return a record with no usable name (a dead ASIN, or a stub);
		// fall back to the caller-supplied name so the enrichment has something to
		// search Hardcover/Goodreads on.
		if (!author.name?.trim() && this.options.name?.trim()) {
			author.name = this.options.name.trim()
		}

		// 1. Prefer Hardcover's curated (Wikipedia-sourced) portrait when it has one;
		// keep Audible's as the secondary option, and backfill the bio only when
		// Audible left it empty. Guarded, not early-returned, so Goodreads still runs.
		const hardcover = defaultRegistry.get('hardcover') as HardcoverProvider | undefined
		// A GENERATED Hardcover avatar (see fetchAuthorInfo's isGenerated) is held
		// back here and only ever FILLS an empty slot at the end of enrichment --
		// it must never displace a real photo. Measured on Robert Harris: the
		// avatar took the "prefer Hardcover" swap, and being perfectly square it
		// then beat his real photo under the square-fit rule. Operator decision
		// 2026-07-26: an avatar is welcome for an author with zero other options
		// (a blank artist tile), and unwelcome everywhere else.
		let generatedAvatar: string | null = null
		if (hardcover?.fetchAuthorInfo) {
			const {
				image: hardcoverImage,
				bio: hardcoverBio,
				imageGenerated
			} = await hardcover.fetchAuthorInfo(author.name, {
				region: this.options.region,
				credentials: this.credentials,
				logger: this.logger
			})
			if (hardcoverImage && imageGenerated) {
				generatedAvatar = hardcoverImage
			} else if (hardcoverImage && hardcoverImage !== author.image) {
				this.logger?.info({ author: author.name }, 'author image: preferring Hardcover portrait')
				// A placeholder never earns the secondary slot -- only a real photo
				// is worth keeping as the alternative.
				if (author.image && !isStaticAvatar(author.image)) author.imageAlt = author.image
				author.image = hardcoverImage
			}
			if (hardcoverBio && !author.description?.trim()) {
				this.logger?.info({ author: author.name }, 'author description: filled from Hardcover')
				author.description = hardcoverBio
			}
		}

		// A placeholder WE persisted on an earlier pass -- a static avatar, or the
		// generated avatar Hardcover just re-identified -- is furniture, not a
		// portrait. It rode back in through the minimal-profile seed (or will via
		// the previous-record restore below), and left in place it reads as a real
		// photo: the Goodreads backstop and the second chance would never run for
		// this author again. Clear it here; the fill rungs at the end put it back
		// when nothing real arrived this pass either.
		// A BOOK COVER counts here too. A jacket persisted by an earlier pass
		// rides back in through the minimal-profile seed / previous-record
		// restore looking like a real portrait, so the profile reads COMPLETE
		// and the throttle never re-fetches that author -- the eight authors
		// measured 2026-07-29 stayed wrong even after the provider-side guard
		// shipped, precisely because their stored records already held one.
		const isPlaceholder = (url: string | null | undefined): boolean =>
			isNonPortraitImage(url, generatedAvatar)
		if (isPlaceholder(author.image)) author.image = ''
		if (isPlaceholder(author.imageAlt)) author.imageAlt = ''

		// 2. Goodreads (bookinfo.pro) — the broad-coverage backstop for a portrait or
		// bio that Audible never had and Hardcover (Wikipedia-only) doesn't carry
		// (e.g. Jessica Townsend). Consulted only when a gap REMAINS, and it only
		// ever FILLS the gap — it never overrides a curated Audible/Hardcover value.
		if (!author.image?.trim() || !author.description?.trim()) {
			// ?force=1 (operator-only -- the scheduler never sends it) retries a
			// cached MISS: a cache-cold mirror answers incompletely (the Zelazny
			// case), and the honest miss then blocks every retry for its TTL. A
			// cached HIT is honored regardless, so the mirror stays protected.
			const { image: grImage, bio: grBio } = await withGoodreadsAuthorInfo(
				author.name,
				this.redisClient,
				this.logger,
				{ retryCachedMiss: this.options.force === '1' }
			)
			if (grImage && !isPlaceholder(grImage) && !author.image?.trim()) {
				this.logger?.info({ author: author.name }, 'author image: filled from Goodreads')
				author.image = grImage
			}
			if (grBio && !author.description?.trim()) {
				this.logger?.info({ author: author.name }, 'author description: filled from Goodreads')
				author.description = grBio
			}
		}

		// 3. Chaptarr — the ASIN-KEYED backstop. Both rungs above search by NAME
		// with exact-ish semantics, and the recorded failure mode is a spelling
		// variant going blind ("J.R.R. Tolkien" vs "J. R. R. Tolkien"); the
		// aggregation server keys authors by the same Audible asin this route
		// was asked for, so it answers exactly where they cannot. Fill-only,
		// like every rung: it never overrides a value an earlier source set,
		// and its photo still passes the placeholder guard.
		if (!author.image?.trim() || !author.description?.trim()) {
			// ?force=1 retries a cached MISS here for the same reason it does on
			// the Goodreads rung: an honest miss is cached for an hour, and
			// without the seam the operator's heal — and the automated second
			// chance three minutes later — could not re-ask this rung at all.
			const { image: ctImage, bio: ctBio } = await chaptarrAuthorInfo(
				this.asin,
				this.redisClient,
				this.logger,
				{ retryCachedMiss: this.options.force === '1' }
			)
			if (ctImage && !isPlaceholder(ctImage) && !author.image?.trim()) {
				this.logger?.info({ author: author.name }, 'author image: filled from Chaptarr')
				author.image = ctImage
			}
			if (ctBio && !author.description?.trim()) {
				this.logger?.info({ author: author.name }, 'author description: filled from Chaptarr')
				author.description = ctBio
			}
		}

		// Enrichment can only ADD. If every source came back empty this pass -- a
		// Goodreads 429, a missing Hardcover token, an Audible page that dropped its
		// photo -- the result is a record with '' where a portrait and bio used to
		// be, and it is persisted with $set, deleting them. One rate-limited minute
		// during a sweep would blank every author it touched. Keep what we already
		// had whenever the fresh pass has nothing to put there.
		const previous = this.originalData as AuthorDocument | null
		if (previous) {
			// The keep-what-we-had rule applies to KNOWLEDGE, not to placeholders:
			// restoring a persisted avatar here would satisfy the second-chance
			// check below and freeze the gap. The fill rungs re-cover the tile.
			if (!author.image?.trim() && previous.image && !isPlaceholder(previous.image)) {
				author.image = previous.image
			}
			if (!author.imageAlt?.trim() && previous.imageAlt && !isPlaceholder(previous.imageAlt)) {
				author.imageAlt = previous.imageAlt
			}
			if (!author.description?.trim() && previous.description) {
				author.description = previous.description
			}
		}
		this.maybeScheduleSecondChance(author)
		// LAST, after every real source (Audible, Hardcover, Goodreads, the
		// previous record) has had its chance: a generated avatar beats a blank
		// artist tile. Deliberately after the second-chance scheduling too, so an
		// avatar-only author still counts as incomplete and gets the delayed
		// retry for a real photo.
		if (!author.image?.trim() && generatedAvatar) {
			this.logger?.info(
				{ author: author.name },
				'author image: no real portrait anywhere, filling with the generated Hardcover avatar'
			)
			author.image = generatedAvatar
		} else if (!author.image?.trim() && author.name?.trim()) {
			// No materialized avatar either (the Scanlon class: Hardcover renders
			// its default client-side and the API row says image:null). Fill with
			// one of Hardcover's six static avatars, hash-picked so the color is
			// stable per author.
			this.logger?.info(
				{ author: author.name },
				'author image: no portrait anywhere, filling with a static Hardcover avatar'
			)
			author.image = staticAvatarFor(author.name.trim())
		}
		return author
	}

	/**
	 * When an enrichment pass still leaves the author INCOMPLETE (no portrait or
	 * no bio), schedule ONE delayed re-run of the forced heal path.
	 *
	 * A brand-new author's first lookup can catch the Goodreads mirror
	 * cache-cold -- our own query is what sets it warming, and minutes later the
	 * mirror knows the author (measured live on Roger Zelazny: the first answer
	 * surfaced only a franchise continuation, the real record appeared minutes
	 * later). Without this, the gap waits out the 1h miss TTL plus the next
	 * refresh, or the monthly sweep.
	 *
	 * Never scheduled BY the forced pass (no retry loops), never without a name
	 * (nothing to look up), deduped per asin while one is in flight. Best-effort
	 * by design: the retry runs update=1&force=1 -- exactly the operator's heal,
	 * automated once. A PERMANENTLY unfillable author (no portrait anywhere)
	 * earns one such retry per unforced update pass -- bounded by the monthly
	 * sweep cadence, so the accepted cost is ~one extra mirror lookup per month
	 * per author that can never converge.
	 * @param {ApiAuthorProfile} author the enriched profile about to be returned
	 * @param {typeof scheduleSecondChance} schedule injectable for tests
	 * @returns {boolean} true when a retry was scheduled
	 */
	maybeScheduleSecondChance(
		author: ApiAuthorProfile,
		schedule: typeof scheduleSecondChance = scheduleSecondChance
	): boolean {
		if (this.options.force === '1') return false
		const name = author.name?.trim()
		if (!name) return false
		const incomplete = !author.image?.trim() || !author.description?.trim()
		if (!incomplete) return false
		const scheduled = schedule(`author:${this.asin}`, SECOND_CHANCE_DELAY_MS, () =>
			new AuthorShowHelper(
				this.asin,
				{ region: this.options.region, update: '1', force: '1', name },
				this.redisClient,
				this.logger,
				this.credentials
			).handler()
		)
		if (scheduled) {
			this.logger?.info(
				{ author: name, asin: this.asin, delayMs: SECOND_CHANCE_DELAY_MS },
				'author enrichment: incomplete, scheduled a second chance'
			)
		}
		return scheduled
	}

	/**
	 * Search for an author in the database by name
	 */
	async getAuthorsByName() {
		const name = this.options.name ?? ''
		// Assert this.paprHelper is PaprAudibleAuthorHelper
		const paprHelper = this.paprHelper as PaprAudibleAuthorHelper
		const cached = (await paprHelper.findByName()).data

		// Mongo $text is a loose OR over tokens, so a search for "Adrian
		// Tchaikovsky" can return a cached "Adrian McKinty" on the shared
		// "Adrian". Keep only close name matches — otherwise a wrong cached
		// author both mis-matches AND suppresses the Audible fallback below.
		// Collapse same-name duplicates: Audible has several author ASINs for one
		// person (three "David Baldacci"s), which the cache accumulates. Without
		// this, Fix Match shows several identical rows scored 100/99/98 with no way
		// to tell them apart. The cache is text-score ordered, so the first per name
		// is the best-ranked one.
		// ...then collapse one person's middle-initial variants, keeping the
		// populated record: Audible carries an empty "Stephen Lawhead" stub
		// alongside the real "Stephen R. Lawhead", and since a client scores on
		// name similarity against a tag that usually omits the initial, the stub
		// would win outright and the author would show no photo and no bio.
		const close = collapseInitialVariants(
			dedupeAuthorsByName(cached.filter((a) => isSameAuthor(name, a.name)))
		)
		// The richness fields are an internal signal; keep the response shape.
		if (close.length) return close.map((a) => ({ asin: a.asin, name: a.name }))

		// Cache miss (empty on a fresh instance, or only loose matches): fall back
		// to the Audible catalog so authors resolve out of the box. A picked author
		// is then fetched by ASIN and cached, so later searches hit the text index.
		// (searchAudibleAuthors already collapses same-name authors.)
		return searchAudibleAuthors(name, this.options.region, this.logger)
	}
}

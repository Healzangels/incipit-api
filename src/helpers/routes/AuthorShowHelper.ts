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
import { fetchGoodreadsAuthorInfo } from '#helpers/providers/goodreadsSeries'
import type HardcoverProvider from '#helpers/providers/HardcoverProvider'
import defaultRegistry from '#helpers/providers/registry'
import GenericShowHelper from '#helpers/routes/GenericShowHelper'
import { isSameAuthor } from '#helpers/utils/authorNameMatch'

export { isSameAuthor }

export default class AuthorShowHelper extends GenericShowHelper {
	credentials?: Record<string, string>

	constructor(
		asin: string,
		options: ApiQueryString,
		redis: FastifyRedis | null,
		logger?: FastifyBaseLogger,
		credentials?: Record<string, string>
	) {
		super(asin, options, redis, 'author', logger)
		this.credentials = credentials
	}

	/**
	 * Build the author profile, then PREFER Hardcover's curated portrait.
	 *
	 * Audible's author image is unreliable — for many (often indie) authors it is
	 * the book cover, not a photo (e.g. Craig Alanson's is his Expeditionary Force
	 * cover). Hardcover carries real author portraits, so when it has one we use it
	 * and keep Audible's as `imageAlt` (a secondary poster option); when Hardcover
	 * has none we fall back to Audible's image as-is. When a portrait or bio is
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
			name,
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
		if (hardcover?.fetchAuthorInfo) {
			const { image: hardcoverImage, bio: hardcoverBio } = await hardcover.fetchAuthorInfo(
				author.name,
				{ region: this.options.region, credentials: this.credentials, logger: this.logger }
			)
			if (hardcoverImage && hardcoverImage !== author.image) {
				this.logger?.info({ author: author.name }, 'author image: preferring Hardcover portrait')
				if (author.image) author.imageAlt = author.image
				author.image = hardcoverImage
			}
			if (hardcoverBio && !author.description?.trim()) {
				this.logger?.info({ author: author.name }, 'author description: filled from Hardcover')
				author.description = hardcoverBio
			}
		}

		// 2. Goodreads (bookinfo.pro) — the broad-coverage backstop for a portrait or
		// bio that Audible never had and Hardcover (Wikipedia-only) doesn't carry
		// (e.g. Jessica Townsend). Consulted only when a gap REMAINS, and it only
		// ever FILLS the gap — it never overrides a curated Audible/Hardcover value.
		if (!author.image?.trim() || !author.description?.trim()) {
			const { image: grImage, bio: grBio } = await fetchGoodreadsAuthorInfo(
				author.name,
				this.logger
			)
			if (grImage && !author.image?.trim()) {
				this.logger?.info({ author: author.name }, 'author image: filled from Goodreads')
				author.image = grImage
			}
			if (grBio && !author.description?.trim()) {
				this.logger?.info({ author: author.name }, 'author description: filled from Goodreads')
				author.description = grBio
			}
		}
		return author
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

import { FastifyInstance } from 'fastify'

import type { ApiBook } from '#config/types'
import { RequestGeneric } from '#config/typing/requests'
import { NotFoundError } from '#helpers/errors/ApiErrors'
import { alternateCoverWorthOffering, siblingRegion } from '#helpers/providers/alternateCover'
import { withGoodreadsSeries } from '#helpers/providers/goodreadsSeries'
import ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import defaultRegistry from '#helpers/providers/registry'
import { bestSquareCover } from '#helpers/providers/squareCover'
import BookDataHelper from '#helpers/routes/BookDataHelper'
import BookShowHelper from '#helpers/routes/BookShowHelper'
import RouteCommonHelper from '#helpers/routes/RouteCommonHelper'
import { applyPins } from '#helpers/series/shelfPins'
import { applyShelfPolicy } from '#helpers/series/shelfPolicy'
import { languageConflict, regionLanguage } from '#helpers/utils/language'
import {
	recordLanguageMismatchedLookup,
	recordStaleServedOnUpstreamUnavailable
} from '#helpers/utils/matchTelemetry'
import { MessageNotFoundInDb } from '#static/messages'

/**
 * Early warning for a stale/wrong pinned ASIN: an item lookup whose record
 * language positively conflicts with the region's expected language is almost
 * always a listing that changed hands (delisted edition, re-released series) --
 * the Dungeon Crawler Carl case served a FRENCH record for a sidecar-pinned
 * ASIN and the first symptom was a foreign album title on a shelf. Warn with
 * the detail and bump the /metrics counter; deliberately NOT an error, because
 * region conflates marketplace with language and a genuinely foreign library
 * must keep working.
 */
function flagLanguageMismatch(
	book: unknown,
	region: string,
	log: { warn: (obj: object, msg: string) => void }
): void {
	if (!book || typeof book !== 'object' || !('language' in book)) return
	const language = (book as { language?: string | null }).language ?? null
	const wantLanguage = regionLanguage(region)
	if (languageConflict(language, wantLanguage)) {
		log.warn(
			{ language, region, wantLanguage },
			'book lookup language conflicts with region -- stale or wrong ASIN?'
		)
		recordLanguageMismatchedLookup()
	}
}

// An Audible/Amazon cover host. Only such a match can have a sibling-ASIN
// listing in another marketplace, so this keeps the alternate-cover lookup off
// every Hardcover and OpenLibrary response.
const AMAZON_COVER_RE = /\/\/m\.media-amazon\.com\/images\//i

async function _show(fastify: FastifyInstance) {
	fastify.get<RequestGeneric>('/books/:asin', async (request, reply) => {
		const asin = request.params.asin

		// Non-Audible book (Hardcover/OpenLibrary): the id decodes to a provider, so
		// re-query it for full metadata instead of the ASIN-based audnexus lookup.
		const region = request.query.region ?? 'us'
		const credentials: Record<string, string> = {}
		const hardcoverToken = request.headers['x-hardcover-token']
		if (typeof hardcoverToken === 'string' && hardcoverToken) {
			credentials.hardcover = hardcoverToken
		}
		// Attach a native square cover (Apple Books) for a square Plex poster. Any
		// object with a title/authors/image works for both response shapes. The
		// Apple lookup is cached (this runs on every book response, refreshes too).
		const squareCache = new ProviderSearchCache(fastify.redis ?? null, undefined, request.log)
		const withSquareCover = async <
			T extends { title?: string; authors?: { name?: string }[]; image?: string | null }
		>(
			book: T
		): Promise<T> => {
			if (!book?.title) return book
			const square = await bestSquareCover(
				defaultRegistry,
				{
					title: book.title,
					author: book.authors?.[0]?.name,
					currentImage: book.image,
					region,
					credentials,
					logger: request.log
				},
				squareCache
			)
			return square ? { ...book, imageSquare: square } : book
		}

		// Offer the sibling marketplace's cover as an EXTRA choice. Audible
		// commissions different art per marketplace for the same recording:
		// measured over the 16 library ASINs resolving in both us and uk, 7 of 15
		// pairs carry a genuinely different asset. See alternateCover for why the
		// narrator sets must match (one ASIN can front DIFFERENT recordings in
		// different marketplaces) and why runtime cannot stand in.
		//
		// COST CONTROL, because this runs on every book response and Plex asks
		// once per TRACK. Gated on the current cover being an Amazon/Audible
		// image: a Hardcover or OpenLibrary match has no sibling-ASIN concept, so
		// the lookup could only ever miss. Best-effort throughout — this is spare
		// art, never worth failing or delaying a response for.
		const withAlternateCovers = async <T extends { asin?: string | null; image?: string | null }>(
			book: T
		): Promise<T> => {
			const sibling = siblingRegion(region)
			if (!sibling || !book?.asin || !AMAZON_COVER_RE.test(book.image ?? '')) return book
			try {
				const other = await defaultRegistry.fetchBookByAsin(book.asin, {
					region: sibling,
					credentials,
					logger: request.log
				})
				if (!other) return book
				const extra = alternateCoverWorthOffering(book, other)
				return extra ? { ...book, imageAlternates: [extra] } : book
			} catch {
				return book
			}
		}

		// Every book response goes out through here: attach the square cover, then
		// consult Goodreads for the series. Under authority mode (the default)
		// that consult happens for EVERY book, not just the series-less ones, so
		// only the cached case is cheap (one redis GET, 30 days for a hit, 1 day
		// for a miss). A cache-cold book pays the paced mirror chain inline --
		// which is why withGoodreadsSeries carries a time budget
		// (GOODREADS_TIME_BUDGET_MS): the Plex agent gives this whole response
		// 25s, and losing the entire update to enrich one field is a worse trade
		// than serving the book un-enriched and letting the lookup finish in the
		// background to warm the cache.
		const finish = async <
			T extends {
				title?: string
				authors?: { name?: string }[]
				image?: string | null
				asin?: string | null
				seriesPrimary?: { name?: string } | null
				seriesSecondary?: unknown
			}
		>(
			book: T
		): Promise<T> =>
			// Q2 shelf policy runs LAST and at serve time, so pre-policy answers in
			// the goodreads cache obey it too — no invalidation rides along (P3).
			applyShelfPolicy(
				applyPins(
					await withGoodreadsSeries(
						await withAlternateCovers(await withSquareCover(book)),
						fastify.redis ?? null,
						request.log
					),
					asin
				)
			)

		const dataHelper = new BookDataHelper(defaultRegistry, asin, region, credentials, request.log)
		if (dataHelper.isProviderId) {
			const book = await dataHelper.fetch()
			if (!book) throw new NotFoundError(MessageNotFoundInDb(asin))
			// This branch is how a provider EDITION record reaches Plex, and it
			// is exactly where the Dungeon Crawler Carl French edition slipped
			// through unflagged — the mismatch check must cover both serve paths.
			flagLanguageMismatch(book, region, request.log)
			return finish(book)
		}

		// Setup common helper first
		const routeHelper = new RouteCommonHelper(asin, request.query, reply)
		// Run common helper handler
		const handler = routeHelper.handler()
		// If handler reply code is not 200, return error
		if (handler.reply.statusCode !== 200) return handler.reply

		// Setup Helper
		const { redis } = fastify
		const helper = new BookShowHelper(asin, handler.options, redis, request.log)

		// Call helper handler
		let book
		try {
			book = await helper.handler()
		} catch (err) {
			// A DELISTED Audible product is not necessarily unservable. Our own
			// search emits candidates that merely CARRY an ASIN -- a Hardcover
			// edition exposes `asin` for dedup and the exact-match pin -- so a
			// client can be holding an ASIN that was never an Audible id, or one
			// whose listing died after the match. Rescue it through the providers
			// instead of freezing the item's metadata forever. Only the
			// availability codes are rescued; every other failure still throws.
			const code = err instanceof NotFoundError ? err.details?.code : null
			if (code !== 'PRODUCT_DELISTED' && code !== 'REGION_UNAVAILABLE') throw err
			const rescued = await defaultRegistry.fetchBookByAsin(asin, {
				region,
				credentials,
				logger: request.log
			})
			if (rescued) {
				request.log.warn({ asin, region, code }, 'delisted asin rescued via a provider record')
				flagLanguageMismatch(rescued, region, request.log)
				return finish(rescued)
			}
			// STALE-WHILE-ERROR. The provider rescue above runs against the same
			// upstreams that just refused us, so under load it fails too — and we
			// then 404'd a book we already hold a full record for.
			//
			// "Unavailable" is not a stable property of the product. Measured
			// 2026-07-31 against this deployment: 20 concurrent requests for one
			// known-good ASIN returned 404 PRODUCT_DELISTED twenty times out of
			// twenty, while the same record served fine when asked once, seconds
			// later. A refresh is exactly that access pattern, and the agent's
			// documented response to a failed fetch is to keep the existing
			// metadata and move on — so ~15% of albums silently did not update in
			// the 2026-07-31 full refresh.
			//
			// A stored record is strictly better than a 404 here: worst case it is
			// stale, and the next successful pass refreshes it. Counted, not
			// silent — staleServedOnUpstreamUnavailable rising on /metrics is the
			// signal that the upstream is refusing us, which a 200 otherwise hides.
			const stored = await helper.getDataWithProjection().catch(() => null)
			if (stored && 'image' in stored) {
				recordStaleServedOnUpstreamUnavailable()
				request.log.warn(
					{ asin, region, code },
					'upstream reported unavailable; served the STORED record instead of 404'
				)
				flagLanguageMismatch(stored, region, request.log)
				return finish(stored as ApiBook)
			}
			throw err
		}
		flagLanguageMismatch(book, region, request.log)
		return book && 'image' in book ? finish(book as ApiBook) : book
	})
}

export default _show

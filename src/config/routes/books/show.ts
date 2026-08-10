import { FastifyInstance } from 'fastify'

import type { ApiBook, ApiGenre } from '#config/types'
import { RequestGeneric } from '#config/typing/requests'
import { NotFoundError } from '#helpers/errors/ApiErrors'
import {
	alternateCoverKey,
	recallAlternates,
	rememberAlternates
} from '#helpers/providers/alternateCoverCache'
import { backfillChaptarrGenres } from '#helpers/providers/chaptarrGenres'
import { mergeGenres } from '#helpers/providers/genreNormalize'
import { withGoodreadsSeries } from '#helpers/providers/goodreadsSeries'
import { backfillHardcoverGenres } from '#helpers/providers/hardcoverGenres'
import ProviderSearchCache from '#helpers/providers/ProviderSearchCache'
import defaultRegistry from '#helpers/providers/registry'
import { bestSquareCover } from '#helpers/providers/squareCover'
import BookDataHelper from '#helpers/routes/BookDataHelper'
import BookSearchHelper from '#helpers/routes/BookSearchHelper'
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

		// Attach alternate covers -- the extra art dedupe and near-tie borrowing
		// find across a whole candidate set.
		//
		// They cannot be read off this book alone: both sources compare CANDIDATES,
		// and a lookup has exactly one. The search route caches them by id, which
		// covers a fresh match. It does NOT cover a plain "Refresh Metadata", and
		// that is the path Plex actually uses -- `search()` and `update()` are
		// separate plugin entry points and a refresh calls only the second. Measured
		// live: The Testaments, matched to `hardcover-edition-30404079`, served zero
		// alternates through refresh after refresh because nothing had searched.
		//
		// So on a MISS we run the search ourselves and cache the answer for every
		// row it returned, warming this book's near-tie siblings at the same time.
		// The empty result is cached too, or a book with genuinely no alternates
		// would pay for a search on every refresh forever.
		//
		// Cost is one search per book per TTL, and it is spare art: any failure
		// leaves the book exactly as it would have been.
		const computeAlternates = async (book: {
			title?: string
			authors?: { name?: string }[]
		}): Promise<string[]> => {
			if (!book?.title) return []
			const helper = new BookSearchHelper(
				defaultRegistry,
				{
					title: book.title,
					author: book.authors?.[0]?.name,
					region,
					// This is a background lookup, not an operator action: `manual`
					// off keeps it on the automatic-match rules, and `refresh` off
					// lets it reuse the provider cache the real search already filled.
					manual: false,
					refresh: false
				},
				request.log,
				credentials,
				new ProviderSearchCache(fastify.redis ?? null, undefined, request.log)
			)
			const results = await helper.search()
			await Promise.all(
				results.map((r) => rememberAlternates(fastify.redis ?? null, r.id, r.coverAlternates ?? []))
			)
			const want = alternateCoverKey(asin)
			const mine = results.find((r) => alternateCoverKey(r.id) === want)?.coverAlternates ?? []
			// RECORD UNDER THE KEY THE READ SIDE WILL USE, unconditionally.
			//
			// The loop above only writes keys for ids the SEARCH returned. A book
			// that does not appear in its own search results -- a delisted ASIN on
			// the stale-while-error path, or a title the providers answer
			// differently -- therefore had nothing written for it, so the next
			// request recalled null and paid for the whole fan-out again, every
			// time, forever. That is precisely the cost the negative entry exists
			// to prevent, and the comment above claimed it was prevented.
			await rememberAlternates(fastify.redis ?? null, asin, mine)
			return mine
		}

		const withAlternateCovers = async <
			T extends { asin?: string | null; title?: string; authors?: { name?: string }[] }
		>(
			book: T
		): Promise<T> => {
			// Key on the REQUESTED id, never on book.asin. The write side keys on
			// the search row's id, and the bundle asks with the same id it was
			// matched to -- but a provider record can carry an unrelated `asin`
			// (Hardcover exposes one for dedup), so `book.asin ?? asin` read a
			// key nothing ever wrote. Recall missed on every request and the
			// compute re-ran forever, silently, for exactly those books.
			let alternates = await recallAlternates(fastify.redis ?? null, asin)
			// WITHOUT REDIS THERE IS NO COMPUTE. The whole design rests on paying
			// for the search once and recording the answer -- including the empty
			// answer. With nowhere to record it, every book lookup would fan out
			// across every provider on every request, forever, to attach spare art.
			// A redis-less instance simply goes without alternates, exactly as it
			// did before any of this existed.
			if (alternates === null && !fastify.redis) return book
			if (alternates === null) {
				alternates = await computeAlternates(book).catch((err) => {
					request.log.warn({ err, asin }, 'alternate-cover compute failed; serving without them')
					return []
				})
			}
			return alternates.length ? { ...book, imageAlternates: alternates } : book
		}

		// Genre backfill for a record that carries NONE. Audible's catalog API has
		// an empty category_ladders for some listings (Annihilation B00HYGYN5Q,
		// measured 2026-08-07), so those records are honestly genre-less — and the
		// bundle's add_genres only clears an album's existing genres when the
		// served record HAS replacements, so the comma-joined junk in the files'
		// ©gen tags survived as one mega-genre and rolled up to the artist page.
		// Hardcover's community genres answer by the same asin; serving them lets
		// the bundle's existing clear-and-replace fix the album, no plugin change.
		// Audible data is never OVERRIDDEN — its genres keep their place and their
		// ids — but it is now ADDED TO. The old gate returned early whenever the
		// record had any genres at all, and measured 2026-08-09 that was 1,756 of
		// 1,758 cached books, so the whole leg fired for two of them. Merging is
		// what makes the community sources worth their calls; genreNormalize is
		// what keeps the merge from restating what Audible already said.
		const withGenres = async <
			T extends { genres?: unknown; title?: string; seriesPrimary?: { name?: string } | null }
		>(
			book: T
		): Promise<T> => {
			const existing = Array.isArray(book?.genres) ? (book.genres as ApiGenre[]) : []
			// The book itself, so a shelf that merely restates it ("Harry Potter"
			// on Goblet of Fire) is dropped rather than shown as a genre.
			const ctx = { title: book?.title ?? null, series: book?.seriesPrimary?.name ?? null }
			// CONCURRENT, not sequential. While this only filled empties, running
			// Chaptarr solely on a Hardcover miss made the second source nearly
			// free; now that both contribute to every book, chaining them would put
			// two round-trips on the critical path instead of one. Both cache hits
			// and empties for 30/7 days, so the steady state is redis either way.
			const [hardcover, chaptarr] = await Promise.all([
				backfillHardcoverGenres({
					id: asin,
					redis: fastify.redis ?? null,
					token: credentials.hardcover ?? process.env.HARDCOVER_TOKEN,
					logger: request.log,
					ctx
				}),
				backfillChaptarrGenres({
					id: asin,
					redis: fastify.redis ?? null,
					logger: request.log,
					ctx
				})
			])
			// Hardcover ahead of Chaptarr: its curated Genre bucket is a better
			// first claim on the remaining slots than a raw Goodreads shelf list.
			const merged = mergeGenres(existing, [...hardcover, ...chaptarr])
			return merged.length > existing.length ? { ...book, genres: merged } : book
		}

		const finish = async <
			T extends {
				title?: string
				authors?: { name?: string }[]
				image?: string | null
				asin?: string | null
				seriesPrimary?: { name?: string } | null
				seriesSecondary?: unknown
				genres?: unknown
			}
		>(
			book: T
		): Promise<T> => {
			// The four enrichments run CONCURRENTLY: latency is their max, not
			// their sum. They used to be chained, and across the 2026-08-05
			// rebuild /books/:asin averaged 907 ms against a 0.8 ms DB path —
			// the route was essentially the sum of these network waits.
			//
			// Safe because their reads and writes are disjoint, verified leg by
			// leg: square reads title/author/image, writes imageSquare;
			// alternates reads title/author, writes imageAlternates; Goodreads
			// reads title/subtitle/author/series, writes the series fields;
			// genres reads only the field it writes (genres), which no other
			// leg touches. Each leg gets the ORIGINAL book, and the merge takes
			// each leg's own field — conditionally, so a leg that added nothing
			// adds no key here either (the bundle reads presence, not null).
			const [squared, withAlts, withSeries, genred] = await Promise.all([
				withSquareCover(book),
				withAlternateCovers(book),
				withGoodreadsSeries(book, fastify.redis ?? null, request.log),
				withGenres(book)
			])
			const merged = {
				...withSeries,
				...('imageSquare' in squared
					? { imageSquare: (squared as T & { imageSquare?: string }).imageSquare }
					: {}),
				...('imageAlternates' in withAlts
					? { imageAlternates: (withAlts as T & { imageAlternates?: string[] }).imageAlternates }
					: {}),
				...(Array.isArray(genred.genres) && genred.genres.length ? { genres: genred.genres } : {})
			}
			// Q2 shelf policy runs LAST and at serve time, so pre-policy answers in
			// the goodreads cache obey it too — no invalidation rides along (P3).
			return applyShelfPolicy(applyPins(merged, asin))
		}

		const dataHelper = new BookDataHelper(defaultRegistry, asin, region, credentials, request.log)
		if (dataHelper.isProviderId) {
			// The QUERY still gets validated here: only the ASIN rule is
			// inapplicable to a provider id, and skipping validation entirely
			// meant `?region=zz` answered 200 on this branch while the ASIN
			// branch 400s the identical request.
			//
			// Called for the THROW, not for a return value. parseQueryString's
			// only failure path is handleParseError -> `throw new
			// BadRequestError(...)`, and RouteCommonHelper never touches
			// reply.code/status/send, so an `if (reply.statusCode !== 200)` here
			// could only ever read Fastify's untouched 200.
			new RouteCommonHelper(asin, request.query, reply).parseQueryString()
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

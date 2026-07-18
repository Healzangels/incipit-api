import AppleBooksProvider from '#helpers/providers/AppleBooksProvider'
import AudibleProvider from '#helpers/providers/AudibleProvider'
import HardcoverProvider from '#helpers/providers/HardcoverProvider'
import OpenLibraryProvider from '#helpers/providers/OpenLibraryProvider'
import ProviderRegistry from '#helpers/providers/ProviderRegistry'
import StorytelProvider from '#helpers/providers/StorytelProvider'
import type { BookProvider } from '#helpers/providers/types'

/**
 * The default provider registry used by the GET /books search route.
 *
 * Providers (Audible, Hardcover, OpenLibrary) are registered here as they land.
 * Adding one needs no route changes to take effect.
 *
 * Hardcover's default token comes from HARDCOVER_TOKEN for a self-hosted
 * instance; a shared public instance can leave it unset and rely on the
 * per-request token the Plex bundle forwards (see BookSearchQuery.credentials).
 * OpenLibrary needs no auth, only an identifying contact (OL_CONTACT).
 */
const providers: BookProvider[] = [
	new AudibleProvider(),
	new HardcoverProvider({ token: process.env.HARDCOVER_TOKEN })
]

// Storytel is keyless and real (narrator + runtime), but a live check showed its
// English catalog is thin for indie US SF / LitRPG and its search is a loose
// relevance match (a query for "Steel World" returns "Steel River"). Our scorer
// filters that noise, so it's harmless — but for many libraries it's just extra
// latency for ~zero coverage. OFF by default; enable with STORYTEL_ENABLED=true
// (useful for mainstream/European catalogs). Placed before OpenLibrary so the
// provider-richness tiebreak prefers its audio edition over a book-level record.
if (process.env.STORYTEL_ENABLED === 'true') providers.push(new StorytelProvider())

// Apple Books (iTunes) — keyless English-audiobook catalog with square covers.
// Fills the gap where Audible + Hardcover miss. On by default; a wrong match is
// held out by the confidence floor. Set APPLE_ENABLED=false to disable. Placed
// before OpenLibrary so its audiobook record outranks a book-level fallback.
if (process.env.APPLE_ENABLED !== 'false') providers.push(new AppleBooksProvider())

providers.push(new OpenLibraryProvider({ contact: process.env.OL_CONTACT }))

const defaultRegistry = new ProviderRegistry(providers)

export default defaultRegistry

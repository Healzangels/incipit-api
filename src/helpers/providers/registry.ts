import AudibleProvider from '#helpers/providers/AudibleProvider'
import HardcoverProvider from '#helpers/providers/HardcoverProvider'
import OpenLibraryProvider from '#helpers/providers/OpenLibraryProvider'
import ProviderRegistry from '#helpers/providers/ProviderRegistry'

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
const defaultRegistry = new ProviderRegistry([
	new AudibleProvider(),
	new HardcoverProvider({ token: process.env.HARDCOVER_TOKEN }),
	new OpenLibraryProvider({ contact: process.env.OL_CONTACT })
])

export default defaultRegistry

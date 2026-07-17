import type { FastifyBaseLogger } from 'fastify'

import { decodeProviderId } from '#helpers/providers/providerId'
import type ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { ProviderBook } from '#helpers/providers/types'

/**
 * Resolves a non-Audible book id to full metadata for the data-lookup route.
 *
 * After a Hardcover/OpenLibrary match, Plex asks the API for the book's data by
 * its id. The id decodes to a provider + native id, and this helper dispatches to
 * that provider's `fetchBook` (a stateless re-query — no datastore needed). A
 * plain ASIN is not handled here; the route keeps its existing audnexus path for
 * those.
 */
export default class BookDataHelper {
	private registry: ProviderRegistry
	private id: string
	private region: string
	private credentials?: Record<string, string>
	private logger?: FastifyBaseLogger

	constructor(
		registry: ProviderRegistry,
		id: string,
		region: string,
		credentials?: Record<string, string>,
		logger?: FastifyBaseLogger
	) {
		this.registry = registry
		this.id = id
		this.region = region
		this.credentials = credentials
		this.logger = logger
	}

	/** True when the id is a provider-encoded (non-ASIN) id this helper handles. */
	get isProviderId(): boolean {
		return decodeProviderId(this.id) !== null
	}

	/**
	 * Fetch the book. Returns null when the id is not a provider id, the provider
	 * is unknown or lacks fetchBook, or the book was not found.
	 * @returns {Promise<ProviderBook | null>} the book metadata, or null
	 */
	async fetch(): Promise<ProviderBook | null> {
		const decoded = decodeProviderId(this.id)
		if (!decoded) return null

		const provider = this.registry.get(decoded.provider)
		if (!provider?.fetchBook) {
			this.logger?.debug({ provider: decoded.provider }, 'no fetchBook for provider')
			return null
		}

		return provider.fetchBook(decoded.nativeId, decoded.kind, {
			region: this.region,
			credentials: this.credentials,
			logger: this.logger
		})
	}
}

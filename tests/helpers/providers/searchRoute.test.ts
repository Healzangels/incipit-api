import { describe, expect, test } from 'bun:test'
import Fastify, { type FastifyInstance } from 'fastify'

import { makeSearchBookRoute } from '#config/routes/books/search/show'
import ProviderRegistry from '#helpers/providers/ProviderRegistry'
import type { BookProvider } from '#helpers/providers/types'

// Build a Fastify app around the search route with an injected registry, wired to
// the same statusCode->status error contract the real server uses. Injecting the
// registry keeps each test hermetic instead of mutating the shared singleton.
async function appWith(registry: ProviderRegistry): Promise<FastifyInstance> {
	const f = Fastify()
	f.setErrorHandler((err, _req, reply) => {
		const sc = (err as Error & { statusCode?: number }).statusCode ?? 500
		reply.status(sc).send({ error: err.message })
	})
	await f.register(makeSearchBookRoute(registry))
	return f
}

const spellProvider: BookProvider = {
	name: 'stub',
	async search() {
		return [
			{
				provider: 'stub',
				id: 'B1',
				asin: 'B1',
				title: 'A Spell for Chameleon',
				authors: ['Piers Anthony'],
				narrators: ['Traber Burns'],
				audioSeconds: 45000,
				cover: 'https://example/cover.jpg'
			}
		]
	}
}

describe('GET /books route', () => {
	test('400 when neither title nor query is supplied', async () => {
		const f = await appWith(new ProviderRegistry())
		const r = await f.inject({ method: 'GET', url: '/books' })
		expect(r.statusCode).toBe(400)
	})

	test('a bad duration is ignored, not a 400 (Plex sends -1 for unanalyzed files)', async () => {
		const f = await appWith(new ProviderRegistry())
		for (const duration of ['soon', '-1']) {
			const r = await f.inject({ method: 'GET', url: `/books?title=Dune&duration=${duration}` })
			expect(r.statusCode).toBe(200)
		}
	})

	test('400 on an invalid region', async () => {
		const f = await appWith(new ProviderRegistry())
		const r = await f.inject({ method: 'GET', url: '/books?title=Dune&region=mars' })
		expect(r.statusCode).toBe(400)
	})

	test('200 with an empty array when no provider matches', async () => {
		const f = await appWith(new ProviderRegistry())
		const r = await f.inject({
			method: 'GET',
			url: '/books?title=A+Spell+for+Chameleon&author=Piers+Anthony'
		})
		expect(r.statusCode).toBe(200)
		expect(r.json()).toEqual([])
	})

	test('end-to-end: a matching provider candidate is normalized, scored, and returned', async () => {
		const f = await appWith(new ProviderRegistry([spellProvider]))
		// series-suffixed ALBUM tag + a duration that corroborates the edition
		const r = await f.inject({
			method: 'GET',
			url: '/books?title=A+Spell+for+Chameleon%3A+Xanth%2C+Book+1&author=Piers+Anthony&duration=45000000'
		})
		expect(r.statusCode).toBe(200)
		const body = r.json()
		expect(body).toHaveLength(1)
		expect(body[0].id).toBe('B1')
		expect(body[0].provider).toBe('stub')
		expect(body[0].confidence).toBeGreaterThan(0.9)
		expect(body[0].durationDeltaPct).toBeLessThanOrEqual(0.05)
		expect(body[0].narrators).toEqual(['Traber Burns'])
	})
})

/**
 * THE SEARCH MUST RECORD ITS ALTERNATES, or a refresh gets nothing.
 *
 * This is the WRITE half of the alternate-cover hand-off, and it is the half
 * that makes a plain "Refresh Metadata" work: dedupe builds `coverAlternates`
 * here and nowhere else, so if this route does not persist them the item
 * endpoint has nothing to serve and the whole feature is invisible on the path
 * Plex uses most.
 *
 * Pinned at the route because it survived mutation without this: deleting the
 * `rememberAlternates` call left all 1851 tests green. The cache module's own
 * suite cannot see the difference — it never asserts that anyone calls it.
 */
describe('GET /books records alternate covers', () => {
	const twoEditions: BookProvider = {
		name: 'stub',
		async search() {
			const base = {
				provider: 'stub',
				title: 'Leviathan Wakes',
				authors: ['James S. A. Corey'],
				narrators: ['Jefferson Mays'],
				audioSeconds: 68940
			}
			// Same asin + runtime -> dedupe merges them, and the loser's cover
			// becomes the winner's alternate.
			return [
				{ ...base, id: 'B073H9PF2D', asin: 'B073H9PF2D', cover: 'https://example/win.jpg' },
				{ ...base, id: 'other', asin: 'B073H9PF2D', cover: 'https://example/alt.jpg' }
			]
		}
	}

	test('persists the merged group covers under the winning id', async () => {
		const writes: Record<string, string> = {}
		const app = Fastify()
		app.decorate('redis', {
			async set(k: string, v: string) {
				writes[k] = v
				return 'OK'
			},
			async get() {
				return null
			}
		} as never)
		await app.register(makeSearchBookRoute(new ProviderRegistry([twoEditions])) as never)
		try {
			const res = await app.inject({
				method: 'GET',
				url: '/books?title=Leviathan%20Wakes&author=James%20S.%20A.%20Corey'
			})
			expect(res.statusCode).toBe(200)
			// ProviderSearchCache writes to the same redis, so filter by OUR
			// namespace -- grabbing the first key found the search cache instead
			// and compared against a list of candidate objects.
			const keys = Object.keys(writes).filter((k) => k.startsWith('incipit:altcover:'))
			expect(keys).toHaveLength(1)
			const stored = JSON.parse(writes[keys[0] as string] as string) as string[]
			// Which of the two wins the merge is dedupe's business; what matters
			// is that the LOSER's cover is preserved and the winner's is not
			// duplicated into its own alternates.
			expect(stored).toHaveLength(1)
			expect(['https://example/win.jpg', 'https://example/alt.jpg']).toContain(stored[0])
		} finally {
			await app.close()
		}
	})

	/**
	 * "This book has no alternates" must be RECORDED, not left blank.
	 *
	 * `recallAlternates` deliberately separates [] ("asked, found none") from
	 * null ("nobody has looked"), and its caller computes on null. dedupe only
	 * spreads the key in when the list is non-empty
	 * (`...(alternates.length ? { coverAlternates: alternates } : {})`), so a
	 * book with no alternates reaches this route with the field UNDEFINED --
	 * and `rememberAlternates` early-returns on undefined (`if (!redis || !id
	 * || !urls) return`). Nothing is written, recall answers null forever, and
	 * the item route re-computes alternates over the network on EVERY refresh
	 * of every alternate-less book. The item route already passes `?? []`; this
	 * route did not, and the two must agree.
	 */
	test('records an empty list when a result has no alternates, so recall says "asked" not "unknown"', async () => {
		const writes: Record<string, string> = {}
		const app = Fastify()
		app.decorate('redis', {
			async set(k: string, v: string) {
				writes[k] = v
				return 'OK'
			},
			async get() {
				return null
			}
		} as never)
		// A single candidate -- nothing to merge, so dedupe omits coverAlternates.
		await app.register(makeSearchBookRoute(new ProviderRegistry([spellProvider])) as never)
		try {
			const res = await app.inject({
				method: 'GET',
				url: '/books?title=A%20Spell%20for%20Chameleon&author=Piers%20Anthony'
			})
			expect(res.statusCode).toBe(200)
			const keys = Object.keys(writes).filter((k) => k.startsWith('incipit:altcover:'))
			expect(keys).toHaveLength(1)
			expect(JSON.parse(writes[keys[0] as string] as string)).toEqual([])
		} finally {
			await app.close()
		}
	})
})


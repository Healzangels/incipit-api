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

	test('400 on a non-numeric duration', async () => {
		const f = await appWith(new ProviderRegistry())
		const r = await f.inject({ method: 'GET', url: '/books?title=Dune&duration=soon' })
		expect(r.statusCode).toBe(400)
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

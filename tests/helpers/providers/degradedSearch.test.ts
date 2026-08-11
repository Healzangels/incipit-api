import { describe, expect, test } from 'bun:test'
import Fastify, { type FastifyInstance } from 'fastify'

import { makeSearchBookRoute } from '#config/routes/books/search/show'
import ProviderRegistry, { type DegradedReport } from '#helpers/providers/ProviderRegistry'
import type { BookProvider, ProviderCandidate } from '#helpers/providers/types'

/**
 * Regression suite for the "Shadows Beneath" poisoning, measured live on
 * 2026-08-10 during the .99 library rebuild.
 *
 * Hardcover's breaker was open. The fan-out isolated that failure correctly and
 * then DISCARDED it, so the route served 200 with five Apple rows for unrelated
 * books (top confidence 0.75) -- the same shape a complete answer has. The Plex
 * bundle cached that body, and the artist recovery re-read the poisoned entry on
 * every later refresh, so "GraphicAudio" stayed unmatched permanently even after
 * Hardcover recovered. The correct row (the Writing Excuses anthology, carrying
 * the author "Brandon Sanderson" that the file path would have confirmed) was
 * behind the open breaker the whole time.
 */

async function appWith(registry: ProviderRegistry): Promise<FastifyInstance> {
	const f = Fastify()
	f.setErrorHandler((err, _req, reply) => {
		const sc = (err as Error & { statusCode?: number }).statusCode ?? 500
		reply.status(sc).send({ error: err.message })
	})
	await f.register(makeSearchBookRoute(registry))
	return f
}

/** A provider that always rejects, standing in for an open breaker. */
function downProvider(name: string): BookProvider {
	return {
		name,
		async search() {
			throw new Error('Circuit breaker is OPEN')
		}
	}
}

/** A provider returning rows that are near-misses -- the Apple noise. */
function weakProvider(name: string, titles: string[]): BookProvider {
	return {
		name,
		async search(): Promise<ProviderCandidate[]> {
			return titles.map((title, i) => ({
				provider: name,
				id: `${name}-${i}`,
				asin: null,
				title,
				authors: ['Someone Else'],
				narrators: [],
				audioSeconds: null,
				cover: null
			}))
		}
	}
}

/** A provider returning the exact book asked for, title + author + runtime. */
function exactProvider(name: string): BookProvider {
	return {
		name,
		async search(): Promise<ProviderCandidate[]> {
			return [
				{
					provider: name,
					id: `${name}-exact`,
					asin: 'B0EXACT000',
					title: 'Shadows Beneath',
					authors: ['Brandon Sanderson'],
					narrators: ['Various'],
					audioSeconds: 37479,
					cover: 'https://example/cover.jpg'
				}
			]
		}
	}
}

const NOISE = [
	'Shadows Beneath the Shore: Secrets of a Town',
	'Shadows Beneath The Glass: Series of brutal',
	'Shadows Beneath the Willows'
]

const SEARCH = '/books?title=Shadows%20Beneath&author=Brandon%20Sanderson&duration=37479000'

describe('degraded fan-out is reported, not discarded', () => {
	test('searchAll fills the report with the provider that did not answer', async () => {
		const registry = new ProviderRegistry([downProvider('hardcover'), weakProvider('apple', NOISE)])
		const report: DegradedReport = { degraded: [] }
		const candidates = await registry.searchAll(
			{ title: 'Shadows Beneath', region: 'us' },
			undefined,
			undefined,
			report
		)
		expect(report.degraded).toEqual(['hardcover'])
		expect(candidates).toHaveLength(3)
	})

	test('the report is optional — a caller that omits it still gets the pool', async () => {
		// This is the shape every duck-typed registry stub in the suites uses.
		const registry = new ProviderRegistry([downProvider('hardcover'), weakProvider('apple', NOISE)])
		const pool = await registry.searchAll({ title: 'Shadows Beneath', region: 'us' })
		expect(Array.isArray(pool)).toBe(true)
		expect(pool).toHaveLength(3)
	})

	test('a healthy fan-out reports nothing degraded', async () => {
		const registry = new ProviderRegistry([exactProvider('hardcover')])
		const report: DegradedReport = { degraded: [] }
		await registry.searchAll(
			{ title: 'Shadows Beneath', region: 'us' },
			undefined,
			undefined,
			report
		)
		expect(report.degraded).toEqual([])
	})
})

describe('GET /books refuses to pass off an incomplete answer as a complete one', () => {
	test('503, not 200-with-noise, when a PRIMARY is down and nothing is a strong match', async () => {
		const registry = new ProviderRegistry([downProvider('hardcover'), weakProvider('apple', NOISE)])
		const f = await appWith(registry)
		const r = await f.inject({ method: 'GET', url: SEARCH })
		expect(r.statusCode).toBe(503)
		// Names the source, so an operator reading the bundle log knows why.
		expect(r.json().error).toContain('hardcover')
		// Retry-After is what makes this a "come back", not a verdict.
		expect(r.headers['retry-after']).toBe('60')
	})

	test('200 when a primary is down but a STRONG match survived anyway', async () => {
		// Hardcover is out, yet Audible answered with the exact book: the missing
		// provider could not have displaced it, so refusing would throw away a
		// good match over an irrelevant outage.
		const registry = new ProviderRegistry([
			downProvider('hardcover'),
			exactProvider('audible'),
			weakProvider('apple', NOISE)
		])
		const f = await appWith(registry)
		const r = await f.inject({ method: 'GET', url: SEARCH })
		expect(r.statusCode).toBe(200)
		expect(r.json().length).toBeGreaterThan(0)
	})

	test('200 when only a SUPPLEMENT is down, even with a weak pool', async () => {
		// Apple/OverDrive/OpenLibrary cannot outrank a corroborated primary, so
		// losing one narrows the pool without changing which book wins. Blocking
		// on that would make every Apple rate-limit an outage.
		const registry = new ProviderRegistry([
			downProvider('apple'),
			weakProvider('openlibrary', NOISE)
		])
		const f = await appWith(registry)
		const r = await f.inject({ method: 'GET', url: SEARCH })
		expect(r.statusCode).toBe(200)
	})

	test('200 on a genuinely empty answer from a HEALTHY fan-out', async () => {
		// The distinction the whole change exists for: "nobody has this book" is
		// an answer, and must not be turned into an outage.
		const registry = new ProviderRegistry([weakProvider('hardcover', [])])
		const f = await appWith(registry)
		const r = await f.inject({ method: 'GET', url: SEARCH })
		expect(r.statusCode).toBe(200)
		expect(r.json()).toEqual([])
	})
})

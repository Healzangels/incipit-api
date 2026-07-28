import { describe, expect, test } from 'bun:test'
import Fastify, { FastifyInstance } from 'fastify'

import deleteAuthor from '#config/routes/authors/delete'
import deleteChapter from '#config/routes/books/chapters/delete'
import deleteBook from '#config/routes/books/delete'

/**
 * WIRING, not predicates.
 *
 * The 2026-07-28 mutation sweep removed `{ preHandler: requireDeleteAuth }`
 * from all three DELETE routes independently and the suite stayed 1578
 * green: `writeAuth` was tested only as a standalone preHandler, so nothing
 * asserted the destructive routes actually USE it. That mutation ships
 * unauthenticated deletion of book, author and chapter records.
 *
 * These tests drive the registered routes with no credentials and require a
 * refusal, so the guard cannot be unhooked without a failure.
 */
describe('destructive routes must be gated', () => {
	const cases: Array<[string, (f: FastifyInstance) => Promise<void>, string]> = [
		['book', deleteBook as never, '/books/B0TESTASIN'],
		['author', deleteAuthor as never, '/authors/B0TESTASIN'],
		['chapter', deleteChapter as never, '/books/B0TESTASIN/chapters']
	]

	for (const [name, route, url] of cases) {
		test(`DELETE ${name} refuses an unauthenticated caller`, async () => {
			const prior = process.env.DELETE_AUTH_TOKEN
			const priorIps = process.env.DELETE_ALLOWED_IPS
			delete process.env.DELETE_AUTH_TOKEN
			delete process.env.DELETE_ALLOWED_IPS
			const app = Fastify()
			try {
				await app.register(route)
				const res = await app.inject({ method: 'DELETE', url })
				// Default-closed: 403 (or 401). Never 200/404-from-the-helper,
				// which would mean the handler ran.
				expect([401, 403]).toContain(res.statusCode)
			} finally {
				await app.close()
				if (prior !== undefined) process.env.DELETE_AUTH_TOKEN = prior
				if (priorIps !== undefined) process.env.DELETE_ALLOWED_IPS = priorIps
			}
		})
	}
})

/**
 * Route CONTRACTS the bundle depends on. Each was verified live against
 * 10.0.1.99:3737 during the 2026-07-28 review.
 */
describe('search route contract', () => {
	test('accepts the documented keywords alias', async () => {
		// `keywords` is a first-class alias BookSearchHelper already honors
		// (title ?? query ?? keywords), and types.ts records why it exists:
		// "Plex's Audible album search falls back to a bare keywords param
		// when it has no artist name". The guard accepted only title/query,
		// so the authorless / phantom-artist case — the exact one the alias
		// was added for — 400'd. Verified live: ?keywords=Mistborn -> 400
		// while ?query=Mistborn returned results.
		const { BookSearchQueryStringSchema } = await import('#config/types')
		const parsed = BookSearchQueryStringSchema.safeParse({ keywords: 'Mistborn' })
		expect(parsed.success).toBe(true)
		const { default: searchRequiresATitle } = await import(
			'#config/routes/books/search/requireQuery'
		)
		expect(searchRequiresATitle({ keywords: 'Mistborn' })).toBe(false)
		expect(searchRequiresATitle({ title: 'Mistborn' })).toBe(false)
		expect(searchRequiresATitle({ query: 'Mistborn' })).toBe(false)
		expect(searchRequiresATitle({})).toBe(true)
	})
})

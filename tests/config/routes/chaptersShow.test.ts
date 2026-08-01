import { afterEach, describe, expect, test } from 'bun:test'
import Fastify from 'fastify'

import chaptersShow from '#config/routes/books/chapters/show'

/**
 * Chapters are OPTIONAL, and a deployment without Audible credentials must say
 * "no chapters", not "the server broke".
 *
 * `ChapterHelper`'s constructor throws a bare Error when ADP_TOKEN/PRIVATE_KEY
 * are unset — which this deployment does deliberately, since chapter support
 * binds a real Audible account and is not needed for matching or metadata. The
 * throw escaped as a 500 that echoed the missing variable NAMES back to the
 * caller. Verified live 2026-07-31 against the deployed instance:
 *
 *   GET /books/<asin>/chapters
 *     -> 500 {"message":"Missing environment variable(s): ADP_TOKEN or PRIVATE_KEY"}
 *
 * So 100% of chapter requests failed, Plex reads a 500 as "the API is down"
 * rather than "this book has none", and the scheduler's chapter sweep burns a
 * full pass generating them.
 */
const ENV = ['ADP_TOKEN', 'PRIVATE_KEY'] as const
const saved: Record<string, string | undefined> = {}

afterEach(() => {
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k]
		else process.env[k] = saved[k]
	}
})

async function get(url: string) {
	const app = Fastify()
	try {
		await app.register(chaptersShow as never)
		const res = await app.inject({ method: 'GET', url })
		return { status: res.statusCode, body: res.body }
	} finally {
		await app.close()
	}
}

describe('GET /books/:asin/chapters without Audible credentials', () => {
	test('degrades to 404, not 500', async () => {
		for (const k of ENV) {
			saved[k] = process.env[k]
			delete process.env[k]
		}
		const { status } = await get('/books/B002V1CB2Q/chapters')
		expect(status).toBe(404)
	})

	test('answers with the no-chapters message', async () => {
		// Asserting the POSITIVE. An earlier version of this test asserted the
		// ABSENCE of 'ADP_TOKEN' from the body and passed even against the
		// broken 500 — a bare Fastify instance has no error handler, so the
		// message never reached the body in the harness regardless. Absence
		// assertions pass vacuously exactly when the harness differs from
		// production; assert what the response SHOULD say instead.
		for (const k of ENV) {
			saved[k] = process.env[k]
			delete process.env[k]
		}
		const { status, body } = await get('/books/B002V1CB2Q/chapters')
		expect(status).toBe(404)
		expect(body).toContain('B002V1CB2Q')
		expect(body.toLowerCase()).toContain('chapters')
	})

	test('HALF-configured is treated as unconfigured', async () => {
		// One variable set and not the other is the realistic misconfiguration,
		// and it is the dangerous shape: a predicate that accepts either would
		// pass here and then throw inside the constructor — straight back to the
		// 500 this fix exists to remove. Both are required to fetch chapters, so
		// both are required to claim chapters are configured.
		for (const k of ENV) saved[k] = process.env[k]
		process.env.ADP_TOKEN = 'present'
		delete process.env.PRIVATE_KEY
		expect((await get('/books/B002V1CB2Q/chapters')).status).toBe(404)

		process.env.PRIVATE_KEY = 'present'
		delete process.env.ADP_TOKEN
		expect((await get('/books/B002V1CB2Q/chapters')).status).toBe(404)
	})

	test('a malformed asin is still a 400, not swallowed into the 404', async () => {
		// The degradation must not blunt input validation.
		for (const k of ENV) {
			saved[k] = process.env[k]
			delete process.env[k]
		}
		const { status } = await get('/books/not-an-asin/chapters')
		expect(status).toBe(400)
	})
})

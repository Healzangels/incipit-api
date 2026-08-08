import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import Fastify from 'fastify'

import { parsedChapters } from '#tests/datasets/helpers/chapters'

/**
 * Chapters are OPTIONAL, and a deployment without Audible credentials must say
 * "no chapters" — but only about chapters it genuinely cannot produce.
 *
 * `ChapterHelper`'s constructor is the thing that needs ADP_TOKEN/PRIVATE_KEY,
 * and it used to throw a bare Error. That escaped as a 500 echoing the missing
 * variable NAMES. Verified live 2026-07-31 against the deployed instance:
 *
 *   GET /books/<asin>/chapters
 *     -> 500 {"message":"Missing environment variable(s): ADP_TOKEN or PRIVATE_KEY"}
 *
 * The first fix put an unconditional `if (!chaptersConfigured()) 404` in the
 * ROUTE — one layer too high. The route's handler serves stored chapters from
 * Redis (step 1) and Mongo (step 2) and never constructs ChapterHelper on those
 * paths, so the pre-gate 404'd chapters that ARE stored and were previously
 * served 200. Both halves of that are pinned below, which is why these tests
 * stub the STORAGE layer and let the real route + GenericShowHelper +
 * ChapterHelper run.
 */
const ENV = ['ADP_TOKEN', 'PRIVATE_KEY'] as const
const saved: Record<string, string | undefined> = {}

/** What the Redis layer holds for this request, if anything. */
let redisData: unknown = null
/** What the Mongo layer holds for this request, if anything. */
let paprData: unknown = null

/**
 * The Chaptarr fallback is stubbed at its TRANSPORT, not at its module.
 *
 * bun's module registry is process-wide and every test file is evaluated
 * before any test runs, so a `mock.module('…/chaptarrChapters')` here
 * replaced the function inside chaptarrChapters' OWN unit tests — proven:
 * running that file after this one turned 5 green into 2 red, and an
 * afterAll restore is too late to help. The full gate hid it only because
 * tests/config runs last, which is exactly how an order-dependent test
 * survives review.
 *
 * Overriding just `fetchChaptarrWork` (real module spread around it) leaves
 * every other consumer honest, and has the bonus of running the REAL mapper
 * through the route: what this file pins is the wiring plus the mapping.
 */
const realChaptarrProvider = await import('#helpers/providers/ChaptarrProvider')
/** The work the aggregator "holds" for this request; null = it has nothing. */
let chaptarrWork: unknown = null
mock.module('#helpers/providers/ChaptarrProvider', () => ({
	...realChaptarrProvider,
	fetchChaptarrWork: async () => chaptarrWork
}))

/** A work whose audiobook edition carries chapters for the asin under test. */
const workWithChapters = (asin: string) => ({
	work: { title: 'A Test Book' },
	authors: [{ name: 'A Test Author' }],
	editions: [
		{
			asin,
			formatType: 'audiobook',
			durationSeconds: 3600,
			chapters: [
				{ title: 'Opening Credits', startOffsetMs: 0, startOffsetSec: 0, lengthMs: 13432 },
				{ title: '1: Initiation', startOffsetMs: 13432, startOffsetSec: 13, lengthMs: 600000 }
			]
		}
	]
})

mock.module('#helpers/database/redis/RedisHelper', () => ({
	default: class {
		async findOne() {
			return redisData
		}
		async setOne() {
			return undefined
		}
	}
}))

/** What setData handed the storage layer this request — the real layer
 * persists it and hands it back, and the fallback-200 pin needs that
 * round-trip to be faithful. */
let paprStored: unknown = null
mock.module('#helpers/database/papr/audible/PaprAudibleChapterHelper', () => ({
	default: class {
		async findOne() {
			return { data: paprData, modified: false }
		}
		async findOneWithProjection() {
			return { data: paprStored ?? paprData, modified: false }
		}
		setData(data: unknown) {
			paprStored = data
		}
		async createOrUpdate() {
			return { data: paprStored ?? paprData, modified: true }
		}
	}
}))

const { default: chaptersShow } = await import('#config/routes/books/chapters/show')

function unconfigure() {
	for (const k of ENV) {
		saved[k] = process.env[k]
		delete process.env[k]
	}
}

beforeEach(() => {
	paprStored = null
	redisData = null
	paprData = null
	for (const k of ENV) saved[k] = process.env[k]
})

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
	beforeEach(() => {
		chaptarrWork = null
	})

	test('no credentials but CHAPTARR answers: served 200 — the fallback is the feature', async () => {
		// The shared-instance shape chapters were simply OFF for: no ADP creds,
		// nothing stored, but the aggregation server has the chapter list. The
		// real mapper runs here, so this pins the wiring AND the mapping.
		unconfigure()
		chaptarrWork = workWithChapters('B079LRSMNN')
		const { status, body } = await get('/books/B079LRSMNN/chapters')
		expect(status).toBe(200)
		const served = JSON.parse(body)
		expect(served.asin).toBe('B079LRSMNN')
		expect(served.chapters.length).toBe(2)
		expect(served.chapters[0].title).toBe('Opening Credits')
		// Never claimed as Audible-blessed.
		expect(served.isAccurate).toBe(false)
	})

	test('STORED chapters are still served 200 — the credentials are only needed to FETCH', async () => {
		// The regression the route-level pre-gate caused: these rows exist, the
		// deployment has been serving them for months, and no Audible call is
		// needed to answer. 404ing them is data loss to every Plex client.
		unconfigure()
		redisData = parsedChapters
		const { status, body } = await get('/books/B079LRSMNN/chapters')
		expect(status).toBe(200)
		expect(JSON.parse(body).asin).toBe('B079LRSMNN')
		expect(JSON.parse(body).chapters.length).toBe(parsedChapters.chapters.length)
	})

	test('stored in MONGO but not Redis is served 200 too', async () => {
		// Step 2 of the same handler, and just as credential-free.
		unconfigure()
		paprData = parsedChapters
		const { status, body } = await get('/books/B079LRSMNN/chapters')
		expect(status).toBe(200)
		expect(JSON.parse(body).asin).toBe('B079LRSMNN')
	})

	test('nothing stored degrades to 404, not 500', async () => {
		// The genuine no-data case: answering needs a live Audible fetch, and this
		// deployment cannot make one. ChapterHelper's constructor throws a
		// NotFoundError, so it lands as a 404 rather than the old 500.
		unconfigure()
		const { status } = await get('/books/B002V1CB2Q/chapters')
		expect(status).toBe(404)
	})

	test('the 404 answers in the BOOK’s terms, not the environment’s', async () => {
		// Asserting the POSITIVE. An earlier version of this test asserted the
		// ABSENCE of 'ADP_TOKEN' from the body and passed even against the broken
		// 500 — absence assertions pass vacuously exactly when the harness differs
		// from production. Assert what the response SHOULD say instead; the
		// operator-facing reason belongs in the log and in the startup warning,
		// not in an unauthenticated response body.
		unconfigure()
		const { status, body } = await get('/books/B002V1CB2Q/chapters')
		expect(status).toBe(404)
		expect(body).toContain('B002V1CB2Q')
		expect(body.toLowerCase()).toContain('chapters')
		expect(body).not.toContain('ADP_TOKEN')
	})

	test('HALF-configured is treated as unconfigured', async () => {
		// One variable set and not the other is the realistic misconfiguration,
		// and it is the dangerous shape: a predicate that accepts either would
		// pass here and then throw somewhere deeper — straight back to the 500
		// this fix exists to remove. Both are required to fetch chapters, so both
		// are required to claim chapters are configured.
		process.env.ADP_TOKEN = 'present'
		delete process.env.PRIVATE_KEY
		expect((await get('/books/B002V1CB2Q/chapters')).status).toBe(404)

		process.env.PRIVATE_KEY = 'present'
		delete process.env.ADP_TOKEN
		expect((await get('/books/B002V1CB2Q/chapters')).status).toBe(404)
	})

	test('a malformed asin is still a 400, not swallowed into the 404', async () => {
		// The degradation must not blunt input validation.
		unconfigure()
		const { status } = await get('/books/not-an-asin/chapters')
		expect(status).toBe(400)
	})
})

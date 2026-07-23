import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import version, { VersionResponse } from '#config/routes/version'

describe('version route should', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let app: any
	let mockReply: { status: ReturnType<typeof mock>; send: ReturnType<typeof mock> }
	let originalSha: string | undefined
	let originalBuildTime: string | undefined

	/** Register the route and invoke the handler Fastify would have called. */
	const callRoute = async (): Promise<VersionResponse> => {
		await version(app)
		const [path, handler] = app.get.mock.calls[0]
		expect(path).toBe('/version')
		await handler({}, mockReply)
		return mockReply.send.mock.calls[0][0] as VersionResponse
	}

	beforeEach(() => {
		originalSha = process.env.GIT_SHA
		originalBuildTime = process.env.BUILD_TIME
		app = { get: mock() }
		const reply = {
			status: mock(() => reply),
			send: mock(() => reply)
		}
		mockReply = reply
	})

	afterEach(() => {
		mock.clearAllMocks()
		if (originalSha === undefined) delete process.env.GIT_SHA
		else process.env.GIT_SHA = originalSha
		if (originalBuildTime === undefined) delete process.env.BUILD_TIME
		else process.env.BUILD_TIME = originalBuildTime
	})

	test('report the commit baked in at image build time', async () => {
		process.env.GIT_SHA = 'd9a67c0abcdef0123456789abcdef0123456789a'
		process.env.BUILD_TIME = '2026-07-23T04:39:54Z'

		const body = await callRoute()

		expect(mockReply.status).toHaveBeenCalledWith(200)
		expect(body.commit).toBe('d9a67c0abcdef0123456789abcdef0123456789a')
		// Short form is what gets eyeballed against `git log --oneline`.
		expect(body.commitShort).toBe('d9a67c0')
		expect(body.builtAt).toBe('2026-07-23T04:39:54Z')
	})

	test('report "unknown" rather than inventing a build identity', async () => {
		// A local `bun run serve` has no image build behind it. Reporting a
		// plausible-looking value here would defeat the point of the route.
		delete process.env.GIT_SHA
		delete process.env.BUILD_TIME

		const body = await callRoute()

		expect(body.commit).toBe('unknown')
		expect(body.commitShort).toBe('unknown')
		expect(body.builtAt).toBe('unknown')
	})

	test('distinguish a restart from a redeploy', async () => {
		process.env.GIT_SHA = 'abc1234def'
		const body = await callRoute()

		// startedAt moves on a restart while builtAt/commit stay put, so the two
		// together tell "same image, bounced" apart from "new image deployed".
		expect(() => new Date(body.startedAt).toISOString()).not.toThrow()
		expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
		expect(Number.isInteger(body.uptimeSeconds)).toBe(true)
	})
})

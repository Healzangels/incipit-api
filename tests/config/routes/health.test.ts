import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { MongoClient } from 'mongodb'

import health, { HealthCheckResponse } from '#config/routes/health'

const mockMongoConnect = mock()
const mockMongoDb = mock()
const mockMongoCommand = mock()
const mockMongoClose = mock()

mock.module('mongodb', () => ({
	MongoClient: class MockMongoClient {
		connect = mockMongoConnect
		db = mockMongoDb
		close = mockMongoClose
	}
}))

describe('health route should', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let app: any
	let mockMongoClient: MongoClient
	let originalMongoUri: string | undefined

	const createMockRequest = () => ({
		log: {
			error: mock(),
			info: mock(),
			debug: mock(),
			warn: mock()
		}
	})

	beforeEach(() => {
		originalMongoUri = process.env.MONGODB_URI

		app = {
			get: mock(),
			mongoClient: null,
			redis: null,
			reply: null
		}

		mockMongoConnect.mockResolvedValue(undefined)
		mockMongoCommand.mockResolvedValue({ ok: 1 })
		mockMongoDb.mockReturnValue({ command: mockMongoCommand })
		mockMongoClose.mockResolvedValue(undefined)

		mockMongoClient = {
			connect: mockMongoConnect,
			db: mockMongoDb,
			close: mockMongoClose
		} as unknown as MongoClient

		app.mongoClient = mockMongoClient

		const mockReply = {
			status: mock(() => mockReply),
			send: mock(() => mockReply)
		}
		app.reply = mockReply
	})

	afterEach(() => {
		mock.clearAllMocks()
		if (originalMongoUri === undefined) {
			delete process.env.MONGODB_URI
		} else {
			process.env.MONGODB_URI = originalMongoUri
		}
	})

	// Helper function to create mock reply with optional assertions
	const createMockReply = (assertions?: (data: HealthCheckResponse) => void) => {
		const reply = {
			status: mock(() => reply),
			send: mock().mockImplementation((data: HealthCheckResponse) => {
				if (assertions) assertions(data)
				return reply
			})
		}
		return reply
	}

	// Helper to extract route handler
	const getRouteHandler = () => {
		return app.get.mock.calls[0][1]
	}

	describe('runtime disclosure', () => {
		// Two backends behind DB_BACKEND and two cache modes behind REDIS_URL,
		// and `database: true` reads identically whether it pinged Mongo or ran
		// SELECT 1 against SQLite. Without this, identifying what a container
		// actually runs means shelling into the host.
		const saved = { db: process.env.DB_BACKEND, redis: process.env.REDIS_URL }
		afterEach(() => {
			if (saved.db === undefined) delete process.env.DB_BACKEND
			else process.env.DB_BACKEND = saved.db
			if (saved.redis === undefined) delete process.env.REDIS_URL
			else process.env.REDIS_URL = saved.redis
		})

		const runtimeOf = async () => {
			mockMongoCommand.mockResolvedValue({ ok: 1 })
			app.mongoClient = mockMongoClient
			app.redis = { ping: mock().mockResolvedValue('PONG') }
			await health(app)
			// The handler answers through reply.send(), so capture it there —
			// the same way every other test in this file reads the body.
			let seen: HealthCheckResponse | undefined
			const reply = createMockReply((data) => {
				seen = data
			})
			await getRouteHandler()(createMockRequest(), reply)
			return seen?.runtime
		}

		test('reports sqlite + memory when that is what is configured', async () => {
			process.env.DB_BACKEND = 'sqlite'
			delete process.env.REDIS_URL
			expect(await runtimeOf()).toEqual({ backend: 'sqlite', cache: 'memory' })
		})

		test('reports mongo + redis when that is what is configured', async () => {
			delete process.env.DB_BACKEND
			process.env.REDIS_URL = 'redis://localhost:6379'
			expect(await runtimeOf()).toEqual({ backend: 'mongo', cache: 'redis' })
		})

		test('an unrecognised DB_BACKEND reads as mongo, matching the wiring', async () => {
			// server.ts gates on `=== 'sqlite'`, so anything else IS mongo.
			// Echoing the raw value would claim a backend nothing is running.
			process.env.DB_BACKEND = 'postgres'
			expect((await runtimeOf()).backend).toBe('mongo')
		})
	})

	test('return 200 and healthy status when all services are up', async () => {

		mockMongoCommand.mockResolvedValue({ ok: 1 })

		app.redis = {
			ping: mock().mockResolvedValue('PONG')
		}

		await health(app)

		const routeHandler = getRouteHandler()


		const mockRequest = createMockRequest()
		const mockReply = createMockReply((data) => {
			expect(data.status).toBe('healthy')
			expect(data.checks.server).toBe(true)
			expect(data.checks.database).toBe(true)
			expect(data.checks.redis).toBe(true)
			expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
		})

		await routeHandler(mockRequest, mockReply)

		expect(mockReply.status).toHaveBeenCalledWith(200)
	})

	test('return 503 and unhealthy status when MongoDB is down', async () => {

		mockMongoCommand.mockRejectedValue(new Error('MongoDB connection failed'))

		app.redis = {
			ping: mock().mockResolvedValue('PONG')
		}

		await health(app)
		const routeHandler = getRouteHandler()



		const mockRequest = createMockRequest()
		const mockReply = createMockReply((data) => {
			expect(data.status).toBe('unhealthy')
			expect(data.checks.server).toBe(true)
			expect(data.checks.database).toBe(false)
			expect(data.checks.redis).toBe(true)
			expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
		})

		await routeHandler(mockRequest, mockReply)

		expect(mockReply.status).toHaveBeenCalledWith(503)
	})

	test('return 503 and unhealthy status when Redis is down', async () => {

		mockMongoCommand.mockResolvedValue({ ok: 1 })

		app.redis = {
			ping: mock().mockRejectedValue(new Error('Redis connection failed'))
		}

		await health(app)

		const routeHandler = getRouteHandler()


		const mockRequest = createMockRequest()
		const mockReply = createMockReply((data) => {
			expect(data.status).toBe('unhealthy')
			expect(data.checks.server).toBe(true)
			expect(data.checks.database).toBe(true)
			expect(data.checks.redis).toBe(false)
			expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
		})

		await routeHandler(mockRequest, mockReply)

		expect(mockReply.status).toHaveBeenCalledWith(503)
	})

	test('return 503 and unhealthy status when both MongoDB and Redis are down', async () => {

		mockMongoCommand.mockRejectedValue(new Error('MongoDB connection failed'))

		app.redis = {
			ping: mock().mockRejectedValue(new Error('Redis connection failed'))
		}

		await health(app)
		const routeHandler = getRouteHandler()


		const mockRequest = createMockRequest()
		const mockReply = createMockReply((data) => {
			expect(data.status).toBe('unhealthy')
			expect(data.checks.server).toBe(true)
			expect(data.checks.database).toBe(false)
			expect(data.checks.redis).toBe(false)
			expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
		})

		await routeHandler(mockRequest, mockReply)

		expect(mockReply.status).toHaveBeenCalledWith(503)
	})

	test('return 200 and redis as null when Redis is not registered', async () => {

		mockMongoCommand.mockResolvedValue({ ok: 1 })

		app.redis = undefined
		await health(app)
		const routeHandler = getRouteHandler()



		const mockRequest = createMockRequest()
		const mockReply = createMockReply((data) => {
			expect(data.status).toBe('healthy')
			expect(data.checks.server).toBe(true)
			expect(data.checks.database).toBe(true)
			expect(data.checks.redis).toBeNull()
			expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
		})

		await routeHandler(mockRequest, mockReply)

		expect(mockReply.status).toHaveBeenCalledWith(200)
	})

	test('verify response structure has all required fields', async () => {

		mockMongoCommand.mockResolvedValue({ ok: 1 })
		app.redis = {
			ping: mock().mockResolvedValue('PONG')
		}

		await health(app)
		const routeHandler = getRouteHandler()

		const mockRequest = createMockRequest()
		let capturedData: HealthCheckResponse | null = null
		const mockReply = createMockReply((data) => {
			capturedData = data
		})

		await routeHandler(mockRequest, mockReply)

		expect(capturedData).toHaveProperty('status')
		expect(capturedData).toHaveProperty('timestamp')
		expect(capturedData).toHaveProperty('checks')
		expect(capturedData!.checks).toHaveProperty('server')
		expect(capturedData!.checks).toHaveProperty('database')
		expect(capturedData!.checks).toHaveProperty('redis')

		expect(typeof capturedData!.status).toBe('string')
		expect(typeof capturedData!.timestamp).toBe('string')
		expect(typeof capturedData!.checks.server).toBe('boolean')
		expect(typeof capturedData!.checks.database).toBe('boolean')
		expect(
			capturedData!.checks.redis === null || typeof capturedData!.checks.redis === 'boolean'
		).toBe(true)
	})

	test('verify timestamp is valid ISO format', async () => {

		mockMongoCommand.mockResolvedValue({ ok: 1 })
		app.redis = {
			ping: mock().mockResolvedValue('PONG')
		}

		await health(app)
		const routeHandler = getRouteHandler()

		const mockRequest = createMockRequest()
		let capturedData: HealthCheckResponse | null = null
		const mockReply = createMockReply((data) => {
			capturedData = data
		})

		await routeHandler(mockRequest, mockReply)

		const timestamp = new Date(capturedData!.timestamp)
		expect(timestamp).toBeInstanceOf(Date)
		expect(isNaN(timestamp.getTime())).toBe(false)
		expect(capturedData!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
	})
})

afterAll(() => {
	mock.restore()
})

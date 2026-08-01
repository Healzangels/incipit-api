mock.module('mongodb', () => {
	return {
		MongoClient: mock().mockImplementation(() => ({
			connect: mock().mockResolvedValue(undefined),
			// collection() must return an object with createIndex — initialize()
			// ensures the authors text index on boot.
			db: mock().mockReturnValue({
				collection: mock().mockReturnValue({
					createIndex: mock().mockResolvedValue('name_text_aliases_text')
				})
			}),
			close: mock().mockResolvedValue(undefined)
		}))
	}
})
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Db } from 'mongodb'

import { Context, createDefaultContext } from '#config/context'
import { initialize } from '#config/papr'
import { createMockContext, MockContext } from '#config/test-context'

let mockCtx: MockContext
let ctx: Context

beforeEach(() => {
	mockCtx = createMockContext()
	ctx = mockCtx as unknown as Context
	const mockDbInstance = {
		collection: mock().mockReturnValue({
			createIndex: mock().mockResolvedValue('name_text_aliases_text')
		})
	} as unknown as Db
	spyOn(ctx.client, 'db').mockReturnValue(mockDbInstance)
	spyOn(ctx.client, 'connect').mockResolvedValue(ctx.client)
})

describe('Papr should', () => {
	test('initialize with mock', async () => {
		await expect(initialize(ctx)).resolves.toBeUndefined()
		expect(ctx.client.db).toHaveBeenCalledWith('audnexus')
	})
	test('report a failed index build through the logger it is GIVEN', async () => {
		// The path production actually takes. `ensureIndexes` swallows a build
		// failure by design (a slow API beats a dead one), so the log line is the
		// ONLY evidence it happened — and the sole production call site used to
		// pass no logger, making `logger?.warn` a no-op. server.ts now hands over
		// `server.log`; this asserts initialize forwards it.
		const warnings: string[] = []
		const failingDb = {
			collection: mock().mockReturnValue({
				createIndex: mock().mockRejectedValue(new Error('E11000 duplicate key'))
			})
		} as unknown as Db
		spyOn(ctx.client, 'db').mockReturnValue(failingDb)

		await expect(
			initialize(ctx, { warn: (m: string) => void warnings.push(m) })
		).resolves.toBeUndefined()

		expect(warnings.length).toBeGreaterThan(0)
		expect(warnings.join('\n')).toContain('E11000 duplicate key')
	})
	test('initialize with mock client via createDefaultContext', async () => {
		ctx = createDefaultContext('mongodb://localhost:27017')
		// Verify initialize works when called via createDefaultContext (mongodb module is mocked)
		await expect(initialize(ctx)).resolves.toBeUndefined()
		expect(ctx.client.db).toHaveBeenCalledWith('audnexus')
	})
})

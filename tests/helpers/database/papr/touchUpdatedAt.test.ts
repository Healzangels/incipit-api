import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import touchUpdatedAt from '#helpers/database/papr/touchUpdatedAt'

/**
 * THE UNCHANGED-RECORD THROTTLE, and the mirror-drift that left two thirds of
 * it unwritten.
 *
 * `GenericShowHelper.updateActions` consults `isRecentlyUpdated` BEFORE it
 * fetches, so a record whose `updatedAt` never advances is stale on every pass
 * forever. `createOrUpdate` only advances it via `update()`, i.e. only for
 * records that CHANGED — so every STABLE record, the large majority, was
 * re-scraped on every UpdateScheduler sweep for the life of the deployment.
 *
 * The author helper grew the fix after it was traced on an image-less author.
 * Books and chapters — same shape, same scheduler, far larger corpus — never
 * received it. That is the drift this file exists to stop recurring.
 */
describe('touchUpdatedAt', () => {
	const FILTER = { asin: 'B01ABCDEFG' }

	test('advances updatedAt and NOTHING else', async () => {
		const calls: Array<{ filter: object; update: object }> = []
		const model = {
			updateOne: async (filter: object, update: object) => {
				calls.push({ filter, update })
				return undefined
			}
		}

		await touchUpdatedAt(model, FILTER)

		expect(calls).toHaveLength(1)
		expect(calls[0].filter).toEqual(FILTER)
		// A timestamp bump, not a write: $currentDate alone, no $set of any kind.
		expect(calls[0].update).toEqual({ $currentDate: { updatedAt: true } })
		expect(Object.keys(calls[0].update as object)).toEqual(['$currentDate'])
	})

	test('a write failure is swallowed and logged, never thrown', async () => {
		// It runs inside a request that has already succeeded — the caller is
		// about to return the unchanged record. Failing here must degrade to the
		// pre-existing every-cycle behaviour, not fail the response.
		const logged: string[] = []
		const model = {
			updateOne: async () => {
				throw new Error('mongo is down')
			}
		}
		const logger = { error: (m: string) => logged.push(m) }

		await expect(touchUpdatedAt(model, FILTER, logger as never)).resolves.toBeUndefined()
		expect(logged.join(' ')).toContain('mongo is down')
	})

	test('it survives having no logger at all', async () => {
		const model = {
			updateOne: async () => {
				throw new Error('mongo is down')
			}
		}
		// The optional-chain on the logger is load-bearing: the helpers construct
		// without one in several call paths.
		await expect(touchUpdatedAt(model, FILTER)).resolves.toBeUndefined()
	})

	test('ALL THREE helpers call it — the mirror-drift guard', () => {
		// The whole finding was that one of three had it. A unit test of this
		// function passes whether or not anyone calls it, which is exactly how
		// the drift survived; pin the wiring at source instead.
		const dir = join(
			import.meta.dir,
			'..',
			'..',
			'..',
			'..',
			'src',
			'helpers',
			'database',
			'papr',
			'audible'
		)
		for (const type of ['Author', 'Book', 'Chapter']) {
			const src = readFileSync(join(dir, `PaprAudible${type}Helper.ts`), 'utf8')
			expect(src).toContain("import touchUpdatedAt from '#helpers/database/papr/touchUpdatedAt'")
			// Called on the isEqual path specifically, not merely imported.
			expect(src).toContain('await this.touchUpdatedAt()')
			expect(src).toContain(`await touchUpdatedAt(\n\t\t\t${type}Model,`)
		}
	})

	test('no helper keeps a private copy of the $currentDate-only write', () => {
		// A second implementation is how the first one drifts. The discriminator
		// is the BARE update object: `update()` legitimately names $currentDate,
		// but always inside a multi-line object alongside $set, so the inline
		// `{ $currentDate: { updatedAt: true } }` spelling only ever appears in a
		// standalone touch — which now belongs in the shared module.
		const dir = join(
			import.meta.dir,
			'..',
			'..',
			'..',
			'..',
			'src',
			'helpers',
			'database',
			'papr',
			'audible'
		)
		for (const type of ['Author', 'Book', 'Chapter']) {
			const src = readFileSync(join(dir, `PaprAudible${type}Helper.ts`), 'utf8')
			expect(src).not.toContain('{ $currentDate: { updatedAt: true } }')
			// ...while the legitimate paired write is still there, so this test
			// cannot be satisfied by deleting update()'s timestamp handling.
			expect(src).toContain('$set: { ...this.')
			expect(src).toContain('$currentDate: { updatedAt: true }')
		}
	})
})

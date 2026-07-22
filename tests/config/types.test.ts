import { describe, expect, it } from 'bun:test'

import { BookSearchQueryStringSchema } from '#config/types'

describe('BookSearchQueryStringSchema', () => {
	describe('manual query param', () => {
		// Query params arrive as strings; Boolean('0') and Boolean('false') are
		// both true, so a plain z.coerce.boolean() misclassifies explicit-false
		// clients as manual/typed searches in telemetry.
		it('parses manual=0 as false', () => {
			const parsed = BookSearchQueryStringSchema.parse({ title: 'Dune', manual: '0' })
			expect(parsed.manual).toBe(false)
		})

		it('parses manual=false as false', () => {
			const parsed = BookSearchQueryStringSchema.parse({ title: 'Dune', manual: 'false' })
			expect(parsed.manual).toBe(false)
		})

		it('parses manual=1 as true', () => {
			const parsed = BookSearchQueryStringSchema.parse({ title: 'Dune', manual: '1' })
			expect(parsed.manual).toBe(true)
		})

		it('parses manual=true as true', () => {
			const parsed = BookSearchQueryStringSchema.parse({ title: 'Dune', manual: 'true' })
			expect(parsed.manual).toBe(true)
		})

		it('is case-insensitive', () => {
			const parsedTrue = BookSearchQueryStringSchema.parse({ title: 'Dune', manual: 'True' })
			expect(parsedTrue.manual).toBe(true)
			const parsedFalse = BookSearchQueryStringSchema.parse({ title: 'Dune', manual: 'FALSE' })
			expect(parsedFalse.manual).toBe(false)
		})

		it('defaults to undefined when absent', () => {
			const parsed = BookSearchQueryStringSchema.parse({ title: 'Dune' })
			expect(parsed.manual).toBeUndefined()
		})

		it('degrades unrecognized values to undefined instead of failing', () => {
			const parsed = BookSearchQueryStringSchema.parse({ title: 'Dune', manual: 'yes' })
			expect(parsed.manual).toBeUndefined()
		})
	})
})

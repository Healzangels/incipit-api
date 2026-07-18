import { describe, expect, test } from 'bun:test'

import { isSameAuthor } from '#helpers/routes/AuthorShowHelper'

// Similarity values verified against Python difflib (the reference the Ratcliff
// port mirrors). A Mongo $text hit sharing only a first name (or only a
// surname) must be rejected so the Audible fallback can find the real author.
describe('isSameAuthor', () => {
	test('rejects a shared-first-name collision (the Andrew Karevik/Rowe bug)', () => {
		expect(isSameAuthor('Andrew Karevik', 'Andrew Rowe')).toBe(false)
		expect(isSameAuthor('Adrian Tchaikovsky', 'Adrian McKinty')).toBe(false)
	})

	test('rejects a shared-surname collision', () => {
		expect(isSameAuthor('John Smith', 'Jane Smith')).toBe(false)
	})

	test('accepts an identical name and a legit middle-initial variant', () => {
		expect(isSameAuthor('Andrew Karevik', 'Andrew Karevik')).toBe(true)
		expect(isSameAuthor('George Martin', 'George R.R. Martin')).toBe(true)
		expect(isSameAuthor('pirateaba', 'pirateaba')).toBe(true)
	})

	test('rejects an initialled form (recovered by the Audible fallback)', () => {
		expect(isSameAuthor('A. Karevik', 'Andrew Karevik')).toBe(false)
	})
})

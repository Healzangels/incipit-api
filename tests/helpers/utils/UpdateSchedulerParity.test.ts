import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE THREE SWEEPS MUST STAY IN SYNC.
 *
 * updateAuthors / updateBooks / updateChapters are the same 35 lines three
 * times, differing only by the entity word — and processAuthor / processBook /
 * processChapter likewise. Measured: after renaming the entity word, the author
 * and book sweeps are byte-identical, and the chapter sweep differs by exactly
 * one 7-line precondition (`chaptersConfigured`).
 *
 * Nothing is broken today, so this file deliberately does NOT collapse them —
 * it pins them. The failure mode this class of duplication actually produces
 * here is a change landing in one copy and silently missing the other two, and
 * that is what a parity check catches. Two live bugs fixed the same day this
 * was written were exactly that shape: `touchUpdatedAt` written for authors and
 * never for books or chapters, and the series fold written three times with the
 * apostrophe class drifted between copies. In both, a unit test of the shared
 * behaviour passed while two of three call sites lacked it.
 *
 * If someone DOES collapse them into one helper, this file should be deleted in
 * the same change — the parity it checks becomes structural.
 */

const SRC = readFileSync(
	join(import.meta.dir, '..', '..', '..', 'src', 'helpers', 'utils', 'UpdateScheduler.ts'),
	'utf8'
)

/** The body of a method, from its signature to the closing brace at that indent. */
function methodBody(name: string): string {
	const start = SRC.indexOf(`\tprivate async ${name}(`) >= 0
		? SRC.indexOf(`\tprivate async ${name}(`)
		: SRC.indexOf(`\tasync ${name}(`)
	expect(start).toBeGreaterThan(-1)
	const end = SRC.indexOf('\n\t}\n', start)
	expect(end).toBeGreaterThan(start)
	return SRC.slice(start, end)
}

/**
 * Strip everything that is legitimately per-entity: the entity word in every
 * casing, and comments. What survives is the control flow, which must match.
 */
function skeleton(body: string, singular: string, plural: string): string {
	return body
		.replace(/\/\/[^\n]*/g, '')
		.replace(new RegExp(plural, 'gi'), 'ENTITIES')
		.replace(new RegExp(singular, 'gi'), 'ENTITY')
		.replace(/\s+/g, ' ')
		.trim()
}

describe('UpdateScheduler sweep parity', () => {
	test('the AUTHOR and BOOK sweeps are identical control flow', () => {
		const authors = skeleton(methodBody('updateAuthors'), 'author', 'authors')
		const books = skeleton(methodBody('updateBooks'), 'book', 'books')
		expect(authors).toBe(books)
	})

	test('the CHAPTER sweep differs ONLY by its credentials precondition', () => {
		// Chapters are optional, so that sweep alone declines up front. Every
		// other line must still match, or a change reached two sweeps of three.
		const authors = skeleton(methodBody('updateAuthors'), 'author', 'authors')
		const chapters = skeleton(methodBody('updateChapters'), 'chapter', 'chapters')
		const precondition =
			"if (!ENTITIESConfigured()) { this.logger.info('Skipping scheduled ENTITY update: ADP_TOKEN/PRIVATE_KEY unset') return } "
		expect(chapters).toContain(precondition)
		expect(chapters.replace(precondition, '')).toBe(authors)
	})

	test('the three per-record processors are identical control flow', () => {
		const author = skeleton(methodBody('processAuthor'), 'author', 'authors')
		const book = skeleton(methodBody('processBook'), 'book', 'books')
		const chapter = skeleton(methodBody('processChapter'), 'chapter', 'chapters')
		expect(author).toBe(book)
		expect(author).toBe(chapter)
	})

	test('the three list fetchers are identical control flow', () => {
		const fetcher = (name: string, singular: string, plural: string) => {
			const start = SRC.indexOf(`\t${name} = async () => {`)
			expect(start).toBeGreaterThan(-1)
			return skeleton(SRC.slice(start, SRC.indexOf('\n\t}\n', start)), singular, plural)
		}
		const authors = fetcher('getAllAuthorAsins', 'author', 'authors')
		expect(fetcher('getAllBookAsins', 'book', 'books')).toBe(authors)
		expect(fetcher('getAllChapterAsins', 'chapter', 'chapters')).toBe(authors)
	})

	test('all three sweeps are still reachable from the scheduled job', () => {
		// A parity check would happily pass on three methods nobody calls.
		for (const name of ['updateAuthors', 'updateBooks', 'updateChapters']) {
			expect(SRC).toContain(`this.${name}()`)
		}
	})
})

/**
 * SYNTHETIC overlay fixtures. The real overlay data is operator prose and stays
 * out of the public repository, so every test builds its file from these: the
 * books, people and prizes below do not exist.
 */

type Json = Record<string, unknown>

export const AWARD_WORK = {
	award: 'Lantern Prize',
	year: 2020,
	category: 'Best Novel',
	result: 'winner',
	scope: 'work',
	sources: ['https://example.invalid/lantern-prize-2020']
}

export const AWARD_RECORDING = {
	award: 'Voice Medal',
	year: 2021,
	category: 'Best Narration',
	result: 'finalist',
	scope: 'this-recording',
	sources: ['https://example.invalid/voice-medal-2021']
}

/** A work: plain operator text, four approved genres. */
export const work = (over: Json = {}): Json => ({
	hook: 'A synthetic hook about a lantern road. It is two sentences long.',
	genres: ['Fantasy', 'Epic Fantasy', 'High Fantasy', 'Adventure'],
	...over
})

/** An APPROVED edition of `workKey`. */
export const edition = (
	workKey: string,
	keys: { title: string; author: string; narrator: string },
	over: Json = {}
): Json => ({
	work: workKey,
	keys,
	status: 'approved',
	approved_on: '2026-10-16',
	...over
})

/**
 * The base file every loader and lookup test starts from:
 * - lantern-road: ONE narration (B0SYNTH001), so its plain title key is granted;
 * - tide-clock: TWO narrations, one carrying a "(Narrated by …)" qualifier in its
 *   title — the Harry Potter 5 shape — so the plain key must be refused;
 * - glass-orchard: served under a provider id;
 * - a draft and a held edition.
 */
export const baseFile = (): Json => ({
	schema: 1,
	works: {
		'lantern-road': work({ series_total: 3, awards: [AWARD_WORK] }),
		'tide-clock': work({
			hook: 'A synthetic hook about a tide clock.',
			genres: ['Science Fiction', 'Time Travel', 'Adventure', 'Humor']
		}),
		'glass-orchard': work({
			hook: 'A synthetic hook about a glass orchard.',
			genres: ['Literary Fiction', 'Magical Realism', 'Family Life', 'Classics']
		}),
		'paper-moon': work({ hook: 'A synthetic hook about a paper moon.' })
	},
	editions: {
		B0SYNTH001: edition(
			'lantern-road',
			{
				title: 'The Lantern Road',
				author: 'Ada Quill',
				narrator: 'Ben Reader'
			},
			{ awards: [AWARD_RECORDING] }
		),
		B0SYNTH002: edition('tide-clock', {
			title: 'The Tide Clock (Narrated by Cora Voice)',
			author: 'Ada Quill',
			narrator: 'Cora Voice'
		}),
		B0SYNTH003: edition('tide-clock', {
			title: 'The Tide Clock',
			author: 'Ada Quill',
			narrator: 'Dan Voice'
		}),
		'hardcover-book-424242': edition('glass-orchard', {
			title: 'The Glass Orchard',
			author: 'Fen Writer',
			narrator: 'Gus Speaker'
		}),
		B0SYNTHDRF: edition(
			'paper-moon',
			{ title: 'Paper Moon', author: 'Ada Quill', narrator: 'Hal Draft' },
			{ status: 'draft', approved_on: undefined, gate2_open: 'a quote still to verify' }
		),
		B0SYNTHHLD: edition('paper-moon', {
			title: 'Paper Moon Held',
			author: 'Ada Quill',
			narrator: 'Ivy Held'
		})
	},
	held: { B0SYNTHHLD: 'STOP card: wrong-language file' }
})

/** A served record as /books/:id would carry it (only the fields that matter). */
export const record = (over: Json = {}): Json => ({
	asin: 'B0SYNTH001',
	title: 'The Lantern Road',
	authors: [{ name: 'Ada Quill' }],
	narrators: [{ name: 'Ben Reader' }],
	formatType: 'unabridged',
	runtimeLengthMin: 1023,
	publisherName: 'Synthetic Audio',
	releaseDate: '2000-12-31T00:00:00.000Z',
	language: 'english',
	seriesPrimary: { name: 'The Lantern Cycle', position: '2' },
	summary: '<p>The provider blurb.</p>',
	genres: [{ asin: '18580606011', name: 'Science Fiction & Fantasy', type: 'genre' }],
	...over
})

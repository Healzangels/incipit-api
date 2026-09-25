import { afterEach, describe, expect, it, mock } from 'bun:test'

// N1 of docs/design/spec-shelf-titles-across-the-board.md. Goodreads titles manga
// and light-novel series "<original script> [<romanization>]"; with no English
// alias declared, the shelf took the Japanese name. Same transport mock as the
// other resolver suites, so the REAL rename runs over fixture payloads.
const fetchMock = mock()
mock.module('#helpers/utils/fetchPlus', () => ({ default: fetchMock }))

const { bracketedRomanization, fetchGoodreadsSeries } =
	await import('#helpers/providers/goodreadsSeries')

const MUSHOKU = '無職転生: 異世界行ったら本気だす [Mushoku Tensei: Isekai Ittara Honki Dasu]'

function respond(...bodies: unknown[]) {
	fetchMock.mockReset()
	for (const body of bodies) fetchMock.mockImplementationOnce(() => Promise.resolve({ data: body }))
}

describe('bracketedRomanization', () => {
	it('takes the Latin romanization Goodreads brackets after a non-Latin title', () => {
		expect(bracketedRomanization(MUSHOKU)).toBe('Mushoku Tensei: Isekai Ittara Honki Dasu')
	})

	it('leaves a Latin series that merely ends in brackets alone', () => {
		// Nothing to translate: the outside is already Latin script.
		expect(bracketedRomanization('Discworld [Rincewind]')).toBeNull()
	})

	it('needs the bracket: a non-Latin name without one has no Latin form to take', () => {
		expect(bracketedRomanization('無職転生')).toBeNull()
	})

	it('refuses a bracket that is itself non-Latin', () => {
		expect(bracketedRomanization('無職転生 [無職転生]')).toBeNull()
	})

	it('reads only a CLOSING bracket, not one in the middle of the name', () => {
		expect(bracketedRomanization('無職転生 [Mushoku] 異世界')).toBeNull()
	})

	it('skips a FORMAT tag: a bracketed edition is never a shelf name', () => {
		// Librarians bracket the format too; shelving by "Light Novel" would put
		// unrelated series on one shelf name (section 12).
		expect(bracketedRomanization('無職転生 [Light Novel]')).toBeNull()
		expect(bracketedRomanization('ソードアート・オンライン [Sword Art Online] [Light Novel]')).toBe(
			'Sword Art Online'
		)
		expect(bracketedRomanization('進撃の巨人 [Attack on Titan] [Manga]')).toBe('Attack on Titan')
	})
})

// Per-test ids: seriesRecord memoizes /series/{id} for the process lifetime.
// The real work is titled just "Mushoku Tensei"; what lets our long Audible title
// through the title gate is the ENGLISH EDITION title the work lists among its
// Books -- without it the gate rightly refuses, and every assertion below reads
// a null that has nothing to do with the rename.
const lnWork = (workId: number, seriesId: number) => ({
	Title: 'Mushoku Tensei',
	Books: [{ Title: 'Mushoku Tensei: Jobless Reincarnation (Light Novel) Vol. 14' }],
	Series: [
		{
			Title: MUSHOKU,
			ForeignId: seriesId,
			LinkItems: [{ ForeignWorkId: workId, PositionInSeries: '14' }]
		}
	]
})

describe('the display rename applies the romanization to the SHELF', () => {
	afterEach(() => {
		fetchMock.mockReset()
		delete process.env.GOODREADS_SERIES_LANGUAGE
	})

	it('a non-Latin series with no declared alias shelves under its romanization', async () => {
		// Live on prod 2026-09-23: rk 749441/749439 shelved as the Japanese title.
		respond([{ workId: 88793724 }], lnWork(88793724, 1136942), { LinkItems: [], Description: '' })
		const out = await fetchGoodreadsSeries(
			'Mushoku Tensei: Jobless Reincarnation (Light Novel), Vol. 14',
			'Rifujin na Magonote'
		)
		expect(out?.primary).toEqual({
			name: 'Mushoku Tensei: Isekai Ittara Honki Dasu',
			position: '14'
		})
		// search + work + the one series record the rename reads.
		expect(fetchMock.mock.calls.length).toBe(3)
	})

	it('CONTROL: a DECLARED English alias still wins over the romanization', async () => {
		respond([{ workId: 88793725 }], lnWork(88793725, 1136943), {
			LinkItems: [],
			Description: 'Also known as:\n- Mushoku Tensei: Jobless Reincarnation (English)\n\nPlot.'
		})
		const out = await fetchGoodreadsSeries(
			'Mushoku Tensei: Jobless Reincarnation (Light Novel), Vol. 14',
			'Rifujin na Magonote'
		)
		expect(out?.primary).toEqual({ name: 'Mushoku Tensei: Jobless Reincarnation', position: '14' })
	})

	it('CONTROL: an operator who asked for canonical names keeps the canonical name', async () => {
		// GOODREADS_SERIES_LANGUAGE=canonical turns every display rename off; the
		// romanization is a display rename, so it honours the same switch.
		process.env.GOODREADS_SERIES_LANGUAGE = 'canonical'
		respond([{ workId: 88793726 }], lnWork(88793726, 1136944))
		const out = await fetchGoodreadsSeries(
			'Mushoku Tensei: Jobless Reincarnation (Light Novel), Vol. 14',
			'Rifujin na Magonote'
		)
		expect(out?.primary).toEqual({ name: MUSHOKU, position: '14' })
	})

	it('a library configured for a non-Latin language keeps the original-script name', async () => {
		// The romanization is a Latin-script DISPLAY name. An operator who set
		// GOODREADS_SERIES_LANGUAGE=Japanese asked for the Japanese name, not romaji.
		process.env.GOODREADS_SERIES_LANGUAGE = 'Japanese'
		respond([{ workId: 88793727 }], lnWork(88793727, 1136945), { LinkItems: [], Description: '' })
		const out = await fetchGoodreadsSeries(
			'Mushoku Tensei: Jobless Reincarnation (Light Novel), Vol. 14',
			'Rifujin na Magonote'
		)
		expect(out?.primary).toEqual({ name: MUSHOKU, position: '14' })
	})
})

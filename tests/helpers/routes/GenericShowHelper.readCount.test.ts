import { describe, expect, mock, test } from 'bun:test'

/**
 * A WRITE MUST NOT COST TWO READS.
 *
 * Every papr createOrUpdate path returns a findOneWithProjection result, and
 * createOrUpdateData threw it away and re-read the same document — one wasted
 * query per book on every write, ~1,600 of them in a from-scratch scan.
 *
 * The sort and the schema parse that getDataWithProjection also performs are
 * NOT waste, so the remedy was to split those out (projectData) and apply them
 * to the record already in hand — not to delete the call.
 */

let projectionReads = 0
const stored = {
	asin: 'B0READCNT1',
	name: 'A Test Author',
	description: '',
	image: '',
	genres: [],
	similar: [],
	region: 'us'
}

mock.module('#helpers/database/papr/audible/PaprAudibleAuthorHelper', () => ({
	default: class {
		setData() {}
		async findOneWithProjection() {
			projectionReads += 1
			return { data: stored, modified: false }
		}
		async findOne() {
			return { data: stored, modified: false }
		}
		async createOrUpdate() {
			// The real helper reaches its return through findOneWithProjection;
			// model that faithfully so the count reflects production.
			return this.findOneWithProjection()
		}
	}
}))

mock.module('#helpers/database/redis/RedisHelper', () => ({
	default: class {
		async findOne() {
			return null
		}
		async findOrCreate() {
			return stored
		}
		setOne() {
			return Promise.resolve(undefined)
		}
		async setExpiration() {}
		async deleteOne() {}
	}
}))

mock.module('#helpers/authors/audible/ScrapeHelper', () => ({
	default: class {
		async process() {
			return stored
		}
	}
}))

mock.module('@fastify/redis', () => ({}))

// The author enrichment chain would otherwise reach the live network; it has
// its own suites, and here it must simply not run.
mock.module('#helpers/providers/goodreadsSeries', () => ({
	withGoodreadsAuthorInfo: async () => ({ image: null, bio: null }),
	fetchGoodreadsAuthorInfo: async () => ({ image: null, bio: null }),
	withGoodreadsSeries: async (book: unknown) => book,
	fetchGoodreadsSeries: async () => null,
	foldSeriesName: (s: string) => s
}))
mock.module('#helpers/providers/chaptarrAuthor', () => ({
	chaptarrAuthorInfo: async () => ({ image: null, bio: null })
}))
mock.module('#helpers/providers/registry', () => ({ default: { get: () => undefined } }))
mock.module('#helpers/utils/secondChance', () => ({
	scheduleSecondChance: () => true,
	pendingSecondChances: () => []
}))

const { default: AuthorShowHelper } = await import('#helpers/routes/AuthorShowHelper')

describe('createOrUpdateData', () => {
	test('performs ONE projected read, not two', async () => {
		projectionReads = 0
		const helper = new AuthorShowHelper('B0READCNT1', { region: 'us', update: '1' } as never, null)
		await helper.createOrUpdateData()
		// createOrUpdate's own read is unavoidable; the second one was waste.
		expect(projectionReads).toBe(1)
	})
})

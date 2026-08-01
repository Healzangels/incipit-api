import type { Db } from 'mongodb'

/**
 * The indexes every deployment needs, as DATA so a test can hold them.
 *
 * Two reasons this is a list rather than a few inline createIndex calls:
 *
 * 1. Until now the ONLY index created here was the authors $text index. Every
 *    `/books/:asin` lookup — the request Plex makes for every album, twice per
 *    lookup (findOne + findOneWithProjection) — ran an unindexed collection
 *    scan. Small at ~1,600 documents, but it is 2 scans × ~12,000 requests on
 *    a full refresh against a monotonically growing collection, and the fix is
 *    free.
 *
 * 2. NONE of these may be UNIQUE, and that has to be enforceable rather than
 *    remembered. A unique index over a collection that already holds duplicate
 *    {asin, region} pairs FAILS TO BUILD, initialize() rejects inside
 *    startServer's try, and the catch calls process.exit(1) — a boot
 *    crash-loop. Duplicates are known to exist here: papr does read-then-insert
 *    with no upsert, so concurrent first-touches of the same ASIN (Plex fires
 *    one lookup per TRACK, and a 27-part book issues 27 near-simultaneously)
 *    create them. De-duplicating is a separate, deliberate migration; adding a
 *    non-unique index is safe today and helps immediately.
 *
 * The lookup predicate is `{ asin, $or: [{region: {$exists:false}}, {region}] }`
 * in all three helpers, so `{asin: 1, region: 1}` serves it with asin — the
 * selective field — as the prefix.
 */
export interface IndexSpec {
	collection: string
	keys: Record<string, 1 | -1 | 'text'>
	/** Present so the non-unique invariant is explicit, not merely absent. */
	unique: false
	why: string
}

export const REQUIRED_INDEXES: readonly IndexSpec[] = [
	{
		collection: 'authors',
		keys: { name: 'text', aliases: 'text' },
		unique: false,
		why: 'author search runs a $text query; a fresh self-hosted Mongo 500s without it'
	},
	{
		collection: 'books',
		keys: { asin: 1, region: 1 },
		unique: false,
		why: 'every /books/:asin lookup; unindexed it is a collection scan, twice per request'
	},
	{
		collection: 'authors',
		keys: { asin: 1, region: 1 },
		unique: false,
		why: 'same lookup shape as books'
	},
	{
		collection: 'chapters',
		keys: { asin: 1, region: 1 },
		unique: false,
		why: 'same lookup shape as books'
	}
]

/**
 * Ensure every required index exists. `createIndex` is idempotent, so this is
 * safe to run on every boot.
 *
 * A failure here is logged and swallowed rather than thrown: an index is a
 * performance property, and refusing to boot because one could not be built
 * would turn a slow API into a dead one.
 * @param {Db} db the audnexus database handle
 * @param {{warn: (msg: string) => void}} [logger] optional sink for build failures
 * @returns {Promise<void>}
 */
export async function ensureIndexes(
	db: Db,
	logger?: { warn: (msg: string) => void }
): Promise<void> {
	for (const spec of REQUIRED_INDEXES) {
		try {
			await db.collection(spec.collection).createIndex(spec.keys as never)
		} catch (err) {
			logger?.warn(
				`index build failed for ${spec.collection} ${JSON.stringify(spec.keys)}: ` +
					`${err instanceof Error ? err.message : String(err)}`
			)
		}
	}
}

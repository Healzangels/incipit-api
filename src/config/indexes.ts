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
}

// The non-unique invariant is enforced by HOW these are built, not by a field:
// `ensureIndexes` calls `createIndex(keys)` with one argument and no options, so
// there is nowhere for `unique: true` to enter. A `unique: false` property here
// was read by no code, and a test "pinning" it was statically empty.
export const REQUIRED_INDEXES: readonly IndexSpec[] = [
	// author search runs a $text query; a fresh self-hosted Mongo 500s without it
	{ collection: 'authors', keys: { name: 'text', aliases: 'text' } },
	// every /books/:asin lookup; unindexed it is a collection scan, twice per request
	{ collection: 'books', keys: { asin: 1, region: 1 } },
	// same lookup shape as books
	{ collection: 'authors', keys: { asin: 1, region: 1 } },
	// same lookup shape as books
	{ collection: 'chapters', keys: { asin: 1, region: 1 } }
]

/**
 * Ensure every required index exists. `createIndex` is idempotent, so this is
 * safe to run on every boot.
 *
 * A failure here is logged and swallowed rather than thrown: an index is a
 * performance property, and refusing to boot because one could not be built
 * would turn a slow API into a dead one. But it MUST be said out loud. This
 * replaced a bare `createIndex` whose rejection reached startServer's catch and
 * `process.exit(1)`, and the sole production call site passed no logger — so
 * `logger?.warn` was a no-op and a failed build produced NO output at any level,
 * leaving `/authors?name=` to 500 forever with nothing to grep for. Hence the
 * console fallback: silence is the one outcome that is never acceptable here.
 *
 * Built in PARALLEL: four independent `createIndex` calls awaited in sequence
 * put their combined latency on the boot path for no reason. The per-spec
 * try/catch keeps them isolated — one failure must not skip the rest.
 * @param {Db} db the audnexus database handle
 * @param {{warn: (msg: string) => void}} [logger] sink for build failures; defaults to console
 * @returns {Promise<void>}
 */
export async function ensureIndexes(
	db: Db,
	logger?: { warn: (msg: string) => void }
): Promise<void> {
	const warn = (msg: string) => (logger ? logger.warn(msg) : console.warn(msg))
	await Promise.all(
		REQUIRED_INDEXES.map(async (spec) => {
			try {
				// ONE argument, deliberately: no options object means no way for
				// `unique: true` to be introduced. A unique index over a collection
				// that already holds duplicate {asin, region} pairs fails to build.
				await db.collection(spec.collection).createIndex(spec.keys as never)
			} catch (err) {
				warn(
					`index build failed for ${spec.collection} ${JSON.stringify(spec.keys)}: ` +
						`${err instanceof Error ? err.message : String(err)}`
				)
			}
		})
	)
}

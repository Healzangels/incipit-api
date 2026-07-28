import { FastifyInstance } from 'fastify'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

import { envInt } from '#helpers/utils/env'

/**
 * Perceptual image comparison for the bundle's poster dedupe.
 *
 * The bundle's duplicate_shown_elsewhere withholds the agent's poster when
 * another source already displays byte-identical art. Re-encodes of the SAME
 * picture (a hand upload of the provider photo, LMA's embedded art next to a
 * cover.jpg mirror) defeat byte identity, so the bundle consults this
 * endpoint as a fallback: a 64-bit dHash on both images, similar when the
 * hamming distance is at or under the threshold.
 *
 * The threshold is deliberately conservative (measured same-picture
 * re-encodes in the library sit at distance 0-2): hiding a genuinely
 * different poster option is worse than showing a duplicate tile, and the
 * client fails open on every non-200 anyway.
 */

/**
 * Hamming distance at or under which two images count as the same picture
 */
// Raised from 4 on 2026-07-28 after measuring the operator's own library.
// 4 was chosen when the hash was the ONLY signal; the chroma gate now catches
// colour variants independently (the Three-Body sepia/blue pair sits at luma
// distance 3 and is rejected on chroma), which is what makes a wider luma
// threshold safe.
//
// Visually confirmed same-cover pairs inside one album: distance 5 (Sunreach,
// 2400px vs 500px re-encode), 8 (The Grief of Stones, different crop), 10
// (Tom Clancy Support and Defend, tighter crop). All three were being shown
// twice. Against that, 3,700 pairs of genuinely different author portraits
// measured a MINIMUM distance of 11, so 10 is the largest value that stays
// strictly below the observed different-content floor.
//
// IMAGES_SIMILAR_MAX_DISTANCE still overrides, so this is a dial, not a law.
const DEFAULT_MAX_DISTANCE = 10

/**
 * Generous body cap: two base64 poster blobs plus JSON overhead
 */
const BODY_LIMIT_BYTES = 16 * 1024 * 1024

/**
 * Grid the dHash samples: 9 columns x 8 rows of luma, 64 horizontal gradients
 */
const HASH_COLS = 9
const HASH_ROWS = 8

/** Evenly spaced samples per axis within a cell (see imageGrid). */
const CELL_SAMPLES = 16

/** Refuse to decode beyond this many pixels (~100MP, jpeg-js's own ceiling). */
const MAX_DECODED_PIXELS = 100_000_000

/**
 * Luma spread below which an image carries no structure: every threshold
 * comparison ties, so a flat white placeholder and a flat black one both hash
 * to 0n and read as the same picture with a DEFINITIVE verdict the client
 * cannot fail open on. Real artwork measured far above this (portraits floor
 * 13.1, covers 15.6); a flat image is 0.
 */
const MIN_GRID_STDDEV = 6

/** Per-cell chroma difference above which a same-luma pair is a colourway. */
const MAX_CHROMA_DISTANCE = 20

export interface ImagesSimilarBody {
	a?: string
	b?: string
	aSig?: string
	bSig?: string
}

export interface ImagesSimilarResponse {
	similar: boolean
	distance: number | null
	undecodable: boolean
	/**
	 * Set (with undecodable) when a supplied signature could not be used:
	 * corrupt, or minted by an older grid geometry. Tells a caching client
	 * "re-send the bytes", which plain undecodable must not — that one means
	 * the CONTENT is unusable and retrying bytes would loop.
	 */
	staleSig?: boolean
	/** Signatures for the two sides, returned on every full verdict. */
	aSig?: string
	bSig?: string
}

interface RawImage {
	width: number
	height: number
	/** RGBA byte stream, 4 bytes per pixel */
	data: Uint8Array
}

/**
 * Decodes JPEG or PNG bytes into RGBA pixels, sniffing by magic bytes.
 * Returns null for anything it cannot decode (other formats, corrupt data).
 */
export function decodeImage(buf: Buffer): RawImage | null {
	try {
		if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
			const out = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 })
			return { width: out.width, height: out.height, data: out.data }
		}
		if (
			buf.length > 8 &&
			buf[0] === 0x89 &&
			buf[1] === 0x50 &&
			buf[2] === 0x4e &&
			buf[3] === 0x47
		) {
			// Read IHDR and refuse absurd geometry BEFORE decoding. pngjs
			// allocates width*height*4 with no cap of its own, so a crafted
			// 74-byte PNG declaring 20000x20000 decoded to 1.6GB and ~4s of
			// blocking (measured 2026-07-28) -- two per request, on a route
			// whose 16MB body limit bounds only the ENCODED size.
			if (buf.length >= 24 && buf.toString('latin1', 12, 16) === 'IHDR') {
				const pixels = buf.readUInt32BE(16) * buf.readUInt32BE(20)
				if (!pixels || pixels > MAX_DECODED_PIXELS) return null
			}
			const out = PNG.sync.read(buf)
			return { width: out.width, height: out.height, data: new Uint8Array(out.data) }
		}
	} catch {
		return null
	}
	return null
}

interface ImageGrid {
	/** Per-cell mean luma, HASH_ROWS x HASH_COLS. */
	luma: number[][]
	/** Per-cell mean chroma, flattened, for the colour-variant gate. */
	cb: number[]
	cr: number[]
	/** Spread of the luma cells; near zero means a flat/degenerate image. */
	stddev: number
}

/**
 * Area-averages the image down to a HASH_COLS x HASH_ROWS grid of mean luma
 * and chroma.
 *
 * SAMPLED, not exhaustive: summing every pixel cost 72ms per request on a
 * 3000x3000 pair (measured), while capping each cell at CELL_SAMPLES^2 evenly
 * spaced samples costs ~1.5ms and produced a bit-identical hash at every size
 * tested -- a cell mean over 256 samples is far more precise than the 64
 * threshold comparisons that consume it.
 */
function imageGrid(img: RawImage): ImageGrid {
	const luma: number[][] = []
	const cb: number[] = []
	const cr: number[] = []
	const flat: number[] = []
	for (let gy = 0; gy < HASH_ROWS; gy++) {
		const row: number[] = []
		const y0 = Math.floor((gy * img.height) / HASH_ROWS)
		const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * img.height) / HASH_ROWS))
		const yStep = Math.max(1, Math.floor((y1 - y0) / CELL_SAMPLES))
		for (let gx = 0; gx < HASH_COLS; gx++) {
			const x0 = Math.floor((gx * img.width) / HASH_COLS)
			const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * img.width) / HASH_COLS))
			const xStep = Math.max(1, Math.floor((x1 - x0) / CELL_SAMPLES))
			let sumY = 0
			let sumCb = 0
			let sumCr = 0
			let n = 0
			for (let y = y0; y < y1; y += yStep) {
				for (let x = x0; x < x1; x += xStep) {
					const i = (y * img.width + x) * 4
					const r = img.data[i]
					const g = img.data[i + 1]
					const b = img.data[i + 2]
					const yy = 0.299 * r + 0.587 * g + 0.114 * b
					sumY += yy
					sumCb += b - yy
					sumCr += r - yy
					n++
				}
			}
			row.push(sumY / n)
			flat.push(sumY / n)
			cb.push(sumCb / n)
			cr.push(sumCr / n)
		}
		luma.push(row)
	}
	const mean = flat.reduce((acc, v) => acc + v, 0) / flat.length
	const variance = flat.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / flat.length
	return { luma, cb, cr, stddev: Math.sqrt(variance) }
}

/**
 * 64-bit difference hash: one bit per horizontal luma gradient.
 */
export function dhash64(img: RawImage): bigint {
	return gridHash(imageGrid(img))
}

function gridHash(grid: ImageGrid): bigint {
	let bits = 0n
	for (let y = 0; y < HASH_ROWS; y++) {
		for (let x = 0; x < HASH_COLS - 1; x++) {
			bits = (bits << 1n) | (grid.luma[y][x] > grid.luma[y][x + 1] ? 1n : 0n)
		}
	}
	return bits
}

/**
 * Mean absolute per-cell chroma difference between two grids.
 *
 * The hash is luma-only, so a design re-issued in another colourway hashes
 * IDENTICALLY -- measured live on the two Audible editions of The Three-Body
 * Problem (sepia vs blue, different narrators): distance 3, i.e. "the same
 * picture", and one would have been hidden. Verified same-picture re-encodes
 * score 0.2-8.2 on this measure; the colour variants scored 60.9.
 */
function chromaDistance(a: Pick<ImageGrid, 'cb' | 'cr'>, b: Pick<ImageGrid, 'cb' | 'cr'>): number {
	let total = 0
	for (let i = 0; i < a.cb.length; i++) {
		total += Math.abs(a.cb[i] - b.cb[i]) + Math.abs(a.cr[i] - b.cr[i])
	}
	return total / a.cb.length
}

/**
 * Everything a verdict needs from one image: the 64-bit luma hash plus the
 * per-cell chroma means the colourway gate compares. A summary only exists
 * for an image that DECODED and carried structure (the stddev gate ran
 * before it was built), so replaying one can never smuggle a flat
 * placeholder past the guards.
 */
interface SideSummary {
	bits: bigint
	cb: number[]
	cr: number[]
}

/**
 * Version tag for signatures. It encodes the grid geometry (9x8 cells,
 * CELL_SAMPLES sampling): change any of that and hashes stop being
 * comparable across versions, so bump the tag — old signatures then decode
 * to null and the client is told to re-send bytes (staleSig) instead of
 * silently comparing incompatible grids.
 */
const SIG_VERSION = 'g1'

const SIG_CELLS = HASH_ROWS * HASH_COLS

/**
 * Serializes a side summary into an opaque token the client can replay in
 * place of the image bytes. The point is traffic, not secrecy: the bundle
 * compares every poster tile against every other, so each tile's bytes were
 * being re-uploaded once per PAIR; with signatures each tile is uploaded
 * once and its ~600-byte token rides on every later consult.
 *
 * Chroma means are rounded to one decimal: the gate is a mean-absolute
 * threshold of 20, so 0.05 of rounding noise cannot flip a verdict, and the
 * rounding halves the token size.
 */
export function encodeSignature(s: SideSummary): string {
	const payload = {
		h: s.bits.toString(16),
		cb: s.cb.map((v) => Math.round(v * 10) / 10),
		cr: s.cr.map((v) => Math.round(v * 10) / 10)
	}
	return SIG_VERSION + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url')
}

/**
 * Parses a signature token back into a side summary, or null for anything
 * that is not a well-formed current-version token. Strict on purpose: a
 * null here surfaces as staleSig, the one response that tells a caching
 * client to fall back to bytes.
 */
export function decodeSignature(token: string): SideSummary | null {
	if (!token.startsWith(SIG_VERSION + '.')) return null
	let payload: unknown
	try {
		payload = JSON.parse(Buffer.from(token.slice(SIG_VERSION.length + 1), 'base64url').toString())
	} catch {
		return null
	}
	if (typeof payload !== 'object' || payload === null) return null
	const { h, cb, cr } = payload as { h?: unknown; cb?: unknown; cr?: unknown }
	if (typeof h !== 'string' || !/^[0-9a-f]{1,16}$/.test(h)) return null
	for (const arr of [cb, cr]) {
		if (!Array.isArray(arr) || arr.length !== SIG_CELLS) return null
		if (!arr.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
	}
	return { bits: BigInt('0x' + h), cb: cb as number[], cr: cr as number[] }
}

/**
 * Number of differing bits between two 64-bit hashes.
 */
export function hammingDistance(a: bigint, b: bigint): number {
	let x = a ^ b
	let count = 0
	while (x) {
		count += Number(x & 1n)
		x >>= 1n
	}
	return count
}

/**
 * The distance at or under which two images count as the same picture.
 * Overridable via IMAGES_SIMILAR_MAX_DISTANCE for tuning without a release.
 */
export function maxDistance(): number {
	return envInt(process.env.IMAGES_SIMILAR_MAX_DISTANCE, DEFAULT_MAX_DISTANCE, 0, 32)
}

/**
 * POST /images/similar: are these two images the same picture?
 *
 * Each side is EITHER base64 image bytes (`a`/`b`) OR a signature returned
 * by a previous call (`aSig`/`bSig`; preferred when both are sent). Always
 * 200 with a verdict; undecodable CONTENT (unsupported format, corrupt
 * bytes, flat placeholder) reports { similar: false, undecodable: true } so
 * the client's fail-open stays trivially simple, while an unusable
 * SIGNATURE additionally sets staleSig — the cue to re-send bytes. A side
 * with neither field is a malformed request and 400s, exactly as a missing
 * field always has.
 *
 * Every full verdict carries aSig/bSig back, so a client comparing one
 * image against N others uploads its bytes once and replays tokens.
 */
async function imagesSimilar(app: FastifyInstance) {
	app.post<{ Body: ImagesSimilarBody; Reply: ImagesSimilarResponse }>(
		'/images/similar',
		{
			bodyLimit: BODY_LIMIT_BYTES,
			schema: {
				body: {
					type: 'object',
					properties: {
						a: { type: 'string', minLength: 1 },
						b: { type: 'string', minLength: 1 },
						aSig: { type: 'string', minLength: 1 },
						bSig: { type: 'string', minLength: 1 }
					}
				}
			}
		},
		async (request, reply) => {
			const sides: Array<[string | undefined, string | undefined]> = [
				[request.body.a, request.body.aSig],
				[request.body.b, request.body.bSig]
			]
			if (sides.some(([bytes, sig]) => !bytes && !sig)) {
				return reply.status(400).send({
					similar: false,
					distance: null,
					undecodable: true
				})
			}
			const summaries: SideSummary[] = []
			for (const [bytes, sig] of sides) {
				if (sig) {
					const summary = decodeSignature(sig)
					if (!summary) {
						return reply
							.status(200)
							.send({ similar: false, distance: null, undecodable: true, staleSig: true })
					}
					summaries.push(summary)
					continue
				}
				const img = decodeImage(Buffer.from(bytes as string, 'base64'))
				if (!img || !img.width || !img.height) {
					return reply.status(200).send({ similar: false, distance: null, undecodable: true })
				}
				const grid = imageGrid(img)
				// A flat image has no structure to hash: every threshold
				// comparison ties, so white and black both come out 0n and
				// read as "the same picture" with a verdict the client trusts.
				// Report it as undecodable, which the client already fails
				// open on, rather than as a confident false positive.
				if (grid.stddev < MIN_GRID_STDDEV) {
					return reply.status(200).send({ similar: false, distance: null, undecodable: true })
				}
				summaries.push({ bits: gridHash(grid), cb: grid.cb, cr: grid.cr })
			}
			const distance = hammingDistance(summaries[0].bits, summaries[1].bits)
			// Same luma, different colour = a colourway of one design, which is
			// a genuine alternative rather than a duplicate.
			const similar =
				distance <= maxDistance() &&
				chromaDistance(summaries[0], summaries[1]) <= MAX_CHROMA_DISTANCE
			return reply.status(200).send({
				similar,
				distance,
				undecodable: false,
				aSig: encodeSignature(summaries[0]),
				bSig: encodeSignature(summaries[1])
			})
		}
	)
}

export default imagesSimilar

import { FastifyInstance } from 'fastify'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

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
const DEFAULT_MAX_DISTANCE = 4

/**
 * Generous body cap: two base64 poster blobs plus JSON overhead
 */
const BODY_LIMIT_BYTES = 16 * 1024 * 1024

/**
 * Grid the dHash samples: 9 columns x 8 rows of luma, 64 horizontal gradients
 */
const HASH_COLS = 9
const HASH_ROWS = 8

export interface ImagesSimilarBody {
	a: string
	b: string
}

export interface ImagesSimilarResponse {
	similar: boolean
	distance: number | null
	undecodable: boolean
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
			const out = PNG.sync.read(buf)
			return { width: out.width, height: out.height, data: new Uint8Array(out.data) }
		}
	} catch {
		return null
	}
	return null
}

/**
 * Area-averages the image's luma down to a HASH_COLS x HASH_ROWS grid.
 */
function lumaGrid(img: RawImage): number[][] {
	const grid: number[][] = []
	for (let gy = 0; gy < HASH_ROWS; gy++) {
		const row: number[] = []
		const y0 = Math.floor((gy * img.height) / HASH_ROWS)
		const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * img.height) / HASH_ROWS))
		for (let gx = 0; gx < HASH_COLS; gx++) {
			const x0 = Math.floor((gx * img.width) / HASH_COLS)
			const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * img.width) / HASH_COLS))
			let sum = 0
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const i = (y * img.width + x) * 4
					sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
				}
			}
			row.push(sum / ((y1 - y0) * (x1 - x0)))
		}
		grid.push(row)
	}
	return grid
}

/**
 * 64-bit difference hash: one bit per horizontal luma gradient.
 */
export function dhash64(img: RawImage): bigint {
	const grid = lumaGrid(img)
	let bits = 0n
	for (let y = 0; y < HASH_ROWS; y++) {
		for (let x = 0; x < HASH_COLS - 1; x++) {
			bits = (bits << 1n) | (grid[y][x] > grid[y][x + 1] ? 1n : 0n)
		}
	}
	return bits
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
	const raw = Number(process.env.IMAGES_SIMILAR_MAX_DISTANCE)
	if (Number.isInteger(raw) && raw >= 0 && raw <= 32) return raw
	return DEFAULT_MAX_DISTANCE
}

/**
 * POST /images/similar: are these two images the same picture?
 * Body: { a, b } as base64. Always 200 with a verdict; undecodable input
 * (unsupported format, corrupt bytes, bad base64) reports
 * { similar: false, undecodable: true } so the client's fail-open stays
 * trivially simple.
 */
async function imagesSimilar(app: FastifyInstance) {
	app.post<{ Body: ImagesSimilarBody; Reply: ImagesSimilarResponse }>(
		'/images/similar',
		{
			bodyLimit: BODY_LIMIT_BYTES,
			schema: {
				body: {
					type: 'object',
					required: ['a', 'b'],
					properties: {
						a: { type: 'string', minLength: 1 },
						b: { type: 'string', minLength: 1 }
					}
				}
			}
		},
		async (request, reply) => {
			const decoded: RawImage[] = []
			for (const field of [request.body.a, request.body.b]) {
				const img = decodeImage(Buffer.from(field, 'base64'))
				if (!img || !img.width || !img.height) {
					return reply.status(200).send({ similar: false, distance: null, undecodable: true })
				}
				decoded.push(img)
			}
			const distance = hammingDistance(dhash64(decoded[0]), dhash64(decoded[1]))
			return reply
				.status(200)
				.send({ similar: distance <= maxDistance(), distance, undecodable: false })
		}
	)
}

export default imagesSimilar

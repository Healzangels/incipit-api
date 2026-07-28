import { afterEach, describe, expect, test } from 'bun:test'
import Fastify, { FastifyInstance } from 'fastify'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

import imagesSimilar, {
	decodeImage,
	dhash64,
	hammingDistance,
	maxDistance
} from '#config/routes/images'

/**
 * Paints a deterministic "author photo": a diagonal luma gradient with a
 * bright block, structured enough that dHash carries real signal.
 */
function paintPortrait(width: number, height: number): Buffer {
	const data = Buffer.alloc(width * height * 4)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4
			const base = Math.floor((x / width) * 160 + (y / height) * 80)
			const block =
				x > width * 0.3 && x < width * 0.6 && y > height * 0.2 && y < height * 0.7 ? 60 : 0
			data[i] = Math.min(255, base + block)
			data[i + 1] = Math.min(255, base)
			data[i + 2] = Math.min(255, Math.floor(base * 0.7))
			data[i + 3] = 255
		}
	}
	return data
}

/**
 * A structurally DIFFERENT picture: vertical bands, inverted lighting.
 */
function paintOther(width: number, height: number): Buffer {
	const data = Buffer.alloc(width * height * 4)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4
			const band = Math.floor(x / (width / 8)) % 2 === 0 ? 220 : 30
			data[i] = band
			data[i + 1] = 255 - band
			data[i + 2] = band
			data[i + 3] = 255
		}
	}
	return data
}

function asJpeg(pixels: Buffer, width: number, height: number, quality: number): Buffer {
	return jpeg.encode({ data: pixels, width, height }, quality).data as Buffer
}

function asPng(pixels: Buffer, width: number, height: number): Buffer {
	const png = new PNG({ width, height })
	pixels.copy(png.data)
	return PNG.sync.write(png)
}

describe('perceptual hashing should', () => {
	test('call re-encodes of the same picture near-identical', () => {
		const px = paintPortrait(300, 300)
		const hi = decodeImage(asJpeg(px, 300, 300, 90))
		const lo = decodeImage(asJpeg(px, 300, 300, 30))
		expect(hi).not.toBeNull()
		expect(lo).not.toBeNull()
		const d = hammingDistance(dhash64(hi!), dhash64(lo!))
		expect(d).toBeLessThanOrEqual(2)
	})

	test('call a resized copy of the same picture near-identical', () => {
		const big = decodeImage(asJpeg(paintPortrait(400, 400), 400, 400, 85))
		const small = decodeImage(asJpeg(paintPortrait(120, 120), 120, 120, 85))
		const d = hammingDistance(dhash64(big!), dhash64(small!))
		expect(d).toBeLessThanOrEqual(2)
	})

	test('match across JPEG and PNG containers', () => {
		const px = paintPortrait(200, 200)
		const j = decodeImage(asJpeg(px, 200, 200, 80))
		const p = decodeImage(asPng(px, 200, 200))
		const d = hammingDistance(dhash64(j!), dhash64(p!))
		expect(d).toBeLessThanOrEqual(2)
	})

	test('keep different pictures far apart', () => {
		const a = decodeImage(asJpeg(paintPortrait(300, 300), 300, 300, 85))
		const b = decodeImage(asJpeg(paintOther(300, 300), 300, 300, 85))
		const d = hammingDistance(dhash64(a!), dhash64(b!))
		expect(d).toBeGreaterThan(maxDistance())
	})

	test('refuse formats it cannot decode', () => {
		expect(decodeImage(Buffer.from('GIF89a not really an image'))).toBeNull()
		expect(decodeImage(Buffer.from([0xff, 0xd8, 0x01, 0x02]))).toBeNull()
		expect(decodeImage(Buffer.alloc(0))).toBeNull()
	})
})

describe('POST /images/similar should', () => {
	let app: FastifyInstance

	async function build(): Promise<FastifyInstance> {
		const server = Fastify()
		await server.register(imagesSimilar)
		return server
	}

	async function post(app: FastifyInstance, a: Buffer, b: Buffer) {
		return app.inject({
			method: 'POST',
			url: '/images/similar',
			payload: { a: a.toString('base64'), b: b.toString('base64') }
		})
	}

	afterEach(async () => {
		if (app) await app.close()
	})

	test('report re-encoded twins as similar', async () => {
		app = await build()
		const px = paintPortrait(250, 250)
		const res = await post(app, asJpeg(px, 250, 250, 90), asJpeg(px, 250, 250, 35))
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.similar).toBe(true)
		expect(body.undecodable).toBe(false)
		expect(body.distance).toBeLessThanOrEqual(maxDistance())
	})

	test('report different pictures as dissimilar', async () => {
		app = await build()
		const res = await post(
			app,
			asJpeg(paintPortrait(250, 250), 250, 250, 85),
			asJpeg(paintOther(250, 250), 250, 250, 85)
		)
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.similar).toBe(false)
		expect(body.undecodable).toBe(false)
	})

	test('flag undecodable input without erroring', async () => {
		app = await build()
		const res = await post(
			app,
			Buffer.from('not an image at all'),
			asJpeg(paintOther(50, 50), 50, 50, 80)
		)
		expect(res.statusCode).toBe(200)
		expect(res.json()).toEqual({ similar: false, distance: null, undecodable: true })
	})

	test('reject a missing field with a 400', async () => {
		app = await build()
		const res = await app.inject({
			method: 'POST',
			url: '/images/similar',
			payload: { a: 'onlyone' }
		})
		expect(res.statusCode).toBe(400)
	})

	test('honor the env threshold override', async () => {
		const prior = process.env.IMAGES_SIMILAR_MAX_DISTANCE
		process.env.IMAGES_SIMILAR_MAX_DISTANCE = '0'
		try {
			expect(maxDistance()).toBe(0)
		} finally {
			if (prior === undefined) delete process.env.IMAGES_SIMILAR_MAX_DISTANCE
			else process.env.IMAGES_SIMILAR_MAX_DISTANCE = prior
		}
		expect(maxDistance()).toBe(10)
	})
})

describe('review hardening', () => {
	/**
	 * 2026-07-28 review, all measured:
	 *  - `Number('')` is 0 and passes `Number.isInteger`, so an env var that
	 *    is present-but-empty silently set the threshold to 0 (only
	 *    bit-identical hashes similar) instead of the default.
	 *  - `PNG.sync.read` had no dimension cap: a crafted 74-byte PNG whose
	 *    IHDR declares 20000x20000 decodes to 1.6GB and ~4s of blocking.
	 *  - Every achromatic FLAT image hashes to 0n, so a white placeholder and
	 *    a black one were reported similar with a definitive verdict, which
	 *    the client's fail-open (undecodable only) cannot catch.
	 *  - Luma-only hashing made colour variants of one design identical:
	 *    the two Audible editions of The Three-Body Problem (sepia vs blue,
	 *    different narrators) measured distance 3 in the live cover corpus.
	 */
	function flat(width: number, height: number, r: number, g: number, b: number): Buffer {
		const data = Buffer.alloc(width * height * 4)
		for (let i = 0; i < width * height; i++) {
			data[i * 4] = r
			data[i * 4 + 1] = g
			data[i * 4 + 2] = b
			data[i * 4 + 3] = 255
		}
		return jpeg.encode({ data, width, height }, 95).data as Buffer
	}

	function tinted(width: number, height: number, swap: boolean): Buffer {
		const data = Buffer.alloc(width * height * 4)
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4
				const v = Math.floor((x / width) * 200) + (y > height / 2 ? 40 : 0)
				data[i] = swap ? 40 : v
				data[i + 1] = Math.floor(v * 0.6)
				data[i + 2] = swap ? v : 40
				data[i + 3] = 255
			}
		}
		return jpeg.encode({ data, width, height }, 92).data as Buffer
	}

	async function ask(a: Buffer, b: Buffer) {
		const server = Fastify()
		await server.register(imagesSimilar)
		const res = await server.inject({
			method: 'POST',
			url: '/images/similar',
			payload: { a: a.toString('base64'), b: b.toString('base64') }
		})
		await server.close()
		return res.json()
	}

	test('an empty env var falls back to the default threshold', () => {
		const prior = process.env.IMAGES_SIMILAR_MAX_DISTANCE
		try {
			for (const raw of ['', '   ']) {
				process.env.IMAGES_SIMILAR_MAX_DISTANCE = raw
				expect(maxDistance()).toBe(10)
			}
		} finally {
			if (prior === undefined) delete process.env.IMAGES_SIMILAR_MAX_DISTANCE
			else process.env.IMAGES_SIMILAR_MAX_DISTANCE = prior
		}
	})

	test('the route honors the threshold, not just the helper', async () => {
		// Mutation-resistant: two GENUINELY different pictures must flip to
		// "similar" only because the env raised the threshold. The first
		// version asserted on maxDistance() itself, so hard-coding the default
		// in the route left it green. Greyscale so the chroma gate (a separate
		// guard) cannot be what decides the outcome.
		const grey = (src: Buffer): Buffer => {
			const out = Buffer.from(src)
			for (let i = 0; i < out.length; i += 4) {
				const y = Math.round(0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2])
				out[i] = y
				out[i + 1] = y
				out[i + 2] = y
			}
			return out
		}
		const a = asJpeg(grey(paintPortrait(300, 300)), 300, 300, 88)
		const b = asJpeg(grey(paintOther(300, 300)), 300, 300, 88)
		const baseline = await ask(a, b)
		expect(baseline.similar).toBe(false)
		expect(baseline.distance).toBeGreaterThan(4)

		const prior = process.env.IMAGES_SIMILAR_MAX_DISTANCE
		process.env.IMAGES_SIMILAR_MAX_DISTANCE = '32'
		try {
			const raised = await ask(a, b)
			expect(raised.similar).toBe(true)
		} finally {
			if (prior === undefined) delete process.env.IMAGES_SIMILAR_MAX_DISTANCE
			else process.env.IMAGES_SIMILAR_MAX_DISTANCE = prior
		}
	})

	test('a PNG declaring absurd dimensions is refused, not decoded', () => {
		// IHDR 20000x20000, 8-bit RGBA - the shape of the 74-byte bomb.
		const png = Buffer.alloc(33)
		png.write('\x89PNG\r\n\x1a\n', 0, 'binary')
		png.writeUInt32BE(13, 8)
		png.write('IHDR', 12)
		png.writeUInt32BE(20000, 16)
		png.writeUInt32BE(20000, 20)
		png[24] = 8
		png[25] = 6
		const started = Date.now()
		expect(decodeImage(png)).toBeNull()
		expect(Date.now() - started).toBeLessThan(1000)
	})

	test('flat placeholders are undecodable, never similar', async () => {
		const white = await ask(flat(300, 300, 255, 255, 255), flat(300, 300, 0, 0, 0))
		expect(white.similar).toBe(false)
		expect(white.undecodable).toBe(true)
		const grey = await ask(flat(300, 300, 128, 128, 128), flat(300, 300, 200, 200, 200))
		expect(grey.similar).toBe(false)
		expect(grey.undecodable).toBe(true)
	})

	test('a colour variant of one design is not the same picture', async () => {
		const body = await ask(tinted(300, 300, false), tinted(300, 300, true))
		expect(body.undecodable).toBe(false)
		expect(body.similar).toBe(false)
	})

	test('re-encodes of one image still match after the chroma gate', async () => {
		const px = paintPortrait(300, 300)
		const body = await ask(asJpeg(px, 300, 300, 92), asJpeg(px, 300, 300, 30))
		expect(body.similar).toBe(true)
	})
})

describe('threshold calibration', () => {
	/**
	 * The default was 4 while the hash was the only signal. Measured against
	 * the operator's library on 2026-07-28, that hid nothing and MISSED real
	 * duplicates: visually-confirmed same-cover pairs sit at distance 5
	 * (Sunreach, 2400px vs 500px), 8 (The Grief of Stones, different crop) and
	 * 10 (Tom Clancy Support and Defend, tighter crop) -- all three were being
	 * displayed twice in the picker.
	 *
	 * 3,700 pairs of genuinely different author portraits measured a MINIMUM
	 * distance of 11, so 10 is the largest threshold strictly below the
	 * observed different-content floor. The chroma gate is what makes the
	 * wider luma window safe: a colourway of one design is rejected on chroma
	 * regardless of how close its luma hash is.
	 */
	test('the default admits real re-encodes but stays under the different-content floor', () => {
		expect(maxDistance()).toBe(10)
		expect(maxDistance()).toBeLessThan(11)
	})

	function tintedPair(width: number, height: number, swap: boolean): Buffer {
		const data = Buffer.alloc(width * height * 4)
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4
				const v = Math.floor((x / width) * 200) + (y > height / 2 ? 40 : 0)
				data[i] = swap ? 40 : v
				data[i + 1] = Math.floor(v * 0.6)
				data[i + 2] = swap ? v : 40
				data[i + 3] = 255
			}
		}
		return jpeg.encode({ data, width, height }, 92).data as Buffer
	}

	test('a colour variant is still rejected inside the wider window', async () => {
		// Guards the interaction: widening luma must not let colourways through.
		const server = Fastify()
		await server.register(imagesSimilar)
		try {
			const res = await server.inject({
				method: 'POST',
				url: '/images/similar',
				payload: {
					a: tintedPair(300, 300, false).toString('base64'),
					b: tintedPair(300, 300, true).toString('base64')
				}
			})
			const body = res.json()
			expect(body.undecodable).toBe(false)
			expect(body.similar).toBe(false)
		} finally {
			await server.close()
		}
	})
})

describe('signature replay', () => {
	// WHY: the bundle compares every poster tile against every other, so one
	// tile's bytes were re-uploaded once per PAIR. A verdict now returns a
	// signature per side; replaying it must reproduce the byte-path verdict
	// exactly, and an unusable signature must say staleSig (re-send bytes),
	// never plain undecodable (which means the CONTENT is bad and retrying
	// bytes would loop).
	let app: FastifyInstance

	async function build(): Promise<FastifyInstance> {
		const server = Fastify()
		await server.register(imagesSimilar)
		return server
	}

	async function postRaw(app: FastifyInstance, payload: Record<string, string>) {
		return app.inject({ method: 'POST', url: '/images/similar', payload })
	}

	afterEach(async () => {
		if (app) await app.close()
	})

	test('a full verdict returns a signature per side', async () => {
		app = await build()
		const px = paintPortrait(250, 250)
		const res = await postRaw(app, {
			a: asJpeg(px, 250, 250, 90).toString('base64'),
			b: asJpeg(px, 250, 250, 35).toString('base64')
		})
		const body = res.json()
		expect(body.undecodable).toBe(false)
		expect(typeof body.aSig).toBe('string')
		expect(typeof body.bSig).toBe('string')
		expect(body.aSig.startsWith('g1.')).toBe(true)
	})

	test('replaying both signatures reproduces the byte verdict exactly', async () => {
		app = await build()
		const px = paintPortrait(250, 250)
		const first = (
			await postRaw(app, {
				a: asJpeg(px, 250, 250, 90).toString('base64'),
				b: asJpeg(px, 250, 250, 35).toString('base64')
			})
		).json()
		const replay = (await postRaw(app, { aSig: first.aSig, bSig: first.bSig })).json()
		expect(replay.similar).toBe(first.similar)
		expect(replay.distance).toBe(first.distance)
		expect(replay.undecodable).toBe(false)
		// Signatures are stable across replays, so a client may cache the
		// response's tokens without them drifting per call.
		expect(replay.aSig).toBe(first.aSig)
		expect(replay.bSig).toBe(first.bSig)
	})

	test('bytes on one side and a signature on the other agree with all-bytes', async () => {
		app = await build()
		const px = paintPortrait(250, 250)
		const aBytes = asJpeg(px, 250, 250, 90)
		const bBytes = asJpeg(px, 250, 250, 35)
		const allBytes = (
			await postRaw(app, { a: aBytes.toString('base64'), b: bBytes.toString('base64') })
		).json()
		const mixed = (
			await postRaw(app, { a: aBytes.toString('base64'), bSig: allBytes.bSig })
		).json()
		expect(mixed.similar).toBe(allBytes.similar)
		expect(mixed.distance).toBe(allBytes.distance)
	})

	test('the colourway gate survives the signature round trip', async () => {
		// Same luma, different colour must stay "not the same picture" when
		// both sides arrive as signatures -- the chroma grid rides inside the
		// token, and dropping it there would silently re-open the
		// Three-Body sepia/blue hole.
		app = await build()
		const width = 220
		const height = 220
		const sepia = Buffer.alloc(width * height * 4)
		const blue = Buffer.alloc(width * height * 4)
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4
				const base = Math.floor((x / width) * 150 + (y / height) * 60)
				sepia[i] = Math.min(255, base + 60)
				sepia[i + 1] = Math.min(255, base + 30)
				sepia[i + 2] = Math.max(0, base - 40)
				sepia[i + 3] = 255
				blue[i] = Math.max(0, base - 40)
				blue[i + 1] = Math.min(255, base + 10)
				blue[i + 2] = Math.min(255, base + 70)
				blue[i + 3] = 255
			}
		}
		const seeded = (
			await postRaw(app, {
				a: asJpeg(sepia, width, height, 90).toString('base64'),
				b: asJpeg(blue, width, height, 90).toString('base64')
			})
		).json()
		expect(seeded.similar).toBe(false)
		const replay = (await postRaw(app, { aSig: seeded.aSig, bSig: seeded.bSig })).json()
		expect(replay.similar).toBe(false)
		expect(replay.undecodable).toBe(false)
	})

	test('an unusable signature says staleSig, not plain undecodable', async () => {
		app = await build()
		const px = paintPortrait(250, 250)
		for (const bad of [
			'garbage',
			'g0.' + Buffer.from('{}').toString('base64url'), // older geometry
			'g1.' + Buffer.from('not json').toString('base64url'),
			'g1.' + Buffer.from(JSON.stringify({ h: 'ff', cb: [1], cr: [1] })).toString('base64url')
		]) {
			const res = await postRaw(app, {
				a: asJpeg(px, 250, 250, 90).toString('base64'),
				bSig: bad
			})
			expect(res.statusCode).toBe(200)
			const body = res.json()
			expect(body.undecodable).toBe(true)
			expect(body.staleSig).toBe(true)
			expect(body.similar).toBe(false)
		}
	})

	test('undecodable BYTES never claim staleSig', async () => {
		app = await build()
		const res = await postRaw(app, {
			a: Buffer.from('not an image').toString('base64'),
			b: asJpeg(paintPortrait(100, 100), 100, 100, 90).toString('base64')
		})
		const body = res.json()
		expect(body.undecodable).toBe(true)
		expect(body.staleSig).toBeUndefined()
	})

	test('a side with neither bytes nor signature is still a 400', async () => {
		app = await build()
		const res = await postRaw(app, {
			aSig: 'g1.' + Buffer.from('{}').toString('base64url')
		})
		expect(res.statusCode).toBe(400)
	})
})

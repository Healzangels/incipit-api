import { afterEach, describe, expect, test } from 'bun:test'
import Fastify, { FastifyInstance } from 'fastify'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

import imagesSimilar, { decodeImage, dhash64, hammingDistance, maxDistance } from '#config/routes/images'

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
		const res = await post(app, Buffer.from('not an image at all'), asJpeg(paintOther(50, 50), 50, 50, 80))
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
		expect(maxDistance()).toBe(4)
	})
})

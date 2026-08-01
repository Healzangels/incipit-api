import { describe, expect, test } from 'bun:test'

import { fetchBoxGuids, fetchServedAnswer, parsePlexBoxes } from '#helpers/series/sweepFetch'

// The drift sweep reads every library record through the api. It runs from an
// operator workstation, which is NOT in RATE_LIMIT_ALLOWLIST, so its own
// concurrency trips the 100/min bucket and the api answers 429. The sweep used
// to score a 429 as "unavailable" — indistinguishable from a genuinely missing
// record — and unavailable rows are deliberately never queued for review. Two
// consecutive full sweeps on 2026-07-31 reported an IDENTICAL 121 unavailable
// records, which is the signature of a rate limiter, not of transient loss:
// ~7.5% of the library was silently exempt from drift detection every run.
//
// A 429 is therefore a RETRY, never an answer. A 404 still is an answer.
const ok = (name: string, position: string) =>
	new Response(JSON.stringify({ seriesPrimary: { name, position } }), { status: 200 })

describe('fetchServedAnswer', () => {
	test('a 200 answers directly', async () => {
		const got = await fetchServedAnswer('http://api', 'B001', {
			fetchImpl: async () => ok('The Legend of Drizzt', '8'),
			sleep: async () => {}
		})
		expect(got).toEqual({
			primary: 'The Legend of Drizzt #8',
			secondary: null,
			available: true
		})
	})

	test('a 429 is retried and the eventual answer is what counts', async () => {
		let calls = 0
		const got = await fetchServedAnswer('http://api', 'B002', {
			fetchImpl: async () => {
				calls += 1
				return calls < 3 ? new Response('slow down', { status: 429 }) : ok('Riyria Chronicles', '1')
			},
			sleep: async () => {}
		})
		expect(calls).toBe(3)
		expect(got.available).toBe(true)
		expect(got.primary).toBe('Riyria Chronicles #1')
	})

	test('a 429 that never clears reports UNAVAILABLE, not a false answer', async () => {
		let calls = 0
		const got = await fetchServedAnswer('http://api', 'B003', {
			fetchImpl: async () => {
				calls += 1
				return new Response('slow down', { status: 429 })
			},
			sleep: async () => {},
			retries: 4
		})
		expect(calls).toBe(5) // the initial attempt plus 4 retries
		expect(got.available).toBe(false)
		expect(got.primary).toBe('UNAVAILABLE(429)')
	})

	test('a 404 is an ANSWER about the record and is never retried', async () => {
		let calls = 0
		const got = await fetchServedAnswer('http://api', 'B004', {
			fetchImpl: async () => {
				calls += 1
				return new Response('not in db', { status: 404 })
			},
			sleep: async () => {}
		})
		expect(calls).toBe(1)
		expect(got).toEqual({ primary: 'UNAVAILABLE(404)', secondary: null, available: false })
	})

	test('backoff honours Retry-After when the limiter states it', async () => {
		const waits: number[] = []
		let calls = 0
		await fetchServedAnswer('http://api', 'B005', {
			fetchImpl: async () => {
				calls += 1
				return calls === 1
					? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } })
					: ok('Jack Ryan', '1')
			},
			sleep: async (ms) => {
				waits.push(ms)
			}
		})
		expect(waits).toEqual([7000])
	})

	test('without Retry-After the backoff grows instead of hammering', async () => {
		const waits: number[] = []
		let calls = 0
		await fetchServedAnswer('http://api', 'B006', {
			fetchImpl: async () => {
				calls += 1
				return calls < 4 ? new Response('slow down', { status: 429 }) : ok('Elric Saga', '2')
			},
			sleep: async (ms) => {
				waits.push(ms)
			}
		})
		expect(waits.length).toBe(3)
		expect(waits[1]).toBeGreaterThan(waits[0])
		expect(waits[2]).toBeGreaterThan(waits[1])
	})

	test('a positionless series still reports its name', async () => {
		const got = await fetchServedAnswer('http://api', 'B007', {
			fetchImpl: async () =>
				new Response(JSON.stringify({ seriesPrimary: { name: 'Warhammer 40,000' } }), {
					status: 200
				}),
			sleep: async () => {}
		})
		expect(got.primary).toBe('Warhammer 40,000 #-')
	})

	test('a network throw is unavailable, not a crash', async () => {
		const got = await fetchServedAnswer('http://api', 'B008', {
			fetchImpl: async () => {
				throw new Error('ECONNREFUSED')
			},
			sleep: async () => {},
			retries: 1
		})
		expect(got.available).toBe(false)
		expect(got.primary).toBe('UNAVAILABLE(error)')
	})
})

/**
 * THE DRIFT GATE MUST NOT PASS BY AUDITING NOTHING.
 *
 * After the privacy scrub, PLEX_BOXES became free-text env input filtered only
 * for truthiness, and the record fetch was `await (await fetch(url)).text()`
 * with no status check at all. A wrong section id or an expired token therefore
 * produced zero guids, every later stage was empty, the `process.exit(1)` review
 * gate was never reached — and the sweep printed "0 distinct records" and exited
 * 0. A gate that reports clean because it looked at nothing is worse than one
 * that fails.
 */
describe('parsePlexBoxes', () => {
	test('parses host:section:label, defaulting the cosmetic label to the host', () => {
		expect(parsePlexBoxes('10.0.0.2:56:test,10.0.0.3:6')).toEqual([
			{ host: '10.0.0.2', section: '56', name: 'test' },
			{ host: '10.0.0.3', section: '6', name: '10.0.0.3' }
		])
	})

	test('rejects a non-numeric section instead of sweeping nothing', () => {
		expect(() => parsePlexBoxes('10.0.0.2:audiobooks:test')).toThrow(/malformed/)
	})

	test('rejects the scheme mis-split, which is the realistic typo', () => {
		// "http://10.0.0.2:56:test".split(':') -> ['http', '//10.0.0.2', '56', 'test'],
		// i.e. host "http", section "//10.0.0.2" — which used to survive as a box
		// and simply return nothing.
		expect(() => parsePlexBoxes('http://10.0.0.2:56:test')).toThrow(/malformed/)
	})

	test('an empty or absent value is an error, not an empty sweep', () => {
		expect(() => parsePlexBoxes('')).toThrow(/PLEX_BOXES must be set/)
		expect(() => parsePlexBoxes(undefined)).toThrow(/PLEX_BOXES must be set/)
		expect(() => parsePlexBoxes('  ,  ')).toThrow(/PLEX_BOXES must be set/)
	})
})

describe('fetchBoxGuids', () => {
	const box = { host: '10.0.0.2', section: '56', name: 'test' }
	const xml =
		'<MediaContainer><Directory guid="com.plexapp.agents.incipit://B001_us"/>' +
		'<Directory guid="com.plexapp.agents.incipit://B002_us"/></MediaContainer>'

	test('returns the record ids', async () => {
		const got = await fetchBoxGuids(box, 'tok', async () => new Response(xml, { status: 200 }))
		expect(got).toEqual(['B001', 'B002'])
	})

	test('a non-OK response throws, naming the box and the status', async () => {
		await expect(
			fetchBoxGuids(box, 'tok', async () => new Response('denied', { status: 401 }))
		).rejects.toThrow(/test .*401/)
	})

	test('an EMPTY section throws — the silent path that made the gate pass', async () => {
		// A wrong section id answers 200 with a container holding nothing.
		await expect(
			fetchBoxGuids(box, 'tok', async () => new Response('<MediaContainer/>', { status: 200 }))
		).rejects.toThrow(/ZERO incipit records/)
	})
})

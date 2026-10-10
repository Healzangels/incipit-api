import { runChaptarrWireCheck } from '#helpers/providers/chaptarrWireCheck'

// Live contract test: the Chaptarr wire canary against the real service (keyless).
// Chaptarr publishes no changelog, so this is how a field rename gets noticed; the
// daily run of the same check is `bun run check:chaptarr` on the homelab. Run with
// `bun run test:live`.
describe('Chaptarr wire (live)', () => {
	it('sends what ChaptarrProvider reads, and the provider still reads it', async () => {
		const report = await runChaptarrWireCheck()
		const failed = report.checks.filter((c) => !c.ok)
		if (failed.length) console.warn('[CHAPTARR WIRE CHANGE]', JSON.stringify(failed))
		expect(report.unreachable).toBe(false)
		expect(failed).toEqual([])
	}, 60000)
})

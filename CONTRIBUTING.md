<!-- omit in toc -->
# Contributing to incipit-api

Thanks for taking the time. This is short and specific: the general advice is the
usual advice, so what follows is what is particular to this codebase.

<!-- omit in toc -->
## Table of Contents

- [Setup](#setup)
- [Running the tests](#running-the-tests)
- [Live tests are separate, and deliberately so](#live-tests-are-separate-and-deliberately-so)
- [Provider work: the two rules](#provider-work-the-two-rules)
- [What a good change looks like here](#what-a-good-change-looks-like-here)
- [Reporting bugs](#reporting-bugs)
- [Licence](#licence)

## Setup

[Bun](https://bun.sh/) 1.3.9+, then `bun install`. Storage is either MongoDB
(`MONGODB_URI`) or SQLite (`DB_BACKEND=sqlite`, `SQLITE_PATH`). Redis is optional to
boot but several features are inert without it — see the README's environment section,
which lists what each variable actually decides.

## Running the tests

```bash
bun run test
```

**Use the script, not a bare `bun test`.** The script names the directories, sets the
timeout and pins `--parallel=1`; running the whole tree yourself picks up suites that
expect services and produces failures that are about your environment rather than your
change.

Before opening a PR:

```bash
bun run lint
```

That is prettier, `tsc --noEmit` and eslint together — the same combination CI runs.

## Live tests are separate, and deliberately so

`tests/live/` talks to real providers, and is not part of the gate. It is
`workflow_dispatch` only, and the reason is worth knowing before you put it back on a
cron: Audible rate-limits the product pages. Measured 2026-08-12, three consecutive
local runs from a residential IP degraded 13 → 12 → 11 passing as the throttle
tightened, and from a GitHub runner's datacenter IP **every** fetch fails. So the daily
job could only ever report failure — and did, every morning — while training the reader
to ignore the one alert that would matter.

If you touch a scraper, run the relevant live test by hand and say in the PR what you
saw.

A live test that cannot reach its provider should **skip**, not fail — and it must not
pass vacuously either. Assert something the response actually proves.

## Provider work: the two rules

**Pace yourself.** Providers rate-limit, and being throttled does not merely slow things
down, it silently costs data: a book served during a 429 window comes back with no
genres, which is indistinguishable at the point of use from a book that has none. Use
`createPacer` (`src/helpers/utils/pacer.ts`) rather than adding another private
gap-and-cooldown. It takes a policy — `'wait'` to hold callers until a cooldown lifts,
`'shed'` for a caller on a serve path with a time budget, which returns immediately and
marks the result degraded.

**A degraded answer is not a miss.** If a lookup failed, was throttled or stood down,
say so and do not cache the empty result as "this does not exist" — otherwise one bad
minute pins a book to nothing for the whole TTL. Caching a genuine empty answer is
correct and necessary; caching a failure is not.

## What a good change looks like here

- **Measure it.** The comments and commit messages in this repo carry numbers, because
  a claim like "this is faster" or "this matches better" is checkable and worth
  checking. Say what you ran it against.
- **Mutate your fix.** Break it deliberately and confirm a test goes red. A green suite
  proves nothing about a test that never constrained the code — more than one bug here
  was found exactly that way, after shipping.
- **Anything touching series or matching needs an A/B.** There is a harness
  (`scripts/seriesHarness.ts`) that scores a golden corpus against required outcomes.
  Run each arm at least twice: it talks to a live mirror, and the first cold run against
  a fresh one reports failures that do not reproduce.
- **A test that mirrors is not a guard.** Asserting the value the code currently
  produces locks in behaviour without describing it. Assert the invariant, so the test
  still means something after a refactor.

## Reporting bugs

Open an issue at
[Healzangels/incipit-api/issues](https://github.com/Healzangels/incipit-api/issues).

Useful to include: the ASIN or search that misbehaved, the response you got and the one
you expected, which providers are enabled, and whether Redis is configured — a
surprising number of "feature does nothing" reports come down to that last one.

Please do not file security issues publicly — raise them privately with the maintainer
through GitHub instead.

## Licence

By contributing you agree your work is provided under this project's licence (GPL-3.0),
inherited from [audnexus](https://github.com/djdembeck/audnexus).

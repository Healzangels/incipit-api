# An unknown member count must cap the cache TTL

Status: proposed
Measured: 2026-08-20

## Symptom

Re-running the series sweep against prod produced 96 CHANGED rows. Verifying the
36 that were primary-series changes against the live API found **33 real and 3
that did not reproduce**. Two of the three share one shape -- a parent series
losing its shelf to one of its own sub-series:

| book | sweep saw | API actually serves |
| --- | --- | --- |
| Wintersmith | Tiffany Aching #3 | Discworld #35 |
| Evershore | Skyward Flight #3 | Skyward #2.3 |

(The third, Joyland, is a different shape -- the sweep saw a series where there
is now none. Not covered by this spec.)

## Mechanism (proven, not inferred)

The ranking picks the parent by member count:

```ts
ranked = [...pool].sort(
    (x, y) => positioned(y) - positioned(x) || (counts.get(y) ?? 0) - (counts.get(x) ?? 0)
)
```

`seriesRecord` returns `count: 0` whenever `/series/{id}` fails to yield
`LinkItems` -- including a 404. And `getJson` classifies 404/410 as **the mirror
ANSWERING**, not degrading:

```ts
const answered = status === 404 || status === 410
if (!answered && state) state.degraded = true
```

So a 404 on the parent's series id gives it `count: 0`, it sorts last, the
sub-series wins, and `countProbe.degraded` is never set. The answer is then
written by the cache path under the **full hit TTL -- 2592000s, 30 days shared**:

```ts
probe.uncacheable ? tuning.uncacheableTtlSeconds : fetched ? hitTtlSeconds : missTtlSeconds
```

An earlier fix already stops that zero being *memoized* in-process. It does not
stop the resulting answer being *cached*. **One 404 pins the narrower shelf for a
month** -- the same "one series, two shelves" split this module exists to
prevent, produced through redis instead of the memo.

### The load-bearing claim

A series the work **declares membership in** cannot genuinely have zero members:
our book is one of them. So `count: 0` on a pooled series is always MISSING
EVIDENCE, never an empty series. That is what makes capping safe rather than
paranoid, and it is why the existing "a REAL empty series" case is not a
counterexample -- for a pooled series that state is unreachable.

### A trap this nearly died in

The first version of the proof test passed, and proved nothing. The alias pass
re-asks the parent (its 404 kept it out of the memo); that 5th call hit an
EXHAUSTED bun mock, which rejects with a plain `Error` carrying no status --
therefore not "answered", therefore degraded, therefore `uncacheable` was set
**by accident**. Production returns a genuine 404 there, which IS classified as
answering, so nothing is set. The test only goes red once the 5th response is
queued as a real 404. The file already warns about this at the Tier One block;
it caught this spec too.

## The fix

A pooled series whose count came back 0 has an UNKNOWN count. When such a series
LOSES the ranking to one with a known count, the answer was decided on missing
evidence, so mark the lookup `uncacheable` -- the module's existing middle state,
already wired to the short TTL (21600s shared / 3600s local) and already used by
the alias path at two sites. This is a third site, not new machinery.

## What deliberately does NOT change

* **The answer.** With the parent's size unknown the sub-arc really is the best
  available read; re-ranking on a guess would be worse. This bounds a guess's
  LIFETIME from 30 days to 6 hours. It does not prevent the wrong shelf, and the
  spec should not be read as claiming it does.
* **Healthy multi-series books.** Guarded by an explicit test -- if every count
  came back, the long TTL is kept. Without that guard "cap it" degenerates into
  "never cache a multi-series book", which would be a large cache-hit regression.
* **Single-series books.** They never enter the ranking and pay no counts.

## Rejected alternatives

* **Retry the count on 404.** The mirror answered; a retry spends a paced request
  to be told the same thing.
* **Rank on name containment** ("Skyward Flight" contains "Skyward") instead of
  count. A genuinely different ranking signal, plausibly better -- and far too
  broad to land inside a bounded fix. It would move shelves across the whole
  corpus and needs its own spec and A/B.
* **Treat 404 on /series as degradation.** Over-broad: it would degrade the whole
  lookup, discarding a sound answer and arming a stand-down for a cosmetic loss.

## A/B plan

Gate is the standing one: **no NEW failures vs baseline** on the 521-row golden
corpus, each arm run twice (a cold first run reports phantom reds). The answer
should not move on any row -- this changes a TTL, not a ranking -- so a corpus
diff of ZERO rows is the expected result and any moved row is a defect in the
fix, not a finding.

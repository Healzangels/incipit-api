# Spec — the fresh-scan confidence ceiling leaves correct matches unapplied

Status: **CLOSED — WON'T FIX.** The gate in §6 was written before the sizing in
§5 was read, and the sizing says ship nothing. Kept as the record of a defect
that is real, understood, and NOT worth a scorer change.

## 1. The defect

`Gav Thorpe — Tales of Heresy` came out of the 2026-08-19 from-scratch rebuild
UNMATCHED (`local://198262`) while `.98` has it correctly on
`Horus Heresy, Book 10`. It was the only unmatched album in 1,706, and it is
not a one-off: the same class produced unmatched books in the 2026-08-05
rebuild too.

## 2. Root cause — measured end to end

**The search works.** The agent searched `Tales of Heresy` (from metadata.json)
with `artist=Gav Thorpe` and the API returned the RIGHT BOOK. The failure is
purely a scoring shortfall against Plex's own auto-apply threshold.

Three facts compound:

1. **A fresh scan has no duration.** Plex sends `'duration': '-1'` (logged) —
   nothing is analysed yet — so `media_duration_ms()` correctly returns None
   (a partial sum would misfire the duration veto, which is worse).
2. **The provider record was SPARSE.** Audible returned `B07RC2W367`: correct
   title, correct subtitle `The Horus Heresy, Book 10`, correct publisher and
   release date — but its author list is truncated to `['Dan Abnett']` for a
   SEVEN-author anthology, and **`runtimeLengthMin: None`**.
3. **The confidence model then cannot reach the threshold.**
   `conf = 0.55*title + 0.30*author + durBonus`, `durBonus` = +0.15 only when
   BOTH sides have a duration. Scored 0.65 -> Plex score 65.
   `PLEX_AUTO_MATCH_SCORE = 80`. Not applied.

### The arithmetic is the finding

With no duration signal the ceiling is **0.85** (perfect title + perfect
author). Clearing 80 therefore requires `0.30*a >= 0.25`, i.e. **the author arm
must score >= 0.833**. Any author imperfection — a truncated contributor list,
an anthology, a "with" credit — fails the whole match on a fresh scan.

### It does not self-heal

* A refresh does NOT fix it: once Plex writes `local://`, the guid is sticky and
  a refresh never re-searches. Verified live 2026-08-19 — refreshed after the
  file WAS analysed, still `local://`. Only `PUT /match` re-points it.
* Even post-analysis the candidate scores **79** — one point short — because
  `B07RC2W367` carries no runtime, so the +0.15 can never apply to it however
  much Plex knows about the file.

### The input is non-deterministic
Audible returned the sparse `B07RC2W367` during the rebuild and the COMPLETE
`1789997100` (all 7 authors, `runtimeLengthMin: 690`, delta 0.6 min vs the
file) to a manual query minutes later. Same query, same params. **Any fix must
survive the provider returning either record.**

## 3. What is NOT the cause (each checked, each refuted)

* **NOT the author arm mishandling multi-author works.** `matchScorer.ts:252`
  already takes `Math.max` over every candidate author; a seventh-listed author
  scores fine WHEN the provider lists them.
* **NOT a bad search.** The log shows `Found 1 result(s) for query "Tales of
  Heresy"` and `Title is Tales of Heresy`.
* **NOT the album fragmentation / bulk-scan class** — unrelated defect.
* **NOT fixable by a pin.** The operator's instruction was explicit: fix it in
  code, "we don't want to fix it every time". A pin also could not have helped
  here — the album never reached a shelf to pin.

## 4. Candidate designs, and the objection to each

**D1. Series corroboration.** Give a candidate whose OWN series (name AND
position, e.g. subtitle `The Horus Heresy, Book 10`) agrees with the search's
stated series a bonus in the shape of `durBonus`.
*Objection:* `BookSearchHelper` documents `seriesPosition` as **penalise-only
and integers-only**, deliberately — "these positions come from the same
sidecars known to carry wrong ASINs and cannot be trusted to promote a
candidate". D1 overturns a decision made ON EVIDENCE. Requiring the series NAME
to match too is a materially higher bar than position alone, but that claim
needs measuring, not asserting.

**D2. Redistribute the weight when the candidate has no runtime.**
e.g. `0.65*t + 0.35*a` when `candAudioSeconds` is null.
*Objection: DOES NOT FIX THIS CASE.* Worked through: 0.65 + 0.35*0.33 = 0.765,
still below 80. It also silently changes scoring for every runtime-less
candidate in the library.

**D3. Author-arm leniency for truncated lists.**
*Objection: not implementable.* A truncated list is indistinguishable from a
genuinely single-author book at the candidate.

**D4. Second-look on a near-miss.** When the winning candidate lands in a band
just below the threshold, re-query for a better record of the SAME book (the
complete `1789997100` exists and scores 0.85 without duration / 1.0 with it).
*Objection:* costs an extra provider round trip per near-miss book, on a path
already measured at 5-12s/book during a cold rebuild (~90 min for 1,885
albums). Needs a bound on how many books would trigger it — which is §5.

## 5. SIZING (the measurement that picks the design)

Re-search a 150-album random sample exactly as a fresh scan would
(title + author, NO duration) and bucket the winning candidate's score:

| band | meaning |
|---|---|
| >= 85 | safe |
| 80-84 | applies, but with NO margin |
| 75-79 | FAILS — near miss, the Tales of Heresy band |
| < 75 | fails outright |

Also counted: how many winning candidates have NO `runtimeLengthMin` (the
population that can never earn the +0.15).

**RESULT (150-album random sample, 2026-08-19):**

| band | count | |
|---|---:|---|
| >= 85 (safe) | 144 | 96% |
| 80-84 (applies, no margin) | 5 | 3% |
| **75-79 (FAILS, near miss)** | **0** | **0%** |
| < 75 (fails) | 1 | 0% |
| no result at all | 0 | |

The single `< 75` is **not a scoring failure**: it is `The White Dragon`, which
scored 66 only because that album's TITLE was itself polluted (see §5a). Its
title was repaired by a refresh, after which it searches normally. **The sample
contains ZERO genuine fresh-scan scoring failures.**

⚠️ A line in the first run of this measurement reported "candidates whose record
has NO runtimeLengthMin: 150" — that was a BUG IN THE MEASUREMENT, not a
finding. Search results carry `audioSeconds`, not `runtimeLengthMin`; the probe
read the wrong field and every row read as null. Discarded.

### 5a. A SECOND, unrelated defect found while sizing

`The White Dragon` matched the CORRECT record (same guid as gold,
`B002V1LIGQ_us`) and then kept the m4b's own album tag as its title:

    gold  title 'The White Dragon'   sort 'Pern, Book 5 - The White Dragon'
    .99   title '"The White Dragon" by A.McCaffrey w/ '   sort 'White Dragon" by A.McCaffrey w/ '

Same class as the 2026-08-05 rebuild's 34 albums titled
`"The Way of Kings" by B.Sanderson w/ K.Reading`, which were rate-limit
collateral. Here it is **1 album in 1,706**, and **a refresh repaired it
completely**. Filed as another second-pass item, not a code defect.

## 6. GATE — stated before the numbers were read; VERDICT: ship nothing

* If the **75-79 band is 0 and 80-84 is small**, Tales of Heresy is an outlier.
  Ship NOTHING; record the `PUT /match` remedy and the sticky-guid trap. A
  scorer change to fix one book in 1,706 is not worth the blast radius.
* If **75-79 is non-trivial**, this is a standing tax on every rebuild and a
  design is justified — **D4 first** (it changes no weights and cannot move a
  book that already matches), D1 only if D4 cannot reach.
* If **80-84 is large**, the ceiling itself is the problem: many correct matches
  apply with zero margin and any provider wobble drops them. That argues for
  D1, and for treating the 0.85 ceiling as the defect rather than the symptom.

## 7. A/B required before shipping

Per the standing directive and `docs/design/README.md`. Blast radius: every one
of 1,706 albums.

1. `bun run test` green; new tests for the chosen design, each mutated red.
2. Harness arm A baselined, arm B `--gate` x2 with an allow file of exactly the
   predicted movers. **Any unpredicted mover is a blocker.**
3. The specific assertion: `Tales of Heresy` scored as a FRESH SCAN
   (title + author, no duration) reaches >= 80.
4. Re-run §5's sizing after the change: the 75-79 band must shrink and the
   >= 85 band must not.


## 8. VERDICT and the remedies that ARE recorded

`75-79` is **empty** and `80-84` is 3%, so by §6 this ships **nothing**. A
change to the confidence model would touch all 1,706 albums to fix one, and
tonight already produced a spec whose "obvious" fix was refuted by its own A/B.

The 0.85 fresh-scan ceiling is REAL and worth knowing — it is why a rebuild
cannot rely on author-imperfect matches — but 96% of the library clears it with
margin, so it is a property to remember, not a defect to repair.

**Operational remedies to use instead:**

1. **A from-scratch rebuild needs a SECOND PASS.** Three independent defects in
   the 2026-08-19 rebuild were bulk-scan artifacts that a second pass repairs:
   292 albums with the wrong poster selected, 5 fragmented folders (needs the
   MERGE endpoint, not a refresh), and this 1 polluted title.
2. **An unmatched album cannot be refreshed back.** Once Plex writes
   `local://`, the guid is STICKY — a refresh never re-searches. Verified live:
   refreshed AFTER the file was analysed, still `local://`. Only
   `PUT /library/metadata/{rk}/match?guid=...&name=...` re-points it.
3. `Tales of Heresy` was re-matched by hand to `1789997100_us` and now serves
   `Horus Heresy, Book 10 - Tales of Heresy`, matching gold. Library: 1706/1706.

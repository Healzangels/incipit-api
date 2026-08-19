# Spec — the edition-preservation guard freezes stale provider series

Status: **A/B RUN 2026-08-18 — R1 SHIPS, R2 NARROWED, one prediction FALSIFIED (§7).** Gate stated before measuring (§5).

## 1. The defect, as reported

Three Anne McCaffrey albums off the `Pern, Book N` shelf that the other 19
sit on correctly:

| album | serves | should serve |
|---|---|---|
| Dragonsinger | Harper Hall of Pern **#19** | Pern #4 |
| Dragondrums | Harper Hall of Pern #3 | (see §3 — not this defect) |
| A Gift of Dragons | Pern (Chronological Order) #15 | Pern, folder-numbered |

`#19` is `Pern (Chronological Order)`'s number wearing Harper Hall's name.
`(Chronological Order)` is a publication ORDERING — the class
`isSeriesOrdering` exists to demote and the resolver never emits.

## 2. Root cause — proven by isolation, not inferred

A cold `withGoodreadsSeries` on a BARE book (title + author only) returns
the right answer for all three: `Pern #4`, `Pern #6`, positionless `Pern`.
So the resolver — ranking, `positionFor`, the trailing-space `Pern ` name —
is NOT the bug. Every earlier hypothesis on this thread was wrong; the
resolver's own debug log named the mechanism:

**Dragonsinger** — stored subtitle `"Harper Hall Trilogy, Volume 2"`.
`EDITION_MARKER_RE` contains `trilogy`; the record is classed as a specific
edition, and the edition-preservation guard keeps the incumbent
`Harper Hall of Pern #19` unexamined:
> `goodreads series: title names a specific edition, keeping the provider series`

Remove EITHER the subtitle OR the stale primary and the resolver returns
`Pern #4`. The guard is the entire mechanism.

**A Gift of Dragons** — no subtitle. Goodreads returns positionless `Pern`
(the only clean listing carries librarian free-text `'16.5 + 4.5, 8.5 &
15.5'`, which `isShelvablePosition` rightly refuses). The not-shelvable
guard then keeps the incumbent — an ORDERING — unexamined:
> `goodreads series: answer not shelvable, keeping the provider series`

## 3. What is NOT this defect

**Dragondrums** carries a provider primary WITH an Audible ASIN
(`B005NAMI2U`), and Audible's own lead series for that product really is
`Harper Hall of Pern #3` (live catalog probe 2026-08-18: pub_name and
series[0] both Harper Hall). That is the edition rule keeping REAL provider
data — right position, coarser shelf, defensible. Untouched by this spec.

## 4. The general shape, and the measurement that fixes the design

Four keep-guards in `seriesEnriched` share one shape: `if (hadSeries && X)
return book` — each keeps `book.seriesPrimary` **without asking what it
is**. A stale position, an ordering, an umbrella: once on a record that
trips any guard, no recompute can ever correct it. `?force=1` on the books
route does not move it either. **The guard does not cause errors; it makes
any pre-existing error permanent.**

Measured over the golden corpus (518 rows), 2026-08-18:

* **`trilogy`/`duology` as an edition marker is wrong 13 times in 14.**
  14 title/subtitle hits; 13 are `<Series> Trilogy, Book N` — an ordinary
  series volume (Drizzt sub-arcs, Kharkanas, Southern Reach, Void,
  Skinjacker, Magister, Night's Dawn). Exactly one, `The Society of the
  Sword Trilogy` (a bare title, no volume), is a genuine omnibus. The
  SHAPE `<word> … (Volume|Book|Part) N` separates them perfectly: 13/1.
* All 13 shaped rows serve CORRECTLY today — because their provider input
  was already right. That is precisely the point: the guard is invisible
  until the incumbent is wrong.
* **23 corpus rows carry a provider primary that is ITSELF an ordering**
  (21 × `A Jack Ryan Novel (chronological order)`, 2 × `The Chronicles of
  Narnia (Publication Order)`), all requiring the real shelf. Every one is
  one resolver stumble away from being frozen on the ordering.

## 5. Fix — two rules, both at the guard, gate stated first

**R1. A series-shaped subtitle is not an edition marker.** `<word>` followed
by `, Volume N` / `, Book N` / `Part N` names a series and a volume; strip
that shape before applying `EDITION_MARKER_RE`. `trilogy`/`duology` stay
in the vocabulary for the bare-title omnibus case (Society of the Sword).

**R2. No keep-guard keeps an incumbent the resolver would refuse to emit.**
If `book.seriesPrimary.name` is an ordering (`isSeriesOrdering`) the
guards do not preserve it: the edition guard, the not-shelvable guard and
the variant-only guard fall through and let the Goodreads answer land —
including a positionless one, which the folder can number. This is the
same doctrine as `rescueWouldSpendItsOwnSubSeries`: preservation is for
answers worth preserving.

**Gate, stated before running:** `bun run test` green; new tests for R1
(shaped subtitle NOT edition-marked; bare "…Trilogy" title still IS;
Dragonsinger's exact record resolves to Pern #4) and R2 (ordering
incumbent is not kept under each of the three guards; a REAL provider
series still is), each mutated red; harness arm A baselined then arm B
`--gate` ×2 with an allow file of exactly the predicted movers; **any
non-Pern mover is a blocker.** Prediction: the 13 shaped rows and the 23
ordering-provider rows are UNCHANGED (their answers were already right or
already overridden), and only Dragonsinger + A Gift of Dragons move.

## 6. Why not pins

Pins would fix both records in five minutes and hide a guard that has
frozen a wrong answer once and will again on the next stale import — the
Elderlings spec shipped pins because the general fix was REFUTED; here the
general fix is measured safe (13/1 shape split, 0 currently-correct rows
predicted to move) and small.

## 7. A/B results — the gate did its job

Arm A (pre-fix, source stashed) ×2: exactly the two Pern rows red, runs
identical, the harness reproducing the live defect from corpus inputs alone
(`Harper Hall of Pern #19`, `Pern (Chronological Order) #15`). Arm B (fix)
×2, 520 rows: **10 rows moved, not 2.** The prediction in §5 that the 13
shaped rows would be unchanged was WRONG for 8 of them — and the reason is
the finding of the whole exercise:

**Those rows were correct because they were FROZEN.** `trilogy` in the
subtitle tripped the guard, the guard kept the provider name, and Goodreads
authority never got a vote. Unfreeze them and it votes for the first time:

* 7 rows: article-only renames, still MATCH — `Legend of Drizzt` →
  `The Legend of Drizzt` (×5), `Skinjacker Trilogy` → `The …`, `Magister
  Trilogy` → `The …`. These bring the frozen rows INTO LINE with their
  unfrozen siblings on the same shelves; the frozen spelling was the outlier.
* 1 row: a real rename — `The Evolutionary Void`: `Void Trilogy #3` →
  `Void #3`. Goodreads names the series `Void`; the corpus requires the
  provider's `Void Trilogy`. Position kept. **This is the unpredicted mover
  and, per §5, a blocker until decided.**
* Dragonsinger: HEALED to `Pern #4`. ✓
* A Gift of Dragons: `Pern (Chronological Order) #15` → **MISSING_SERIES**.

**Gift of Dragons falsifies its own requirement.** R2 correctly refuses the
ordering and the resolver returns positionless `Pern` — but `applyShelfPolicy`
demotes a positionless primary to the TAG slot by design ("primary absent or
positionless: the shelf is the positioned secondary; else no shelf"). There
is no shelvable position anywhere: the mirror's one clean listing carries
librarian free-text `'16.5 + 4.5, 8.5 & 15.5'` — an anthology of four short
stories that Goodreads itself could not number. The choice is therefore
NOT "Pern #N vs an ordering"; it is "a positioned ORDERING shelf" vs
"tag-only Pern, folder-sorted". The row's `required.position: null` was
written believing the pipeline shelved a positionless primary. It does not.

### Decisions

**R1 ships as written.** The 7 article renames are convergence, not
regression; `bun run test` 2421/0; 7/7 mutations caught.

**R2 is NARROWED to the edition guard only.** At the not-shelvable and
variant-only guards, letting an ordering incumbent fall through trades a
positioned (if ugly) shelf for NO shelf, because the resolver's answer at
those two guards is by definition unshelvable. That is worse for the reader.
The rule stands where the resolver HAS a shelvable answer (edition guard);
it is withdrawn where it cannot. Gift of Dragons keeps `Pern (Chronological
Order) #15` — an ordering, positioned, and the only positioned answer that
exists — with its corpus row re-required to say so honestly (outcome SERIES,
series `Pern (Chronological Order)`, position 15, note explaining why).

**Evolutionary Void: the corpus is corrected, not the code — but only after
the sibling check.** First instinct was wrong twice. (a) "Goodreads is the
authority, re-require it" — too fast: prod serves `Void Trilogy` for ALL
THREE Void books, including books 1 and 2 whose titles carry no marker and
were never frozen, so R1 would seem to flip book 3 alone and SPLIT a uniform
shelf — the exact defect this module exists to prevent. (b) So the fix was
about to be blocked. Then the cold recompute: `The Dreaming Void` (no marker,
never frozen) resolves to `Void #1` TODAY, pre-fix. Its prod `Void Trilogy #1`
is warm cache — the Assassin's Quest trap again. All three books cold-resolve
to `Void`; the shelf CONVERGES on Goodreads' name with or without R1. R1 only
removes the one book that could never converge. Corpus row re-required to
`Void #3`, sourceOfTruth citing this measurement.

**Rule learned, twice in one night: a "settled" serving is not evidence until
it has been cold-recomputed.**

## 8. Final A/B — the shipped change

Arm B′ (R1 + R2-narrowed) ×2, gated against the arm-A baseline with an allow
file of one row (Dragonsinger): **gate PASS both runs, 2 HEALED, 0 new
failures.** Full served-answer diff, arm A → arm B′, **9 of 520 rows moved,
every one named**:

| row | A | B′ | class |
|---|---|---|---|
| Dragonsinger | Harper Hall of Pern #19 | **Pern #4** | MATCH |
| The Evolutionary Void | Void Trilogy #3 | Void #3 | MATCH (re-required, §7) |
| Legend of Drizzt ×5 | Legend of Drizzt #N | The Legend of Drizzt #N | MATCH |
| Everfound | Skinjacker Trilogy #3 | The Skinjacker Trilogy #3 | MATCH |
| Legacy of Kings | Magister Trilogy #3 | The Magister Trilogy #3 | MATCH |

Rows MATCH in A and not in B′: **0**. A Gift of Dragons: unchanged at
`Pern (Chronological Order) #15` by decision (§7). The 23 ordering-provider
rows (Jack Ryan, Narnia): unmoved. The 6 Hobb pins: unmoved.

`bun run test` 2421/0 · 7/7 mutations caught against the FINAL rule
(including two that assert R2 must NOT be re-widened) · baseline re-written
post-fix to 0 standing reds.

# Spec — shelf granularity: which of a work's competing series is the shelf

Status: **SHIPPED AND LIVE 2026-09-05 — A/B complete, ten pins retired at the
operator's direction (seven Hobb, three Bill Hodges), all gates green, deployed
to prod as `6910735` and verified by digest.** Supersedes
`spec-franchise-umbrella-detection.md` (2026-08-18), whose §6 named member-set
containment as "the one viable general design" — §4.1 below refutes that with
full member sets. §§1–5 are the problem statement and measurements as they stood
before the change; §§6–10 are the design, the A/B, the release and its checks.

Operator framing, verbatim: *"I feel like this could be the crux of the whole
project with proper series as it ruins the sorting/series order within plex."*
That is the right weight. This document exists to make the next attempt cheaper,
not to justify a rule that reads well.

## 1. The defect as the operator experiences it

Goodreads lists several series on one work. One of them becomes the Plex shelf
(`titleSort` = `<Series>, Book <N> - <Title>`). When different books of one
continuum resolve to different winners, the author's shelf **splits**, and Plex
sorts each fragment separately. That is the damage — not the name itself.

Live on prod, Robin Hobb, 2026-09-05 (13 albums, one author, one world):

| Album | Shelved as | Correct |
| --- | --- | --- |
| Assassin's Apprentice / Royal Assassin / Assassin's Quest | Farseer Trilogy 1–3 | ✓ (pinned) |
| Ship of Magic / Mad Ship / Ship of Destiny | Liveship Traders 1–3 | ✓ (pinned) |
| Blood of Dragons | Rain Wild Chronicles 4 | ✓ (pinned) |
| Fool's Assassin | Fitz and the Fool 1 | ✓ (only one candidate) |
| **Fool's Fate** | **Realm of the Elderlings 9** | The Tawny Man 3 |
| **Dragon Keeper** | **Realm of the Elderlings 10** | Rain Wild Chronicles 1 |
| **Dragon Haven** | **Realm of the Elderlings 11** | Rain Wild Chronicles 2 |
| **City of Dragons** | **Realm of the Elderlings 12** | Rain Wild Chronicles 3 |

The split is caused by **partial pin coverage**: seven operator pins from
2026-08-18 hold the sub-series, and every book added since falls through to the
ranking, which picks the umbrella. Without pins the shelf would be uniformly
wrong; with complete pins uniformly right. Pins cannot close this — four more
Elderlings books exist (Fool's Errand, Golden Fool, Fool's Quest, Assassin's
Fate) and each will arrive the same way. This is the Magic Tree House shape
recorded in `incipit-series-pin-workflow`: *a pin covers one record, so a
growing series out-runs it.*

## 2. What the ranking does today

`goodreadsSeries.ts`, one comparator:

```ts
ranked = [...pool].sort(
  (x, y) => positioned(y) - positioned(x) || (counts.get(y) ?? 0) - (counts.get(x) ?? 0)
)
```

Positioned candidates first; among those, **most members wins**. Two filters run
before it: `isSeriesOrdering` (name contains `chronological`, `publication order`,
`split-volume`, `omnibus`, `box set`, `edition`, …) and `isUmbrella`
(`/\b\w*verse\b/` with a stopword list). `CONTAINER_SHELF_NAMES` is a *second,
separate* umbrella mechanism in `shelfPolicy.ts`, a curated name set applied one
layer later.

**`The Realm of the Elderlings` matches none of them** — no `-verse`, no ordering
word, absent from the curated set — so it enters the pool clean and wins on 25
members against Farseer's 7.

## 3. Measured: today's rule is right far more often than it is wrong

Census of `tests/fixtures/series-ledger.json` (1,607 reviewed records):
**306 records (19%) carry both a primary and a competing secondary.** The
primaries that most often sit above a competitor:

| Primary | Albums | Sits above |
| --- | --- | --- |
| Discworld | 43 | Discworld – Death, – City Watch, – Industrial Revolution |
| Jack Ryan | 33 | A Jack Ryan Jr. Novel, A Jack Ryan Novel (publication order) |
| The Legend of Drizzt | 25 | Companions Codex, Generations, Die vergessenen Welten |
| The Chronicles of the Black Company | 12 | Les Annales de la Compagnie Noire, … |
| The Chronicles of Amber | 9 | Amber: The Corwin Cycle, Amber: The Merlin Cycle |
| The Mistborn Saga | 8 | Mistborn Era 1, Wax and Wayne, The Cosmere |
| The Stormlight Archive | 7 | The Cosmere |
| Gaunt's Ghosts / Ahriman | 7 | Warhammer 40,000 |

In nearly all of these the **parent is the shelf the operator wants**, and the
last two rows show the existing umbrella machinery already working (Cosmere and
Warhammer 40,000 correctly demoted). Any change to the comparator is therefore
touching ~306 records to fix ~16. **Blast radius is the dominant risk in this
design, not cleverness.**

## 4. Refuted approaches — measured 2026-09-05, do not re-walk

Probe set: 12 works spanning every failure class *and* the counterexamples where
the parent is correctly the shelf (Legend of Drizzt over Legacy of the Drow, Pern
over Harper Hall, Holly Gibney standing alone). Full member sets pulled from the
mirror's `/series/:id` `LinkItems`.

### 4.1 Member-set containment — REFUTES the prior spec's §6

`members(child) ⊆ members(parent)` is **false in every pair measured**, because
Goodreads member sets are polluted with edition- and translation-works:

| Pair | Shared | Child-only | Containment |
| --- | --- | --- | --- |
| Elderlings (25) ⊇ Farseer (7) | 4 | 3 | **FALSE** |
| Elderlings (25) ⊇ Rain Wild (7) | 5 | 2 | **FALSE** |
| Elderlings (25) ⊇ Tawny Man (4) | 3 | 1 | **FALSE** |
| Legend of Drizzt (46) ⊇ Legacy of the Drow (7) | 5 | 2 | **FALSE** |
| L'Assassin royal (25) ∩ Farseer (7) | 3 | 4 | (parallel) |

The August measurement checked three hand-picked work ids and concluded
containment held; over full sets it does not. Worse, a *thresholded* overlap does
not rescue it: the true parent (Drizzt/Legacy, 71% of child covered) and the
umbrella (Elderlings/Rain Wild, 71%) are **identical**, while the correct
Elderlings/Farseer pair (57%) sits *below* them. There is no threshold that
separates "parent that shelves" from "umbrella that does not".

### 4.2 Librarian links as a hierarchy signal

The ranking already parses `/series/NNNN` hrefs out of descriptions under
`Also known as:` and `Sub-series:`. Direction is genuinely encoded where links
exist — Legacy of the Drow says *"part of the larger Legend of Drizzt"*, Legend of
Drizzt lists its arcs. But links are **absent exactly where they are needed**:

* Dragon Haven — **no candidate links any other**. Elderlings ↮ Rain Wild.
* Fool's Fate — none. Sailor on the Seas of Fate — none. Philosopher's Stone — none.
* Malazan's Polish and Italian re-listings — none.

Sporadic librarian annotation cannot carry a general rule.

### 4.3 Cheaper signals, all dead

* **Member count direction** — no consistent answer: the operator's pick is the
  smallest candidate for Hobb, the middle for Elric and Drizzt, the largest for
  Malazan.
* **Description length** — correct answer is longest for Farseer/Drizzt, shortest
  for Harry Potter, middle for Elric. No correlation.
* **`LinkItems[].Primary`** — `false` on every member of every series measured.
  A dead field; do not build on it.

### 4.4 One case in this cluster has a different root cause

**A Gift of Dragons** was filed as an umbrella/variant defect. It is not. Its
position in `Pern` is the free-text string `16.5 + 4.5, 8.5 & 15.5`, which
`isShelvablePosition` correctly rejects, so the only *positioned* candidate left
is `Pern (Chronological Order) #15`. The ranking is behaving exactly as designed.
Fixing umbrellas will not touch it; it needs compound-position parsing or a pin.

## 5. The irreducible finding

**Umbrella-ness is not inferable from Goodreads structure.** A franchise umbrella
and a legitimate parent series are graph-isomorphic: both list many members, both
overlap their children partially, both may or may not link them, both carry a
position for our work. The distinction is a *publishing and cultural* fact —
whether readers and the publisher treat the parent as the thing on the spine —
and Goodreads does not encode it.

Every general rule attempted (three in August, four more today) has failed on
that. The design below therefore stops trying to infer it, and instead makes the
judgement **cheap to state, safe to apply, and automatic to surface**.

## 6. Proposed design

### 6.1 Declare the relation as ID-keyed data, once per franchise

```ts
/** Goodreads series ids that never shelve when a non-umbrella rival can. */
export const UMBRELLA_SERIES: ReadonlySet<number> = new Set([
  54099,  // The Realm of the Elderlings — operator-stated 2026-09-05
  318697, // Holly Gibney — see below
])
```

**Holly Gibney is a second instance, not a counterexample.** Arm A (pins off)
shows the Bill Hodges trilogy failing exactly like Hobb: `Holly Gibney` (7
members) beats `Bill Hodges` (3) on count, and the corpus requires Bill Hodges
1–3. The memory recorded Holly Gibney as *the* counterexample to umbrella
classification because it shelves four albums of its own (The Outsider, If It
Bleeds, Holly, Never Flinch) — true at the **shelf layer**, where
`CONTAINER_SHELF_NAMES` would blank them. At the **ranking layer** it is exactly
what the rescue path is for: The Outsider has Holly Gibney as its *only*
candidate, so the umbrella is rescued and shelves it; Mr. Mercedes has Bill
Hodges as a clean positioned candidate, so the umbrella loses. One declaration,
both outcomes. Including it in B1 is the deliberate stress test of §6.2.

Keyed by **Goodreads series id, not name**: exact, immune to folding and
orthography, language-independent, and it survives a librarian rename. One entry
covers all 16 Elderlings books, the four already in the library and the four not
yet added — which is the property pins lack.

### 6.2 Extend the ONE existing predicate; the rescue path is the no-blanking guarantee

Reading the pool construction (`goodreadsSeries.ts` ~L1990) changed this section.
`isUmbrella` already DROPS umbrellas from the clean pool, and a **rescue path
already exists**: when no clean candidate can position the book, umbrellas that
can are let back in (`rescued`, `rescuedOver`). So "demote, never remove" is not
a new mechanism to design — it is how the code works today for `-verse`
umbrellas. The change is therefore one line of intent: `isUmbrella` also returns
true for ids in `UMBRELLA_SERIES`. No third mechanism; the §8 consolidation risk
shrinks rather than grows.

The August `CONTAINER_SHELF_NAMES` failure *blanked three books* because it acts
at the SHELF layer, after the pool is gone, with nothing to put back. At the
ranking layer the rescue makes blanking impossible; the worst case is today.

### 6.3 Demote parallel listings in the same change — the sequencing lesson

August's attempt failed because removing the umbrella **exposed the translation**:
with Elderlings gone, `L'Assassin royal` (25 members) beats Farseer (7). Any
umbrella change that ships without handling parallel listings makes Assassin's
Apprentice *worse*, not better.

Two mechanisms, to be measured against each other:

1. **Same table, second kind** — `PARALLEL_LISTINGS: Set<number>` holding
   translated/renumbered re-listings (`L'Assassin royal` 89770, `Vatídico`
   174690, `A Saga do Assassino` 65022, `Les cités des Anciens`). Same
   properties as 6.1; costs curation.
2. **Widen the deny-heading extraction** — all three Hobb translations *are*
   href-linked from Farseer's own description, but under
   `Editions with different numbering:` and in the prose phrase
   `…in French under the name:`, neither of which the current
   `/also\s+known\s+as/` heading matches. Widening is nearly free and generalises
   to any series whose librarians annotated it.

   **Measured 2026-09-05 (dry-run over all harvested descriptions):** the
   Tawny Man risk is real and is resolved by anchoring the prose form to the ONE
   link immediately after `under the name:`. Farseer's block 3 reads *"combined
   with the <Tawny Man> trilogy in French under the name: <L'assassin royal>"* —
   the anchored form takes 89770 and leaves 45182. Result over the 8
   multi-candidate probes: denies exactly `L'Assassin royal`, `Vatídico`,
   `A Saga do Assassino` (all by Farseer's own description); **0 expected
   shelves denied**.

   **REFUTED in the same dry-run — the naive "deny every link any candidate
   makes":** parents and children link EACH OTHER (Drizzt lists Legacy of the
   Drow as an arc; Legacy says "part of the larger Legend of Drizzt"), so it
   denies both — it would have stripped **Farseer, Legend of Drizzt and
   Malazan** of their correct shelves. Direction, carried by the surrounding
   text, is not optional.

   Implemented as a separate, exported, unit-tested pure function
   (`goodreadsParallelListings.ts: parallelListingIds`), in the same spirit as
   `isSeriesOrdering` — the vocabulary is testable on its own. Wiring it into the
   pool is the B2 arm of the A/B. Mechanism 2 is therefore preferred over the
   curated `PARALLEL_LISTINGS` set: it generalises to any series whose
   librarians annotated it, and costs no curation.

### 6.4 Surface the next one automatically — the actual generality

The operator found this defect by noticing Plex sorting was wrong. That is the
failure to fix at the system level. The signal is already computable from the
ledger the monthly sweep maintains:

> For each primary P, collect the distinct positioned secondaries it sits above.
> P sitting above **two or more mutually disjoint** sub-series is umbrella-shaped.

Prototyped 2026-09-05, two feeds, opposite results:

* **Fed from the reviewed ledger (what serves today):** 15 umbrella-shaped
  primaries, led by Discworld (12 sub-series beneath), Drizzt (8), Black Company,
  Jack Ryan, Amber — **nearly all correct parents**, and **The Realm of the
  Elderlings is absent**. The ledger records *serving*, and with pins on, the
  Hobb rows serve the sub-series as primary. **A detector fed from pinned serving
  cannot see the umbrellas the pins mask** — which are precisely the ones that
  matter. Half the "sub-series" it lists are translations (Kolekcja Świat Dysku,
  Les Annales de la Compagnie Noire, La Roue du Temps, Le cronache…), so the same
  pass is also a parallel-listing census for §6.3.
* **Fed from pins-off serving (arm A `--no-pins --out`):** the queue is
  `The Realm of the Elderlings — 3 sub-series, 7 albums`, then `Holly Gibney —
  1 sub-series (Bill Hodges), 3 albums`, then the Jack Ryan cluster, then a tail
  of single-album oddities. **The two true umbrellas rank first.**

Two displacement *directions* appear in that queue and they are different
defects: Elderlings and Holly Gibney are a **large series displacing a small
required one** (umbrella over sub-series; remedy = declare the umbrella), while
`Jack Ryan, Jr.` / `John Clark` / `A Jack Ryan Novel (chronological order)` are
**small series displacing the large required one** (sub-arc or variant over
parent; remedy = ordering/alias rules, already the pinned Jack Ryan cluster). The
queue must show direction, which needs member counts the harness `--out` does not
carry today — add them.

So: a **review queue, not a classifier**, fed from **pins-off** serving (the
`--no-pins` harness arm is the right producer, not the ledger), ranked by
sub-series breadth then album count. It turns "the user notices their shelf is
split" into "the run prints two names to confirm", the same posture the duration
oracle and the drift ledger already take. A `≥2 distinct sub-series` threshold
would keep Elderlings and drop Holly Gibney; `displaces a required shelf on ≥2
albums` keeps both — prefer the latter and let the operator read direction.

## 7. Measurement plan (required before any ship) — and results as they land

**Arm A, 2026-09-05, two runs, pins disabled, today's code:** 463 MATCH /
33 WRONG_SERIES / 15 WRONG_POSITION / 10 MISSING_SERIES, **byte-identical
across both runs (0 rows moved)**. The 58 reds are what the pins mask today:
7 Hobb → Elderlings, 3 Bill Hodges → Holly Gibney, ~32 Jack Ryan (a
separately-pinned renumbering cluster), remainder documented in memory. With
zero run-to-run noise, any movement in arm B is signal.

**B1 applied (`UMBRELLA_SERIES` {54099, 318697}, `isUmbrella` consults it
first):** hermetic gate 2,472 pass / 0 fail; three behavioral tests green
(declared umbrella loses to a smaller clean sub-series and its member count is
never fetched; a lone declared umbrella is rescued and flagged `variantOnly`;
Bill Hodges beats Holly Gibney on Mr. Mercedes).

**B1 harness, two runs, pins disabled:** MATCH 463 → **471**, WRONG_SERIES 33 →
25, both runs byte-identical.
* **HEALED 8, without pins:** Royal Assassin, Ship of Magic, Mad Ship, Ship of
  Destiny, Blood of Dragons → their sub-trilogies; Mr. Mercedes, Finders Keepers,
  End of Watch → `Bill Hodges #1–3`. Five of the seven Hobb pins are proved
  redundant by this arm alone.
* **BROKE 0.** All 463 previously-matching rows unmoved — the 306
  competing-secondary records (Discworld, Jack Ryan, Drizzt, Amber, Mistborn
  canaries) and the ~32-row Jack Ryan cluster included. Zero regression budget
  met.
* **Moved red→red, 2 — the predicted sequencing failure, reproduced:**
  Assassin's Apprentice `Elderlings #1 → L'Assassin royal #1`, Assassin's Quest
  `Elderlings #3 → L'Assassin royal #3`. Demoting the umbrella exposed the
  French listing (25 members) over Farseer (7), exactly as §6.3 states. **B1
  alone must not ship**; these two rows are B2's acceptance test.
* **B1 edit mutation-tested:** Elderlings id ±1 → 1 red; id check removed → 3
  red; Holly Gibney id ±1 → 2 red; source restored byte-identical each time.

**B2 applied on B1** (`parallelListingIds` over every pool description; denied
candidates filtered out of `ranked` unless that would empty it): prettier and
tsc clean, 154 unit tests green.

**Wiring test trap, caught by its own control (2026-09-05):** the first draft of
`goodreadsParallelListingsRanking.test.ts` reused Farseer's live id across two
tests. `seriesRecord` memoizes `/series/{id}` for the process lifetime, so the
control (no description) received test 1's record *with* the description and
the deny fired anyway — the first gate with B2 read 2,477/1 on exactly that row.
Per-test ids plus a fetch call-count assertion (search + work + 2 records = 4)
fixed it and proved the deny, not fixture order, decides the answer. Rule: a
ranking test that reuses a series id another test fetched may be passing on a
memo hit; assert call counts.

**Hermetic gate with B1 + B2 + all new tests: 2,478 pass / 0 fail** (read in its
own step).

**B2 harness, run 1, pins disabled:** MATCH 471 → **473**, WRONG_SERIES 25 → 23.
* **B1 → B2: HEALED exactly 2** — Assassin's Apprentice and Assassin's Quest,
  `L'Assassin royal → The Farseer Trilogy`. **BROKE 0, other movement 0.** The
  deny touched nothing but the two rows it exists for.
* **Today → B1+B2, total: HEALED 10, BROKE 0, other movement 0.** MATCH 463 →
  473. All **seven Hobb pins are proved redundant** with pins off (Farseer 1–3,
  Liveship 1–3, Rain Wild 4), plus Bill Hodges 1–3 which had no pins at all.
  Every other row in the corpus — 463 matching, the 306 competing-secondary
  records, the Jack Ryan cluster, the remaining 48 standing reds — is
  byte-for-byte where arm A left it.
* **Run 2: byte-identical to run 1** (473/10/15/23, 0 rows moved). Every arm of
  the A/B — A ×2, B1 ×2, B2 ×2 — is stable across its two runs; the mirror was
  warm and no phantom-red artefact appeared in any of the six runs.

**B2 wiring mutation-tested:** never-empty guard dropped → 1 red; deny inverted
→ 1 red (Farseer → L'Assassin royal, the exact defect); deny set forced empty →
1 red. Source restored byte-identical each time.

**The four books the operator reported** (Fool's Fate, Dragon Keeper, Dragon
Haven, City of Dragons) were added to the library after the corpus census and
were not corpus rows, so the harness never scored them. **Probed live against
the mirror with B1+B2 and pins off: 4 of 4 correct** — `The Tawny Man #3`,
`Rain Wild Chronicles #1/#2/#3`. Added to the corpus as regression rows with
`mintPin: false` (rows 522–525; fixture round-trips byte-identical), so the
rule, not a pin, is what the gate protects. Note: Dragon Keeper and Dragon
Haven carry `Les cités des Anciens` as a positionless secondary tag — Rain
Wild's own AKA block is plain text with no hrefs, so §6.3 cannot deny it. The
shelf is unaffected; a stray tag may be written. Follow-up, not a blocker.

**Hermetic gate with the 525-row corpus, B1 + B2, all new tests: 2,478 pass /
0 fail** (read in its own step).

**Harness over the 525-row corpus, pins off, B1 + B2:** MATCH **477**. The four
new regression rows all read **MATCH** (`The Tawny Man #3`, `Rain Wild
Chronicles #1/#2/#3`) with no pin involved; among the 521 shared rows, healed 0,
broke 0, moved 0. **The measurement contract in this section is met in full:**
each arm run twice and stable, pins disabled throughout, zero regressions
against the named canaries and the whole competing-secondary population, cold
recompute (the harness drives from corpus inputs), gate green.

**Ship step RUN, operator-directed 2026-09-05 ("retire the pins"):** the seven
Hobb corpus rows flipped to `mintPin: false` (rows kept, note appended; fixture
round-trips byte-identical; 101 → 94 minting rows). `mintPins.ts` re-run with
its output read in full: `minted 94 pins, 94 of 94 portable (101 keys)`; no
COLLISION, no SKIPPED. Generated table re-formatted. **Verified semantically by
importing HEAD's copy and the working copy side by side**, never by line count:
`SHELF_PINS` 101 → 94 and `SHELF_PINS_BY_KEY` 108 → 101 — removed exactly the
seven recordIds and exactly their seven portable `title|author` keys, **0 added,
0 changed in place**. **Hermetic gate after retirement: 2,478 pass / 0 fail**
(no test asserted the old pin count or a Hobb pin).

**Pins-ON `--gate` harness against the reviewed baseline: PASS** — baseline reds
0, now 0, no new failures. All seven retired rows MATCH via the rule alone
(`The Farseer Trilogy #1/#2/#3`, `The Liveship Traders #1/#2/#3`, `Rain Wild
Chronicles #4`) and all four new rows MATCH. Totals 518 MATCH / 1
WRONG_POSITION / 6 MISSING_SERIES — the seven non-MATCH are the known
harness-only rows whose corpus inputs are not rebuildable (they serve correctly
in production; see `incipit-series-pin-workflow`, 2026-08-20). The gate noted the
baseline was recorded over 520 rows against a 525-row corpus, so it is being
re-recorded. **The first `--baseline` sample, minutes after the PASS on identical
code, recorded 2 standing failures the gate had not seen** — `The Nowhere Man`
`Orphan X #2 → An Orphan X Novel #2` and `The Third Gate` `Jeremy Logan #3 →
Dr. Jeremy Logan #3`: same series, same position, variant NAME. Both rows read
MATCH in arm A, in the pins-off B2 run and in the pins-on gate. **That baseline
was NOT kept** (a baseline with standing reds hides those rows from every future
gate — the rule from `incipit-elderlings-umbrella-pins`); the committed one was
restored and a second sample taken.

**Diagnosed:** the mirror lists exactly ONE series on each of those works
(`Orphan X` 170378, 19 members; `Jeremy Logan` 152744, 6 members) — the variant
names do not exist on the Goodreads side — and both flipped `got` values equal
the rows' own `inputs.providerSeries` names verbatim. So for those two rows the
Goodreads lookup **degraded during that one run** (a mirror blip) and the harness
scored the provider passthrough. Not a ranking change; not attributable to this
work (the umbrella/parallel logic never engages on a single-candidate work).

**Follow-up this exposes:** the harness `--out` carries no per-row `degraded`
flag (the sweep's `sweepDegraded` has no harness equivalent) and the run log
showed nothing, so a `--baseline` taken during a blip can enshrine a transient
as a standing red. Add `degraded` to each harness row and have `--baseline`
refuse to record a degraded row as standing.

**Second `--baseline` sample: 0 standing failures, rowCount 525, 471 assertable
/ 54 excluded.** The transient did not reproduce. This is the baseline
committed with the change.

**Bill Hodges pins retired too (operator-directed, 2026-09-05):** the pre-release
check found Mr. Mercedes / Finders Keepers / End of Watch held on prod by three
operator-stated pins the rule (318697) had made redundant — arm B1 healed them
with pins off. Same workflow: rows flipped to `mintPin: false` and kept, re-mint
`91 pins / 98 portable keys` with no COLLISION or SKIPPED, semantic diff against
HEAD removed exactly the three ids and their three `title|author` keys (0 added,
0 changed), unit gate 2,478 / 0, pins-ON `--gate` **PASS (0 → 0)** with all three rows MATCH via the rule.

**Live on prod, 2026-09-05 20:27Z.** `454d72f` deployed to the single API on .99
(`:nightly`, digest `2e0f24ac…`, verified by digest); cold-cache `/books` answers
correct for all four reported books; `refresh?force=1` on rk 747873/747883/
747877/747869 converged in 20 s to `Tawny Man, Book 3` and `Rain Wild
Chronicles, Book 1/2/3`, snapshot taken first, four posters byte-identical. The
Hobb shelf is now thirteen albums under five sub-trilogy prefixes with no
`Realm of the Elderlings` anywhere. No bundle change was needed on either box.

**Side effect confirmed:** Dragon Keeper and Dragon Haven carry the mood
`Series: Les cités des Anciens` beside `Series: Rain Wild Chronicles` — the
French listing is a positionless secondary the deny cannot reach (Rain Wild's
alias block is plain text, no hrefs). Precedented fix: one `SERIES_ALIASES`
entry `['les cités des anciens', 'Rain Wild Chronicles']` (key keeps the é —
`foldSeriesName` does not fold diacritics and strips only English articles); the
duplicate rule then clears the echo and the bundle retires the stale mood on the
next forced refresh. Spec-first; not done.

## 10. Pre-release double check — whole-library old-vs-new diff (2026-09-05)

The corpus A/B covers 525 rows; the library has 1,724 albums. Before promoting,
the `314fa00` resolver with its 101-pin table and the shipped resolver with its
current table were run side by side, through the route's own pipeline
(resolve → pins → shelf policy), over **every prod album**.

* **Primary movers, whole library: only the Hobb books this change targets** —
  Fool's Fate, Dragon Keeper, Dragon Haven, City of Dragons (umbrella → sub-
  trilogy) — plus Fool's Assassin, whose old-arm `Elderlings #14` is an artefact
  of the harness omitting the Audible provider series (prod served
  `Fitz and the Fool #1` under old code because Audible supplied it; the shipped
  code reaches it unaided). **Zero regressions.**
* **Tag-only movers, all benign:** the Elderlings umbrella, Holly Gibney and
  `L'Assassin royal` leaving secondary slots; one Hobb book gaining a Finnish
  `Elolaivat` tag (same class as `Les cités des Anciens`).
* **Three traps the first pass hit, all resolved by re-running the movers:** the
  fed listing was captured before the seven newest albums (the four reported
  Hobb books among them) and had to be refreshed; 105 titles carry numeric HTML
  entities the first decoder missed (`&#8217;`), which broke the new arm's search
  where the old arm was rescued by a pin; and the old arm always runs first
  against a cold mirror record, so transients bias onto one arm — five reported
  "movers" vanished on a warm re-run. Rule for next time: decode every entity,
  re-check every mover warm, and diff against a listing pulled the same hour.
* Coverage: 1,717 + 7 missed = 1,724 albums; 105 entity-titled rows re-checked on
  correct input; 0 errors.

**Outcome: the umbrella is now a rule, not data.** Ten pins retired (seven Hobb,
three Bill Hodges), fourteen books protected by corpus rows, zero regressions at
every step including a whole-library diff, and the reported defect closed on
prod.

Per the standing series directive, spec **and** full A/B before shipping.

1. **Golden corpus A/B**, each arm run twice (first-run mirror artefacts are
   documented in `incipit-local-rreading-glasses`). Arm A = today. Arm B = 6.1 +
   6.2 + one variant of 6.3.
2. **Pins temporarily disabled in the A/B**, so the seven Hobb pins are proved
   redundant rather than masking the result — the prior spec's §7 requires this.
   Success = all seven still correct with pins off.
3. **Regression budget: zero.** All 306 competing-secondary records must be
   unmoved except the intended ones. Discworld, Jack Ryan, Drizzt, Amber and
   Mistborn are the named canaries.
4. **Cold recompute, not warm serving** — a correct prod answer may be cache.
5. `bun run test` green, read in its own step before commit.

## 8. Risks

* **Blast radius** — 306 records share the mechanism; 16 are wrong. The ratio is
  the argument for demote-not-remove and for a zero-regression budget.
* **Curation debt** — 6.1 is a list a human maintains. 6.4 is what stops it
  becoming stale, and is the reason it is in scope rather than a follow-up.
* **`Fitz and the Fool`** shows a single-candidate work already resolving
  correctly; confirm the change cannot demote a lone umbrella into no shelf.
* **Two umbrella mechanisms already exist** (`isUmbrella` at ranking,
  `CONTAINER_SHELF_NAMES` at shelf policy) and now a third is proposed.
  Consolidating them is desirable but is its own change — do not fold it in.

## 9. Alternatives considered and rejected

* **More pins** — four now, four more when the remaining Elderlings books are
  added, and again for the next franchise. Rejected as the wrong shape; this is
  the documented Magic Tree House lesson.
* **`SERIES_ALIASES`** — maps a name to a canonical spelling. The umbrella is not
  a misspelling of the sub-series; there is nothing to alias.
* **Prefer the provider's (Audible) series** — right for 2 of 6 Hobb books in the
  August measurement and wrong elsewhere; `GOODREADS_SERIES_AUTHORITY` is
  measured as a net improvement (74 agree / 51 differ, most differences
  improvements) and must not be disabled.
* **Library-cohesion tie-break** (prefer the shelf an author's other albums
  already use) — self-reinforcing and order-dependent: it locks in whichever
  answer happened to land first, and cannot bootstrap a correct shelf for a new
  author.

## 11. Two of the four predicted arrivals failed (2026-09-06) — diagnosis

The operator added Fool's Errand, Golden Fool, Fool's Quest and Assassin's Fate.
Golden Fool → `Tawny Man, Book 2` and Assassin's Fate → `Fitz and the Fool, Book 3`
landed correctly. The other two did not, and **neither is the umbrella class §6
covers** — the claim in §1 that the rule "covers the four not yet added" was half
wrong. Both root causes were reproduced by driving the shipped resolver with the
route's inputs (`.cache/trace2.ts`), not inferred.

### 11.1 Fool's Errand → `O Regresso do Assassino, Book 1` (should be The Tawny Man, Book 1)

Tawny Man's own description links the Portuguese re-listing — and
`parallelListingIds` extracts it correctly — as **id 65016**. But the work carries
a *second* Goodreads listing with the same name, **id 311441** (5 members, one
per split volume), and that is the candidate in the pool. The deny is exact-id,
so the duplicate is never denied and wins on member count, 5 to 4; the provider's
`Realm of the Elderlings #7` then survives as the tag. Goodreads duplicating a
translated listing is ordinary librarian drift, so an id-only deny will recur.

**Fix (D2): deny by the linked NAME as well as the id.** The href slug
(`65016-o-regresso-do-assassino`) and the anchor text both carry the listing's
name; fold both sides (diacritics, punctuation, case) and deny any candidate
whose folded title equals a linked re-listing's folded name. Direction is
unchanged — the same headings and the same anchored phrase decide *which* links
count — so the mutual parent/child guard from §6.3 still holds.

### 11.2 Fool's Quest → `Fitz and the Fool, Book 15` (should be Book 2)

The name is right and the number is the umbrella's. The mirror never says 15:
every search hit resolves to work 42704733, where `Fitz and the Fool` places the
book at 2. The number comes from the **provider**: Audible carries the
Elderlings ordinal under the trilogy's name for this edition (the public
catalog returns a thin product for this ASIN; the sibling Assassin's Fate shows
the shape, `Fitz and the Fool #3` + `Realm of the Elderlings #16`). The
**edition guard** then freezes it: the stored subtitle is *"Book II of the Fitz
and the Fool trilogy"*, and `namesEdition` strips series-shaped phrases of the
form `<name> trilogy, Book N` before its marker test — the August R1 fix — but
this subtitle is the **reversed form with a Roman numeral**, `Book II of the
<name> trilogy`, which the strip does not match. `trilogy` survives, reads as an
edition marker, and the guard returns the provider series untouched before any
lookup runs. `?update=1` cannot help; the guard is upstream of it. Trace: the
same inputs without the subtitle resolve to `#2` and log "replaced an
inconsistent provider series".

**Fix (R1′): extend the series-shape strip to the reversed form** —
`(book|volume|part) <N or Roman> of (the) <name> (trilogy|…)` — so an ordinary
volume subtitle written that way is not an edition marker. This is the same
narrow shape-based approach R1 took, not a change to the guard's semantics;
Assassin's Fate carries the identical subtitle shape and resolves to `#3` either
way. Corpus census: the guard fires on 11 of 525 rows, 8 with a provider series
(anniversary editions, dramatized adaptations, anthologies, omnibuses) — none of
that reversed shape, so the expected corpus movement is zero.

### 11.3 Measurement

The four books joined the corpus as regression rows 526–529 (`mintPin: false`;
provider inputs for three are inferred from the sibling's Audible shape and
proved by the trace that reproduces the served answer — recorded in each row's
`inputSource`). **Arm A, today's code, pins off, 529 rows:** MATCH 479, 39 reds;
the four rows read exactly the live state — Fool's Quest WRONG_POSITION
(`Fitz and the Fool #15`), Fool's Errand WRONG_SERIES (`O Regresso do Assassino
#1`), Golden Fool and Assassin's Fate MATCH. Arm B = R1′ + D2, pins off, twice;
the two must heal, the two must hold, everything else unmoved.

**Arm B, R1′ + D2, pins off, two runs, byte-identical:** MATCH 479 → **481**,
WRONG_POSITION 16 → 15, WRONG_SERIES 24 → 23. **HEALED exactly 2** — Fool's
Errand `O Regresso do Assassino #1 → The Tawny Man #1`, Fool's Quest `Fitz and
the Fool #15 → #2`. **BROKE 0, other movement 0** across all 529 rows: Golden
Fool and Assassin's Fate hold, the 306 competing-secondary records and the
eleven edition-guard rows are untouched. Unit tests: five reversed-shape cases
in the `namesEdition` suite, five extraction/fold tests, two ranking wiring
tests (duplicate-id heals; control where the linked name differs does not),
four suites 164 / 0.

**Mutations, each red with source restored byte-identical:** R1′ alternative
removed → 1 red; D2 name clause dropped → 1 red; fold without diacritics → 1
red; phrase-form names ignored → 2 red. **Hermetic gate: 2,485 pass / 0 fail.**
**Pins-on `--gate` against the reviewed baseline: PASS, 0 → 0**, all four new
rows MATCH; totals 522 MATCH / 1 WRONG_POSITION / 6 MISSING_SERIES, the same
seven harness-only rows as before. The gate asked for the baseline to be
re-recorded over 529 rows; done with the same discipline as §7 — one sample,
kept only if it carries no standing reds. **It did: rowCount 529, 0 standing
reds, 475 assertable / 54 excluded.**

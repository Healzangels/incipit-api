# Spec — the ordering-only shelf split: when a series exists on Goodreads ONLY as reading orders

Status: **DRAFT 2026-09-08 — measured, not yet shipped.** Sibling of
`spec-shelf-granularity.md` (2026-09-05, shipped): same damage (one continuum,
several shelves), a different cause. That spec was about *which of several
series wins*. This one is about *what happens when none of them is a series at
all* — every listing Goodreads offers is a reading ORDER, which the resolver
demotes by design, so the answer depends on something that varies book to book.

Operator framing, verbatim: *"this is a classic case of a new series being added
and it being match onto different series or onto similar series but not the
exact same so ends up out of order"*, and on the choice of winner: *"I think
prefer goodreads … added more and they added to Hornblower Saga: Chronological
Order, Book N so I think goodreads makes sense"*.

## 1. The defect as the operator experiences it

C. S. Forester, prod section 6, 2026-09-08. Eleven albums, one continuum, one
numbering — sitting on **three** shelves:

| # | Album | Shelved as |
| --- | --- | --- |
| 1 | Mr Midshipman Hornblower | Horatio Hornblower (chronological order) |
| 2 | Lieutenant Hornblower | Horatio Hornblower (chronological order) |
| 3 | Hornblower and the Hotspur | **Hornblower Saga: Chronological Order** |
| 4 | Hornblower and the Crisis | Horatio Hornblower (chronological order) |
| 5 | Hornblower and the Atropos | **Hornblower Saga: Chronological Order** |
| 6 | The Happy Return | Horatio Hornblower (chronological order) |
| 7 | A Ship of the Line | Horatio Hornblower (chronological order) |
| 8 | Flying Colours | Horatio Hornblower (chronological order) |
| 9 | The Commodore | **Hornblower Saga: Chronological Order** |
| 10 | Lord Hornblower | Horatio Hornblower (chronological order) |
| 11 | Hornblower in the West Indies | **Hornblower Saga - Chronological Order** (folder) |

Plex sorts each fragment separately, so the series reads out of order. The
positions are not in dispute anywhere: every source agrees 1–11.

## 2. What the sources actually say

Goodreads (local mirror, 2026-09-08) has **no plain Hornblower series**. The
work records carry exactly two listings, and both are reading orders:

| id | Title | members |
| --- | --- | --- |
| 49812 | Hornblower Saga: Chronological Order | 31 |
| 49813 | Hornblower Saga: Publication Order | 12 |

Audible carries its own name — `Horatio Hornblower (chronological order)` —
for the eight books it knows, with the same numbers. It does **not** know
`B006QM78OW` (Atropos: empty product echo), and three albums are matched to
Hardcover ids, so five of the eleven reach the resolver with **no provider
series at all**.

## 3. Root cause — two independent defects

### D1 — an ORDERING incumbent is preserved against a variant-only answer

`goodreadsSeries.ts` demotes orderings and umbrellas out of the clean pool. When
nothing clean survives it keeps them anyway (a variant beats none) and sets
`variantOnly`, and the apply path then refuses to spend a provider series on
such an answer:

```ts
if (hadSeries && result.variantOnly) return book   // keeps Audible's name
```

That refusal is right when the incumbent is a real shelf — the comment cites
`Foundation #0.5` not being traded for `Foundation (Chronological Order) #1`.
It is wrong when the incumbent is **itself an ordering**, which is the very
class the demotion exists to keep off a shelf. The file already draws exactly
this distinction fifty lines earlier, at the edition guard:

```ts
const incumbentIsOrdering = isSeriesOrdering(book.seriesPrimary?.name)
if (hadSeries && editionMarked && !incumbentIsOrdering) return book
```

so D1 is a rule the module states in one place and forgets in the other.

**Proof it is the whole story for these rows** — same book, same mirror, same
code, the only variable being whether Audible's series is passed in:

| Book | incumbent = Audible | incumbent = none |
| --- | --- | --- |
| Lieutenant Hornblower | Horatio Hornblower (chronological order) #2 | Hornblower Saga: Chronological Order #2 |
| The Happy Return | Horatio Hornblower (chronological order) #6 | Hornblower Saga: Chronological Order #6 |

### D2 — the candidate window is three works deep

`lookupByTitle` walks `hits.slice(0, 3)` distinct works. Goodreads' relevance
order puts study guides and omnibus editions in front of the real work often
enough to matter, and the two Hornblower stragglers are both outside the window:

| Book | rank of the correct work | what fills the window |
| --- | --- | --- |
| A Ship of the Line | 5th (work 2924, #7) | The Ship; Captain Hornblower R.N. (`5-7 omnibus`); a compilation |
| Hornblower in the West Indies | 4th (work 3658697, #11) | two "… Summary & Study Guide" works; Admiral Hornblower |

Both return `NONE`, so #7 keeps Audible's name and #11 falls through to its
folder — the third shelf. D2 is why D1 alone cannot finish the job.

## 4. Scope — measured library-wide, not assumed

* **Split shelves** (`scratchpad/split-shelves.py`, 1,739 albums, 189 authors):
  12 candidate pairs, of which **one** is a true same-series split with
  interleaved numbering — Hornblower. Ten are legitimate distinct series
  (Riyria Chronicles vs Revelations, Spellmonger vs Cadet, Discworld vs Science
  of Discworld, Galaxy's Edge vs Savage Wars, Horus Heresy vs Primarchs,
  Commonwealth Saga vs Fallers, and the deliberate Stephen Fry edition split).
  One is a folder fallback (Tales of Middle Earth).
* **Ordering-shaped shelf names**: 13 albums across 7 names. Eight are
  Hornblower; the other five (`Duma Key Split-Volume`, `Insomnia Split-Volume`,
  `Needful Things (Split-Volume)`, `Under the Dome Split-Volume`,
  `English Edition`) have **no API series at all** and are folder-derived, so
  no resolver rule reaches them.
* So D1's live blast radius is **the seven Audible-named Hornblower albums**.
  D2's is library-wide and must be measured by the whole-library diff (§6).

## 5. Design

**O1 — release an ordering incumbent.** Add the condition the edition guard
already uses:

```ts
if (hadSeries && result.variantOnly && !incumbentIsOrdering) return book
```

The `isShelvablePosition` guard immediately below is untouched, so the A Gift of
Dragons case still holds: an ordering incumbent is released only for an answer
that can actually number the book. Releasing it for a positionless answer would
trade an ugly shelf for no shelf.

**O2 — widen the candidate window from 3 to 5 distinct works.** The window was
narrowed to protect against same-universe false accepts, but three gates now
stand behind it: the title-similarity gate, the positive author-credit gate, and
the "work lists no series → keep looking" rule. Depth 5 covers both measured
cases with two works to spare.

**Rejected: a per-series alias table** (`49812 → Horatio Hornblower`). It works,
and it is the mechanism `UMBRELLA_SERIES` established for facts that are not
inferable. But this fact *is* inferable — "an ordering name is not a shelf" is
already stated in code — and an alias needs one entry per franchise forever,
which is the pin-coverage trap `spec-shelf-granularity.md` §1 was written about.

**Rejected: pinning the four Goodreads-named albums.** Same trap, smaller. It
would also unify on the losing side: every book added since has arrived on the
Goodreads name.

## 6. A/B protocol

Arms are the corpus harness with **pins disabled** (`--no-pins`), each arm run
twice and required byte-identical, against the local mirror:

1. Arm A = `nightly` head. Arm B = O1. Arm C = O1 + O2.
2. Hermetic gate `bun run test:gate` green on each arm.
3. Pins-on `--gate` = no new failures vs `series-harness-baseline.json`.
4. Whole-library old-vs-new diff (`.cache/libraryDiff.ts`, 1,739 albums), which
   is the only measurement that can see a regression outside the corpus.
5. Eleven Hornblower rows added to the corpus first, with live inputs, so the
   A/B has something to hold the fix to.

## 7. Results

### 7.1 Arm stability, and the cold-mirror trap

"Two byte-identical runs" is a property of a WARM mirror, not of the code. The
first two arm A runs (identical code, `nightly` HEAD) differed on **seven** rows,
every one of them in the direction of the mirror warming up: Ahriman 1-3 moved
`Ahriman: Warhammer 40,000 #N` -> `Ahriman #N`, Wool `The Silo Saga #1` ->
`Silo #1`, Ruin and Rising and A Savage War of Peace went `NONE` -> a match, and
The Girl with the Dragon Tattoo swapped one wrong Millennium listing for another.
A cold `/series` count probe changes the ranking, so the first run after an idle
period scores rows the second run gets right. Runs 2 and 3 then agreed on
**524/524 shared rows, zero differences**. Only a warmed arm is evidence.

### 7.2 The eleven new rows, arm A (pins off, `nightly` HEAD)

| Rows | Classification | Cause |
| --- | --- | --- |
| 7 | WRONG_SERIES `Horatio Hornblower (chronological order) #N` | D1 |
| 1 | WRONG_SERIES (A Ship of the Line) | D2, then D1 keeps the incumbent |
| 1 | MISSING_SERIES (Hornblower in the West Indies) | D2 |
| 3 | MATCH | no incumbent to keep; already on the Goodreads name |

### 7.3 Pre-registered prediction

Written before arm B was run, so the arms can falsify it:

* **Arm B (O1 alone)** heals the D1 rows and nothing else — the six rows the
  corpus marks `specRule: ["O1"]`. A Ship of the Line (`["O1","O2"]`) and
  Hornblower in the West Indies (`["O2"]`) stay red: O1 releases an incumbent
  only when there is a variant-only answer to release it TO, and for those two
  the Goodreads lookup returns nothing at all.
  (The first draft of this line said "seven", miscounting A Ship of the Line as
  an O1 row while the same sentence excluded it. The corpus `specRule` fields,
  written first, say six + two, and six is what arm B healed.)
* **Arm C (O1 + O2)** heals all eleven.
* Any other row that moves in either arm is a regression until judged.

### 7.4 Arm B (O1) — measured

Two runs, byte-identical (535/535 rows, zero differences). Against arm A:

| | |
| --- | --- |
| Rows compared | 535 |
| Healed | **6** |
| Broke | **0** |
| Changed but neither | **0** |

The six are exactly the rows the corpus marks `specRule: ["O1"]` — Mr Midshipman
Hornblower, Lieutenant Hornblower, Hornblower and the Crisis, The Happy Return,
Flying Colours, Lord Hornblower — each moving
`Horatio Hornblower (chronological order) #N` -> `Hornblower Saga: Chronological
Order #N`, position unchanged. Nothing else in the corpus moved, which is the
result the "23 rows carry an ordering as their provider primary" note predicted:
the Jack Ryan and Narnia rows resolve to a CLEAN Goodreads series, so they never
reach the variant-only refusal that O1 narrows.

### 7.5 Arm C (O1 + O2) — measured

Two runs, byte-identical (535/535). Against arm A (`nightly` HEAD):

| | |
| --- | --- |
| Rows compared | 535 |
| Healed | **9** |
| Broke | **0** |
| Changed but neither | **0** |

All eleven Hornblower rows now MATCH: six from O1, two from O2 (A Ship of the
Line `NONE`-behind-the-incumbent -> `#7`, Hornblower in the West Indies
`MISSING_SERIES` -> `#11`), three were already correct.

O2 also healed a row nobody was aiming at: **The Girl Who Takes an Eye for an
Eye**, a standing red, moved `Millennium Series #5` -> `Millennium #5`. The
correct Millennium work was outside the three-work window too. That is one
pre-existing defect of this shape found in a 540-row corpus, which is the only
evidence available on how common D2 is.

### 7.6 An existing test asserted the opposite, and was reversed on purpose

`goodreadsSeries.test.ts` carried
`variant-only guard: an ORDERING incumbent is KEPT when every candidate is itself
a variant`, reasoning that *"ordering-for-ordering buys the reader nothing and
risks a worse number"*. It was the only red in the hermetic gate after O1.

It was reversed, not deleted, and the comment records why: the first half is
refuted by measurement (it buys nothing for one BOOK and everything for a SHELF,
because which name a book gets depends on whether its provider happens to know
it), and the second half is still honoured by the not-shelvable guard downstream
of the release. The reversal is the operator's call of 2026-09-08, taken with the
Forester evidence the original decision did not have.

Hermetic gate after the reversal: **2,489 pass, 0 fail, 126 files**.

### 7.7 Whole-library old-vs-new diff — and what it can and cannot see

1,739 prod albums, both resolvers, same pins and shelf policy, 904 s, **0 errors**:
**4 primary movers, 1 tag-only**. Each was re-probed twice per arm afterwards,
which is what separates a real change from mirror variance:

| Album | old -> new | verdict |
| --- | --- | --- |
| A Ship of the Line | NONE -> `Hornblower Saga: Chronological Order #7` | real heal (O2) |
| Dungeon Crawler Carl | NONE -> `Dungeon Crawler Carl #1` | real heal (O2); shelf already read that, from the Audible passthrough, and is now Goodreads-backed |
| The Survivor | NONE -> `Mitch Rapp #14` | real heal (O2); same, passthrough -> Goodreads |
| Mythos | `Stephen Fry's Great Mythology #1` -> NONE | **transient**: on re-probe both arms answer `#1` twice. Not a regression |
| Fahrenheit 451 (tag) | tag NONE -> `Fahrenheit 451 #?` | real, cosmetic: a positionless self-named listing lands in the TAG slot. No shelf effect (positionless), one extra `Series:` mood |

**Zero regressions.** Exactly one album's Plex shelf changes as a result of this
diff: A Ship of the Line.

**The limitation, stated plainly.** This harness builds each book from the Plex
listing alone (`asin`, `title`, `authors`), so it passes **no provider series**.
O1 only ever fires when there IS an incumbent, so this diff measures **O2 only**.
O1's library-wide blast radius is bounded a different way — by the §4 census of
shelves whose name is ordering-shaped, since a kept ordering incumbent is
precisely what puts such a name on a shelf: 13 albums, of which 8 are Hornblower
and 5 (`… Split-Volume`, `English Edition`) have no API series at all and so have
no incumbent to release. The corpus arms measure O1 properly, because corpus rows
carry their recorded `inputs.providerSeries`.

Getting a true library-wide O1 measurement would mean reading every provider
record, which is the route sweep that
[[incipit-route-reads-are-not-free]] exists to forbid.

## 8. Release

**SHIPPED AND LIVE on prod 2026-09-08.** `1fa81b0` on `nightly`, CI green (Bun +
Docker), deployed to the single API on 10.0.1.99 and verified by digest, not by
the word "Started":

```
ghcr :nightly            sha256:bee782c031ae4b8917d5790f2b01b6515f14b5efca24af68c00a7df429463088
deployed on .99          sha256:bee782c031ae4b8917d5790f2b01b6515f14b5efca24af68c00a7df429463088
/health uptime           0s  (a fresh container, so the in-process cache is empty --
                             which also cleared the answers poisoned by the 2026-09-07 route sweep)
```

Refresh of the eleven albums (`scratchpad/hornblower-refresh.sh`), which refuses
to touch Plex unless the API already serves the unified answer for every id:

* deploy guard: **11/11 OK** cold, `Hornblower Saga: Chronological Order #1..#11`
* snapshot captured for undo before any write
* `PUT /library/metadata/{rk}/refresh?force=1` -> HTTP 200 on all eleven
* converged in **20 seconds**; re-read of the artist's children afterwards:
  **11 albums, 1 distinct shelf name, positions 1-11 in order**
* covers: **11/11 byte-identical** (md5 before vs after) -- the standing rule is
  that covers are hand-curated and never bulk-written

Before -> after, the three shelves collapse to one:

| was | albums |
| --- | --- |
| `Horatio Hornblower (chronological order)` (Audible) | 7 -> 0 |
| `Hornblower Saga - Chronological Order` (folder) | 1 -> 0 |
| `Hornblower Saga: Chronological Order` (Goodreads) | 3 -> **11** |

Undo, if it is ever wanted:
`python3 scripts/shelfSnapshot.py restore --host 10.0.1.98 --token <token> --snap scratchpad/hornblower-snap.json`

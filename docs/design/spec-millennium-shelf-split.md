# spec: the Millennium shelf, split three ways

**Status: Implemented as PINS** (2026-08-15). Two rows, two *different* causes. Also
records a FALSE ALARM worth keeping, because it is evidence for the thing it looked
like it contradicted.

## What was wrong

Six Larsson/Lagercrantz novels, one shelf, three names:

```
Millennium                                  #2 #3 #4 #6
Millennium Series                           #5
Millennium: Sylvain Runberg's Adaptation    #1
```

`Sylvain Runberg` wrote the **graphic-novel adaptation**. The book filed under it is
Stieg Larsson's novel.

## Two causes, opposite directions

This is the interesting part: the same series shows authority mode failing **both
ways**, and the tell is one field.

**#1 — Goodreads fired and chose wrong.** It returned the adaptation series as
primary and put the correct one in `seriesSecondary`. The right answer was already in
hand, one slot over.

**#5 — Goodreads never fired.** Its served series still carries the provider ASIN:

```
#5  ours = { asin: 'B005NAT8KK', name: 'Millennium Series', position: '5' }
#4  ours = {                     name: 'Millennium',        position: '4' }
#2  ours = {                     name: 'Millennium',        position: '2' }
```

An `asin` on the series object means the PROVIDER supplied it — Audible calls this
shelf "Millennium Series" for every book in it, including #2 and #4. Those two lost
the suffix because Goodreads answered for them; #5 kept it because Goodreads did not.

So the fragmentation is not one bug applied inconsistently. It is a wrong Goodreads
answer on one row and a missing Goodreads answer on another, landing on the same
shelf from opposite sides.

## Why pins and not a rule

The obvious rule — "never shelve under a series whose name marks it an adaptation" —
was sized first. Across all 1685 albums, series names matching
`adaptation|graphic novel|comic|manga|illustrated edition`:

**exactly one.** This row. A rule that runs on every book forever to catch one is the
same trade that closed [spec-edition-subtitle-arm.md](spec-edition-subtitle-arm.md)
and pinned [spec-translated-series-pin.md](spec-translated-series-pin.md).

**REOPEN IF** that count rises — adaptations are a growing category in audio
(GraphicAudio, full-cast dramatisations), and the rule becomes worth building the
moment it would catch more than a handful.

## The false alarm — Quantico, and why it stays

*Quantico* was flagged alongside these because our shelf says `Quantum Logic` while
Audible says `Quantico`. **Ours is right and Audible's is not.** The library holds the
sibling:

```
rk729516  Quantico  ->  Quantum Logic, Book 1
rk729514  Mariposa  ->  Quantum Logic, Book 2
```

Audible's "series" here is just the book's own title — its habit of minting a
one-book series. Taking it would have split a coherent duology, because *Mariposa*
is in no series called *Quantico*.

Keep this case in mind before ever proposing that the provider's series should win
over Goodreads: that instinct fails on the exact shelf it looks most reasonable on.
The same audit found Goodreads correcting Audible's own typo (`His Dark Materialsik`)
and stripping format noise (`The Camel Club (abridged)`).

## The corpus already said the opposite — and it was wrong

The first gate run **failed**, which is the whole reason the gate exists:

```
WRONG_SERIES  rk155266 The Girl with the Dragon Tattoo
   required = Millennium: Sylvain Runberg's Adaptation #1
   got      = Millennium #1
```

The book was already in the corpus, under its **pre-rebuild ratingKey**, requiring the
adaptation name. That row was not an operator decision:

```
pinType:      "current-correct-default"
sourceOfTruth: "Census 2026-07-29 dual-series row, verdict 'dual-ok' (shard 2):
                the current answer is the required answer
                (assignment: 82-of-93 parent-primary-correct class)"
```

The 2026-07-29 census **bulk-assigned** the then-current answer as required across a
93-row class. So a live defect was recorded as truth and sat there for a year, and any
future fix would have been scored as a regression against it.

The row was corrected to `Millennium` (pinType `operator-stated`) rather than backing
out the pin. **The tell that it was always wrong is in the row itself**: its own
`servedNow.secondary` was `Millennium #1`. The resolver had the right answer and
ranked it second; the census then froze the wrong pick.

⚠️ **`current-correct-default` means "nobody judged this"** — it is the corpus
equivalent of a test that mirrors instead of guards. Before treating such a row as
authority, check whether its own `servedNow` contradicts it.

## Do not add a second row for a book already in the corpus

`mintPins` refuses outright:

```
COLLISION (two corpus rows claim one recordId): B002UZMWNG (rk731152 …)
mintPins: refusing to report success — fix the corpus rows above and re-run.
```

Two rows may share a recordId (Discworld and Stormlight legitimately do) — but not two
rows carrying `mintPin`. Since ratingKeys changed in the library rebuild, **search the
corpus by `recordId`, never by ratingKey**, before adding anything.

And read the generator's output in full: piped through `tail -2`, that refusal is
invisible and the run looks like it succeeded.

## Verification

* corpus 511 → **512** rows (one row ADDED for #5, one CORRECTED for #1, one duplicate
  removed), **75 insertions / 10 deletions**
* pin table **4 keys added, 0 changed, 0 removed** (2 recordId + 2 portable)
* `bun run test` — 2410 pass / 0 fail
* harness `--gate` twice after the correction: **PASS both**, identical,
  MATCH 504 → **505**, baseline reds 0 → 0 (the mirror is nondeterministic; a
  single-row flip between runs is not evidence, so both runs matching is the claim)

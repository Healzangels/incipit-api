# Spec — franchise umbrellas that carry no `-verse` tell

Status: **PROPOSAL REJECTED after measurement, 2026-08-18.** The defect is real;
the proposed general rule is not safe. The six affected books were fixed by
OPERATOR PINS (corpus group `named-umbrella-elderlings`, mintPin: true). The
only viable general design found is documented in §6 and is deliberately NOT
implemented. This file is kept as the measurement record so the next attempt
does not re-walk the same three dead ends.

## 1. The defect (real, and fixed by pins)

Robin Hobb's six albums sorted under three different prefixes, five wrong:
the Realm of the Elderlings umbrella shelved everything except Assassin's
Quest, which kept `Farseer Trilogy` only because its PROVIDER primary already
said so. Required state: Farseer Trilogy 1/2/3, Liveship Traders 1/3, Rain
Wild Chronicles 4.

## 2. Root cause — measured

Goodreads lists BOTH the umbrella and the sub-series on each work, e.g. work
171715 (Assassin's Apprentice):

    The Realm of the Elderlings  id 54099   25 members   #1
    The Farseer Trilogy          id 41452    7 members   #1
    L'Assassin royal   (French)  id 89770   25 members   #1
    Vatidico          (Spanish)  id 174690   5 members   #1
    A Saga do Assassino    (PT)  id 65022    5 members   #1

`goodreadsSeries.ts` demotes umbrellas BY NAME (`/\b\w*verse\b/`); this
umbrella carries no `-verse` tell, survives into the clean pool, and wins on
member count. The file's own header states the assumption this falsifies:
"the umbrella carries the tell in its name".

## 3. Dead end #1 — `CONTAINER_SHELF_NAMES` (shelf-policy layer)

Tested on paper against live provider payloads: fixes Ship of Magic, promotes
the FRENCH `L'Assassin royal` for Assassin's Apprentice, and blanks the three
books whose secondary is absent or is the umbrella again. The container list
disposes of a name; it cannot supply the sub-series the provider never sent.

## 4. Dead end #2 — the umbrella name list at the RANKING site (this spec's
original proposal)

Adding `realm of the elderlings` to a curated set consulted by `isUmbrella`
was REFUTED by the member counts above. With the umbrella out of the pool,
the ranking's parent-wins-by-count rule hands the shelf to `L'Assassin royal`
(25 members vs Farseer's 7) for every work that lists it:

* Assassin's Apprentice: French shelf instead of umbrella — WORSE.
* Assassin's Quest: **regression** — the one correct book flips from
  Farseer Trilogy to the French series.

The translated listings are the umbrella problem again, one layer down: big
member counts, no name tell, and this time no curated list can be complete —
every popular series has per-language re-listings.

## 5. Dead end #3 — the librarian "Also known as" deny set

The ranking already builds a deny set from `/series/NNNN` hrefs under the
"Also known as" heading (used for the SECONDARY slot only). Measured against
the live descriptions 2026-08-18:

* NO hrefs exist on any of the five candidate series — the deny set is inert
  here (the Black Company case that motivated it happened to be href-linked).
* Extending extraction to PLAIN-TEXT names also fails: Farseer's AKA block
  lists Chinese/Italian/Finnish/Slovenian names — NOT the French, Spanish or
  Portuguese series actually competing in the pool.

Librarian annotations are not reliably present where they are needed.

## 6. The one viable general design — NOT implemented

Member-SET parent-ness, replacing member-count parent-ness:

    A is a parent of B  iff  members(B) ⊆ members(A)  (approximately)

Measured on this cluster: the umbrella genuinely CONTAINS Farseer's works
(a true parent — demote only via the umbrella judgement); `L'Assassin royal`
only PARTIALLY overlaps Farseer (171715 and 503752 yes, 4668002 no) — a
PARALLEL listing, not a parent, and parallel listings should never outrank
the candidate they parallel. This distinguishes umbrella / translation /
canonical structurally, with no language guessing and no curated lists.

Cost: it changes the ranking comparator for every multi-series work in the
library (1,524 of 1,713 albums carry a series sort). Per the standing series
directive that is its own spec + full A/B, not a rider on this one. The
`/series/:id` responses already carry LinkItems, so the data is free; the
design work is the comparator semantics and the overlap threshold.

## 7. What shipped instead — six pins

Corpus rows `named-umbrella-elderlings` (recordIds B0G5PPTS4V, B003NYOBOQ,
B003XWVC0E, B008Y4ZU3G, B0040F3GN4, B07BB3D7CR), all `mintPin: true`,
pinType operator-stated, sourced to the operator's 2026-08-18 statement.
Assassin's Quest is pinned as the CONTROL: correct today, and the first book
to regress under dead end #4 — the pin locks it against any future ranking
change until the §6 design ships.

Raw Audible evidence preserved in the rows: for B0040F3GN4 and B07BB3D7CR the
provider's own lead series is the CORRECT sub-series; the Goodreads authority
overwrote a right answer with the umbrella. Any future §6 implementation must
keep those two rows green without their pins (temporarily disable pins in the
A/B to prove it).

A/B RESULTS, 2026-08-18. Arm A (no pins) x2: exactly 6 gate-relevant reds,
all Hobb, identical across both runs -- including Assassin's Quest, whose
cold recompute serves the umbrella (its correct prod serving was CACHE, not
current behaviour; the "control" framing in an earlier draft was wrong, and
the allow file was widened to all six). Arm B (pins minted) x2: 0 failures,
all 6 HEALED by name, gate PASS, no ALLOWLIST-UNCHANGED. 512 non-Hobb rows:
zero movement in any of the four runs. `bun run test`: 2411 pass / 0 fail.
Baseline re-written POST-fix (0 standing reds) so a future regression of
these rows reads as NEW rather than standing.

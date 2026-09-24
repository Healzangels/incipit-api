# Spec — shelf titles across the board: non-Latin names and co-written books

Status: **2026-09-24 — resolver rules (N1, C1) gated and committed; bundle folder rule on `nightly`, awaiting the test box.** Two independent resolver
defects found by a library-wide shelf-title audit, fixed together because they share
one A/B cycle. Operator framing, verbatim: *"lets make sure all the titles are
across the board"*.

## 1. The audit

`.cache/title-audit.py` over prod section 6 (1,743 albums, 1,550 on a shelf), Plex
data only. It flags non-Latin shelf names, split shelves, position collisions,
ordering-shaped names and retail junk. Most flags are deliberate or legitimately
distinct series (Riyria Chronicles vs Revelations, the Stephen Fry Harry Potter
edition shelf the operator keeps on purpose). Four kinds are real:

| kind | examples | mechanism | fix |
| --- | --- | --- | --- |
| non-Latin shelf name | Mushoku Tensei 14, 15 | resolver: no display rule for `<kanji> [<romanization>]` | **N1**, this spec |
| co-written book on a provider name | Cemetery Dance, Fever Dream | resolver: author gate reads only the FIRST author | **C1**, this spec |
| stale shelf the code already answers correctly | The Adventures of Sherlock Holmes | written by an earlier state | guarded refresh, no code |
| junk shelf built from a folder name | King "Split-Volume" shelves, "English Edition" on 1984, novellas stacked at Book 1 | bundle folder fallback on standalones | operator decision, not this spec |

The audit's split detector groups by Plex artist, so it missed Pendergast: the
albums carry different artist credits. The three Pendergast names were found by
reading the shelf list, and the grouping blind spot is noted for the next audit.

## 2. N1 — a non-Latin Goodreads name with a bracketed romanization

Goodreads lists the Mushoku Tensei light novel under exactly one series, 136942,
titled `無職転生: 異世界行ったら本気だす [Mushoku Tensei: Isekai Ittara Honki Dasu]`
— the librarian convention for manga and light novels: original title, then the
romanization in brackets. Positions are right (14, 15). The name is the defect.

* The existing display rename (`renamed()` in `lookupByTitle`, the Tintenwelt ->
  Inkworld mechanism) reads the series description's "Also known as" list for an
  English alias. This series declares none, so it correctly does nothing.
* `NON_LATIN_SCRIPT` guards only the secondary slot.
* Measured in-process: even an English PROVIDER series ("Mushoku Tensei: Jobless
  Reincarnation (Light Novel)" #14) is replaced by the Japanese name.

**Rule:** after the English-alias step, when the chosen name contains non-Latin
script AND ends in a bracketed Latin-script part, display the bracketed part.
Everything stays inside the one Goodreads record — same id, same positions — so
every volume lands on one shelf: `Mushoku Tensei: Isekai Ittara Honki Dasu, Book 14`.

It deliberately does NOT produce the English release title ("Jobless
Reincarnation"): that name exists only in providers, and provider names vary book
to book — the mechanism that split Hornblower. A per-series English name would
need a declaration table, one entry per franchise; out of scope.

## 3. C1 — the author gate reads only the first author

`seriesEnriched` passes `book.authors[0]` into the lookup, where it is both the
second half of the search query and the only name the positive-mismatch author
gate checks. The gate exists to reject companion records credited to someone else
("White Fire (Pendergast)" by BookBuddy). A CO-AUTHOR is not someone else.

Measured, deterministic: Cemetery Dance and Fever Dream are stored with authors
`[Lincoln Child, Douglas Preston]`; the mirror credits both works solely to
Douglas Preston. The search with Lincoln Child still returns the real work as hit
1 for both — so the query is fine and the gate is the whole defect:

| book | authors as stored | authors reversed |
| --- | --- | --- |
| Cemetery Dance | provider name kept: `Aloysius Pendergast #9` | `Pendergast #9` |
| Fever Dream | Audible passthrough: `Agent Pendergast #10` | `Pendergast #10` |

**Worse than it looks:** the shelf depends on author ORDER, and the order is not
stable. AudioSilo's copy of Audible's record lists Fever Dream as `Douglas Preston
| Lincoln Child` — the opposite of our stored record. So any re-fetch can flip a
co-written book onto a different shelf.

**Rule:** the gate accepts a work credited to ANY of the book's authors. The
search query keeps the first author (unchanged, so which works come back does not
move). Rejection still happens on a positive mismatch with ALL of them.

## 4. A/B protocol

* Corpus harness, pins off, each arm twice and byte-identical on a warm mirror.
  Arm A = `nightly` HEAD, arm B = N1 + C1.
* The harness gains `inputs.authors` (an array, preferred over `inputs.author`)
  so a corpus row can carry a co-author first, as the provider stores it.
* New corpus rows: Mushoku Tensei 14 and 15; Cemetery Dance and Fever Dream with
  authors in stored order; The Adventures of Sherlock Holmes.
* C1's reach cannot be seen by the whole-library diff (it passes one author), so
  it gets its own measurement: every co-written album (a work with 2+ authors in
  the AudioSilo snapshot), resolved old and new, with each co-author first.
* Whole-library old-vs-new diff for N1 and general safety.

## 5. Results

### 5.1 Pre-registered prediction (written before any arm ran)

* Arm B heals **exactly four** rows: Mushoku Tensei 14 and 15 (N1), Cemetery
  Dance and Fever Dream (C1). The Sherlock row is MATCH in both arms.
* **Zero** other movers, because both rules are structurally inert elsewhere:
  C1 reads co-authors, and every older corpus row carries a single `author`
  string; N1 fires only on a non-Latin name, and the corpus holds no other.
* Tests: **13 new** -- 5 pure N1, 3 N1 integration, 1 Gate C, 3 C1, 1 C1
  cache-key -- all passing; six mutations, one per part of the two rules, each
  confirmed to change the file, each killed, source restored byte-identical.

### 5.2 The A/B had to be restarted: my own burst throttled the mirror

Arm A ran twice on `nightly` HEAD. Run 1 took nine minutes and matched the
prediction exactly: the four target rows red, the Sherlock row MATCH. Run 2 took
**two minutes** and disagreed with run 1 on **220 of 540 rows**, almost all in
one direction: Goodreads answers replaced by Audible's names ("An Orphan X
Novel", "The Tier One Thrillers") or by NONE. That is the signature of lookups
short-circuiting, not of code.

Cause, measured: the mirror kept answering HTTP 200, but every `/search` went
from well under a second to **1.6-4.0 s**, even with nothing else running, while
`/work` and `/series` stayed at ~10-45 ms. The self-hosted mirror is paced at
`minGapMs = 0`, so a harness run fires ~1,000 searches as fast as the mirror
answers; run 1 did exactly that and the searches were throttled from then on.
Run 2's lookups then blew the per-lookup budget and fell back.

Consequences, and what was done:

* Arm B was stopped before it produced anything; no result from the throttled
  window is used anywhere.
* The live API degrades gracefully meanwhile: an over-budget lookup serves the
  provider's series and keeps running in the background, caching the real answer
  for the next refresh; an ordinary Plex refresh never rewrites an existing sort
  title. Nothing on prod was touched.
* The redo uses the harness's record/replay mode: ONE live recording on arm A
  (the superset: C1 accepts a hit the old gate walked past, so arm A fetches
  every URL arm B needs), sequential and with a long budget, then both arms
  REPLAYED from it with zero network. Deterministic by construction, and the
  mirror is hit once instead of four times.

### 5.3 The A/B, by record/replay -- measured

Each arm recorded once, live, sequential, 600 ms between requests (arm A 1,519
exchanges, arm B 1,512 -- seven fewer, because C1 accepts a hit the old gate
walked past), then replayed twice from its own recording with zero network:

| | |
| --- | --- |
| replay fidelity | every run served every exchange: 0 misses, 0 left over |
| arm A stability | 540/540 identical across its two replays |
| arm B stability | 540/540 identical across its two replays |
| the two recordings | 1,465 of 1,467 shared requests returned identical data |
| A -> B healed | **4**: Mushoku Tensei 14 and 15 (N1), Cemetery Dance and Fever Dream (C1) |
| A -> B broke | **0 by the code** (see Sherlock below) |

The prediction held exactly. One row flipped between the arms, The Adventures of
Sherlock Holmes -- and it is one of the two requests whose data DIFFERED between
the recordings. Replaying HEAD and the fix against each recorded search order in
separate processes gave identical answers per order, zero misses:
`Sherlock Holmes #3` under one, `The Adventures of Sherlock Holmes #4` under the
other. The code is not the variable; the data is.

### 5.4 Two defects the A/B surfaced, neither caused by this change

* **The Adventures of Sherlock Holmes -- exposed by O2.** Goodreads' `/search`
  never returns the collection in its top five. The FIFTH hit decides, and the
  five-deep window from `spec-ordering-only-shelf-split.md` made it reachable:
  "The Great Adventures of Sherlock Holmes" (no series) leaves Audible's correct
  `Sherlock Holmes #3` standing; "The Boscombe Valley Mystery - a Sherlock Holmes
  Short Story" gets adopted at its position in a series of the collection's
  stories. Prod rk 735035 carries that story's shelf. The first diagnosis of this
  shelf as "stale" was wrong. Needs its own title-gate fix, spec first.
* **A Time of Courage -- a new umbrella in the live data.** The work now lists
  both `Of Blood and Bone #3` (4 members) and `Banished Lands #7` (7 members),
  Gwynne's whole world; the ranking takes the bigger one. Identical in both arms.
  Same class as The Realm of the Elderlings: declare 449031 in UMBRELLA_SERIES.
  Prod shelves are still correct; a forced refresh of the seven Faithful and the
  Fallen / Of Blood and Bone books would move them.

Both rows are `knownDefectNow: true` with the mechanism recorded, and the
re-recorded baseline (545 rows, pins on, by replay) carries exactly these two as
standing reds. Pins-on `--gate` by replay: **PASS, 2 -> 2**. Hermetic gate:
**2,505 pass / 0 fail**. Lint and types clean; the one Prettier fix on the
resolver was proven behaviour-neutral by replaying arm B again: 540/540 identical.

### 5.5 Why no whole-library diff this time

Both rules are confined by construction to populations measured directly: N1
fires only on a non-Latin shelf name (the audit found exactly two, both
Mushoku Tensei), and C1 reads only co-authors, which the whole-library diff
cannot exercise because it passes one author per album. A whole-library run is
also ~3,500 mirror lookups, the load that throttled search on 2026-09-23.

## 6. The folder-junk shelves (bundle, `Incipit.bundle` v1.3.216, `619eff9`)

Operator, 2026-09-23: *"fix the folder junk shelves too"*.

Chaptarr files every book as `<Author>/<Series>/<NN - Title>/`, inventing a series
folder even for a book that belongs to none. When neither the provider nor
Goodreads names a series, the bundle's folder fallback trusted that folder.
Measured against every album path on prod (1,743 albums, one read-only Plex
call for track paths): **1,220 albums have a shelf equal to their folder
series** -- because Chaptarr's folders usually AGREE with the API -- so "shelf
equals folder" is not the fallback population. The discriminating signal is the
folder's CONTENTS:

| shape | example | rule |
| --- | --- | --- |
| edition marker in the folder name | `Insomnia Split-Volume/1 - Insomnia`, `The English Edition/3 - 1984` | refuse |
| one-book folder, numbered 1, named after the book (or contained in its title, 4-letter minimum) | `The Stand/1 - The Stand`, `Sunset/1 - Just After Sunset` | refuse |
| every book in the folder on the same number | `Different Seasons/1 - Different Seasons` + `1 - Apt Pupil` | refuse |
| one-book folder with a DIFFERENT name | `The Cosmere/18 - Arcanum Unbounded` | **keep** -- the fallback's reason to exist |
| lone book past number 1 | `Dune/3 - Children of Dune` | keep |
| folder whose books carry different numbers, however wrong | Discworld, Pern, Narnia | keep |
| a book mis-filed into another author's series | `Katie Kazoo, Switcheroo/31 - Child of God` | out of reach -- a folder to move |

Rejected first drafts, each refuted by the same measurement: "any one-book
folder" (Jack Ryan, Horus Heresy and METAtropolis are spread one book per
co-author folder, so it would strip legitimate shelves), and "any number
collision" (flags Discworld and Pern, whose Chaptarr numbering is by sub-arc).

The rule only acts in the fallback path and never overrides
`series_from_folder_wins`. The sibling listing goes through `Core.storage`
(untestable off-box); ANY failure returns None and the fallback behaves as
before. Candidates on prod: **34** albums match a refusal shape; the rule changes
only those the API leaves without a usable series -- measured on the test box by
a before/after forced refresh, not predicted.

Tests: 16 new, every case a real prod folder or a named guard; seven mutations,
all killed. One first SURVIVED: the short-name guard's test claimed "it" is
inside "Twilight" (it is not), so it passed with the guard deleted; rewritten on
"The Witcher", which does contain it.

## 7. Follow-up: Banished Lands declared an umbrella (2026-09-24)

The A/B surfaced it (section 5.4); this closes it with the mechanism
`spec-shelf-granularity.md` established for exactly this class. Goodreads series
449031 describes itself as "the world introduced in The Faithful and the Fallen
series and continued in the Of Blood and Bone series", and its seven members are
exactly those two series' books. At 7 members it outranks Of Blood and Bone (4),
so the member-count ranking handed those books to the world shelf.

Measured on every John Gwynne album on prod, HEAD `5420bae` against the
declaration, in-process against the live mirror. A declared id can only affect
works that list it, and all seven members are in the library, so this is its
complete reach; the Bloodsworn Saga, another world, is the control:

| albums | prod shelf | HEAD | with 449031 declared |
| --- | --- | --- | --- |
| A Time of Dread / Blood / Courage | Of Blood and Bone 1-3 | **Banished Lands #5, #6, #7** | Of Blood and Bone #1, #2, #3 |
| Malice, Valour, Ruin, Wrath | Faithful and the Fallen 1-4 | The Faithful and the Fallen #1-4 | unchanged |
| The Shadow / Hunger / Fury of the Gods | Bloodsworn Saga 1-3 | The Bloodsworn Saga #1-3 | unchanged |

Prod's shelves were still right; the next forced refresh of the three Of Blood
and Bone books would have moved them. One test (live work 72688467, with a
call-count assertion that the umbrella is never counted); removing the id turns
it red, and the source restored byte-identical.

**Corpus defect flags corrected.** `knownDefectNow` means "a live defect right
now". Five rows fixed today (Mushoku Tensei x2, Cemetery Dance, Fever Dream, A
Time of Courage) and the eight Hornblower rows fixed on 2026-09-08 by O1/O2 --
which had passed in every run since but were never unflagged -- now read false.
The only live defect left in the corpus is The Adventures of Sherlock Holmes.

## 8. Q1 decided: an edition listing never shelves a book on its own (2026-09-24)

A corpus question open since July ("Q1": when the only name Goodreads offers is
an ordering or edition listing, does a name beat none?) was answered in two
halves. On 2026-09-08 the operator chose Goodreads' reading ORDER for Hornblower,
so an ordering-only answer shelves. On 2026-09-24, asked to "fix the folder junk
shelves too" of a list naming the Split-Volume shelves, the other half: an
EDITION listing does not.

Under the Dome showed why the bundle rule alone could not finish the job: its
"Under the Dome Split-Volume, Book 1" shelf came from the API, not the folder.
The book's own work lists no series; a split-volume EDITION work lists "Under the
Dome Split-Volume"; the ranking marks that answer variant-only, and with no
provider series no apply-path refusal fired.

**Rule:** a variant-only answer whose name is an edition listing (split volume,
omnibus, box set, "... Edition" -- `EDITION_LISTING_RE`, the edition half of the
ordering vocabulary, held to it by a test) is not applied. The book keeps its
provider series, or none. It sits ahead of every other refusal, which also stops
O1 from releasing an ORDERING provider series to an edition listing.

**A/B by replay** of the umbrella gate's recording (the rule changes only the
apply decision, so both arms consume every exchange): both arms stable 545/545;
exactly **one** mover -- Under the Dome, `Under the Dome Split-Volume #1` -> no
series. Its corpus row, CONDITIONAL since July, now requires no series. Five tests;
four mutations (refusal removed; refusal on any variant-only answer, which kills
the Hornblower control; vocabulary swallowing reading orders; vocabulary without
word boundaries), each changed the file and was killed.

Library reach: the shelf-title audit found one API-derived edition-listing shelf,
Under the Dome. The other edition-marked shelves (Insomnia, Needful Things, Duma
Key Split-Volume; The English Edition) come from folders and are the bundle
rule's (section 6); if the API ever serves one of those listings, this rule
refuses it and the bundle's edition rule refuses the folder, so the two agree.

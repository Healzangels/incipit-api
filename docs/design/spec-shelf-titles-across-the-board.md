# Spec — shelf titles across the board: non-Latin names and co-written books

Status: **2026-09-24 — N1, C1, Q1, Q-author LIVE on prod (`0c8b7e3`); S1 (section 10) gated on `nightly`; bundle folder rule on `nightly`, awaiting the test box.** Two independent resolver
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

## 9. Q-author: the lookup searches for a person (2026-09-24)

Found by the co-author follow-up to C1 (section 3), which left the search query
on the first credit. Re-resolving every co-written album from Audible's CURRENT
record -- what the API's update sweep stores, at every container start
(`runImmediately`) and every 30 days after, for any record older than 7 days --
turned up a first credit that is not a person:

| The Adversary (Tier One #9) | credits |
| --- | --- |
| stored by the API (live route, `1fa81b0`) | Brian Andrews, Jeffrey Wilson |
| Audible today | **Andrews & Wilson**, Brian Andrews, Jeffrey Wilson |

The mirror's `/search` is literal: "The Adversary Andrews & Wilson" returns ZERO
hits; "The Adversary Brian Andrews" returns work 249535826, credited to "Brian
Andrews", in Tier One at 9. With no hit the book keeps its provider series, "The
Tier One Thrillers #9" -- beside nine siblings on "Tier One". No change of ours
causes this: the old build does the same the moment its stored record is
refreshed, and the next deploy's startup sweep refreshes it.

**Survey** (every album on prod, Audible's current record through `ApiHelper`,
paced, read-only; `.cache/audible-inputs.json`): 1,313 records, 430 skipped (365
not available in the US, 65 OverDrive). Combined credits: 3, all Tier One, only
The Adversary's first. Role suffixes: translator 22, introduction 7, editor 7,
note 1, afterword 1; three lists put a role FIRST (Heroic Hearts, Nightmare at
20,000 Feet, Dragonwriter). No corpus credit has either shape (0 of 549): they
arrived with Audible's newer records.

**Rule (`lookupAuthors`):** the lookup's people are the plain credits in provider
order, then the person each WRITING role names (editor, contributor), the role
cut off, once per person. Any other role (introduction, foreword, afterword,
preface, note, translator, illustrator, narrator) is dropped, and so is a
combined credit whose every part -- full name or surname -- is another credit on
the list. The vocabulary is closed: an unknown suffix stays part of the name, as
every suffix did before. A list with nothing to change comes back verbatim, so
the query, the author gate and the cache key of every such book are
byte-identical to before; a list in which no person survives also comes back as
given. The first person is the query author, and all of them feed C1's gate.

Why DROP the combined credit rather than move it last: every person it names is
on the list already, and dropping it keeps the cache key of the record the API
holds today -- the refetch cannot send the book through a fresh lookup at all
(tested). Why keep editors: Goodreads credits an anthology to its editor
(METAtropolis is John Scalzi's there). Dropping a non-writing role cannot move
the gate: `isSameAuthor("Ken Liu - translator", ...)` never matched anyone.

**Pre-registered prediction** (before either arm ran): the corpus is inert;
across the library, exactly one mover, The Adversary, `The Tier One Thrillers #9`
-> `Tier One #9`; the other rewritten lists unchanged.

**A/B, measured.** Corpus arm by replay of the umbrella gate's recording, arm A
= HEAD `80a62dd`, arm B = the rule: both arms consume it exactly (1,507 served, 0
misses, 0 left), twice each, 545/545 identical, gate reds 1 -> 1 (Sherlock).
Library arm, live and paced, over exactly the 31 albums whose credit list the
rule rewrites (any other album sends the same query, gate list and cache key):
both arms stable over two runs, **one mover -- The Adversary -> `Tier One #9`,
its prod shelf** -- and the other 30 identical in both arms and equal to their
prod shelves. Both arms re-run on the prettier-formatted bytes: identical.

Tests: 12 (`goodreadsLookupAuthors.test.ts`). Mutations, each changing the file,
all killed: combined credits never detected; no writing role; writers ahead of
authors; every role kept; surname parts never match; call site on the raw list;
no fallback; a writer duplicated when also credited plainly.

**Also measured by this follow-up** (the new build over every co-written album
with Audible's current record, `.cache/coauthor-real.json`): of the probe's 17
movers, Galaxy's Edge x7 and Defiance of the Fall were artifacts of passing no
provider series; METAtropolis is a real C1 heal (#2 -> #1: Goodreads credits the
anthology to its editor John Scalzi alone, fourth on Audible's list, so the old
first-author gate skipped the right work); Fever Dream and Cemetery Dance are the
expected C1 heals.

## 10. S1: the sibling-listing fallback (2026-09-24)

Found by check F (a sibling audit: albums off the shelf their series-folder
siblings share; `.cache/sibling-audit.py`). King and Maxwell was matched to a
delisted ABRIDGED "Part 1" (B00G2H2L5W, 450 min) against a 776.8-min file; the
operator approved the re-match to the unabridged B00ELMWOJ8 (done: guid moved,
the local-media poster selection the re-match displaced was restored, cover
bytes identical). But the right edition still shelves as Audible's "King and
Maxwell #6", beside Hour Game and First Family on "Sean King & Michelle Maxwell":

| query | the five hits |
| --- | --- |
| "King and Maxwell David Baldacci" | REVIEW record (BookBuddy), "Book Review" (Expert Book Reviews), "King And Maxwell (King & Maxwell)" (BookBuddy), Split Second (#1), The Sixth Man (#5) |

The book itself -- work 24064758 -- never comes back, so nothing is adopted and
the provider series stands. The two siblings name the listing that holds it:
series 43565 lists 24064758 at 6.

**Rule (S1):** in the FIRST pass only, a hit the TITLE gate turns away that is
POSITIVELY credited to one of our authors contributes its clean series (not an
ordering, not an umbrella). If the pass then adopts nothing and was not degraded,
the numbered members of up to two such listings become candidates -- the member
at our own volume marker first, then by position, at most 8 /work reads -- and
each faces the STRICT full-title gate (a listing is all siblings, so no relaxed
arm may match a sibling's stem), the same author gate, ranking and volume veto as
any hit. The listing rides `seriesRecord`'s memoized fetch (it now keeps the
members too). A book whose first pass adopts a hit never reaches the fallback,
so its fetches and answer are unchanged by construction.

Not the stem retry: there the title is a bare stem, and a strict match on
"Ahriman" adopts book 1 for "Ahriman: Exile" (tested). Not Sherlock: traced, it
does not MISS -- it adopts a wrong work (1214700, "The Adventures of Sherlock
Holmes" listed at 4), so the fallback never runs; it stays open as its own defect.

**Pre-registered prediction** (written before either arm ran): corpus -- no row
whose first pass adopts a hit can move; a mover is possible only where arm A
answers from the provider or with none, and every one must be a heal; Sherlock
unchanged. Library -- King and Maxwell (B00ELMWOJ8) moves to `Sean King &
Michelle Maxwell #6`; any other mover is a book whose search misses today, and
each is judged individually before any refresh.

**Corpus A/B, measured.** Arm A = HEAD `0c8b7e3` replaying the umbrella gate's
recording; arm B = S1, live and paced (600 ms), recorded. A strict replay of arm
B is impossible by design -- the fallback adds requests (129 replay misses).
The FIRST live arm B read "gate reds 1 -> 9" and was INVALID: 30 of 1,604
recorded exchanges failed (`ok:false`, empty body; 24 consecutive, a ~30 s
mirror outage). Every one of its 13 movers sat on a failed request, and each fell
to its provider name. It is kept as `rec-s1B-INVALID-30fails.jsonl`. The rerun:
**545/545 rows identical to arm A, gate reds 1 -> 1 (Sherlock), 0 movers**; 1,464
URLs shared with arm A's recording, 1,427 identical (the rest are /search
re-rankings that changed no answer); S1's own footprint on the corpus: 48 extra
requests (1 listing, 47 member /work reads), nothing adopted. Its 4 failed
exchanges are persistent mirror defects on two rows where S1 cannot act: On
Target adopts a hit (Gray Man #2), and Duma Key's /work 217077255 answers HTTP
500 every time, so its lookup is always degraded -- in both arms and in prod.

**Library A/B, measured** (`.cache/s1LibraryAB.ts`): arm B over every album with
a current Audible record (1,313), live and paced, recorded -- 3,715 exchanges, 2
failed (Duma Key's permanently broken record again). The fallback ENGAGED on 28
albums and adopted a listing member on 11 of them; arm A (HEAD) re-run on exactly
those 28 (133 exchanges, 0 failed): **28/28 identical, 0 movers, every answer
equal to its prod shelf.** Where S1 adopted, it found the Goodreads work agreeing
with the provider's own name and number (The Beast Arises #1, The Expanse #3.5,
Jurassic Park #2, Chaos Seeds #3, The Dark Tower #7, He Who Fights with Monsters
#11/#12, ...), so no shelf moves; Sherlock is identical in both arms. King and
Maxwell is outside that index (it held the delisted id); resolved from the API's
stored record for B00ELMWOJ8 through both arms: A `King and Maxwell #6` -> B
**`Sean King & Michelle Maxwell #6`** -- its siblings' shelf. The prediction
held on every point.

Tests: 11 (`goodreadsSiblingListing.test.ts`, a routing transport mock so each
test pins exactly which requests a lookup makes). Mutations, each changing the
file, all killed: fallback never runs; a sibling with no author data names a
listing; listing members get the relaxed gate; runs on a degraded pass; no member
budget; no volume-hint ordering; orderings/umbrellas name listings; a sibling
credited to anyone names a listing; listing members skip the author gate; runs in
the stem retry too.

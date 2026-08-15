# spec: the edition-marker (subtitle) tiebreak

**Status: CLOSED — won't fix.** Measured 2026-08-14 against the gate in §7, which was
written before anything was measured. G0 **passed**; the sizing **failed**, by a wide
margin and for a reason the design did not anticipate. See §9. The `REOPEN IF` in §7
still stands.

## 1. The case

Prod, 2026-08-14. `Ken Kesey/One Flew Over the Cuckoo's Nest/` holds two editions,
and both matched to the wrong one:

| on disk | catalogue record it took | what that record is |
|---|---|---|
| 25 parts, `©wrt = John C. Reilly`, `©day 2012` | `B000N0WX1G` | **Ken Kesey**, no runtime |
| single 601-min file, `©cmt = Read by Tom Parker … Blackstone, Aug 2005` | `B008N1TVDU` | **John C. Reilly**, 632 min, "50th Anniversary Edition" |

The parts belong on `B008N1TVDU`. The evidence to say so was already in the request
and already in the candidate payload — it was simply never compared.

## 2. Both halves of the discriminator exist today

* **Library side.** The bundle already sends the parts' track title as
  `trackTitle=One Flew Over the Cuckoo's Nest: 50th Anniversary Edition (Unabridged)`
  (`search_tools.py:1515`). It is not suppressed here: it differs from both the album
  tag and the resolved title, so the redundancy guard at `:1511` lets it through.
* **Catalogue side.** `B008N1TVDU`'s title is the plain book title; its
  `subtitle` is **"50th Anniversary Edition"**.

Nothing in the comparator brings those two together.

## 3. Why nothing compares them — two independent gaps

1. **`ProviderCandidate` has no `subtitle` field at all**
   (`helpers/providers/types.ts:39-88`). `ProviderBook` — the full record for
   `GET /books/{id}` — does (`:110`), which is why the field is visible when you
   fetch the ASIN and invisible when you rank it. Search ranks `ProviderCandidate`s.
2. **`titleTierById` reads the title only** —
   `normalizeTitle(c.title).toLowerCase()`, `BookSearchHelper.ts:1572-1582`. Both
   Cuckoo's Nest candidates carry the plain title, so both land in the same tier and
   the arm declines.

This split has bitten before and is already written down once:
`goodreadsSeries.ts:854-857` — *"Audible stores title and subtitle as separate
fields … and present a clean title to a guard that only reads book.title."*

## 4. Why the obvious fix is wrong

The obvious fix is to concatenate subtitle onto title before scoring. Do not.

**(a) It moves confidence, not just the tiebreak.** `c.title` feeds title
similarity, so every book where a provider carries a subtitle would score
differently. The blast radius becomes the whole library instead of the ambiguous
corner this is meant to fix.

**(b) It inverts a lesson already paid for.** `byExactTitle` (`:1836-1848`) exists
specifically to prefer the **bare** title: measured on Seth Ring's *Apex*, Audible's
"Apex: A Fantasy LitRPG Adventure" and OverDrive's "Apex" both scored 0.85 and
provider order handed the match to the marketing-subtitled row, so the album
displayed a tail its five series siblings don't carry. Making subtitles count
toward the title would re-seat exactly that row.

**(c) A subtitle is not an edition marker.** "A Novel", "A Fantasy LitRPG
Adventure" carry no identity at all. Treating every subtitle as evidence lets
marketing noise decide matches.

So the arm must be **additive, ranking-only, and inert unless the library's own tag
names an edition** — the same shape as the narrator-branding arm, which is
"inert without a narrator hint, so single-narration libraries never notice it"
(`:1746`).

## 5. Design

### 5.1 Schema

Add `subtitle?: string` to `ProviderCandidate`. **Optional**, like `abridged`, not
required like `language`: `types.ts:66-71` records why requiring a field forces six
of eight providers to write a meaningless `undefined`, and the risk that comes with
optional — a provider that HAS the signal silently dropping it — is covered by a
source-guard test, the pattern `abridgedTiebreak.test.ts` already uses.

### 5.2 Source — and the kill switch

`AudibleProvider.search` requests `RESPONSE_GROUPS` including `product_desc`
(`:23`). `ApiHelper` requests the same group and reads `.subtitle` (`:401`), which
is where the visible "50th Anniversary Edition" comes from. So subtitle is
**probably** already on the wire in the search response and merely unread — the same
shape as the `abridged` fix, whose comment reads *"the value was on the wire and
simply unread"* (`AudibleProvider.ts:155`).

**Probably is not measured.** See gate G0.

### 5.3 The arm

**Placement: inside the existing `runtimeCannotSeparate` block** (`:1814-1827`),
after `byExtends` / `byTagTitle`.

Two reasons, both load-bearing:

* `withinRoundingNoise` returns **true when either delta is null** (`:1097`, "no
  runtime on one or both … is also runtime-cannot-separate"). `B000N0WX1G` lists no
  runtime, so the block is live for exactly this case.
* Everywhere runtime *can* decide, it still does. That preserves the 2026-07-28
  finding that a cosmetic arm must not outrank runtime evidence — a branded edition
  22.8 minutes off must keep losing to the byte-exact recording.

Semantics:

```
queryMarker  := the subtitle segment of the library's own title forms
                (text after the first ":" in trackTitle / album title), normalized
rowMarker(c) := normalizeTitle(c.subtitle ?? ''), normalized

fires only when queryMarker is non-empty AND some candidate has a rowMarker
tier(c)      := 1 when queryMarker and rowMarker(c) share significant tokens, else 0
```

Ranking signal only. It can never discard a candidate, never change confidence, and
never fire when the library's tag names no edition — which is the property that
keeps it away from the ~95% of books that have no edition ambiguity.

Token comparison is **overlap of non-stopword tokens**, not equality: the tag says
"50th Anniversary Edition (Unabridged)" and the catalogue says "50th Anniversary
Edition". Deliberately not a closed vocabulary of edition words — a vocabulary is
brittle and needs maintaining, whereas requiring the marker on **both** sides is
self-limiting and needs none.

### 5.4 Invariants

1. Never a filter — reorders only candidates that already passed acceptance.
2. Never touches `confidence`.
3. Inert when the query carries no subtitle segment.
4. Inert when no candidate carries a subtitle.
5. Never fires where runtime can separate the pair.

## 6. Tests, and the mutations that must go red

Each mutation must be applied, **verified to have changed the file**, and confirmed
red — a green suite proves nothing about a test that never constrained the code.

| # | mutation | must break |
|---|---|---|
| 1 | invert the comparator sign | Cuckoo's Nest fixture seats `B000N0WX1G` again |
| 2 | delete the "query must carry a marker" guard | an Apex-shaped fixture (bare tag, subtitled Audible row) regresses |
| 3 | let the arm run outside `runtimeCannotSeparate` | the 22.8-min-off branded-edition fixture regresses |
| 4 | drop `subtitle` in `AudibleProvider.search`'s map | the source guard fails |
| 5 | make token overlap always true | a fixture with two DIFFERENT subtitles picks wrong |
| 6 | make the arm return a confidence delta | invariant-2 test fails |

Assert **which ASIN wins and why**, never a confidence number: a test that mirrors
the current value is a mirror, not a guard.

## 7. The gate — stated before measuring

**G0 (kill switch).** Confirm `subtitle` is present in the Audible *search*
response, not merely in the per-ASIN fetch. If absent → **close**; adding a response
group to the hot search path is a different, costlier change and is out of scope here.

**S1 (sizing).** Count library albums whose album/track title carries a subtitle
segment AND whose search returns ≥2 audio candidates. Read-only, prod + API.

**SHIP only if** the full A/B over the library shows both:
* ≥ 5 books whose winner changes and whose new winner is corroborated as the right
  edition (narrator, runtime, or edition marker), and
* **0 books whose currently-correct winner changes.** Regressions are disqualifying,
  not tradeable against wins.

**CLOSE (won't fix) if** G0 fails, or S1 < 20 candidate albums — the schema touches
eight providers and is not worth that for a handful — or any regression cannot be
designed out.

**REOPEN IF** the library gains materially more multi-edition books, or a provider
changes how it splits title and subtitle.

## 8. What this deliberately does not fix

* **The single Cuckoo's Nest file.** It is the Tom Parker / Blackstone 2005
  narration; a catalogue search surfaced no such edition, so no ranking arm can seat
  it correctly. Nothing to fix in code.
* **The 25-album split.** All 25 files carry identical `©alb`/`©ART` and no `trkn`
  at all. Grouping happens in Plex's scanner before the agent is called — a tagging
  fix, not an agent one.
* **Books whose tags name no edition.** The lever there is the narrator in `©wrt`,
  which the bundle does not read: the hint is sidecar-only (`search_tools.py:1463`),
  so `trustedNarratorKeys` is empty and the whole narrator block (`:1735-1781`) is
  skipped. That is a separate, larger spec.

## 9. Measured 2026-08-14 — the gate, and why it closed

### G0: PASSED

One live search (`title=One Flew Over the Cuckoo's Nest&author=Ken Kesey`, the exact
`RESPONSE_GROUPS` from `AudibleProvider.ts:23`) returns `subtitle` on the product:

```
B008N1TVDU  title="One Flew Over the Cuckoo's Nest"
            subtitle='50th Anniversary Edition'  narrators=['John C. Reilly']  rt=632
B002V8DEW0  title="One Flew Over the Cuckoo's Nest"
            subtitle=None                        narrators=['Ken Kesey']       rt=199
```

The field is on the wire and simply unread — exactly the shape of the `abridged`
fix. §5.2's inference was right.

Incidental, and worth keeping: the structured search returns **only these two
products**. `B000N0WX1G`, the record the 25 part-albums are actually sitting on, is
not among them.

### S1: FAILED — 4 books, not the ~300 the first count suggested

Across all **1675** albums in prod section 6 (3789 tracks, one pass over
`/library/sections/6/all?type=10`), counting albums whose first-track or album title
carries a `":"` segment:

```
albums with a subtitle segment          311   (266 distinct segments)
  ├─ EDITION-marker shaped               28   (4 distinct)
  ├─ series / marketing shaped          113   (93 distinct)
  └─ other (mostly series volumes)      170   (169 distinct)
```

311 looks like a comfortable pass. It is not, for two reasons:

**25 of the 28 edition-shaped albums are ONE book** — the Cuckoo's Nest split, where
every part carries the same `©nam`. Collapsed to distinct books, the entire library
holds **four** candidates for this arm:

| book | segment |
|---|---|
| One Flew Over the Cuckoo's Nest | 50th anniversary edition |
| Ender's Game | 20th anniversary edition |
| Homefront | an expeditionary force audio drama special |
| The Magician's Nephew | abridged |

The ship gate asked for **≥5 books corrected**. Four is the ceiling on books the arm
could *touch*, before asking whether any of them even has an ambiguous candidate set —
so the gate cannot be met at any implementation quality.

**And the other 283 segments are the hazard §4(c) named.** They are series names and
marketing taglines: "a novel", "the chronicles of narnia", "a mistborn novel", "a
litrpg adventure", "penguin classics". Audible puts series names in `subtitle` too,
so §5.3's both-sides rule does **not** confine the arm to edition evidence the way it
was designed to — it would fire on series-name agreement across ~113 albums while
doing its intended job on four. That ratio is the finding, and it is an argument
against the design, not only against its size.

### What this cost, and what it bought

Two live provider requests and one Plex pass. It bought not making a schema change
across eight providers for four books — and it produced the §4(c) evidence that the
both-sides rule is insufficient, which any future attempt at this arm has to answer.

### The lever this measurement points at instead

The narrator does not have this problem. It applies to **every** multi-edition book
rather than the four whose tags happen to name an edition, the discriminator is
already in the file (`©wrt = John C. Reilly` on all 25 parts), and the ranking
machinery already exists and is fully tested — it is inert only because the hint has
one source, the sidecar (`search_tools.py:1463`), so `trustedNarratorKeys` comes back
empty and `BookSearchHelper.ts:1735-1781` is skipped whole.

Note what G0 showed: `B002V8DEW0` is Kesey at **199 min** against a 601-min file, so
duration alone rejects it. The pair that actually needs separating — Reilly at 632
against a runtime-less Kesey record — is separable by narrator and by nothing else
this codebase currently reads.

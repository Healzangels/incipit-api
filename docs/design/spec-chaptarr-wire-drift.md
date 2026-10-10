# Chaptarr's wire drifted to snake_case: read what it sends now

Status: built and A/B'd on branch `chaptarr-wire-drift` — not merged. Serve arm 0/42 -> 42/42; search arm 7 heals, 0 regressions, 0 pins created or lost (section 6)
Measured: 2026-09-25

## 1. What changed on the wire

`ChaptarrProvider` was built on 2026-08-08 against a live capture
(`tests/fixtures/chaptarr-work-annihilation.json`). The same routes, captured live
on 2026-09-25 (`tests/fixtures/chaptarr-work-ninth-house-live.json`), answer a
different shape:

| field the code reads | 2026-08-08 | 2026-09-25 |
|---|---|---|
| store ids of an edition | `providerIdsAll.az` | `provider_ids_all.az` + a flat `asins` |
| format | `formatType` | `format` |
| edition language | `language` (`eng`) | `languageCode` (`eng`) |
| description | edition + work `description` | gone from both |
| `readingFormatId`, `narratorNames`, `durationSeconds`, `chapters` | present | unchanged |

Audiobook detection survived only because `readingFormatId` did. Everything else
that read a renamed field has read nothing, silently, since some point after
2026-08-08.

## 2. What that broke, measured

- **Variant ids cannot be served.** `editionForAsin`'s variant pass read only
  `providerIdsAll.az`, so an ASIN that is one of an edition's regional ids (not its
  own) resolves to nothing, and `GET /books/<variant>` answers **404**. Three Lady
  Hardcastle albums (A Picture of Murder, Rotten to the Core, Death Around the
  Bend) are matched to such ids: a refresh has nothing to fetch. The census found
  45 albums whose match is a variant id.
- **Every chaptarr row is language-unknown.** `language` is never on the wire, so
  the language gate, dedupe's language-conflict guard and the lookup route's
  foreign-edition flag never see a Chaptarr edition's language — relevant now that
  the edition check found seven foreign-language files.
- **The duration oracle skips variant ids** (`editionForAsin` again): fewer
  verdicts, not wrong ones.
- Descriptions: gone upstream; nothing to read. Recorded so nobody chases it.

## 3. The change

- `editionStoreIds` (added for spec-regional-pin-sibling) already reads all three
  store-id spellings; `editionForAsin`'s variant pass now uses it.
- `isAudiobookEdition` accepts `format === 'audiobook'` beside `formatType` and
  `readingFormatId`.
- `editionLanguage` reads `language ?? languageCode` for rows and served records.
- **The injection stands down for a recording already here.** Re-enabling the
  variant rescue re-opens what spec-regional-pin-sibling section 4 warned about: a
  sidecar naming a regional id gets the recording injected with Chaptarr's
  to-the-second runtime, which on merits can edge out the same recording's
  whole-minute Audible row and re-match the book to an id no store sells. So when
  the rescued row's store ids include an Audible row already in the pool, with a
  runtime inside provider rounding and narrators that do not disagree (the same
  `storeSibling` predicate R1 uses), nothing is injected. The pin stays unheld —
  exactly the behaviour while the rescue found nothing — so no privilege is minted
  from a fetch.

**Serving and injecting part ways** (added by the A/B, section 6). `fetchBookByAsin`
— serving an id an album is already matched to — resolves variants: that is the
404 fix. `fetchCandidateByAsin` — the pinned-edition INJECTION, which decides what
an album gets matched to — resolves an edition's own asin only. The injection is
reached only when Audible declined the id, so a Chaptarr-rescued variant is by
construction an id no store sells here; injected, it out-ranks the recording's own
store listing whenever that listing is not among the ids Chaptarr files for the
edition. This reverses the 2026-08-08 choice to inject variants under the asked-for
id — the choice that, while the camelCase wire still resolved them, produced the
45 variant-class matches.

## 4. What must not change

- Searches with no hint, or with a hint Audible serves: no new rows, no new pins.
- The variant class must not gain a regional #1 where today's #1 is a store row.
- The item route must serve a variant id it answered 404 for, and nothing else.

## 5. A/B plan

Same data (memory incipit-ab-same-data): arm B (this branch) live and recorded over
the same 298 albums as spec-regional-pin-sibling (138 primary, 42 variant, 58 other
unsellable, 60 controls; hint = the current match), arm A (`95fc57e`, deployed)
replaying arm B's recording. Compared: #1, the top three, `asinPinned`, and the
#1's language. Plus an item-route arm: `fetchBookByAsin` for every variant-class
match, before vs after.

## 6. A/B results (2026-09-25)

Same data. Search arm: 298 albums live on this branch, 1,919 exchanges (10 failed,
all Chaptarr, replayed identically); `95fc57e` replayed them with 0 misses and 0
left over, and so did the refinement below. Serve arm: `fetchBookByAsin` for the 42
variant-class matches, 42 exchanges, same discipline.

| arm | result |
|---|---|
| serve: variant-class ids served | `95fc57e` **0 / 42** (every one a 404) -> fix **42 / 42** |
| search: controls (60) | 0 #1 movers, 0 pins changed |
| search: primary class (138) | 6 heals: an injected own-asin Chaptarr row (sold nowhere) won its group; with the stand-down, the same recording's Audible listing is #1 (Rhythm of War, Jade Setter, In the Tall Grass 0.79 -> 1.0, Fool's Fate, The God Is Not Willing, Command Authority) |
| search: variant class (42) | 0 #1 movers |
| search: other unsellable (58) | 1 heal: Midnight Tides onto its Audible listing, same 0.777 |

**First cut refuted by its own A/B.** With variants injectable again, The Bone
Season's sidecar id (`B0CDCHG5XT`) was injected and beat the sellable
`B0CDXTH99Z`: the stand-down missed it because `B0CDXTH99Z` is not among the ids
Chaptarr files for that edition. Below #1 the same injection appeared for The Way
of Kings, Lord of Chaos and The Mime Order. Hence the split in section 3; replayed
on the same recording, those four are back to `95fc57e`'s answers.

**Language now reaches the gate.** Every row that left a top three below an
unchanged #1 is a foreign-language Chaptarr edition — French Brimstone and The Gray
Man, Spanish Murtagh / L.A. Confidential / Katabasis / Colour of Magic / Light
Fantastic / Ruin and Rising, German Origin and Red Rising, Italian Fourth Wing,
Dutch L.A. Confidential — several of which had ranked at 1.000 as "unknown".

Mutation: 31/31 killed (`.cache/mutateWireDrift.py`).

## 7. A zero runtime means "unknown" (2026-10-07, branch `chaptarr-zero-runtime`)

Found in the 2026-10-07 code review. The wire says `durationSeconds: 0` when it does not
know an edition's length: 5,426 of the 7,495 audiobook editions in the 2026-09-26 search
recordings, 208 of them with an asin and so emitted as candidates. `candidateFrom` passed
the 0 through as a length, while the duration oracle and the chapter reader already read
0 as absent.

**What it broke.** dedupe groups rows that share a title, lead author and rounded-minute
bucket, so every zero-runtime row landed in bucket 0. Two zero-runtime chaptarr rows of
DIFFERENT recordings therefore joined their recordings' groups (each row also shares
its asin with that recording's store listing), and one recording vanished from the
results, Fix Match included. Reproduced with two narrators, each with an Audible listing
and a chaptarr row: one result instead of two.

**The change.** `audioSeconds` is null unless `durationSeconds > 0`. The provider's cache
version goes 2 -> 3, because a cached v2 row still says 0 and prod's Redis would serve it
for 7 days. Audible (1,344 runtimes, all positive) and OverDrive (2,540, and its parser
already skips 0) emit no zeros, so the source fix is the whole fix.

**Same-data A/B.** Arm A `2659572` (nightly) and arm B this branch, both replaying the
2026-09-26 recordings (759 albums, 4,562 exchanges, 0 misses, 0 left over in either arm):

| | albums |
|---|---|
| result list grew (rows dedupe had merged away) | 18, +34 rows |
| rows lost | 0 |
| #1 changed | 1: Sphere Of Influence, from a merged row (an ISBN record's id wearing another edition's narrator) to the B0 audiobook listing narrated by Michael Kramer |
| top three changed below an unchanged #1 | 11 (regained editions entering the list) |
| unchanged #1 whose confidence or narrators changed | 0 of 753 |

The regained rows are real editions the merge hid, several with their own narrators
(Dragonflight's Adrienne Barbeau, Fade's Robertson Dean, The Lion, the Witch and the
Wardrobe's Michael York). Mutation: 4/4 killed (`.cache/mutateZeroRuntime.py`).

## 8. A daily canary (2026-10-10)

Chaptarr publishes no docs, version or changelog (probed 2026-10-10: `/docs`,
`/openapi.json`, `/api/v5/version`, `/api/v6/...` all 404), and the rename in section 1
went unnoticed for weeks. A wire check, re-fetching 25 works and 6 editions against the
same bodies recorded in September, found the schema unchanged since 2026-09-25, the data
growing (+31% audiobook editions in two weeks) with flat completeness (asin 25%, runtime
24%, narrators 72%), enrichment and the odd regression (an edition lost its runtime,
chapters and store ids), and the R1 gap editions unchanged (spec-regional-pin-sibling
section 9). `providerUrls.audible`, a field we never read, was always one of the edition's
own store ids (2,342 editions, 0 outside), so it adds nothing to R1.

`runChaptarrWireCheck` (src/helpers/providers/chaptarrWireCheck.ts) checks one known work,
Ninth House, on the raw wire (naming the field that moved, in every spelling it has had)
and through ChaptarrProvider itself (whether we still read it: runtime, narrators,
language, the store ids naming audible.com's listing, and serving a regional id). Run it
inside the API container, where it uses the deployed build:

    docker exec incipit-api bun run check:chaptarr

Exit 0 all passed, 1 drift (the output names the field), 2 unreachable (an outage, not a
drift). `tests/live/providers/chaptarr.live.test.ts` runs the same check; its unit test
renames each field the way the service did and asserts exactly that field's checks fail.
Mutation: 8/8 killed (`.cache/mutateCanary.py`).

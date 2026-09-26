# Chaptarr's wire drifted to snake_case: read what it sends now

Status: built on branch `chaptarr-wire-drift` — A/B pending (section 5)
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

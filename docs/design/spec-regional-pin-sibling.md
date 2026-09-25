# A regional sidecar ASIN lands on the listing the store sells

Status: proposed — built on a branch, A/B pending (section 7)
Measured: 2026-09-25

## 1. What the edition check found

The 2026-09-25 edition check compared every prod album's file duration with its
matched edition. 238 of 1,745 albums are matched to an ASIN that Audible's catalogue
sells in **no region** (us/uk/ca/au/de sampled: `NOT_AVAILABLE_FOR_PURCHASE`, no
runtime, no narrators). They are not wrong books and not ebook ASINs. Chaptarr's
metadata service knows 231 of them as **audiobook editions**:

| census over the 238 (`.cache/audiosilo/unsellable_census.py`) | albums |
|---|---|
| Chaptarr resolves the ASIN as the edition's own (primary) asin | 186 |
| ...only as one of the edition's regional ids | 45 |
| not known to Chaptarr (404 / null) | 7 |
| the SAME edition lists an ASIN Audible's US store sells, within 3 min of the file | **180** (138 primary, 42 variant) |
| the matched recording itself is >3 min off the file (a different recording) | 22 |

Chaptarr files one audiobook edition under every regional id it has. Ninth House's
Lauren Fortgang recording carries twelve, `B07LHB5ZJ6` (what audible.com sells)
among them, and the service names `B07LH8GF23` — which nothing sells — as the
edition's `asin`.

What the album loses by sitting on the unsellable id (both read from prod
`/books/:asin`, 2026-09-25):

| | `B07LH8GF23` (matched) | `B07LHB5ZJ6` (sellable sibling) |
|---|---|---|
| served from | Chaptarr rescue + Hardcover | Audible |
| runtime / format | none / none | 982 min / unabridged |
| cover | Hardcover edition art | Audible |
| rating, genres | Goodreads 4.05, Hardcover genres | Audible 4.4, Audible genres |

It also rides on a supplement with no SLA, and the duration guard cannot check an
edition with no runtime.

## 2. The mechanism, reproduced live

`GET /books?title=Ninth House&author=Leigh Bardugo&duration=58947942` on prod:

| hint | #1 | Audible's `B07LHB5ZJ6` |
|---|---|---|
| none | audible `B07LHB5ZJ6`, 1.0 | #1 |
| `asin=B07LH8GF23` | chaptarr `B07LH8GF23`, 1.0 | **absent from the results** |

1. The album's sidecar names `B07LH8GF23`; the bundle sends it as `&asin=` on every
   automatic search and on Fix Match's auto-fired list (search_tools.py
   `incipit_extra_args`).
2. ChaptarrProvider's search emits the edition under its own `asin` —
   `B07LH8GF23` — with a to-the-second `durationSeconds`.
3. Audible's row for the same recording lands in the same minute bucket, so
   `dedupeCandidates` merges the two, and its pin-aware winner rule ("a pin beats
   everything") keeps the chaptarr row. The sellable listing is deleted from the
   results — not even pickable in Fix Match.
4. The album then refreshes through the Chaptarr rescue (`bookFrom`), which serves
   no runtime.

Each step is correct by its own lights: the pin is the operator's stated identity,
and dedupe protects it. The gap is that the pin names a RECORDING by an id the store
does not sell, and nothing maps it to the id the store does.

**The variant class does not reproduce today.** Royal Assassin (`B003NYOBOQ`, only a
regional id of edition `B003NTPCVM`): with or without the hint, Audible's
`B003NTPCVM` wins. Audible's `fetchCandidateByAsin` returns null for the unsellable
id, the registry falls through to Chaptarr, and `editionForAsin`'s variant pass
reads `providerIdsAll` — a key the live service no longer sends (section 6). So the
42 came from older code and a re-match already fixes them; the pin itself is dead
for them (no row carries it), which this rule also repairs.

## 3. The rule

**R1 — a regional pin moves to its store sibling.** In `BookSearchHelper.search()`,
after the pinned-edition injection and BEFORE the dead-pin ISBN promotion, on both
the album pass and the widened pool:

1. The pin is a listing identity (`pinHasListingPrivilege`: B0-shaped). ISBN-derived
   identities are untouched — they rank on their merits by the 2026-07-28 contract.
2. No `audible` row in the pool carries the pinned ASIN, and the pinned-edition
   fetch was not answered by Audible. Either means the id IS a store listing here.
3. A pool row names the pin — its `asin` is the pin, or its `asinAliases` hold it —
   and carries an alias set (the regional ids of its edition) and a runtime.
4. An `audible` row in the pool has an `asin` in that alias set.
5. **Same recording, not merely same edition record:** the two runtimes agree
   within the provider-rounding epsilon (`durationTieEpsilonSeconds`, the same
   width the comparator already treats as "cannot separate"), and when both list
   narrators they share one.

Then the pin identity becomes that Audible row's ASIN (closest runtime first, then
the lexically smaller ASIN, so the choice is a function of the candidate set). Every
pin mechanism downstream — dedupe's group winner, the confidence override, the
pinned-first tiebreak, the stale-pin duration override, telemetry's `asinPinned` —
then acts on the sellable listing. Nothing else changes: the scorer, the comparator
arms and dedupe are untouched.

**Supporting changes:**
- ChaptarrProvider candidates carry `asinAliases`: the edition's other store ids,
  read from `provider_ids_all.az` (what the service sends now), `providerIdsAll.az`
  (what it sent on 2026-08-08) and `asins`, uppercased, prefix stripped. The field is
  stripped from the search response — it is matching evidence, not payload.
- ChaptarrProvider declares `cacheVersion = 2`; the registry keys a provider's
  search-cache entries by name plus version. Prod runs Redis with a 7-day TTL, and a
  cached chaptarr row without aliases would keep R1 off for a week after deploy.
- Telemetry: `pinPromotedToSibling` per decision, `pinPromotedToSiblingSearches` on
  `/metrics`, and an info log line naming both ids.

## 4. What R1 must not do

- Move a pin whose id Audible serves here (a live listing is never second-guessed).
- Move a pin to a DIFFERENT recording: Chaptarr's edition grouping is data, and
  guard 5 refuses an alias whose runtime or narrators disagree.
- Touch a search without a hint, or with an ISBN-derived identity.
- Re-enable the Chaptarr rescue of a variant id (section 6): without R1's sibling in
  the pool, a rescued regional row could win on closest-runtime and re-create the
  variant class.

## 5. Predictions (for the A/B, section 7)

| population | today's #1 with hint = current match | with R1 |
|---|---|---|
| 138 primary-class | the regional id | the census's sellable sibling |
| 42 variant-class | already the sellable listing | same #1; now `asinPinned` |
| 58 other unsellable | the regional id or a mismatch | unchanged (no sellable sibling) |
| controls (sellable current match) | the current match | unchanged |

A primary-class row that does NOT flip means Audible's fan-out missed the sibling —
counted and listed, not a failure of the rule.

## 6. Out of scope: Chaptarr's wire has drifted

Captured live 2026-09-25 on both `/api/v5/book/` and `/api/v5/work/`: editions carry
`provider_ids_all`, `asins`, `format`, `languageCode`; the 2026-08-08 fixture (and
`ChaptarrEdition`) have `providerIdsAll`, `formatType`, `language`. `readingFormatId`
survives, so audiobook detection still works. Still reading nothing: the variant pass
of `editionForAsin` (both rescue paths), every chaptarr row's `language` (so the
language gate and dedupe's language-conflict guard never see a chaptarr edition's
language), and the duration oracle's parent lookup. A separate change with its own
A/B — and after R1, for the reason in section 4.

## 7. A/B plan

Same data (memory `incipit-ab-same-data`): arm B (R1) runs live and records every
provider exchange; arm A (HEAD) replays arm B's recording. Inputs per album: album
title, artist, the file's summed track duration (ms), region `us`, and `asin` = the
current match — exact for the unsellable classes (the match IS the hint that won)
and the common case for controls. Populations: the 238 plus a seeded control sample
of sellable matches. Compared per album: #1 asin/provider/confidence and the top
three. Failed exchanges are counted before any row is read.

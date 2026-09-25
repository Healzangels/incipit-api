# A regional sidecar ASIN lands on the listing the store sells

Status: built and A/B'd on branch `regional-pin-sibling` — NOT deployed. Same data: 127 heals (111 + 16), 0 movers elsewhere, 0 pins created or lost (section 8)
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

**R1 — a regional pin's privilege moves to its store sibling.** R1 TRANSFERS a pin,
it never creates one. In `BookSearchHelper.search()`, after the pinned-edition
injection, on both the album pass and the widened pool:

1. The pin is a listing identity (`pinHasListingPrivilege`: B0-shaped). ISBN-derived
   identities are untouched — they rank on their merits by the 2026-07-28 contract.
2. No `audible` row in the pool carries the pinned ASIN (else it IS a store listing).
3. **The pin already holds privilege:** a row a provider returned for the TITLE query
   (not the injected fetch-by-asin row) carries the pinned ASIN as its OWN asin — the
   exact `isPinned` warrant — and carries its edition's other ids (`asinAliases`) and
   a runtime.
4. An `audible` row in the pool has an `asin` among those ids.
5. **Same recording, not merely same edition record:** the two runtimes agree
   within the provider-rounding epsilon (`durationTieEpsilonSeconds`, the same
   width the comparator already treats as "cannot separate"), and when both list
   narrators they share one.

Then the pin identity becomes that Audible row's ASIN (closest runtime first, then
the lexically smaller ASIN, so the choice is a function of the candidate set), and
**the listing privilege travels with it** whatever the new id's shape
(`hasListingPrivilege`): audible.com sells Peace Talks as `0593290704`, a store
listing the title search returned, not a book-level ISBN. Every pin mechanism
downstream — dedupe's group winner, the confidence override, the pinned-first
tiebreak, the stale-pin duration override, telemetry's `asinPinned` — then acts on
the sellable listing. The scorer, the comparator arms and dedupe are untouched. R1
and the dead-pin ISBN fallback cannot both act (R1 needs the pin on a fan-out row,
the fallback needs it on none).

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
- CREATE privilege. A pin held only by the injected row, or an id a row merely lists
  (the variant class), had none before R1 and gets none from it.
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

## 8. A/B results (2026-09-25)

Same data: arm B ran live over 298 albums (138 primary, 42 variant, 58 other
unsellable, 60 seeded controls) and recorded 1,919 exchanges — 10 failed, all
Chaptarr, replayed identically; arm A (`aa25b06`) and every refinement replayed it
with 0 misses and 0 left over. Hardcover sat out (no local token): the local pool
lacks rows prod has, identically in both arms.

**First cut — refuted by its own A/B.** 118 primary movers, but two defects:
- Privilege CREATED. Midnight Tides' pin lived only on the injected fetch-by-asin
  row (0.777 on merits, correctly below auto-apply: the file is 9% off that
  recording); R1 moved it onto Audible's listing of the same wrong recording at a
  pinned 1.0. Same shape for the whole variant class (22 pins gained).
- Privilege LOST. Peace Talks, Network Effect and Jade War moved onto
  ISBN-shaped store ids (`0593290704`, `1980021716`, `1549126768`); privilege was
  keyed on the new id's shape, so the pin died and a closer-runtime OverDrive row
  (no ASIN) or another regional chaptarr row took #1.

**Refined (section 3) — the result:**

| population | rows | #1 movers | where they went | pins gained / lost |
|---|---|---|---|---|
| controls | 60 | 0 | — | 0 / 0 |
| primary class | 138 | 111 | all 111 onto the census's sellable sibling | 0 / 0 |
| variant class | 42 | 0 | — (their pin was dead; the store listing already wins on merits for 39) | 0 / 0 |
| other unsellable | 58 | 16 | the same recording's store listing, same confidence (Malazan x6, East of Eden, Joyland...) | 0 / 0 |

Every mover keeps its confidence (1.000 -> 1.000); no row's top three changed below
an unchanged #1. The 25 primary rows that stay: Audible's title search never
returned the sibling (16), Chaptarr's `/work/` edition does not list it although
`/book/` does (2), no Chaptarr duration (1), or the pin lives only on the injected
row (6). The 16 "other" movers matter even though their recording is the wrong
one for the file: on a sellable listing the runtime is readable, so the edition
check can now flag them.

Mutation: 25/25 killed (`.cache/mutateRegionalPin.py`), including the injected-row
vouch, the listed-only pin, and privilege left behind on an ISBN-shaped id.

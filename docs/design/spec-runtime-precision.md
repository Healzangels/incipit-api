# Closest runtime reads Audible's minute as the truncation it is

Status: built and A/B'd on branch `runtime-precision`, not merged. 120 #1 movers over 759 albums, all onto the Audible listing of the same recording; 0 away from Audible; 0 in the non-Audible class (section 7)
Measured: 2026-09-26

## 1. Audible truncates its runtimes

Audible lists `runtime_length_min`, and the API ranks it as the point `m * 60`. Three
measurements say it is the minute the recording STARTS in, not the nearest one:

- **Audible's own chapter runtime** (`isAccurate: true`, via audnexus) against the
  listed minute, for 14 listings: 13 sit inside `[m, m+1)`, and the 14th (B002V1O00C)
  sits 1.12 minutes above. None is below, none was rounded up, and 9 of the 13 have a
  fraction of .5 or more, which rounding would have listed a minute higher.
- **The library's files.** Of 260 files within two minutes of their current Audible
  listing, 238 sit 0-75s ABOVE its minute and 6 below. Rounding would centre them on 0.
- **Chaptarr is not a second opinion.** For an Audible-listed id its duration is the
  same whole minute (430 of 433 equal, all 433 whole), and the API's own
  `/books/:asin/chapters` answers `isAccurate: false` with `m * 60`.

So an Audible runtime `s` stands for the span `[s, s + 60)`; the recording is, on
average, 30s longer than the number the comparator used.

## 2. What that broke

The comparator's closest-runtime arm (below the pin, confidence band, language,
volume, audio and narrator arms) orders rows by `|file - runtime| / runtime`. Audible's
listing pays the truncation, 0-60s; a listing of the SAME recording that states its
runtime to the second pays only real differences. OverDrive's `HH:MM:SS` is that
listing: whenever everything above the delta arm ties, the OverDrive copy takes #1 --
a listing no Audible store sells, with OverDrive's title, cover and blurb.

It shows only in the upper half of Audible's minute. `dedupe` buckets runtimes by the
ROUNDED minute, so an OverDrive row in the lower half shares Audible's bucket and
merges into its group, where the Audible row wins on richness; in the upper half it
rounds to the next minute, stays separate, and wins closest-runtime by up to a minute
of truncation.

Measured in the 2026-09-25 search recording (the wire-drift A/B, 298 albums): 11
albums had an OverDrive #1 while the Audible listing, same narrators, sat in the top
three with the file inside its minute. Wind and Truth (OverDrive 0.8s off; the file
32.8s above Audible's minute), The Mime Order (0.5s; 57.5s), Disquiet Gods (0.0s;
38.0s), Lord of Chaos, Fool's Assassin, Howling Dark, Armored, Sentinel, The Shadows of
London, The Ballad of Songbirds and Snakes, and a Mushoku Tensei volume.

**Not this class**, though first listed as examples: The Book of Koli and Parable of the
Sower. Koli's file is 851.99 minutes, inside the 851-minute regional listing Chaptarr
carries and 2 minutes under audible.com's 854; Parable's sits between the two listings,
closer to the regional one. There the runtime points at a different master, and the
rule leaves them where they are.

## 3. The change

- `runtimeGapSeconds(want, audio, truncatedMinute)`: the point `|want - audio|`, or,
  for a truncated minute, the distance from the file to the span `[audio, audio + 60]`
  (0 inside it).
- The delta arm orders by that gap as a fraction of the row's runtime, the unit it
  already used (`runtimeDelta`). A row is a truncated minute when its provider is
  Audible. Every other row is a point, so its key is exactly its old `durationDeltaPct`,
  and a row with no delta there still never takes part.
- **Nothing else reads it.** The 90s rounding band (`withinRoundingNoise`) and the
  cosmetic arms it licenses, the 600s narrator-branding window, the pin-fingerprint
  contradiction, `storeSibling`, the Gate-0 scorer (corroboration at 5%, veto at 25%),
  the dead-zone ramp and dedupe's bucket all measure as before. Confidence is
  untouched: this reorders rows that already passed; it never adds or drops one.

**Audible's rows only.** The first cut read every whole-minute runtime as a span, and
the existing He Who Fights with Monsters test failed. A Hardcover "Vol. 1" record whose
whole minute held the file out-ranked the tag-exact listing 14s away: the 2026-07-28
wrong-edition shape again. A whole minute from any other provider is not known to be
truncated. A Chaptarr or Hardcover copy of an Audible minute therefore stays a point,
which can only favour the listing the store sells.

The injected pin row (provider `pinned`) stays a point even when Audible served it.
With listing privilege it ranks first anyway. An ISBN-shaped pin ranks on its merits and
could still lose a truncation tie; that case is not measured here.

## 4. What must not change

- Pairs with no Audible row order exactly as before. Tested as an invariant: rows come
  out sorted by the scorer's own delta, even when equidistant from the file.
- **The 2026-07-28 lesson:** the epsilon never discards evidence. An Audible listing
  whose minute sits 88s under the file is still 28s past its span, and loses to the
  byte-exact row. Tested.
- The He Who Fights with Monsters test is unchanged and passes.
- The span ends a minute after its start: a file 70s above Audible's minute is 10s out,
  and a row 8s off still wins. Tested at 59/61s by mutation.

## 5. Alternatives not taken

- **Every whole minute as a span:** refuted by the He Who Fights with Monsters test
  (section 3).
- **The midpoint `s + 30`, or the expected distance to a uniform minute:** unbiased as
  estimates, but they leave the class as it is. For the same recording, OverDrive's few
  seconds still beat Audible's expected 15-30s. The runtime cannot tell the two
  listings apart. The comparator still needs one number per row to stay transitive, so
  Audible's listing has to be placed somewhere, and the span's lower bound places it
  first: inside its minute, it is as consistent with the file as any evidence can show.
- **Dedupe by the truncated minute (`floor`) instead of the rounded one:** that would
  merge the same pairs and remove the OverDrive row from Fix Match altogether. It
  changes every provider's grouping, so its blast radius is wider. It is recorded here
  as the asymmetry behind section 2 and not done.

## 6. A/B plan

Same data (memory incipit-ab-same-data): arm B (this branch) runs live and recorded, and
arm A (`775ca95`, deployed) replays arm B's recording. Hint-less searches: the rule acts
below the pin arm, so this is the superset of what it can move (Fix Match's list, and
every album without a B0 sidecar pin).

- Batch 1: the 568 albums whose exact file duration is on hand. That is the 298
  wire-drift A/B albums (138 primary, 42 variant, 58 other unsellable, 60 controls)
  plus 270 more currently matched to Audible.
- Batch 2: the edition check's 108 UPGRADE and 83 non-Audible albums (191, none
  skipped). Their exact durations had to come from Plex, which refused connections
  for about 45 minutes while batch 1 started; batch 2 runs after batch 1 so the two
  never double the load on the providers.

Compared: #1, the top three, and the #1's confidence. Each #1 mover is classified by
provider pair, by whether narrators agree, and by where the file sits against the new
#1's span.

## 7. A/B results (2026-09-26)

Both batches replay faithfully. Arm A and the branch's own replay each served every
recorded exchange, with 0 misses and 0 left over, and the branch's replay reproduced
its live ranking on every album (568/568 and 191/191).

| batch | albums | exchanges (failed) | #1 movers | below an unchanged #1 |
|---|---|---|---|---|
| 1: wire-drift A/B set + 270 Audible-matched | 568 | 3,368 (4) | 93: 92 OverDrive -> Audible, 1 Chaptarr -> Audible | 6 top-3 reorders |
| 2: UPGRADE + non-Audible | 191 | 1,194 (0) | 27, all UPGRADE: 25 OverDrive -> Audible, 1 Chaptarr -> Audible, 1 Audible -> Audible | 2 top-3 reorders |

- **Every one of the 120 movers lands on an Audible listing whose narrators match the
  row it replaces.** The one apparent mismatch is OverDrive spelling Cliff Kirk as
  "Cliff Kurt". No row moved away from Audible, no #1 confidence changed, and no
  result list grew or shrank. The eight reorders below #1 are all an Audible listing
  rising above an OverDrive row.
- **Where the file sits against the new #1:** 91 inside Audible's minute (the class);
  18 within a minute past it, where the span still measures closer than the old #1;
  11 with both listings more than a minute off. In those 11 the file is a different
  production, and #1 flips between two listings of the same recording, neither of
  them right.
- **Against curated matches:** in the two sets whose current match is curated (the
  controls and the Audible-matched albums), the branch's #1 is the album's current match
  for 48 of 49 movers and nightly's for none. For the 32 unsellable-class movers that
  the guarded re-match waves re-pointed, the branch's #1 is the wave's verified target
  in 31. The 32nd is The Mime Order, which Audible sells twice: the same recording
  under B0D3238M1M and B0D333ZKCC, five days apart.
- **The 83 non-Audible albums (no exact Audible edition) moved 0.** Of the 108 UPGRADE
  albums, 27 moved and 81 did not, for reasons outside this rule. In 18 Audible's
  search returns no fitting row. About 12 are settled by an earlier arm: the 'query'
  title preference inside the band (Nevermoor, Apex, Silverborn, Dragonsong) or a
  confidence gap from a title missing the series prefix (the Alcatraz books). A few
  are genuinely closer to OverDrive (The Corrections, Red Dragon: the file sits
  12s and 2.5s past Audible's minute). The rest meet an Audible listing of a different
  production.

**The first run was thrown out.** Batch 1's first live run hit two network drops, and
the registry's circuit breakers (OPEN for 60s of wall-clock time) carried them across
albums. Replayed in milliseconds, a window covered the rest of the run, so both
replays skipped providers live had called: 501 exchanges went unconsumed, and 85
albums differed between live and replay. Chaptarr's POST `/match` replays in
per-URL order, so it could also have shifted answers between albums. The harness now
resets breakers per album. The re-run is the one reported above.

Mutation: 12/12 killed (`.cache/mutateRuntimePrecision.py`).

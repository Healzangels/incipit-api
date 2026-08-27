# A duration oracle: catch a truncated file before an operator does

Status: proposed
Measured: 2026-08-26

## The problem it solves, twice over

Two duration incidents inside a week, both found by accident and both expensive:

* **Soldiers Live** was a **6.56 h** file of a **19.53 h** book — a third of the
  audiobook, sitting in the library looking healthy. Nothing detected it. It
  surfaced only because an unrelated sweep happened to print its bitrate.
* **Shadows Linger** was FINE, and I told the operator to delete it. I read its
  `mvhd` duration (1412.69 min) as real and inferred ~13 h of foreign audio. The
  analysed duration was 10.59 h and the chapter table ended at 635.6 min — two
  sources agreeing against the header. **The file was deleted on my advice and
  had to be re-acquired.**

The common shape: **nothing in this stack knows how long a book is SUPPOSED to
be.** `mvhd` lies, bitrate proves nothing here (encodes range 64–145 kbps), and
Plex's analysed duration only says what IS on disk, never what SHOULD be.

## What makes this newly possible

`api2.chaptarr.com` returns, per ASIN-keyed audiobook edition:

```
durationSeconds  chapterCount  hasChapters  audibleParts[]  isAudibleExpectedMultipart
audibleContentDeliveryType  audibleHasChildren  audibleDeliveryStructure
```

Only `durationSeconds`, `chapters` and `hasChapters` are consumed today. The
whole Audible multipart family is unused.

Measured 2026-08-26 against Plex's ANALYSED durations:

| book | chaptarr | plex analysed | verdict |
| --- | --- | --- | --- |
| Soldiers Live | 19.53 h | 19.49 h (after replacement) | agree, 0.2% |
| Shadows Linger | 10.55 h | 10.59 h | agree, 0.4% — the file was fine |
| The Dreaming Void | 22.58 h | 22.63 h | agree, 0.2% |

Agreement is within 0.4% on all three, while the truncated Soldiers Live was
**66% short**. The separation is not close, which is what makes a threshold
viable at all.

## Design

A read-only operator audit, `scripts/durationAudit.ts`, in the shape of
`seriesSweep.ts` — NOT a serving-path change and NOT a gate.

1. Read every track's analysed `Part.duration` and its `incipit://<ASIN>` guid
   from Plex (one bulk call per box, the shape `library-baseline.py` already uses).
2. For each ASIN, resolve the edition through the EXISTING
   `fetchChaptarrWork` + `editionForAsin` — cached, breaker-isolated, paced.
   Never `chaptarrGet` directly (see the rate-limit section).
3. Report `drift% = |plex − chaptarr| / chaptarr`, worst first, with the
   multipart fields alongside so a flag arrives with its diagnosis.

### Thresholds, and why

* `< 2%` — agreement. All three measured cases land under 0.4%; 2% allows for
  encoder padding and the intro/outro trims that vary between rips.
* `2–10%` — REPORT, do not alarm. Plausible edition mismatch rather than damage.
* `> 10%` — flag. A truncation is a whole missing part: with `audibleParts`
  of length N, a single-part file lands near `100/N` percent short — 66% for
  Soldiers Live's 3 parts. Nothing legitimate lives up there.

### The multipart fields turn a flag into a diagnosis

When `isAudibleExpectedMultipart` is true and `plex ≈ chaptarr / len(audibleParts)`,
the file is one part of N rather than merely short — which names the remedy
(re-rip or re-merge) instead of leaving it to be guessed. This library is BUILT
by merging multi-part Audible titles into a single `.m4b`
([[incipit-library-consolidation]]), so a merge that silently dropped a part is
exactly the defect worth catching.

## False positives to design against, before shipping

1. **`editionForAsin` resolves through `providerIdsAll.az` variants**, so asking
   for a regional ASIN can return the PARENT edition, whose duration may
   legitimately differ. Record which edition answered and whether the match was
   exact or via a variant; treat variant matches as report-only regardless of
   drift.
2. **Abridged / different narration** share a work but not a duration. The audit
   is ASIN-keyed precisely to avoid this; never fall back to title matching.
3. **No ASIN, no answer.** ~3,098 of 4,012 tracks carry an ASIN guid (~77%);
   OverDrive-sourced items (Arcanum Unbounded among them) cannot resolve at all.
   Report the uncovered count explicitly — a silent 23% blind spot reads as
   "everything is fine".
4. **Chaptarr's `durationSeconds` can be absent** on an edition. Absent is not
   zero: skip, and count skips separately from agreements.

## ⚠️ Rate limiting is a REQUIREMENT, not a nicety

Sizing this spec, I burst ~50 requests at `api2.chaptarr.com` from a workstation
and was **HTTP 403'd**. It is another project's free infrastructure with no SLA,
and the existing integration is deliberately cached and breaker-isolated for
exactly that reason. The audit MUST:

* go through `fetchChaptarrWork`, never the raw wire;
* pace requests (the module already owns a pacer for the Goodreads mirror —
  reuse that shape, do not invent a second policy);
* cache per ASIN so a re-run costs nothing, the way the series cache does;
* stop on breaker-open rather than grinding, and say how many rows went
  unchecked as a result.

A full pass is ~3,098 lookups. That must be a paced, cached, resumable walk.

## What this does NOT do

* It does not delete, re-match, or modify anything. It prints.
* It is not a gate and must never fail CI — Chaptarr availability is not our
  correctness.
* It does not replace the duration veto in the matcher
  ([[incipit-duration-veto-needs-analysis]]); that is a SEARCH-time signal about
  which edition to pick, while this is a LIBRARY-time signal about whether the
  file on disk is complete.

## Tests

* `editionForAsin` variant-vs-exact reporting — pinned, since a variant match is
  the main false-positive source.
* Threshold banding at the boundaries (1.9 / 2.0 / 10.0 / 10.1%).
* Absent `durationSeconds` is a SKIP, never a 0% or a 100% drift.
* The multipart diagnosis fires only when `isAudibleExpectedMultipart` is true
  AND the ratio is near `1/N`.
* A breaker-open run reports unchecked rows rather than reporting agreement.

## Rollout

Run it read-only against prod and hand the operator the >10% list. Soldiers Live
is the known-positive control: had this existed, it would have been row one at
66%. Shadows Linger is the known-NEGATIVE control, and the more important of the
two — a correct oracle must call it agreement, because a false alarm there is
what cost a file.

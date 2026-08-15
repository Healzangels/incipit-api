# spec: the translated-series case (Magic Tree House)

**Status: Implemented as a PIN**, not a resolver change. Minted 2026-08-15 from the
golden corpus. The reason it is a pin is a measurement, and that measurement is the
useful part of this document.

## The case

Three Mary Pope Osborne albums were filed under the **German** series name:

```
Das magische Baumhaus, Book 1 - Dinosaurs Before Dark
Das magische Baumhaus, Book 3 - Mummies in the Morning
Das magische Baumhaus, Book 8 - Midnight on the Moon
```

Both series slots were translated — German primary, **French** secondary
(`La Cabane Magique`) — on books whose `language` is `en`. The French slot even
numbers differently (#7 where the German says #8), which is the tell that these are
foreign *editions* of the series, not aliases of one taxonomy.

The positions were already correct. Only the name was wrong.

## Where it came from

Not Chaptarr. Its series arrays are translated-first and the codebase already refuses
them (`ChaptarrProvider.ts:29-32`); here it is wired only to genres.

It came from **`GOODREADS_SERIES_AUTHORITY`**, which defaults on
(`goodreadsSeries.ts`, `seriesEnriched`) and by design overwrites whatever series the
matched provider supplied. Audible had the answer right and lost it:

```
B002V0LWAE  publication_name: 'Magic Tree House'
            series: [{ title: 'Magic Tree House', sequence: '8' }]
```

## Why authority mode is NOT the bug

The obvious fix — disable authority mode, or make it defer to the provider — would be
a large net regression. Measured 2026-08-15 across 180 library ASINs, comparing our
served series against Audible's:

```
agree 74 | differ 51 | no data 55
```

Nearly every one of those 51 differences is authority mode doing its job:

| ours | Audible |
|---|---|
| Hyperion Cantos | Hyperion |
| Jack Ryan | A Jack Ryan Novel (chronological) |
| The Camel Club | The Camel Club (abridged) |
| Inkworld | Inkheart |
| His Dark Materials | His Dark Material**ik** *(Audible's own typo)* |

That is exactly what the comment in `seriesEnriched` claims it is for: providers have
incompatible taxonomies, and one source answering the whole series in one taxonomy is
what makes a shelf internally consistent. Turning it off to fix three books would
damage far more than it repairs.

## Why not a language guard in the resolver either

The tempting generalisation is "reject a series name that is not in the book's
language". Sized before building it, library-wide:

```
albums with a series sort title   1475
distinct series                    322
series names matching a non-English marker   1   ← this one
```

**One series in the entire library.** A resolver-level guard would need a reliable
"is this name English?" test — which is genuinely hard, risks demoting legitimately
foreign-named series (*Kagerou Daze*, *Le Carré*-style titles), and would run on every
book forever to fix three. Same shape as the edition-subtitle arm closed in
[spec-edition-subtitle-arm.md](spec-edition-subtitle-arm.md): a broad mechanism
justified by a handful of rows is the wrong trade.

**REOPEN IF** the count of translated series names rises materially above 1 — re-run
the scan before assuming it has.

## The fix

Three corpus rows with `pinType: operator-stated`, `mintPin: true`, and a required
outcome of `Magic Tree House` at the positions already being served (1, 3, 8), then
`bun run scripts/mintPins.ts`.

Pins are the mechanism built for exactly this: *"operator-stated answers for records
the resolver cannot derive or derives wrongly."* Each book is keyed twice — by
recordId and by the portable `title|author` key — so the pin survives a re-match to a
different record.

⚠️ **Do not hand-edit `shelfPins.data.ts`.** It is generated; the file says so and the
generator will clobber you. Edit the corpus and regenerate.

Two mechanical traps hit while doing this, both worth knowing:

* The corpus is **1-space indented, ASCII-only**. Writing it back with different
  formatting produces a 27,000-line diff that buries the three real rows. Round-trip
  with `json.dump(..., indent=1)` and a trailing newline.
* `mintPins.ts` emits JSON-style quoting; the committed file is prettier-formatted.
  Run prettier on the generated file or the diff looks like a full rewrite
  (1292/1074) instead of what it is (36/3).

## Verification

* corpus 508 → 511 rows, diff **152 insertions / 0 deletions**
* pin table: **5 keys added, 0 changed, 0 removed** (3 portable + the recordIds)
* `bun run test` — 2410 pass / 0 fail
* harness `--smoke`, run twice: all three rows **MATCH**, got `Magic Tree House #1/#3/#8`
* harness `--gate`, run twice (the mirror is nondeterministic; single-row flips across
  runs are not evidence)

## Not fixed here

Two of the three albums are matched to **OverDrive** records (`overdrive-192237`,
`overdrive-192936`). OverDrive carries no ASIN and is meant to be supplement-only, so
those matches are their own smell — but the pin is keyed portably, so it holds either
way, and the series name was wrong on the Audible-matched one too. Fixing the matches
would not have fixed this.

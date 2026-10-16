# spec: the book-enrichment overlay

**Status: Built and A/B'd on `nightly` (local commit), not deployed.** Designed in the
audiobooks plan (PLAN-v2 section 4.1, decision Q11: "Incipit is the source of truth");
built after Healzangels approved the pilot texts on 2026-10-16. Same-data A/B: 8 movers,
exactly the 8 overlaid editions, only `summary` and `genres`; 0 of 50 controls moved.

## What

An operator-written description and genre list, served by `/books/:id` **in place of**
the provider's for specific editions. Plex already writes `summary` and replaces `genres`
on a forced refresh (bundle `set_metadata_summary`, `add_genres`), so a forced refresh
delivers the overlay and the bundle does not change.

## Why here and not in Plex

- Plex field locks would work for a pilot of eight, but they live in one Plex database:
  the second server, a rebuild or a re-match loses them, and they hide the provider text
  for good instead of replacing it with something maintained.
- The API already serves both servers, and it is where the other operator decisions
  live (shelf pins). One table, every library, every refresh.
- Redis caches only the STORED record, never the served shape, so a serve-time change
  needs no cache invalidation (the same property pins rely on).

## The data: two levels

```jsonc
{
  "schema": 1,
  "works": {
    "lantern-road": {                       // what every edition shares
      "hook": "Two to four sentences, our words.",
      "setting": "Optional second paragraph.",
      "genres": ["Fantasy", "Epic Fantasy", "High Fantasy", "Adventure"],
      "series_total": 3,                    // only when the series is complete
      "awards": [{ "award": "…", "year": 2020, "category": "…", "result": "winner",
                   "scope": "work", "sources": ["https://…"] }],
      "contents": ["First Tale", "Second Tale"],   // collections
      "age_band": "8-12"                    // only when the publisher states one
    }
  },
  "editions": {
    "B0SYNTH001": {                         // one recording, by its served record id
      "work": "lantern-road",
      "keys": { "title": "The Lantern Road", "author": "Ada Quill", "narrator": "Ben Reader" },
      "status": "approved", "approved_on": "2026-10-16",
      "praise": [], "awards": [ /* scope "this-recording": Audie, Earphones, Grammy */ ],
      "production": "…dramatized adaptation, full cast",   // replaces narrators + abridgement
      "credits": ["Translated by …", "Introduction by …"],
      "read_by_author": true
    }
  },
  "held": { "B0SYNTHHLD": "STOP card: why" }
}
```

(Synthetic example: the real file is private, see Storage.) Both narrations of one book
point at one work and keep their own recording items. **The credits line and the Series
line are never stored**: they are rendered from the served record, so a corrected match,
a fixed runtime or a new pin corrects them by itself.

## Keys and lookup

Tried in order; the first that answers wins (`findOverlay`, `bookOverlay.ts`):

1. **the served record id**, exact: an ASIN or a provider id (`hardcover-book-…`), the id
   `applyPins` uses;
2. **(title, author, narrator)**, every author x narrator of the record: the same
   narration under another id. Recording items (praise, awards, credits) render;
3. **`pinKey(title, author)`**, only where the loader proved it unambiguous. It serves the
   **work** only: no narration praise, no recording awards, no edition credits, since the
   record may be another recording.

A "(Narrated by …)" / "[Read by …]" qualifier is folded out of every key's title. That is
what makes the two Harry Potter 5 narrations collide on the plain key, which is how the
loader learns the plain key is ambiguous and withholds it from both.

**Never the wrong one.** The lookup answers "no overlay" when:

- the record id is `held`, whatever its keys;
- its narrators reach two entries;
- the only match is a plain key two editions share;
- a key match (not an id match) is on a record in another language than the work's
  (`language`, default english). Hyperion's French record folds to the same title key
  as the English one.

Keys come from the **pre-pin** record: a pin's `displayTitle` must not decide which text
a book gets.

## The load gate (mintPins-grade, at load)

`compileOverlay` refuses the whole file, listing every reason, when:

- the schema fails. Every object is strict: an unknown field (`series_totl`) is a
  refusal, not a silent drop;
- an edition's work does not exist, or an edition id is not bare (a `_us` suffix can
  never be asked for);
- a genre is not in the approved vocabulary (`genreVocabulary.ts`: the 105 names of
  PLAN-v2 4.4, spelled exactly), is listed twice, or there are fewer than 4 or more
  than 6;
- operator text contains `<` or an entity (`&` must be followed by a space). The bundle
  decodes nothing;
- an award's result is not a juried one (winner, finalist or shortlist), it has no
  source URL, or it is filed at the wrong level (a recording award on the work);
- an approved entry has no `approved_on`, has an open `gate2_open` question, or carries
  more than two quotes (the template shows two), or a placeholder quote;
- two approved entries claim one (title, author, narrator) key.

Only `status: "approved"` entries are served, and never a `held` id. Drafts are still
validated, and they count when the loader decides whether a plain key is ambiguous: a
narration the file knows about but has not approved is still a second narration.

## Serving

In `finish()`, last:

```ts
const shelved = applyShelfPolicy(applyPins(merged, asin))
return applyBookOverlay(shelved, merged, asin, bookOverlayTable(request.log))
```

- **After** pins and shelf policy, so the Series line states the shelf actually served
  ("Series: Harry Potter (Narrated by Jim Dale), Book 5 of 7").
- `summary` is replaced with the rendered plain text. `genres` is **replaced**, never
  merged, by the approved names with `syntheticGenreAsin` ids.
- Every other field is the served object's own. A book with no entry, or a call with the
  table off, returns the **same object**.
- Not through `namesToGenres`. That mapper normalises community free text, and it drops
  two approved names outright: it splits "Fairy Tales, Folk Tales & Myths" and "Movie,
  TV & Video Game Tie-Ins" at the comma. The vocabulary is closed and checked at load,
  so there is nothing to normalise. A test pins this.
- The table is a parameter, so a test or an A/B can switch it off.

### The template (`renderOverlay.ts`, PLAN-v2 4.2)

```
<hook>

<setting>                                     (optional)

Series: <served shelf>, Book N[ of M]         (real shelf only; none for a self-titled one-book shelf)
Narrated by A, B, C[ and others] · Unabridged · 17 h 03 min · Publisher, 2000
<credits joined with " · ">                   (translator / introduction)
Ages <band>                                   (only when stated)
Contents: First; Second; Third                (collections)

Praise
"quote" — Source, Year                        (at most two, the recording's first)

Awards
Award Year: Category (result)                 (work first, then the recording)
```

"Read by the author" replaces "Narrated by" when the first narrator is the lead author
(or `read_by_author`). A `production` replaces both the narrators and the abridgement.
Record text is entity-decoded and stripped of `<` and `>`. The year is the ISO date's own
year, so it never depends on the API's timezone. A thin record (Hardcover: no narrator,
runtime or date) drops those pieces and never prints "undefined".

## Storage, reload, rollback

- `BOOK_OVERLAY_PATH`, default `/data/overlays/book-enrichment.json`. In the container,
  `/data` is `/mnt/cache/appdata/incipit-api` on CMacServer-2.
- **No file means no overlay**: the API serves exactly what it served before.
- Each request costs one `stat()`. The file is re-read only when its inode, size or
  mtime changes, so no restart is needed.
- A file that fails to parse or fails the gate is refused and logged once with every
  reason (`book overlay REFUSED …`). The last good table keeps serving.
- The data is private: the public repository holds the code, schema, gate and
  vocabulary, and the tests use synthetic fixtures. The approved batches are audited in
  the research repository.
- **Rollback**: remove the entry (or the file), then force-refresh the album. The
  provider summary and genres return. The bundle never blanks a summary with an empty
  value. For the whole feature: delete the file, or revert the commit and redeploy.

## Tools

- `bun run check:overlay` (modelled on `check:pins`) reports entries no album serves and
  keys that reach more than one album. By default it uses ids plus title keys from ONE
  bulk Plex listing and reads nothing through the API. `--full` reads every album to
  form narration keys; a whole-library read has degraded the API's caches before, so
  use it deliberately.
- `bun scripts/renderOverlay.ts --file … [--records dir] [--expect approved.txt]` renders
  each entry through the real serve step against the served record. With `--expect` it
  diffs body and genres against the text the operator approved.

## Measured (2026-10-16)

The gate was stated before measuring: the movers must be exactly the overlaid ids, only
`summary` and `genres` may change, and every series and shelf field must be identical.

- **Parity.** All 8 approved texts render byte-identical through this renderer from the
  live served records, with one expected exception: the Jim Dale Order of the Phoenix
  (B017V4NMX4) Series line now reads the pinned shelf, "Harry Potter (Narrated by Jim
  Dale), Book 5 of 7". The approved text predates that pin. Genres match for all 8.
- **A/B on one capture** (58 served answers: the 8, Hyperion (held), every other Rowling
  album, three albums each by the other pilot authors, and a seeded sample).
  - Arm A (off) moved 0.
  - Arm B (on) moved exactly the 8, every one by id, `genres` and `summary` only.
  - Series and shelf fields moved: 0.
- **check:overlay** on prod (section 6, 1,756 albums): 8 reachable by id, 0 dead,
  0 ambiguous. One title key withheld by the loader: the two Harry Potter 5 narrations.
- **Mutation.** 31 mutants, all killed. They cover the id lookup, key order, plain-key
  refusal, qualifier fold, two-hit refusal, language guard, held, a third changed field,
  merged genres, the overlay moved before pins or keyed post-pin or removed, the
  vocabulary, collision and draft gates, and keeping the last good table. Renderer,
  liveness and store mutants are killed too.

## Not in scope

- The M1-M7 serve-time hygiene pass over every summary (PLAN-v2 4.3). This change
  serves approved text only.
- Praise: Gate 2 has not run, and the pilot entries carry none.
- The research draft's keys use the Plex album title. For B017V4NMX4 the record's own
  title is "…, Book 5", so that entry is reachable by id only, not by its narration key.
  That is harmless for the pilot; a batch tool should key from the served record.

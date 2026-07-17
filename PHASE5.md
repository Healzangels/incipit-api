# Phase 5 — switch book matching to the multi-provider API

Turns "No matches found" for non-Audible books (Xanth) into real Hardcover/OpenLibrary matches
in Plex. It is a two-sided contract: the bundle (`Incipit.bundle`) and this API both change, and
the hard middle is **non-ASIN books** (they break both the GUID and the data-lookup).

Plex matches in two separate calls — both must work end-to-end:
1. **Search**: Plex → bundle `search()` → `GET /books` → ranked candidates
2. **Data lookup**: after match, Plex → bundle `update()` → `GET /books/{id}` → full metadata

## API side (this repo — offline-testable) — DONE, live-verified

- [x] **GUID-safe, reversible candidate ids** (`providerId.ts` + encode/decode tests). ASINs stay
      verbatim; Hardcover/OpenLibrary → `hardcover-book-119295` / `openlibrary-works-OL80870W`.
- [x] **`GET /books/{id}` serves non-ASIN ids** — route branches on `decodeProviderId` →
      `BookDataHelper` dispatches to the provider's `fetchBook` (stateless re-query). Live e2e:
      `GET /books/hardcover-book-119295` and `.../openlibrary-works-OL80870W` return full data.
- [x] **Non-ASIN data mapped to a book shape** — `ProviderBook` matches the bundle's optional
      fields (bundle reads each with `if key in response`, so no strict schema needed). Hardcover
      supplies title/authors/narrators/series/publisher/rating/date/cover/summary; OpenLibrary the
      book-level subset.

## Bundle side (Incipit.bundle — needs live Plex + deployed API)

- [ ] Flip the book-search fork (`search_tools.py:37`) → always `get_search_url()`.
- [ ] `build_search_args()` adds `&duration=` `&asin=` `&trackTitle=`.
- [ ] Send `x-hardcover-token` header, scoped to the api_base_url host ONLY (not Audible).
- [ ] Rewrite `parse_api_response` to consume flat `ScoredCandidate[]` and KEEP non-ASIN items.
- [ ] Map confidence 0–1 → Plex score 0–100; drop the local ScoreTool for books.
- [ ] Non-ASIN id survives `extract_asin_from_id()` (`split('_')[0]` — ids must be underscore-free).

## Unknowns — resolve on the live test Plex before wiring

- [ ] How the legacy `media` object exposes `duration` (Plex sends `duration=` in the search URL,
      but Audnexus never read it). Probe + log on a real match. NON-NEGOTIABLE: no duration = no veto.
- [ ] How to read the first track's title (for the track-title fallback). Probe `media.tracks`/children.

## Sequence

1. Deploy incipit-api (Mongo-only compose) reachable from the test Plex.
2. API: ids + `GET /books/{id}` + schema (this list's top block) — build + unit-test offline.
3. Bundle: a probe build that just logs duration + track access on a real match.
4. Bundle: search/parse/id changes, tested piece-by-piece against live API + Plex.
5. Acceptance: "Harpy Thyme" matches via Hardcover end-to-end in Plex.

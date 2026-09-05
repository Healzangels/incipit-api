# docs/design/

Design rationale for changes big enough that the reasoning outlives the diff.
**Read the Status line first** — a spec here is not a plan of record, and at least
one is expected to describe work that was deliberately not done.

Not to be confused with [`docs/spec/`](../spec/), which holds the OpenAPI document.

| spec | status |
|---|---|
| [spec-edition-subtitle-arm.md](spec-edition-subtitle-arm.md) | **Closed — won't fix.** Kill switch passed, sizing failed: 4 books library-wide |
| [spec-translated-series-pin.md](spec-translated-series-pin.md) | **Implemented as a pin.** A German series name, fixed as data rather than in the resolver |
| [spec-millennium-shelf-split.md](spec-millennium-shelf-split.md) | **Implemented as pins.** One shelf split three ways, by two opposite causes |
| [spec-franchise-umbrella-detection.md](spec-franchise-umbrella-detection.md) | **Proposal rejected, fixed as pins.** Three general rules refuted by measurement; the safe one is a future spec **§6 (member-set containment) superseded 2026-09-05 by [spec-shelf-granularity.md](spec-shelf-granularity.md).** |
| [spec-shelf-granularity.md](spec-shelf-granularity.md) | **Shipped and LIVE on prod 2026-09-05 — rule replaces ten pins (seven Hobb, three Bill Hodges).** Which of a work's competing Goodreads series is the shelf. Seven inferred rules refuted with full member sets — umbrella-ness is not in the graph — so the umbrella is declared once per franchise by series ID, demoted through the existing rescue path, with parallel listings denied in the same change. Arm A (pins off) 58 reds; B1 healed 8 with 0 regressions and exposed the French listing exactly as predicted; B2 healed the 2 French rows and nothing else — total 10 healed / 0 broke, all 7 Hobb pins redundant; the four live books the operator reported probe 4/4 with pins off and are now corpus regression rows. Pins retired; pins-on gate PASS (0→0); baseline re-recorded over 525 rows with 0 standing reds (a first sample caught 2 transient degraded-passthrough rows and was discarded). |
| [spec-edition-guard-freezes-stale-series.md](spec-edition-guard-freezes-stale-series.md) | **Shipped, narrowed by its own A/B.** A keep-guard that froze stale answers; one prediction falsified and the rule cut to where it is safe |
| [spec-fresh-scan-match-ceiling.md](spec-fresh-scan-match-ceiling.md) | **Closed — won't fix.** The 0.85 fresh-scan ceiling is real; the sizing found ZERO near-misses, so the fix was not worth 1,706 albums of blast radius |

The two pin specs are worth reading together: between them, Goodreads series authority
is caught overwriting a name that was already right, choosing the wrong one of two
answers, and failing to answer at all — three distinct ways to land a book on the
wrong shelf. All three were fixed as corpus data, and each spec states the count that
made a resolver change the wrong trade.

The closed one is the more useful read. Its first count said 311 albums qualified;
the real number was **four books**, because 25 of the 28 hits were one split title
and the rest of the "subtitles" were series names and marketing taglines. It also
records the design flaw that number exposed — the both-sides rule it relied on does
not actually confine the arm to edition evidence, because providers put series names
in `subtitle` too.

## Why matching changes get written down

Everything in `BookSearchHelper`'s comparator is a ranking arm over candidates that
already passed acceptance, and the arms are ordered by how much identity evidence
they carry. Reordering them is easy to do and hard to see: the diff shows a moved
`if`, while the effect is a different edition on someone's shelf. Several comments
in that file record arms that shipped in the wrong order and were measured wrong
days later.

So a matching change earns a spec when it adds or moves an arm, when it changes
what a provider puts on a candidate, or when the obvious implementation is wrong in
a way the diff will not show.

## Writing another one

State the gate **before** measuring, so the decision belongs to the criterion rather
than to whichever answer you were hoping for. Include the mutations that must go red
— in this codebase a green suite has more than once proved nothing at all.

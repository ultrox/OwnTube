# Automatic German Home mix

Curated → Home → **Automatic German mix** applies across every personalized Home
row, independently of HackerTube. The default target is 30% of video-card
positions, including excluded rows. Existing titles estimated German count toward
that target. Overall share remains an **estimate** because existing originals are
classified by title. Automatic alternatives require German **original-audio track
metadata**; this is not transcript analysis or content-quality scoring.

## Lightweight discovery

1. Detect likely English titles locally. Skip unclear titles.
2. Select the exact originals at the configured positions (default 2, 6, 9).
3. Batch-translate selected titles into German search queries with DeepSeek Flash.
4. Run one flat YouTube search per title, returning the first five hits.
5. Check eligible candidates' original-audio metadata. Reject non-German, unknown,
   conflicting and dubbed-only evidence. Use the first qualifying hit; trusted
   creators get preference within the five hits.
6. Publish automatically only at the owner's allowed positions in each row.
   Keep the matched original in that row's tail, below the first ten.

No original video-detail requests, transcripts, comments, candidate AI analysis,
or quality scoring. Flat search supplies titles, creator IDs and durations.
Clearly English hits, live/upcoming videos, duplicates and blocked creators are
skipped. Unknown candidate-title language is allowed only with German original-audio
evidence. Candidate details are fetched with `yt-dlp --skip-download`; explicit
original tracks (`format_note` or `language_preference=10`) must agree on German.
The top-level language alone, titles, captions and dubbed tracks cannot qualify.
Duration must be 50–200% of the original when its duration badge is available.
Shorts replacements must be at most 180 seconds; vertical format is not verified.

Pins, manual additions, excluded rows, removed videos, creator limits and all
editorial controls remain effective. Creator limits include existing cards.
Only one occurrence of a duplicated original can be replaced.

Placement stays within each original topic row. `replacementPositions` defaults
to **2, 6, 9**, counted from one. `rowPositions` overrides those defaults by row ID;
an empty array disables replacements in that row. Curated exposes these controls
beside each row: blank inherits defaults, `off` disables replacements. Positions
must be distinct, sorted integers from 1–48, with at most ten positions per row.
Positions identify the originals to match, not destinations for matches found
elsewhere. Without an eligible match for that exact original, the slot stays as-is.
Other occurrences of that original in other rows stay untouched.

Pinned originals, manually added cards, live/upcoming and non-video cards retain
their positions. Excluded rows are untouched. The matched original is appended
when space allows. At the cap it occupies the last safe ordinary tail slot,
displacing that card from publication but not from the source snapshot. Protected
cards, configured positions and already retained originals/alternatives cannot
be displaced. Keep at least one intervening card and place originals after #10.
Short rows or rows without a safe slot remain unchanged.

Editor order contains each original once, including source cards displaced by
the overlay. Move/drag map both alternative and retained-original views to that
unique original. Removing an alternative excludes it and restores the original;
removing the original removes its pairing. Pinning restores its original position.
Flip remains comparison-only.

Configured positions containing protected cards, existing German-title originals,
live/upcoming videos or non-video tiles are skipped. Existing German recommendations
are labeled separately from automatic replacements. Show/channel/playlist rows
explain why they have no eligible individual videos. The whole-Home target remains
a ceiling/goal, subordinate to these exact placement rules.

## Budget, cache and cost

- Default: **12 new searches per six-hour UTC-aligned cycle**, editable from 1–50.
  The search ledger is shared across Home feeds in this server's data directory;
  each pass applies its configured limit against that shared count.
- **Fill target now** temporarily allows up to 150 searches in the same shared
  cycle. It translates/searches in batches of at most 24 and publishes each
  completed batch, continuing until the target, quota, or eligible-title pool is
  exhausted. It then returns to the saved maintenance budget. Fill state survives
  restart and respects cooldowns; pausing or undoing cancels it. The target is
  still an aspiration when eligible matches cannot fill it.
- Quota is reserved transactionally before each search, including failed attempts.
  Clicking **Find matches now** or restarting the server does not reset it.
- Translations and search pages (including empty results) are cached for 30 days.
  Cached results are checked against current owner controls before new work.
- Audio checks are cached separately for 30 days (unknown/error results for one
  hour). Each pass makes at most 24 detail requests; a shared transactional quota
  allows five times the current search budget per six-hour cycle. Deferred checks
  continue in bounded batches. Metadata requests time out after 40 seconds.
  Only language and timestamp are stored, never signed media URLs or full details.
- One translation request per pass, only for uncached selected titles. At most
  the remaining search allowance is translated. A concurrent pass or provider
  failure can consume translation tokens without producing a new search.
- `DATA_DIR/german-title-mix/usage.sqlite3` records translation requests/responses,
  actual input/output token counts, and search attempts. Authorization headers and
  API keys are not stored. This ledger starts with the title-search implementation;
  it cannot reconstruct historical Pro-model spend.
- Flash cost is a conservative peak-rate estimate: $0.30/M uncached input,
  $0.006/M cached input and $1.20/M output tokens. It is not an invoice. Nondefault
  model cost is shown as unavailable. Cache files and the ledger are retained;
  expired cache entries are ignored.

The next cycle is scheduled automatically while the target remains unmet.
Fresh Home snapshots and owner changes can trigger cached reevaluation sooner.
YouTube/DeepSeek 429 responses persist a one-hour cooldown; other failures retry
after six hours. Failures keep the previous publication.

## Local setup

Run from the repository root with Python 3 and `yt-dlp` on `PATH`. No extra Python
packages are required. Supply `DEEPSEEK_API_KEY` or `DEEP_SEEK_API` in the
environment or Git-ignored root `.env`, or use `DEEPSEEK_API_KEY_FILE`.
`OWNTUBE_ENV_FILE` selects a different dotenv file; it is read, never executed.

Optional environment settings:

- `GERMAN_TRANSLATION_MODEL`: defaults to `deepseek-flash`.
- `YT_DLP`: extractor executable.
- `OWNTUBE_GERMAN_WORKER`: defaults to `scripts/german-matcher.py`.

The old `DEEPSEEK_MODEL` and `GERMAN_MAX_ORIGINALS` settings do not control this
worker. Migration preserves saved rules and edits, immediately creates a clean
publication without legacy title-only alternatives, and resets the undo baseline.
Old pagination versions remain immutable. An active DeepSeek cooldown is respected.
Cached Home matching needs no TV credentials; refreshing the source feed still
needs transient credentials supplied by the TV.

## Publication and editor

Worker results publish atomically against the exact source generation, editorial
revision and publication version. A newer owner decision wins. Saved drafts are
preserved, and pagination keeps reading the immutable version it started with.
Settings changes immediately apply cached eligible matches, then queue discovery.
Identical **Apply mix rules** submissions do not change revision or publication.

**Undo mix & pause** restores the saved pre-mix publication as a new version and
pauses automation. **Keep original instead** pins one original persistently.
`curated_german_versions` stores each publication's selected matches/counts so
explanations also match restored versions.

Background polling patches existing DOM nodes, preserving unchanged thumbnails,
forms, open details and horizontal scroll. Status shows the bounded search cycle,
cached reuse, cumulative translation tokens/cost, queries and search ranks.

Replaced cards have a green **German replacement** label and a compact original
thumbnail/title preview labeled **Replaced this · flip to original**.
Flip compares the original thumbnail/title with the selected alternative
in both draft and published views; it changes only the local comparison view.
The original side is clearly marked and stays open through background polling.
**Use original on TV** is the separate persistent pin action. If an older
publication's original has disappeared from the source snapshot, newly published
matches retain an `originalCard` snapshot so both sides remain available. Older
publications fall back to the current source, or an ID/thumbnail with an explicit
unavailable-title label.

## Owner API

- `GET /api/curation/{id}` includes settings, published counts/selection, progress,
  candidate matches and usage report under `german`.
- `PUT /api/curation/{id}/german`: `{revision,generation,settings}`.
- `POST /api/curation/{id}/german/run`: queue against saved inputs.
- `POST /api/curation/{id}/german/fill`: `{revision,generation}`; start a bounded
  fill toward the saved target.
- `POST /api/curation/{id}/german/undo`: `{revision,generation}`.

Only Home accepts mix settings. All controls require an owner session.

## Verification

```sh
python3 scripts/test_german_matcher.py
node --test apps/backoffice/modules/curated/{model,german}.test.js
cargo test --locked --manifest-path server/Cargo.toml
```

Coverage includes batched translation/usage logging, flat search, first
audio-qualified hit, persistent quotas, cache reuse, exact originals, title estimates, target
allocation, pins/blocks/exclusions, duplicates, creator caps, duration/Shorts,
localized-English/dubbed/unknown audio rejection, original retention, row caps,
stale results, drafts, immutable pagination, undo and authentication.

This feature is exercised locally; production deployment is separate.

### Local live check, 2026-11-16

The first title-search batch published seven replacements from 12 searches in
Home v15. One Flash request used 537 input and 366 output tokens: estimated
peak-rate cost **$0.0006003**. With 44 original card positions estimated German
by title, the published mix was 51/332 positions (15.4%), toward the 30% target.
Saved editorial edits and mix rules survived migration.

A same-cycle rerun reused all 12 cached search pages, made zero searches and zero
translation calls, and published identical rows as v16. Checks passed: six Python
tests, five Curated JS tests, 71 Rust tests (two fixture-dependent tests ignored),
and web/server builds.

### Visible spacing and target fill

After the next source refresh, fill reached 49 alternatives. The owner's requested
first-ten spacing then published v25 with 43 replacements and 62 original German
title positions across 373 cards (28.2%). Short-row placement limits account for
the reduction. Fourteen alternatives are in their rows' first ten cards; existing
German titles count toward those leading sections' quotas.

The Recommendations row now includes an alternative at position 6 between its
existing German titles at positions 4 and 9. Power tools has alternatives at
positions 2, 6 and 9. Saved edits/settings were preserved; browser preview matched
publication and all 373 pin controls addressed the correct originals.

Cumulative title-translation estimate: $0.0051237 for 4,531 input and 3,137 output
tokens across nine calls. The spacing-only rerun made zero searches or AI calls.
Checks: eight Python tests, seven Curated JS tests, 73 Rust tests passed (two
fixture-dependent tests ignored), plus server and web builds.

### Exact-position correction

Historical v26 behavior below was subsequently superseded by the exact-original
and audio-metadata correction described next.

The owner identified that v25 still clustered four replacements at positions
11–14 in Recently uploaded. They chose explicit per-row positions instead of
automatic spacing. With default positions 2, 6 and 9, v26 has 22 replacements,
all within permitted slots. Recently uploaded has only position 2 replaced;
positions 6 and 9 already hold original German-title videos and are protected.
The whole-Home percentage is consequently 22.5%; placement rules take priority
over filling that percentage.

All 22 selected records retain their original card snapshots, and browser preview
matches publication. Row controls validate positions, accept `off`, and preserve
saved editorial edits. Flip cards show a thumbnail/title for both sides, and
non-video rows explain their ineligibility. This cached re-publication made no
additional translation calls. Nine Python tests, seven Curated JS tests and the
nine Rust German-mix tests passed after the correction.

### Exact-original and original-audio correction

v29 was verified locally on 2026-11-16. The migration first published v27 without
legacy title-only alternatives; subsequent validated batches produced three:

| Row | Alternative position | Retained original position | Alternative ID |
| --- | --- | --- | --- |
| New to you | 2 | 29 | `Bk2tkN4fshw` |
| Power tools and more | 9 | 30 | `jJiS3x9cMlA` |
| Recommended podcasts | 2 | 30 | `IcXd1obfvAU` |

All have explicit German original-audio metadata. All three match the exact
source original at their configured position, respect row caps, and retain the
original once in that row. The browser policy preview equals server publication.
Draft and published editorial edits were unchanged. Flip works both ways through
polling without changing revision/publication; retained originals have badges.

The localized-title candidate `K5O_e8AmwoM` reports English original audio and is
rejected. A fresh metadata check recorded `en`; neither localized German text nor
the unrelated Dutch muxed format can qualify it.

Lessons and more #2 (`0o_GMhy12ls`) was translated using its own exact title, as
confirmed by the translation request/response and search ledger. Its query,
`Trick nicht wie abgelesenes Skript klingen`, returned zero results and that cached
result was reused; no other original's match is substituted. #6 had no eligible
audio-qualified result. The row now explains both outcomes and shows the queries.
Recommended equals its composed source, including all duplicate-original positions.

This correction required no additional translation calls: cumulative usage remains
9 calls, 4,531 input tokens, 3,137 output tokens, estimated $0.0051237. Nine audio
metadata requests were made including the explicit false-candidate check; the
final cached pass needed zero.

Checks: 14 Python tests, 9 Curated JS/model tests, 9 targeted Rust German tests;
the full Rust suite passed 73 tests with two fixture-dependent ignores before the
final protection/report refinements. Server and Backoffice builds passed.

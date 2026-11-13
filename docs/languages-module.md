# Languages: independent production module

Languages is an optional review/tally module. Its interpretation data and API are
separate from playback collection, global viewing history and feed curation.

## Scope

- Period, device and person define the watch-time totals. Language, review status,
  and text search only filter the paged observation list.
- Background playback counts. Foreground, background and unspecified always sum
  to the same total as the shared viewing read model. Audited device playback
  corrections affect attribution consistently across History and Languages.
- One row is one video, combining all its stored metadata versions and selected
  devices in scope. Saved versions and their exact evidence live in the inspector.
  Mixed audio/assessment summaries stay visibly mixed.
- One manual confirmation, undetermined choice or reset covers all current versions
  in that row atomically. Decisions cover those device/version identities across
  history, including outside the visible date range. They do not establish a rule
  for future audio versions or devices outside the selected scope.
- Language/status/text filters match any version but retain the whole scoped video
  group and its time. Grouping precedes pagination.

## Storage and decisions

`server/src/languages.rs` owns an additive `language_assessments` table. Every
manual classification, saved-evidence analysis, external result and reset creates
an immutable revision. The table references existing device/metadata identities.
Evidence text, metadata, viewing slices, original collector language estimates
and global history totals are never rewritten.

Manual choices are labelled owner-confirmed (or deliberately undetermined).
Automatic results are always estimates. Reset records the action and restores the
original collector interpretation. Clients submit `baseRevision`; stale edits and
in-flight analyzer results return 409 rather than overwrite a newer correction.
Automatic analysis cannot replace a manual choice without an explicit reset.
Grouped review sends each version's expected revision. A conflict in any target
rolls back the entire action; the user refreshes and reviews the updated group.
Automatic analysis remains selected-version-only.

## Evidence and analysis

Unreviewed records automatically use a usable selected-audio language from
digest-verified saved evidence. This works for historical and incoming observations,
without an Analyze click or fabricated manual audit entry. These high-confidence
estimates do not require review. Explicit saved assessments and resets win over the
automatic fallback. Original collector fields and mismatched evidence stay intact.

The module serves exact saved evidence text with its SHA-256 ID, its parsed view,
the original collector estimate and the assessment history. The history response
is bounded to the latest 100 entries and explicitly signals when older entries
exist. All revisions remain in SQLite.

The built-in analyzer uses only the recorded **selected audio language**. It does
not treat title language, default audio, translated subtitles or available caption
tracks as proof of audio actually played. Unsupported/missing labels remain
undetermined. Metadata-based estimates remain visibly different from human review.

Optional external analyzer configuration:

```sh
LANGUAGE_ANALYZER_URL=https://your-analysis-service.example/assess
LANGUAGE_ANALYZER_TOKEN=... # optional, server-side only
```

See [the request/response contract](../contracts/languages.md). The adapter sends
the saved evidence and video identity on explicit request. It has a 20-second
timeout, a 64 KB response limit, no redirects, and requires HTTPS except on local
loopback. It never holds the database write lock during a network call. Device
keys and viewer identity are not sent. It does not download media or transcripts.
Text/transcript/metadata-only responses retain a needs-review flag even if the
provider declares high confidence.

Without this configuration, manual review and saved-audio-metadata analysis work.
No third-party analyzer is enabled by default.

## Build and integration

The independently styled page lives at `/modules/languages/` and uses the existing
owner session. All module APIs require owner authentication; collector/device keys
cannot make corrections. See `contracts/languages.md`.

```sh
pnpm --dir apps/backoffice build
cd server
cargo test --locked
cargo run --locked
```

The production image packages the module alongside the existing history UI. The
old UI remains available during the broader backoffice migration. No module code
is loaded or queried just to view global History.

The production build gives CSS and the complete JavaScript import graph
content-hashed filenames, so a release loads matching assets through browser/CDN
caches. The design preview continues to serve the original source filenames.

This is a built-in module with explicit UI/API/storage boundaries. A dynamic
plugin system is unnecessary for this first release.

## Local verification

```sh
node apps/backoffice/modules/languages/check.mjs
node apps/backoffice/modules/languages/check.mjs --live http://127.0.0.1:3211 --token-file <local-admin-token>
```

The live check requires fictional fixtures seeded into a disposable loopback
server using `apps/backoffice/modules/languages/tests/seed-dev.mjs`. It performs
real, audited corrections. Never seed the production database.

The design preview links to `/modules/languages/?demo=1`. That explicit mode uses
in-memory sample data, displays a permanent demo label, and makes no API calls.
Normal mode uses authenticated server data and displays errors without falling
back to fictional records. The current development server on port 3211 contains
fictional fixtures too, but its authentication, evidence and corrections use the
real backend and persist in its isolated database.

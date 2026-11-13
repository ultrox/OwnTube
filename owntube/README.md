# OwnTube tracking

The `owntube` Android library owns pairing, capture, storage, delivery, and the settings screen.
It is active only in package `com.ultrox.owntube`. No upstream submodule is modified.

## Use

Open **Settings → OwnTube tracking**, paste a **device key** from ytdash's People & devices,
and select **Pair / replace key**. The production origin is fixed to
`https://ytdash.gromobran.com`. `GET /api/device` supplies the ID, label, and person;
device IDs are never invented or entered manually. Pairing enables capture.

The screen shows the ID, capture state, pending/held counts, acknowledged count, last receipt,
and errors. It also provides pause/resume, upload now, retry held, and JSON export through the
Android document picker. Pausing capture does not erase events or stop delivery of the existing queue.

Keys are AES-GCM encrypted using Android Keystore and stored in Android's no-backup directory.
The outbox also lives there. No key is compiled into the app, logged, committed, or exported.
OwnTube now requires Android 6+ for Keystore-backed AES; the upstream variants retain their SDK settings.

## Capture and delivery

- ExoPlayer's actual `isPlaying` and `isPlayingAd`, not UI button intent, control capture.
- Approximately one-second monotonic measurements feed `ViewingRecords`. Starting with
  **32.72-owntube.5 / versionCode 2466**, a dedicated disk executor persists cumulative checkpoints
  (`kind: "viewing"`) with stable event/viewing IDs and increasing revisions. Higher revisions replace
  queued/server totals rather than adding them. A process kill can lose the not-yet-persisted tail,
  not committed records.
- Pause, buffer, seek, source, speed and visibility transitions split intervals. Watch time is
  elapsed wall time; 2× speed does not double it. Gaps over 20 seconds are not extrapolated.
- Coverage is attached only for continuous plausible positions with a known non-live duration.
  Seek jumps never contribute coverage. Unknown context is omitted; started/stopped player-host
  activities distinguish foreground/background. Incognito playback is excluded.
- Records split at 15-minute UTC boundaries and metadata/evidence/language/context changes.
  Coverage is a merged array of ranges; unknown coverage is `[]`. Replays add time, not duplicate
  coverage. Each accumulator seals before 501 disjoint ranges or an invalid clock-span change;
  memory retains at most 64 records in current/previous buckets. Sealed records remain durable.
- Source/process restarts and device/video changes start fresh identities. New checkpoints include
  the whole accumulated total; never reconstruct an active session from only the remaining queue.
- This collector sends **playback only**. Search collection and JEV filtering are future work.
- SQLite binds each event to its original production origin and device. Switching keys to another
  device retains the original queue, which resumes only when that device's key is paired again.
- Unique WorkManager work uploads while active; constrained periodic work provides a 15-minute
  fallback. A process-wide lock also serializes periodic/one-shot workers and key rotation.
- Receipts are validated in full, then matching accepted payloads and receipt metadata are committed
  together. An old acknowledgement or rejection cannot remove/hold a newer queued revision.
  Partial, malformed, foreign and lost receipts cannot delete unacknowledged records. Acknowledged
  counts measure uploaded checkpoints, not extra watch time. Held replacements remain held.
- Backoff with jitter is persisted, respects longer `Retry-After`, and survives restarts.
  401/403 pause delivery until successful pairing. 409/413/422 split batches; isolated failures
  remain held with an error and can be retried unchanged or exported.
- The client follows no redirects and sends no cookies. It uses a 20-second call timeout,
  at most 100 records / 3 MB including escaped evidence per batch.

### Upgrade from immutable watch events

Install using the existing signing key without clearing app data. SQLite schema stays at v2:
pairing, pending/held legacy rows, evidence and delivery state are preserved. Legacy `watch` rows
drain unchanged alongside new `viewing` rows; never convert those old measurements into new IDs
because a lost response may already have committed them on the server. Transient `WatchSegments`
samples are no longer stored separately. Only newly measured time enters the new accumulator.

Public protocol and valid examples: https://ytdash.gromobran.com/android-integration.html.

## Source evidence

Viewing records and legacy watch events reference SHA-256-addressed evidence snapshots. The digest is computed over the
exact UTF-8 JSON string; the ingestion envelope sends that same **string**, not a JSON object.
SQLite schema v2 migrates v1 queues without rewriting their events or delivery state. Event and
snapshot are committed together. Snapshots are deduplicated in storage and each request, retained
for pending/held events across devices, and removed only after the last referencing event is acknowledged.
Outbox export v2 includes the exact evidence strings. **Inspect latest captured evidence** shows the
last persisted snapshot from this app session, including its digest, even after upload.

The collector allowlists these values actually exposed by SmartTube:

- `MediaItemFormatInfo`: source title, `videoDetails.shortDescription`, author, channel ID,
  duration/view-count strings, upload date, live start timestamp/flags, paid-content text;
  regular formats with itag, MIME, bitrate, content length, audio track ID, exposed language
  label, sampling rate, dimensions, FPS, quality label, DRC and projection type.
  Adaptive-format inventories and their counts are excluded starting with `32.72-owntube.4`.
- `MediaSubtitle`: caption language, kind, vss ID, name, MIME/codecs, translatability. `tlang` URL
  parameters distinguish translation options; these are excluded, with only an omitted count retained.
  Same-language aliases added by upstream are deduplicated by language/vss ID/exact URL.
  URLs are used locally for filtering/deduplication and are never retained. Counts disclose aliases and size truncation.
- `MediaItemMetadata`: separate title/description, author/channel ID, formatted view/like/dislike/
  subscriber counts, published date, badge, duration, live/upcoming flags and chapter titles/times.
- ExoPlayer: the actual selected decoder audio/video formats and selected text tracks, including
  exposed language, codecs/MIME, bitrate, resolution/FPS, channel count/sample rate, selection flags
  and color characteristics. Selection changes create a new immutable snapshot.

These are **exposed source values**, not untouched YouTube responses: upstream can format counts,
rewrite subtitle names/MIME, normalize language labels (`en (original)`, `de (dubbed-auto)`), and
default absent flags to false. Provenance is included; formatted counts remain strings. Decoder
language is not inferred spoken language, and decoder selection flags are not YouTube's default
audio flag. The stable `MediaFormat` interface does not expose `audioIsDefault`/`isAutoDubbed`;
`defaultAudioLanguage` is omitted rather than reconstructed from labels. Language analysis is
explicitly `not-run`; no detector result, confidence or algorithm version is fabricated.

Callbacks must match the video's ID. The bridge binds source snapshots to the actual Video object;
segments retain the snapshot observed at their start. Missing fields are omitted. The two strings
required by ingestion (`title`, `description`) use empty strings when absent, with availability/source
markers for description. Titles are limited to 500 UTF-16 units and descriptions to 10,000; snapshots
stay below 64,000 UTF-8 bytes. `truncatedFields` identifies character/byte-limit reductions, and
`descriptionTruncated` marks a shortened root description. Source collection counts retain original
array sizes. A failed getter retains partial metadata and an exception-class-only `mappingError`.
Signed media/caption URLs, cookies, tokens, request configuration, and thumbnails are not serialized.

## Upstream maintenance

`origin` is `ultrox/OwnTube`; `upstream` is `yuliskov/SmartTube`.
Keep upstream history and merge it; do not rename upstream Java packages or edit its submodules.
OwnTube changes should be small, separate commits.

Integration points to review after an upstream merge:

1. `settings.gradle` includes this library; `common/build.gradle` depends on it.
2. `ExoPlayerController` creates the collector, attaches/detaches its listener, and signals
   video/source changes. Its supplier maps the current video metadata and incognito state.
3. `VideoStateController.isIncognitoSession()` exposes the existing session flag read-only.
4. `AppDataSourceManager` adds one OwnTube-only settings entry.
5. `smarttubetv` retains its separate `stown` flavor, identity, assets, and signing setup.
6. `VideoLoaderController.processFormatInfo` and `PlaybackPresenter.onMetadata` pass received
   metadata through `SmartTubeTracking`; mapping lives in `owntube/SourceEvidence`.

```sh
# Start from a clean, committed tree.
./scripts/sync-upstream.sh --check  # conflict check; working tree is untouched
./scripts/sync-upstream.sh         # merge upstream/master and update pinned submodules

# JDK 17 and ANDROID_HOME pointing to the Android SDK:
./gradlew :owntube:testDebugUnitTest :smarttubetv:assembleStownRelease
```

Use the same local release keystore for updates. OwnTube's `versionCode` is independent of upstream;
increment it for each installed release, and keep its suffix explicit.

## Verification

Tests cover wall-time/coverage, pause/buffer/ad-state intervals, seeks, visibility, device changes,
unknown metadata, incognito, receipt validation, partial acknowledgements, durable restart,
lost responses/idempotent retries, key rotation, Retry-After, rejected-event isolation and export.
Viewing regressions cover bucket splitting, replay/pause totals, immutable snapshots/metadata,
fresh restart identities, backwards clocks, range bounds, stale/conflicting/decreasing revisions,
in-flight receipt/rejection races, held replacement and mixed legacy/cumulative restart recovery.
Run the optional HTTP contract test against a freshly created local Observer database:

```sh
python3 owntube/test-observer.py /path/to/youtube-observer/target/debug/youtube-observer
```

The script starts/stops an isolated loopback backend and supplies temporary test credentials.
It checks the actual accumulator, SQLite outbox and uploader against server replacement semantics,
including a lost receipt, concurrent revision, restart, evidence, stale retry, legacy backlog and conflict.
Verification on 2026-11-13: all 45 unit regressions and this separate HTTP contract test passed;
signed `32.72-owntube.5` release APKs built successfully. The ARM64 APK was installed as an update
on the Shield (`192.168.8.245:5555`) on 2026-11-13; versionCode 2466 and the retained app-data
directory were verified. Post-update playback capture has not yet been checked on-device.
Evidence tests cover source provenance, unavailable/foreign metadata, translated-caption filtering,
partial getter failures, selected-format fields, immutable segment binding, UTF-8 hashing and size
limits, v1 migration, transaction rollback, cross-device retention, and exact-byte retry/export.

On a paired TV, additionally verify a real watch, pause/seek, background playback, and reboot/offline
recovery. A successful ingestion acknowledgement proves server commit. Portal aggregate inspection
requires the owner's dashboard session; the device key cannot read history.

Shield verification (2026-11-07, `32.72-owntube.3`): inspected the actual captured JSON for
`jNQXAC9IVRw` and independently matched its SHA-256. The 5,267-byte snapshot contained two caption
tracks, 14 adaptive/one regular format, selected audio/video formats, three chapters and metadata
description/counts/date. The 155 translation options were excluded (count only). No truncation or
invented default language was present. The server acknowledged 20 additional segments; pending/held
counts were zero. Pairing and previous acknowledgements survived the schema/app update.

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
- Approximately one-second monotonic intervals are persisted as immutable SQLite events on a
  dedicated disk executor. A process kill can lose the not-yet-persisted tail, not committed records.
- Pause, buffer, seek, source, speed and visibility transitions split intervals. Watch time is
  elapsed wall time; 2× speed does not double it. Gaps over 20 seconds are not extrapolated.
- Coverage is attached only for continuous plausible positions with a known non-live duration.
  Seek jumps never contribute coverage. Unknown context is omitted; started/stopped player-host
  activities distinguish foreground/background. Incognito playback is excluded.
- This first collector sends **watch events only**. Search collection and JEV filtering are future work.
- SQLite binds each event to its original production origin and device. Switching keys to another
  device retains the original queue, which resumes only when that device's key is paired again.
- Unique WorkManager work uploads while active; constrained periodic work provides a 15-minute
  fallback. A process-wide lock also serializes periodic/one-shot workers and key rotation.
- Receipts are validated in full, then accepted IDs and receipt metadata are committed together.
  Partial, malformed, foreign and lost receipts cannot delete unacknowledged records.
- Backoff with jitter is persisted, respects longer `Retry-After`, and survives restarts.
  401/403 pause delivery until successful pairing. 409/413/422 split batches; isolated failures
  remain held with an error and can be retried unchanged or exported.
- The client follows no redirects and sends no cookies. It uses a 20-second call timeout,
  at most 100 records / 3 MB of event JSON per batch, and empty evidence.

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

On a paired TV, additionally verify a real watch, pause/seek, background playback, and reboot/offline
recovery. A successful ingestion acknowledgement proves server commit. Portal aggregate inspection
requires the owner's dashboard session; the device key cannot read history.

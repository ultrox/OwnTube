# OwnTube server (YouTube Observer)

A small, single-owner YouTube record: **Chrome / Android collectors → Rust + SQLite → OwnTube backoffice**.
Watch time is the primary measurement. Cumulative viewing records retain titles, descriptions,
detector evidence, playback context and merged coverage for future analysis.

This service now lives in the OwnTube monorepo; see
[component boundaries](../docs/architecture.md) and
[migration notes](../docs/repository-migration.md). Release records below retain
historical paths from the original repository. Current build/deploy commands use
the new component layout.

## Run locally

From the OwnTube repository root (Node 22+, pnpm, Rust):

```sh
pnpm --dir apps/backoffice install --frozen-lockfile
pnpm --dir apps/chrome-extension install --frozen-lockfile
./scripts/build-web.sh
cd server
cargo run --locked
```

1. Open **http://127.0.0.1:3210**.
2. Sign in using the contents of `server/data/admin-token` (relative to the repository root). The server creates this file
   on first run with owner-only permissions. `ADMIN_TOKEN` can supply a key instead (24+ characters).
3. Open **Legacy** (`/legacy/`) to add people, then create labelled devices assigned
   to each person. Each browser installation gets its own device key; a person can have many devices.
4. Load `apps/chrome-extension/dist/` unpacked at `chrome://extensions`.
5. In its popup, open **Server & pairing → Open connection settings**. In that normal tab, enter
   the server URL (`http://127.0.0.1:3210` for local development) and the newly created **device key**,
   then click **Save connection**. New installations default to the production HTTPS address.
   Accept Chrome's server-access permission if prompted. **Saved connection** confirms persistence;
   the key field is deliberately blank after saving/reopening, rather than displaying your stored key.
6. Refresh open YouTube tabs. Watch a regular video or Short; uploads run roughly every 30 seconds.
   History uses an explicit **Refresh** to preserve the list while reading. **Upload now** in the
   collector starts a bounded drain immediately.

### People and history

The production web build serves **History** at `/#/history` and **Searches** at
`/#/history/searches`. The editorial desk reads `/api/history`, `/api/history/searches`
and exact-version `/api/history/evidence`; see [the contract](../contracts/history.md).
Period/person/device define totals. Text narrows records across all pages without changing
those totals. Watch time separates foreground, background and unspecified contexts.
Native entries group recorded viewing ID, metadata version, device and server calendar date.
Legacy entries say **Recorded that day** because the collector saved no visit identity.
Coverage describes the entry's recorded media ranges, with partial/missing coverage labelled.
Searches pages expose every saved query, rather than only the latest twenty.

Paging and text changes preserve the snapshot pair; changing scope or **Refresh** starts
a new snapshot. If viewing records changed, History reloads page one with a notice.
Devices are described by their observed collector evidence, never guessed from labels.
The independent **Languages** module remains at `/modules/languages/` with its own filters
and audited corrections. History shows the original collector estimate.

The existing Elm dashboard remains at `/legacy/` for device/person management and previous
views. The following sections describing Observer tabs/charts apply to that legacy dashboard.
The desk and Languages ship content-hashed CSS and JavaScript import graphs.
Diagnostics and the Android integration guide retain their root paths.

The legacy dashboard has two independent views: **Observer** for viewing statistics, history and device
management, and **Languages** for a watch-time breakdown by recorded language estimate. Languages
has its own person/device/date filters, percentage bars and a selectable one-language-versus-the-rest
comparison. Switching views preserves each view's filters; only the active view refreshes automatically.
Language totals use every watch segment in the selected range, including background playback and
Shorts, independently of Observer's history search, pagination and format filter. Estimates can change
within a video; “Other / undetermined” includes uncertain detections and unsupported languages.

Session restoration uses a small authentication-only request. Successful sign-in opens the dashboard
shell immediately, with a separate loading state for statistics. Observer reads only the latest 100
activity records and 20 searches instead of parsing every network report in the range. Languages uses
its own aggregate query and does not build or transfer video history.

### Compact viewing model

The durable product model uses cumulative viewing records, not permanent playback ticks.
"Keep all history" means watch time, video metadata/evidence and language/context breakdowns;
it does not require retaining every sampling callback in the active database. Sampling remains frequent
for accurate playback detection, while a stable viewing ID and monotonically increasing revision let
the collector checkpoint and resend cumulative totals safely. Historical records must retain calendar-day
attribution, elapsed time versus merged media coverage, people/device scopes and uncertain-language segments.
Records split at 15-minute UTC boundaries; the existing server time zone remains authoritative for daily totals.
Metadata/evidence, playback context and language changes receive separate records. Replays increase elapsed
time; merged media ranges measure unique coverage. A page restart starts a new viewing identity.
The collector stops capturing supplemental YouTube network reports; existing reports remain available.

Verified pre-rewrite backup `pre-rewrite-20261113T000517Z` exists at
`/home/marko/Backups/youtube-observer/` on hserver and
`~/.local/state/youtube-observer/backups/` on the Mac. It includes SQLite and the owner key;
SHA-256 checks, full integrity checks and an independent restore/count check passed:
295,911 events, 395 evidence records, 3 devices, 2 people. Keep this original recoverable.
On this backup, 287,292 watch events represent 17 hours: a grouping inspection found only
253 device/video/day groups and 456 language/context/evidence groups. The verified migration produces
574 bucketed records and 408 metadata snapshots, preserving 61,186.0187 seconds. The production-copy
oracle comparison covers household/person/device scopes, 1/7/30/90 days, fractional coverage, metadata,
daily/context/language totals and partial legacy windows. Original events remain recoverable.

Dashboards read indexed disk-backed compact records through two bounded read connections. A separate
authentication connection keeps login/session checks independent. Legacy uploads remain supported and
are imported transactionally; new viewings bypass the raw events table. Startup imports are resumable
in 2,000-row transactions. The temporary in-memory candidate was never deployed.

### Operational measurements

The header's **Diagnostics** link opens `/diagnostics.html`; its data requires the owner session.
`GET /api/diagnostics` reports request p50/p95/p99, worker queue and database lock/work timings,
analytics timings, records scanned, browser network/render-ready timings, release and processing progress.
Each measured response includes `Server-Timing` and `X-Request-ID`, also written to structured logs.
The report can be copied for investigation. Routes use templates and omit request bodies, query strings,
credentials, video titles and device identities. Diagnostic/telemetry calls are excluded from latency stats.
Series retain at most 512 samples within 15 minutes; counters reset on restart and the last 40 request
breakdowns are retained. Nested stages overlap. Browser measurements enter through authenticated
`POST /api/metrics/client`; no timing samples means "no data", not zero latency.

Only the owner signs in. People have stable IDs and group devices; they do not have separate logins.
The dashboard owns its Elm styles, theme palette and self-hosted fonts, with general
viewing statistics: time watched, daily average, distinct videos, completed videos/viewings, days
with activity, and searches. Charts show daily Videos/Shorts minutes, accumulated watch time and
format share. Light/dark theme is remembered on this browser. Original language estimates remain
inspectable alongside source evidence for future analysis and before/after comparisons.

Choose a person to combine their devices' watch time, video coverage and completion.
The device dropdown offers an optional drill-down within that person. Person cards always summarize
all of that person's devices over the selected 7/30/90-day range, even when drilling into one device.

History starts collapsed below the charts. **Show videos**, or the Videos watched tile, opens a table
with title/channel, person, watch time, video length, coverage, last watched and evidence. Search by
title, channel or video ID; filter Videos/Shorts and sort by recency, watch time or title. These history
filters and the 10/20/50-row pages never change summary cards or charts. Paging freezes complete results
and their revision/time boundary so new uploads do not shuffle results. **Refresh**, or changing a filter/page size,
returns to live page one. The Searches table shows the latest 20, while its summary counts the full range.
Snapshots are bounded to four entries and 32 MiB, expiring after 15 minutes idle. An evicted changed
snapshot returns 410; the UI refreshes page one automatically. Explicit historical cutoffs that intersect
a new cumulative record return 422 rather than inventing time across pauses; use 15-minute UTC boundaries.

History has one row per person/video. Coverage can combine across that person's devices, but never
across different people. Unassigned devices stay separate until assigned to a person. In the Everyone
view, Videos watched counts distinct video IDs; Completed viewings counts completed person/video pairs.
A completion means 90% unique coverage within the selected range, not a lifetime completion date.
Daily average divides recorded time by every calendar day in the selected range. Empty days mean no
recorded playback, not proof that collection was running or that someone watched nothing.

Use **Assign / rename** to manage existing devices. Reassignment moves the device's entire history
to its new person. Existing person labels migrate automatically, preserving keys and events.

### See what is happening

The collector popup refreshes every two seconds and shows the local queued-event count, the actual
Chrome alarm countdown, retry backoff, last capture, in-flight batch, last attempt and last server
acknowledgement. **Upload now** bypasses backoff. The next-batch preview shows up to 100 oldest events,
their type counts, measured watch seconds, request size and distinct source snapshots. Expand an event
to inspect its data. These preview totals apply to the next request, not an entire larger backlog.
In-flight events remain in the queue until acknowledged; receipt metadata and removal commit together.

The dashboard's **Collector delivery** section shows each device's last accepted batch and readable
recent records. It cannot see an offline browser's pending queue; that lives in the extension.
**Cumulative viewing** shows the latest saved total, while legacy **Watch segment** rows show their
individual contribution. Existing YouTube reports are supplemental and add zero seconds.
Raw JSON remains available through details.

The owner key and device keys are different credentials. A device can submit events and read its
own label; it cannot read watch history or manage other devices. Owner sessions expire after seven
days. Revoking a device key stops its uploads without deleting history. **Replace key** immediately
invalidates the previous key and re-enables that device. Paste the replacement into the same collector's
connection-settings tab; queued events remain attached to that device and can resume uploading.

## What is counted

- URL-matched player playback, including background tabs/windows as of collector **0.1.2**;
  paused, buffering, seeking and ad states are excluded. The player must still match the page's video.
- Each new watch segment records `playbackContext`: `foreground` for a browser-visible tab or
  `background` for a hidden tab. Visibility changes split segments; context does not prove attention.
  Dashboard, video rows and evidence show **On-tab**, **Background**, and their combined playback time.
  Older records without this field remain **Unspecified**. Older collectors dropped hidden playback;
  their missing time is not restored by deploying the dashboard or reloading the new collector.
- Elapsed wall time, independent of media speed. Replays add watch time.
- Media ranges provide **unique coverage**; 90% coverage is labelled complete. Dashboard coverage
  is for the selected date/device/person range, not lifetime completion.
- Multiple devices/tabs are summed independently. Totals represent collected playback, not a union
  of a person's simultaneous activity across devices.
- Searches are preserved in raw events; the first direct result retains its search link.
- Daily totals use the server's `TIMEZONE`, default `Europe/Zurich`; ranges include every calendar day.

The collector owns its player selection, Shorts handling, clock, language extraction and
evidence validation in `extension/capture/`, with Observer-specific messages and DOM markers.
Its capture policy enables background playback and one-second durable saves.
Media time updates also sample playback.
Its worker only queues and uploads. It has no local dashboard, rollup or language-correction store.
The retired Lingo Tally extension is preserved in Git history; its local history has no import yet.

## Delivery and data model

- Capture is sampled and saved to IndexedDB about every second. Capture receives success only
  after its local transaction commits. Unacknowledged capture uses stable event IDs on retry.
- An MV3 alarm uploads every 30 seconds, with a single in-worker drain lock, up to 100 events per
  request and ten requests per alarm. Offline backlogs continue on subsequent alarms.
- Failures persist exponential backoff with up to 20% jitter, capped at 30 minutes, and honor longer
  server `Retry-After` delays. Requests time out after 20 seconds. Manual sync bypasses backoff.
  Authentication failures (401/403) pause automatic uploads until credentials change or a manual retry
  succeeds. No failed or malformed receipt deletes queued events.
- Only explicitly acknowledged IDs **and revisions** are deleted. A lost HTTP response resends them.
  SQLite replaces cumulative totals for higher revisions, acknowledges stale revisions, and rejects
  conflicting equal revisions or decreasing totals/coverage with 409, rolling back the entire batch.
- Rejected batches (409/413/422) are split into smaller requests. Individually rejected events move
  into durable **Held data**, keeping their exact payload and evidence while healthy events continue.
  The popup shows rejection reasons and can export held data or return up to 100 events to the queue
  for retry after the underlying issue is resolved. Held data survives worker/browser restarts.
- A replacement key for the same device/server can be saved with data pending. Switching to another
  device/server requires both the upload queue and held data to be resolved first.
  Each source document is bound to its original device/server at first durable capture; late retries
  cannot cross a subsequent pairing change, even after worker restart. Refresh YouTube tabs after
  changing pairing. Small document-binding records are retained locally for this check.
- Descriptions and evidence revisions are SHA-256-addressed snapshots. Their references commit
  atomically with events. Each batch sends the referenced snapshots once; the server stores them
  once globally. Digests cover the exact UTF-8 JSON string, avoiding cross-language float encoding
  differences. Locally, snapshots are retained while queued events reference them; held records keep
  their own evidence copy. A conflicting equal revision rejects the capture transaction; newer queued
  revisions survive older in-flight acknowledgements and rejection responses.
- SQLite uses WAL, foreign keys, full synchronous commits and a busy timeout. Blocking DB work runs
  off the async HTTP executor. Two read connections, one ingestion connection and one authentication
  connection isolate workloads without external background infrastructure.
- Abrupt tab/process termination can lose an unsampled or not-yet-committed tail. Pagehide attempts
  a final save but is not a durability guarantee. Uninstalling the collector removes its local queue.
  There is no queue eviction or server retention deletion; disk usage grows with retained history.

### Supplemental YouTube reports

Collector **0.2.0** no longer intercepts fetch, XHR or sendBeacon. Previously collected sanitized
reports remain inspectable and exportable. They never add to watch time or completion.

## API

The portal links to **Android integration** at `/android-integration.html`, including from
**People & devices**. This public, credential-free agent handoff covers pairing, measurement
semantics, request/receipt examples, validation limits, durable retries and acceptance checks.
Its source is [`dashboard/android-integration.html`](dashboard/android-integration.html), copied
into the portal build by `build.mjs`.

Owner cookie: `POST /api/login {token}`, `POST /api/logout`, `GET /api/session`,
`GET /api/languages?days=7&device=&person=`, `GET /api/dashboard?days=7&device=&person=`,
`POST /api/people {name}`, `POST /api/devices {label,person}`, `POST /api/devices/{id} {label,person}`,
`POST /api/devices/{id}/rotate`, `POST /api/devices/{id}/revoke`, `GET /api/events/{seq}`.

`person` accepts a stable person ID (legacy names remain supported); an empty assignment is unassigned.
Dashboard filters also accept `person=unassigned`. Dashboard pagination uses `page` (1-based),
`perPage` (10/20/50, default 20), and optional paired `before`/`until` snapshot parameters. For subsequent
pages, pass the first response's `snapshotSeq` as `before` and its `until`. The response includes
`people`, full-range `videoCount`/`completedCount`, `page`, `pages`, and `perPage`. History-only filters
are `query` (up to 200 characters), `kind` (`all`/`video`/`short`), and `sort` (`recent`/`watch`/`title`).
`historyCount` counts person/video rows before history filters; `filteredCount` counts matching rows
and determines pagination. Each row has a stable `historyId`, `personId`, and person label.
This legacy `/api/dashboard` response includes `shortSeconds`/`regularSeconds`, daily format totals,
`activeDays`, full-scope `searchCount`, and the latest 20 `searches`. The new
`/api/history/searches` pages through every saved query; see [History's contract](../contracts/history.md).
Evidence is loaded only for the returned page.
`foregroundSeconds`, `backgroundSeconds`, and `unspecifiedSeconds` partition `seconds` at dashboard,
daily and person/video-row levels. History filters and pagination do not change the dashboard partition.
Device rotation returns `{deviceId,token}`; copy that key immediately.

`GET /api/export?after=0&viewingAfter=0` returns up to 500 legacy `events` and 500 cumulative `viewings`,
with evidence and receipt timestamps. Advance **both** cursors (`after=next`, `viewingAfter=nextViewing`)
until both arrays are empty. Viewings contain current totals: upsert by device/eventId/revision, never
sum repeated exported revisions. Changes during export may appear later; this is a resumable change
export, not a frozen database backup. `GET /api/viewings/{device}/{id}` inspects a current record.
Export is all-device/all-time.

Device bearer token: `GET /api/device`, `POST /api/ingest`:

```json
{"deviceId":"device-uuid","events":[{"eventId":"stable-id","kind":"watch","t":1794000000000,"seconds":5,"videoId":"abcdefghijk","title":"Example","lang":"en","source":"audio-track","conf":"high"}],"evidence":{}}
```

Response after commit: `{"deviceId":"device-uuid","accepted":["stable-id"]}`.
The legacy `watch` format above stays supported. New collectors send `kind:"viewing"`, stable
`eventId`/`viewingId`, positive integer `revision`, `bucket` (UTC milliseconds divisible by 900000),
first `t`, `lastWatched`, cumulative `seconds` and merged `coverage:[[start,end],...]`. Metadata/context,
bucket and first timestamp are immutable within an event ID; totals, end and coverage only increase.
Each record stays within its 15-minute bucket, at most 900 seconds and 2,000 coverage ranges / 64 KiB.
The browser seals a record at 500 ranges. New records use new IDs; IDs beginning `legacy-` are reserved.
With source evidence, events contain `evidenceId`; `evidence` maps its SHA-256 digest to the serialized
JSON string. Preserve original event payloads across retries. Requests are limited to 4 MiB, 100 events,
and 100 snapshots. Timestamps are milliseconds; watch events are positive intervals of at most 20s.
An invalid event rejects the entire batch. Keep client clocks reasonably synchronized (60s future tolerance).

## Deployment

Production address: **https://ytdash.gromobran.com**.

### Android collector and integration guide

OwnTube in `/Users/marko/code/tv-tube` now checkpoints cumulative viewing records starting with
**32.72-owntube.5 / versionCode 2466**. Its SQLite outbox replaces higher revisions and matches
submitted payloads before acknowledgement/rejection, preserving newer in-flight revisions.
Pairing, held data, evidence and legacy offline rows survive the update; old measurements are never
re-encoded under new identities. The public Android guide describes this contract and migration.
All 45 Android unit regressions, a disposable-backend HTTP contract test and the signed APK build passed.
The ARM64 APK was installed on the Shield on 2026-11-13; versionCode 2466 and the retained app-data
directory were verified. Post-update playback capture has not yet been checked on-device.

### Current release: `owntube-languages-20261113-2`

Follow-up from commit `4369a6835`, deployed on 2026-11-13: long channel/device
names wrap within the mobile review list and inspector. CSS and the entire module
JavaScript graph now use content-hashed filenames to avoid stale CDN/browser
assets. The actual AMD64 image matches the local module build byte-for-byte;
its backend binary is identical to `-1`.

Container `68d781aae765`, image
`sha256:378f6933d5e05a5c474243ef84e3e647de1f6507d468ea14b1303d06027f4962`.
Source archive SHA-256:
`1c1dfb1ac1c0021f958dce609c8ffde476145df38171905521792c0bdf1ff567`.
Source: `/home/marko/releases/youtube-observer/owntube-languages-20261113-2/`.
The 53-assertion module suite passes; the new wrapping regressions fail against
the old CSS. Read-only browser validation of the fix against 458 production rows
across 23 pages found no overflowing row values or pages.

Final public HTTPS Chromium checks passed: matching HTML and all four hashed
assets, unauthenticated API rejection, owner login with secure HttpOnly cookie,
real-data ledger, independent review filter, evidence inspector, 390 px phone
layout, session restoration, and the original History page/link. No JavaScript
exceptions were observed.

### Backend release: `owntube-languages-20261113-1`

Deployed from OwnTube commit `7e3b61811` on 2026-11-13 through Kamal's
health-gated handover. Languages review is live at
<https://ytdash.gromobran.com/modules/languages/> alongside the existing History UI.
The module adds revisioned corrections and saved-audio analysis without changing
original evidence, collector estimates or global viewing totals.

Container `c3eeccdf826c`, image
`sha256:b48c2fce77857c3f15c3a6b30cb6ec6cff52f620eae74524905dead5a111ced1`.
Source archive SHA-256:
`1284a8f663f25e79e92323922b697983f4adc6747eb643cc2069981d5bcf2497`.
Source and verification records:
`/home/marko/releases/youtube-observer/owntube-languages-20261113-1/`.

The candidate restored a production backup and matched all six frozen full
History responses. Production retained all original events, evidence, metadata,
people, device credentials and viewing identities; integrity and foreign-key
checks passed. Six historical-cutoff summaries match before deployment. New
uploads continued during verification; pre-restart paging snapshots correctly
expire when the ingestion generation advances. Languages and History agree on
watch totals and foreground/background/unspecified time.

Verified online backup `before-owntube-languages-20261113-1` exists under
`/home/marko/Backups/youtube-observer/` and
`~/.local/state/youtube-observer/backups/` on the Mac, with the owner key.
Database SHA-256:
`c52c13cbf16febf22d7914661ca0ee3eb43b59cc5fc50ae81c85a0b07c448b13`.
Both copies passed integrity, foreign-key, hash and count checks: 297,128 events,
444 evidence records, 662 viewing slices, 458 metadata versions, 3 devices,
2 people. The new assessment table started empty; no fictional fixtures or test
classifications were added to production. No external analyzer is configured.

Image-only rollback, preserving the current volume:
`kamal rollback compact-20261113-4 -c deploy/deploy.yml` from the OwnTube root.
The previous image and stopped container remain available.

### Previous release: `compact-20261113-4` (Android guide)

Deployed on 2026-11-13 through Kamal, container `903e7e621052`, image
`sha256:8d2985f0a198d0fa0320cc307fb0bc1dbf2e38e811dcb1cd6b9f2d1445bc1649`.
This image adds the revised `android-integration.html` to the exact `-3` image below. Runtime-user
hash checks confirm the backend binary and dashboard index are identical. Public health, dashboard
assets, guide anchors and example timestamps passed; the public guide matches the source byte-for-byte:
SHA-256 `33966490e52eb0ce1576dd72488b4fac7664a5ae49261d52aed28fde078aef0c`.
The overlay Dockerfile, guide and handoff are in
`/home/marko/releases/youtube-observer/compact-20261113-4/`; full base source remains in `-3`.
Image-only rollback to `compact-20261113-3` preserves the current data volume.

### Backend release: `compact-20261113-3`

Deployed through Kamal's health-gated handover on 2026-11-13, container `e4f153eefe05`, image
`sha256:6410cd02f5f7ab3e77bcefccbd5201852376fa0349f12452ebf97c47e1048d54`.
The database passed full integrity and foreign-key checks after migration. All six frozen full API
responses matched; devices/keys, people and evidence match the pre-deploy backup exactly.

Production origin server p95 (20 requests each): session **0.11 ms**, Observer **23.01 ms**,
Languages **3.91 ms**, undetermined review **3.59 ms**. These are server measurements, excluding
public network/browser time; the owner-only Diagnostics page shows both independently.
The review contains 68 videos in the current seven-day window.
Public Chromium checks verified hashed assets, sign-in/session restoration, both independent tabs,
review links/pagination, mobile fit and visible Diagnostics/browser measurements. The final smoke
measured 60 ms to the signed-in shell and HTTP requests of 91 ms Observer / 50 ms Languages.

On an isolated production copy, startup including migration took 3.83 s; subsequent startup 207 ms.
With 299,055 compact records representing ten synthetic years, seven-day Observer p95 stayed at
26 ms and the 90-day view took 222 ms. Measured container memory was 74 MiB after concurrent work
and 93 MiB in the growth run; these are observations, not hard limits. Authentication during eight
dashboard calls and cumulative ingestion took 0.92 ms. All retries/restarts preserved the final total.
All six household/person/device scopes stayed below 30 ms p95 in the release benchmark.
The initial deployed `-2` diagnostics exposed sparse-scope legacy activity scans; `-3` bounds those
index reads per selected device and exposes activity/search stages explicitly.

**Collector update required:** at `chrome://extensions`, reload YouTube Observer from
`youtube-observer/extension/dist/` (version **0.2.0**), then refresh all open YouTube tabs.
Pairing is preserved. Existing collectors continue uploading the compatible legacy protocol until
reloaded. Refresh the dashboard for the new review and Diagnostics links.

Fresh online backup: `before-compact-20261113-1` under `/home/marko/Backups/youtube-observer/`
and `~/.local/state/youtube-observer/backups/`; database SHA-256
`7c41f6f48f4bcbf0ee8cf239e45721f726d3f300ae9949a8b99f3553ddd1b011`, 295,920 legacy events,
395 evidence records, three devices, two people. Owner key included; both copies passed full
integrity, matching checksums and restored counts. The earlier pre-rewrite backup is also retained.

The previous compatible image `compact-20261113-2` remains available for image-only rollback.
The older `languages-20261113-2` cannot display/accept cumulative records; retain current data/queues
if using it for emergency recovery. Do not restore an older database over new uploads.
An additional online backup before `-3` includes all 574 compact records: `before-compact-20261113-3`,
SHA-256 `ecf14b27c6bbcc0bb339d59d56131bebe9414c21d53a80da13de955eb60eeede`;
server/Mac copies passed matching hashes, full integrity and restored counts.
Source archive SHA-256:
`a30d5031177886ac4d28f70282823a41c93eeb756609265e32b79347ae6662c2`.
Release source, six frozen baselines and benchmark results are under
`/home/marko/releases/youtube-observer/compact-20261113-3/`.

### Kamal on hserver

Uses the same setup as Tixbee: `marko@hserver`, a remote AMD64 build, the SSH-forwarded local
registry, and the shared Kamal proxy behind Cloudflare Tunnel. Run from the repository root:

```sh
kamal deploy -c deploy/deploy.yml
```

The first release (`production-20261106-1`) was built directly on hserver after the
Mac-registry transfer stalled, then started with `kamal app boot --version production-20261106-1
-c youtube-observer/config/deploy.yml`. The database was seeded with 2,174 events and two devices;
existing owner and device credentials were preserved. Public HTTPS, health, login, secure cookies,
and authenticated dashboard data were verified.

The Lingo-style generic dashboard is live as `dashboard-20261106-3`, built on hserver and started
with `kamal app boot`. Before deployment, a consistent SQLite backup was saved as
`backups/before-dashboard-20261106-194331.sqlite3` in the production volume (2,479 events).
Watch-time and distinct-video totals matched the pre-upgrade snapshot across all five household,
person and device scopes. Public asset hashes, authentication, secure cookies, history-filter
isolation, desktop/mobile rendering, populated history and theme persistence were verified.
Dashboard JavaScript and CSS use content-hashed URLs to avoid stale browser/Cloudflare assets.
Refresh the dashboard to load this release; collector pairing and installation need no update.

Release `evidence-20261106-4` adds a native `<dialog>` evidence viewer. Each history row's
**Evidence** button opens structured saved metadata, description, language/audio/caption signals
and text-analysis details, with expandable raw JSON and the evidence digest. It supports dark/light
themes, mobile scrolling, Escape/backdrop dismissal and focus restoration. The Chromium pipeline
and live desktop/mobile checks verified the modal behavior after deployment.

Release `context-20261106-5` adds the on-tab/background/unspecified breakdown. Collector **0.1.2**
fixes hidden-tab undercounting; reload the unpacked extension and then refresh open YouTube tabs.
The browser regression covers real visible → hidden → paused → visible transitions, offline capture,
lost acknowledgements and restarts. Nine Rust tests, twelve queue tests, Clippy and the Chromium
pipeline passed; shared Lingo Tally unit/capture checks also passed. Live checks preserved all five
frozen baseline scopes and confirmed that legacy records remain unspecified.

Release `languages-20261113-2` deploys independent Observer/Languages tabs, language comparison,
and session-first sign-in. Live Chromium checks covered both tabs, independent date ranges,
comparison, mobile layout and restored sessions; public HTML and three hashed assets matched the
local build. Six frozen household/person/device baselines matched after the upgrade, and device
records/keys were preserved. The consistent backup is `backups/before-languages-20261113-1.sqlite3`
(295,911 events). The previous `context-20261106-5` image remains available for rollback.

Production measurements: sign-in shell about 0.94s over HTTPS; full Observer statistics still about
4.6s and Languages about 1.7s. The authentication-only origin request took 1ms when idle, but requests
can still queue behind statistics on the shared SQLite connection. Further query optimization remains.
The first release attempt had unreadable static assets due to restrictive source-upload permissions;
it was rolled back, source read/traverse permissions corrected, and the replacement image checked as
its runtime user before boot. Preserve readable source permissions when packaging server-local builds.

Incident: on 2026-11-06, `YB3XE8mWNF0` had continuous received network reports spanning roughly
40 minutes and reported a media position past 38 minutes, while measured watch events summed to
roughly 3–4 minutes. The user confirmed background playback. The former foreground-only capture
policy explains the undercount; the new version fixes future collection, not those missing intervals.

Kamal SSH uses `tailscale nc` to bypass the Mac's failing direct TCP path to the Tailscale address.
The standard registry/build path above remains unverified; `app boot` can start an image already
present on the server without pulling it.

The builder uses the working directory, including uncommitted files. `Dockerfile.dockerignore`
excludes local databases, credentials, dependencies and generated artifacts. Each deployment gets
an image version; use `--version <unique-label>` when choosing an explicit release name.

`deploy/deploy.yml` routes only `ytdash.gromobran.com` to app port 3210. It matches
the existing shared proxy's loopback ports (8080/8443); Cloudflare provides public HTTPS and the
app sets secure cookies. SQLite and the owner key persist in the `youtube-observer-data` Docker
volume. The app runs as UID 10001; any restored database and key must be owned by that UID.

For updates, Kamal checks `/health` before switching traffic. Back up the database before schema
changes; use SQLite's backup API for a live database, or stop Observer before copying its data volume.

### Standalone Docker Compose

For deployment on another host with its own reverse proxy:

```sh
cd deploy
cp .env.production.example .env
docker compose up -d --build
docker compose exec observer cat /app/data/admin-token
```

The compose file publishes only loopback port 3210 and persists SQLite and the generated owner key
in `observer-data`. Point DNS for `ytdash.gromobran.com` at the deployment host and configure its HTTPS
reverse proxy to forward that hostname to `http://127.0.0.1:3210` (when the proxy runs on the host).
Forward both the dashboard and `/api/*` routes, including the device `Authorization` header, and
allow request bodies up to at least 4 MiB. The production environment example enables secure cookies.

Open **https://ytdash.gromobran.com** to sign in and manage people/devices. Pair each collector to
`https://ytdash.gromobran.com` using its device key. The popup requests permission only for the chosen
host. HTTP pairing is supported only on loopback; local development can continue at port 3210.

For an existing local collector, drain its queue and resolve held events before changing the server
URL, then refresh YouTube tabs after pairing. To preserve local history in production, migrate the
SQLite database and owner key into the production volume before its first start; a fresh volume
otherwise starts with an empty history and new credentials.

Server variables: `BIND`, `DATA_DIR`, `PUBLIC_DIR`, `TIMEZONE`, `ADMIN_TOKEN`, `COOKIE_SECURE`.
The image runs as UID 10001. A bind-mounted data directory must be writable by that user.
Its build stage uses Debian's Elm compiler, including on Linux ARM64. Local builds use the npm
compiler unless overridden with `ELM_BINARY`.
For a simple consistent backup, stop the service and copy its entire data volume, then restart it.
Do not copy only the live `.sqlite3` file while WAL writes are active.

## Checks

```sh
# From the OwnTube repository root:
./scripts/check-web.sh
./scripts/check-web.sh --e2e
```

Rust checks cover authentication, transactional retries/conflicts, supplemental-event exclusion,
evidence revisions, fractional-time precision, legacy migration, combined person totals and stable
pagination. Node checks cover IndexedDB upgrades/durability, partial/invalid acknowledgements,
rejection isolation, credential recovery, retry delays, bounded draining and report sanitization.
The browser pipeline uses a
disposable Chromium profile, real extension worlds, local regular-video/Short fixtures, a real Rust
server, offline recovery, a deliberately lost acknowledgement, worker/server restarts and the Elm UI,
including the real collector pairing form, invalid-key feedback, pairing persistence after reopening,
people/device creation, person filters, pagination during uploads, renaming and key replacement.
These fixtures do not establish long-term capture reliability in your signed-in YouTube session.
OwnTube's Android module implements television collection with its own tests and signed APK build.
Production is deployed on hserver through Kamal.

Live smoke check: `pnpm --dir server check:live` opens public YouTube in a disposable,
signed-out Chromium profile and uses a temporary Rust database. On 2026-11-06, a real Short
(`nOMbBrCYmqE`, 4.06 seconds recorded) and a regular video (`vf0god0LtP8`, 5.09 seconds recorded)
both reached the server and dashboard with saved evidence. A repeat on 2026-11-13 with collector 0.2.0
recorded 5.29 seconds of the Short and 4.78 seconds of the regular video through cumulative records.
Results and a screenshot are written to
`artifacts/live.json` and `artifacts/live-dashboard.png`. This is a short playback check, not a
seven-day soak test or a signed-in-session guarantee.

Container smoke check: build with `docker build -f deploy/Dockerfile -t youtube-observer:local .`
from the repository root, then run `pnpm --dir server check:docker`. This checks non-root
startup, hashed History assets/imports, the legacy page, authenticated History/Searches/Languages
APIs, login, and preservation of devices and sessions after recreating a container
with the same volume. The test removes only its own temporary container and volume.

History parity on an isolated production copy:
`node server/tooling/check-history-parity.mjs http://127.0.0.1:3212 /path/to/copy/admin-token`.
The key file must sit beside that copy's `observer.sqlite3`. It compares all 7/30/90-day
person/device scopes with legacy and Languages totals, checks every page/daily sum,
compares saved searches and exact evidence text directly with SQLite, and reports
pre-existing digest mismatches without changing their records.

Post-release browser smoke:
`node server/tooling/check-history-public.mjs https://ytdash.gromobran.com /path/to/admin-token /path/to/screenshots`.
It checks public root HTML against the local build and verifies hashed dependencies,
sign-in/session restoration, real History/Searches, evidence, stable filter totals,
phone layouts and the legacy/Languages pages. Only session login writes; third-party
thumbnail requests are blocked during the check.

# Deployment

Run container builds from the OwnTube repository root:

```sh
docker build -f deploy/Dockerfile -t youtube-observer:local .
```

The image includes the Rust server, live History/Searches desk at `/`, legacy Elm dashboard
at `/legacy/`, and Languages module. Android and the Chrome
extension are separate artifacts. The curation design preview is not included.

## Local container check

```sh
cd server
pnpm check:docker
```

This creates a disposable container and volume, verifies non-root execution,
hashed runtime assets/imports, authenticated APIs, login and persistence across
container recreation, then removes its own resources.

## Compose

```sh
cd deploy
cp .env.production.example .env
docker compose up -d --build
docker compose exec observer cat /app/data/admin-token
```

Compose explicitly uses project `youtube-observer` and volume key `observer-data`,
preserving the previous default naming. Keep any pre-existing custom project name
when updating an installation. The API binds to loopback port 3210; a reverse proxy
owns public HTTPS.

## Existing hserver service

Chrome releases are downloadable from the application image:
`/youtube-observer-latest.zip` and retained versioned ZIPs. Before releasing collector
changes, build `apps/chrome-extension`, run `python3 scripts/package-chrome.py`
from the repository root, and commit the packages under `apps/backoffice/downloads`.
Keep older versioned downloads so shared URLs continue working after deployments.
The image's frontend build copies these packages into its public directory.

The short-code approval page is `/connect/`. Its backend schema adds only
`pairing_requests`; rollback to the previous image may leave that unused table
in place. Approved devices use the existing device credential format, so their
uploads remain compatible with the previous backend. For image-only rollback,
keep the current data volume rather than restoring a pre-release backup over new
watch history.

`deploy.yml` retains service/image `youtube-observer`, host
`ytdash.gromobran.com`, and volume `youtube-observer-data:/app/data`.
The configuration now uses this repository's Dockerfile paths. A future release
must build from this repository and preserve the existing database and owner key.

```sh
# From the repository root, when preparing an intentional production release:
kamal deploy -c deploy/deploy.yml
```

Historical release and recovery records are retained in
[`server/README.md`](../server/README.md). Repository reorganization alone does not
change production.

## Optional language analyzer

`LANGUAGE_ANALYZER_URL` and optional `LANGUAGE_ANALYZER_TOKEN` enable an explicit
external analysis action in the Languages module. Configure them in the runtime
environment/secret store, not the web bundle. Without them, saved-audio-metadata
analysis and manual corrections remain available. See
[`docs/languages-module.md`](../docs/languages-module.md) for the bounded provider
contract. No external service is configured by this repository.

## OwnTube production cutover — 2026-11-13

Release `owntube-languages-20261113-1` was built on hserver from committed
OwnTube source `7e3b61811`, tagged
`localhost:5555/youtube-observer:owntube-languages-20261113-1`, then started using:

```sh
kamal app boot -c deploy/deploy.yml --version owntube-languages-20261113-1
```

This uses the existing server-local build path documented in `server/README.md`;
the local-registry transfer path was not needed. Git archives supply tracked
server/backoffice/deploy sources, excluding local data and credentials. The actual
AMD64 image passed runtime-user asset checks and a restored-production-copy
comparison before handover. Backups, image identity and rollback are recorded in
[`server/README.md`](../server/README.md#backend-release-owntube-languages-20261113-1).

The Languages follow-up `owntube-languages-20261113-2` uses the same process from
commit `4369a6835`, with mobile wrapping and content-hashed module assets. Its
backend binary is identical to `-1`; the same backup and image-only rollback apply.

## Home feed release

`owntube-home-feed-20261119-1`, source `21781c421`, serves the curated TV Home feed
from production instead of the Mac/ADB tunnel, with the Curated editor and
HackerTube catalog. The image adds Python, pinned yt-dlp, Deno and the German
matcher; automatic German matching is paused on hserver (YouTube bot-checks its
per-video lookups). Home version 42 and the catalog were migrated to the TV's
production device. See [release details](../docs/releases/home-feed.md).

## Previous lead settings release

`owntube-lead-settings-20261115-1`, source `b15cf589b`, requires the lead language
when creating an experiment and moves later changes into automatically saved
**Experiment settings**. 52 Rust tests, 207 mock checks, 74 real-local and
74 AMD64 candidate checks passed. Public verification matched 13 assets and
preserved all three existing experiments and viewing data.
See [release details](../docs/releases/experiment-lead-settings.md) and
[deployment identity](../server/README.md#current-release-owntube-lead-settings-20261115-1).

## Previous saved lead release

`owntube-saved-lead-20261115-1`, source `5bce00bf4`, adds **Save lead** beside
**Lead with**. Each experiment remembers its individual or combined lead.
52 Rust tests, 199 mock checks, 68 real-local and 68 AMD64 candidate checks passed.
Public verification matched 13 assets and preserved all existing plans.
See [release details](../docs/releases/saved-lead.md) and
[deployment identity](../server/README.md#previous-release-owntube-saved-lead-20261115-1).

## Previous named experiments release

`owntube-named-experiments-20261115-1`, source `032a6e4b0`, adds named experiments
under each person, with create, open, rename, duplicate and delete actions.
Both previous plans were imported exactly. The actual AMD64 candidate passed
62 browser checks, and public verification matched 13 assets and both people's
lists and plans. See [release details](../docs/releases/named-experiments.md) and
[deployment identity](../server/README.md#previous-release-owntube-named-experiments-20261115-1).

## Previous calendar picker release

`owntube-calendar-picker-20261115-1`, source `5afed0f5a`, adds the six-week
daily-language calendar, clipped placement, four templates and keyboard/touch
controls. Actual AMD64 candidate checks passed; public verification matched 12
assets and both person plans. No schema migration. See
[release details](../docs/releases/calendar-picker.md) and
[deployment identity](../server/README.md#previous-release-owntube-calendar-picker-20261115-1).

## Previous person-oriented experiments release

`owntube-person-experiments-20261115-1`, source `9781616e0`, gives every person an
independent experiment and restricts the device picker to their devices.
The previous shared comparison stays read-only. The actual AMD64 image passed
34 restored-copy checks; public verification matched ten assets and both people's
device options in light/dark desktop and phone layouts. Six frozen scopes,
384 reviews, credentials and shared comparison revision 11 were preserved.
See [release details](../docs/releases/person-experiments.md) and
[deployment identity](../server/README.md#previous-release-owntube-person-experiments-20261115-1).

## Previous comparison v2 release

`owntube-comparison-v2-20261115-1` introduces the ordered-period experiment model
and the responsive comparison redesign. Deployed from `f19dbf112` through the
server-local Docker/Kamal path after restored-backup verification. Public checks
matched ten assets and desktop/phone layouts in both themes. Six frozen scopes,
376 reviews, credentials and comparison revision 11 were preserved.
Release identity and backup:
[`server/README.md`](../server/README.md#previous-release-owntube-comparison-v2-20261115-1).
The saved configuration migrates only on its first v2 save. Rollback after that
requires targeted configuration conversion, as described in
[`docs/releases/comparison-v2.md`](../docs/releases/comparison-v2.md).

## Previous device-removal release

`owntube-device-removal-20261114-1`, source `01ecbe0b3`, adds a connected-device
list and **Delete device** on `/connect/`. Deletion revokes uploads while keeping
recorded history. Browser checks verified retry, retained exports and blocked
uploads; public checks matched three active devices and all downloadable ZIPs.
Eight frozen production scopes, 370 reviews and comparison revision 11 were
preserved. Backup, release identity and rollback:
[`server/README.md`](../server/README.md#previous-release-owntube-device-removal-20261114-1).

## Previous short-code pairing release

`owntube-device-pairing-20261114-1`, source `ad255d55a`, adds dashboard approval at
`/connect/` and Chrome 0.3.0 short-code setup. All three public ZIP downloads are
included in the image. The actual AMD64 candidate and deployed server matched
seven frozen production scopes, preserving 370 assessments and comparison
revision 11. Public approval assets, login, desktop/phone layouts and ZIP hashes
passed. Release identity, backup and image-only rollback:
[`server/README.md`](../server/README.md#previous-release-owntube-device-pairing-20261114-1).

## Previous comparison redesign release

`owntube-comparison-story-20261113-1`, source `cfebb3765`, leads with named
daily-rate deltas and paired bars, shows exact missing-day counts between unequal
periods, and separates share-point changes from relative daily-rate changes.
184 mock and 75 real-local browser checks passed, including both themes' contrast,
keyboard focus and phone layouts. Backend and saved configuration are unchanged.
Release details, verified backup and image-only rollback:
[`server/README.md`](../server/README.md#previous-release-owntube-comparison-story-20261113-1).

## Previous recorded-language picker release

`owntube-recorded-language-picker-20261113-1`, source `0b4baa5c9`, places
**Add language** beside **Add period** in both groups and offers only languages
recorded in the saved comparison periods for the current device/person scope.
136 mock, 52 real-local browser and 17 language-server checks passed.
Release details, verified backup and image-only rollback:
[`server/README.md`](../server/README.md#previous-release-owntube-recorded-language-picker-20261113-1).

## Previous selected comparison languages release

`owntube-compare-languages-20261113-1`, source `d08347beb`, adds a saved language
selection shared by both period groups, with combined and individual statistics.
132 mock, 48 real-local browser and 17 language-server checks passed.
The verified backup includes the existing saved comparison and 237 assessments.
Release details and configuration-aware rollback:
[`server/README.md`](../server/README.md#previous-release-owntube-compare-languages-20261113-1).

## Previous language period comparison release

`owntube-period-comparison-20261113-1`, source `08599ce56`, adds a saved two-group
**Compare periods** view and a searchable **Other…** language picker. Dates combine
within each group, with calendar-day averages and language-share differences.
Concurrent saves are revision-checked. 126 mock and 42 real-local-server browser
checks passed, with server coverage for DST, cumulative/legacy measurements,
manual precedence, context correction, persistence, scope and conflicts.
The verified fresh backup includes 237 existing language assessments.
Release details and rollback:
[`server/README.md`](../server/README.md#previous-release-owntube-period-comparison-20261113-1).

## Previous YouTube links release

`owntube-youtube-links-20261113-1`, source `8bc544547`, adds **Open in YouTube ↗**
to Languages rows and the inspector. Local and public browser checks verified
new-tab opening, retained filters/draft edits and phone layouts.
Release details and rollback:
[`server/README.md`](../server/README.md#previous-release-owntube-youtube-links-20261113-1).

## Previous quick language controls release

`owntube-quick-languages-20261113-1`, source `d9e0a6b8b`, adds immediate
**? / DE / EN / BCS** row choices and fixes the inspector footer: edited forms
offer **Save & close**, persisting the selected target before closing.
108 mock and 24 real-local-server checks passed. The server executable matches
the previous release byte-for-byte. Fresh verified online backups include the
14 existing assessments and the TV context correction.
Release details and rollback:
[`server/README.md`](../server/README.md#previous-release-owntube-quick-languages-20261113-1).

## Previous video History and selected-audio release

`owntube-video-audio-20261113-1`, source `3a4dbaec8`, groups History once per
video across the scope, retaining visits and exact evidence underneath. It decodes
the actual selected audio in historical browser/TV evidence and preserves manual
decisions. The AMD64 candidate passed 21 scopes, 470 exact evidence versions and
desktop/phone checks against a fresh online backup.
Post-deployment public HTTPS checks passed, including release assets, exact
evidence, corrected languages and phone layouts. Production matched all six
frozen baselines and preserved credentials, assessments and the TV correction.

Chrome 0.2.1 is a separate collector update staged at its existing installed path;
reload YouTube Observer and refresh YouTube tabs to activate it.
Release identity, verification and image-only rollback:
[`server/README.md`](../server/README.md#previous-release-owntube-video-audio-20261113-1).

## Previous grouped History release

`owntube-grouped-history-20261113-1`, source commit `2e44ac20a`, groups History
metadata revisions within their recorded viewing. History and Languages share
version selection and exact-evidence verification; History links select the
matching version in Languages.

The non-root AMD64 candidate passed 21 production-copy scope comparisons, all 465
evidence versions, source-table preservation and desktop/phone browser checks.
Fresh online backups include all 12 assessments and the active TV foreground
override. Release identity, verification and image-only rollback:
[`server/README.md`](../server/README.md#previous-release-owntube-grouped-history-20261113-1).

## Previous review release

`owntube-review-20261113-1`, source commit `457e90e82`, grouped Languages
by video, automatically interprets saved selected-audio labels for unreviewed
records, and supports audited device playback-context corrections. The authorized
TV OwnTube foreground override is active for existing and future playback.

The actual AMD64 image passed production-copy grouping/time/evidence checks and
browser verification before the Kamal handover; public HTTPS verification passed
after deployment. The new online backup and all 12 saved language assessments
were preserved. Image, backup, activation and rollback details are in
[`server/README.md`](../server/README.md#previous-release-owntube-review-20261113-1).

## Previous History release

`owntube-history-20261113-1`, source commit `9fe9556a4`, introduced the live desk at the root.
The server-built AMD64 image passed an isolated fresh-production-copy comparison
before `kamal app boot -c deploy/deploy.yml --version owntube-history-20261113-1`.
Public browser checks and six frozen scope baselines passed after handover.
The new online backup preserves the 12 existing language assessments as well as
all original collector records and credentials. Exact image, backup, verification
and rollback records are in
[`server/README.md`](../server/README.md#previous-release-owntube-history-20261113-1).

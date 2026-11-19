# Cached feeds and the Curated editor

## Working flow

YouTube → backend source snapshot → saved editorial rules → immutable publication
→ existing OwnTube renderer.

Curated at `/modules/curated/` shows real cached categories and rows. Add videos
by YouTube URL/ID at a chosen position, remove videos, block known channels, and
reorder with drag-and-drop or keyboard-accessible arrow buttons. Save a draft or
publish it. The Published tab is the exact stored version served to the TV.
There is no separate injected-content row.

**Browse HackerTube** provides a local source library of recommended videos,
organized by topic. Add individual picks or a ranked batch into an existing row,
then publish normally. See [catalog import and attribution](hackertube-catalog.md).

Home also has an [automatic German mix](german-home-mix.md): detect English titles,
batch-translate them, then insert the first eligible YouTube search result under
saved target, row and creator rules. By default, 12 new searches per six-hour
cycle rotate across Home; results are cached for 30 days. Language and relevance
are title-based estimates, with translation token usage and estimated cost shown.

**Default cards per row** sets a cap for the selected category (1–48). Each row's
**Row override** can set a different cap; clear it to inherit the category default.
Save/publish handles these settings like other edits. On 2026-11-16, both Home
Shorts rows were capped at six and published as version 7; Home's default is 48.
Browser checks verified the category preview, draft isolation and exact published
counts. Rust/JS tests cover inheritance, refresh, ordering and bounded pagination.

Sources refresh in six-hour windows using the next active TV connection. Cached
content is served immediately while refreshing; errors retain the last good
publication. Edits persist across refreshes. The first snapshot takes longer to
prepare. Cache size and limits are disclosed in the UI.

## Production

Since 2026-11-19 the TV uses `https://ytdash.gromobran.com` (release
`owntube-home-feed-20261119-1`); edit feeds at `/modules/curated/` there with the
production owner key. The local setup below is for development only. Automatic
German matching is paused in production; see
[the release notes](releases/home-feed.md).

## Local setup

For development only. Build the web app and server:

```sh
pnpm --dir apps/backoffice build
cd server
cargo build --locked
DATA_DIR=/absolute/path/to/test-data \
OWNTUBE_HOME_RULES=/absolute/path/to/rules.json \
BIND=127.0.0.1:3219 \
PUBLIC_DIR=../apps/backoffice/dist \
target/debug/youtube-observer
```

Use `{}` in `rules.json`. Existing proof-of-concept file insertions/blocks are
superseded by Curated's database rules.

Build the Android debug variant with JDK 17 and Android SDK configured. It uses
the local release key for a data-preserving update:

```sh
cd apps/android
./gradlew :owntube:testDebugUnitTest :smarttubetv:assembleStownDebug
adb -s 192.168.8.245:5555 install --no-streaming -r smarttubetv/build/outputs/apk/stown/debug/OwnTube_own_32.72-owntube.8_arm64-v8a.apk
```

From the repository root:

```sh
python3 scripts/connect-tv-home.py --serial 192.168.8.245:5555 --data /absolute/path/to/test-data
```

This creates a separate local Home device key, writes it to the debug app's
no-backup storage and enables the loopback ADB tunnel. Existing production
tracking credentials remain in place. On later restarts, re-establish
`adb reverse tcp:3219 tcp:3219` if necessary; there is no need to create a new
test device each time.

Open **http://127.0.0.1:3219/modules/curated/** and sign in using the local
`DATA_DIR/admin-token`. The original `:4187` page remains the design prototype.

The Mac server and ADB connection must remain running. Turn **Server feeds** off
in tracking settings to restore direct browsing. Debug builds also expose the
local/production feed server switch; release builds ignore local configuration.

## Verification, 2026-11-15

- Live Home snapshot: 24 rows / 473 cards, loaded from the signed-in Shield.
- Browser-driven removal, video URL lookup, insertion at position 2, reorder,
  draft save, and publication succeeded against the real local API.
- Saving the draft left the published version unchanged. Publishing produced
  version 2 with exact preview equality; the removed ID was absent in every row.
- Restarted the TV app: **Recommended** displayed the published order:
  Foy Vance, Me at the zoo, MDF vs. Plywood, then the next recommendation.
- Installed `.9`: published cards bypass DeArrow, unlocalized titles and
  start/middle/end-frame thumbnail rewriting. Shield Home now shows the original
  published thumbnails. Regression coverage includes copied cards and all four
  thumbnail settings.
- Fixed the backend dropping scheme-relative channel avatar URLs (`//yt3...`).
  They are normalized to HTTPS before publication; parser regression tests pass.
  The local server is updated and Home refresh is queued. Existing publications
  retain their missing images until a new snapshot is built on a TV Home request.
- Other category cache checks and automated results are recorded with the final
  implementation handoff.

### Playback investigation

The Shield was observed entering buffering with no buffered media ahead during
4K VP9 playback. The debug build's upstream shared OkHttp client includes both
the profiler and BODY-level HTTP logging; binary response output was present in
logcat. These interceptors consume response bodies before the player receives
them, making them unsuitable for streaming.

Build `.10` prepares a streaming client without those two diagnostic interceptors,
preserving other interceptors, networking configuration and the connection pool.
This covers ExoPlayer's OkHttp path, including DASH and SABR. A delayed-body test
verifies the player can receive headers before the response finishes downloading.
Build and focused tests passed. Installed `.10` (2471) on the Shield with a
data-preserving update and reopened OwnTube. On-device playback verification is
pending; the cause of every reported out-of-memory event is not yet confirmed.

## Scope and boundaries

The cached boundary covers Home and the TVHTML5 Music, News, Gaming, Sports,
Live and Trending feeds. Each is cached when opened on the TV, and every row of
that cached version is editable.

Kids, Shorts' separate stream, subscriptions/history grids, arbitrary channel
pages, search, player recommendations and video streaming use separate upstream
paths and still need their own adapters. Home shelves containing Shorts are
already represented. Promotional/search-action tiles and some auxiliary metadata
are omitted. Channel blocks match only known channel IDs.

YouTube credentials stay on the TV and in transient request memory; there is no
unattended refresh while the TV is disconnected. Changes become visible when the
TV reopens the category, preserving stable in-progress scrolling.

See [the API and snapshot contract](../contracts/home-feed.md).

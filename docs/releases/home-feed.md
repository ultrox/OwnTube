# Home feed on hserver

Release: `owntube-home-feed-20261119-1`, source `21781c421` (deploy config `f86cf014a`).

Moves the curated Home feed server from the Mac/ADB tunnel to production
(`https://ytdash.gromobran.com`). The TV no longer depends on the Mac being on,
the ADB connection or `adb reverse`. Debug OwnTube uses production when the
`local` preference is off; it authenticates with its existing tracking pairing.

## Image

Adds Python 3, `yt-dlp[default]==2026.10.26`, Deno 2.7.14 and
`scripts/german-matcher.py`; `/app/home-rules.json` (`{}`) enables server feeds.
Curated rules live in the database.

**Automatic German matching is paused on hserver.** YouTube answers per-video
`yt-dlp` lookups from this datacenter address with "Sign in to confirm you're not
a bot"; search still worked. Those lookups verify German audio, so new matching
would find almost nothing while spending DeepSeek tokens. The server therefore has
no DeepSeek key: the worker records a configuration error and keeps its existing
matches, which stay published. Home feed fetching itself uses the TV's YouTube
authorization and worked from hserver. To resume, route the worker's YouTube
requests through a residential connection, then add the `DEEPSEEK_API_KEY` secret
(see `deploy/deploy.yml`; the key comes from git-ignored `.kamal/secrets`).

## Verification

- 73 Rust tests, 15 Python worker/import tests and OwnTube Android unit tests passed.
- The AMD64 candidate ran as UID 10001 on a copy of the fresh backup. All 13
  read-only API/page responses matched the previous image on an identical copy,
  except request timestamps, timing diagnostics and the new **Curated** nav link.
- Migration was rehearsed on backup copies: dry run left data unchanged; apply
  moved all feeds; a missing target feed was refused.
- Public health, Curated page and unauthenticated `/api/device/home` (401) passed.
  Other kamal-proxy targets were unchanged.
- TV: Home requests returned 200; the Recommended row matched published version 42.

## Data migration

The local feeds belonged to the Mac's test device. Feed IDs hash the device, so the
TV first opened Home against production, creating its feed; then, with the app
stopped, the Home publication (version 42, 16 versions, 16 German versions) and the
HackerTube catalog (1 source, 4,654 videos, 10,674 category links) were copied into
it. The German title cache was copied into the volume. Integrity passed.

Sports, Live, Gaming, Music and News were not migrated yet: production creates their
feeds when the TV first opens each category. Move them afterwards with
`owntube-home-feed-migrate.py --only=<categories> --apply` against
`local-final.sqlite3`, while the app is stopped (then restart with `kamal app boot`).
Both files are kept, checksum-verified, in `~/.local/state/owntube-home/migration/`
on the Mac (the server release directory was removed under the retention policy);
upload them to a temporary directory for the migration and delete it afterwards.

`kamal app start` after the migration failed ("Failed to get endpoint for web");
the container exited. `kamal app boot --version owntube-home-feed-20261119-1`
restored service. Total downtime was about one minute. For future stopped-app
migrations, restart with `kamal app boot`.

## Deployment, backup and rollback

Container `94bcbfdfd230`, image
`sha256:0de69af888e085873d8bc3a839fa0a5d9dac7631477f1324e8a7b35ad2354aea`.
Source archive SHA-256:
`bcb099a2a85e1983beae25acfcc4af884f7b56bfa6ca6140e365a985bb80deb8`.
Reports: `/home/marko/releases/youtube-observer/owntube-home-feed-20261119-1/`.

Backup `before-owntube-home-feed-20261119-1` under `/home/marko/Backups/youtube-observer/`,
mirrored under `~/.local/state/youtube-observer/backups/`. SHA-256:
`35bfe7b21fa55cbf5a8f69d28f8cbba664581cce29a57b548e69013d14470ec3`.
Integrity ok, no foreign-key violations; 297,235 events, 3 devices, 386 assessments.

Schema additions only (`curated_*`, `catalog_*`). Image-only rollback:
`kamal rollback owntube-lead-settings-20261115-1 -c deploy/deploy.yml`. The previous
image ignores the new tables; keep the data volume. Then set the TV's `local`
preference back on only if a Mac server and tunnel are running.

## Follow-up: `owntube-curated-nav-20261120-1`

Source `e494abaef` adds the **Curated** link to the Languages and Connect device
navigation (previously only History linked it). Frontend only: the server binary
is byte-identical to the Home feed release. Healthy handover without downtime;
public pages serve the new link. Rollback: `kamal rollback owntube-home-feed-20261119-1 -c deploy/deploy.yml`.

## Follow-up: `owntube-deepseek-key-20261120-1`

Source `45c8db2b9`. Fixes a frozen Home: with the mix enabled, refreshes waited for
the mix to publish, and while it could not run (no key) Home stayed on version 42.
Refreshes now publish directly unless the mix can run now, and a failed mix still
publishes a newer source. Owners can save a DeepSeek key in Curated (verified with
DeepSeek, stored 0600 as `DATA_DIR/deepseek-api-key`, never returned; included in
volume backups). `DEEPSEEK_API_KEY` is restored in `deploy.yml` from `.env` and takes
precedence. A configured key lifts the stale missing-key pause. 77 Rust and 9 JS
tests passed; candidate matched the previous image except timestamps; healthy
handover. Backup `before-owntube-deepseek-key-20261120-1`, SHA-256
`62c4a918d8a61c3a0b037f294fbdf490b7cd8233d125be17b539d1af57a5ebd3`.
Rollback: `kamal rollback owntube-curated-nav-20261120-1 -c deploy/deploy.yml`.
YouTube still bot-checks per-video lookups from hserver, so expect few matches.

The former local data is retained at `~/.local/state/owntube-home/data` on the Mac.

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

## Current review release

`owntube-review-20261113-1`, source commit `457e90e82`, is live. It groups Languages
by video, automatically interprets saved selected-audio labels for unreviewed
records, and supports audited device playback-context corrections. The authorized
TV OwnTube foreground override is active for existing and future playback.

The actual AMD64 image passed production-copy grouping/time/evidence checks and
browser verification before the Kamal handover; public HTTPS verification passed
after deployment. The new online backup and all 12 saved language assessments
were preserved. Image, backup, activation and rollback details are in
[`server/README.md`](../server/README.md#current-release-owntube-review-20261113-1).

## Previous History release

`owntube-history-20261113-1`, source commit `9fe9556a4`, is live at the root.
The server-built AMD64 image passed an isolated fresh-production-copy comparison
before `kamal app boot -c deploy/deploy.yml --version owntube-history-20261113-1`.
Public browser checks and six frozen scope baselines passed after handover.
The new online backup preserves the 12 existing language assessments as well as
all original collector records and credentials. Exact image, backup, verification
and rollback records are in
[`server/README.md`](../server/README.md#previous-release-owntube-history-20261113-1).

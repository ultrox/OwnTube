# Deployment

Run container builds from the OwnTube repository root:

```sh
docker build -f deploy/Dockerfile -t youtube-observer:local .
```

The image includes the Rust server, built history UI and Languages module. Android and the Chrome
extension are separate artifacts. The curation design preview is not included.

## Local container check

```sh
cd server
pnpm check:docker
```

This creates a disposable container and volume, verifies non-root execution,
login and persistence across container recreation, then removes its own resources.

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

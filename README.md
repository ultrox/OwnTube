# OwnTube

**Your feed. Your rules.**

OwnTube brings the TV app, Chrome collector, server, and web backoffice into one
repository. Each component uses its own normal build tools and dependencies.

| Directory | Responsibility |
| --- | --- |
| [`apps/android/`](apps/android/README.md) | SmartTube-derived native TV app, Gradle modules, and pinned upstream submodules |
| [`apps/chrome-extension/`](apps/chrome-extension/README.md) | Browser playback collector and durable upload queue |
| [`apps/backoffice/`](apps/backoffice/README.md) | Live History/Searches, independent Languages, and the curation design preview |
| [`server/`](server/README.md) | Rust HTTP API, SQLite storage/migrations, authentication, integration checks |
| [`contracts/`](contracts/README.md) | Cross-client API documentation and compatibility boundaries |
| [`deploy/`](deploy/README.md) | Container build and deployment configuration |
| [`scripts/`](scripts/) | Small cross-component development and maintenance commands |
| [`docs/`](docs/) | Architecture, migration notes, and product/design decisions |

Playback tracking works today. Feed control is the next feature; the design preview
uses local example data and does not publish rules to a TV. OwnTube 2 remains a
separate prototype until a deliberate future import.

## Local development

Requirements: Node 22+, pnpm 10, Rust/Cargo. Android additionally needs JDK 17
and Android SDK 34. Initialize the pinned Android submodules:

```sh
git submodule update --init --recursive
pnpm --dir apps/backoffice install --frozen-lockfile
pnpm --dir apps/chrome-extension install --frozen-lockfile
./scripts/build-web.sh
cd server
cargo run --locked
```

Open <http://127.0.0.1:3210>. The local owner key is generated in
`server/data/admin-token`. Local development starts with its own empty database.
Load `apps/chrome-extension/dist/` as an unpacked extension in a disposable Chrome
profile for development. Existing installed collectors retain their own pairing
and queue; changing an unpacked extension's directory can change its identity.

### History and Searches

The root opens the live History desk; `/#/history/searches` shows all saved
searches with pagination and filtering. Totals follow period/person/device scope;
text filters only narrow the list. The original dashboard and device management
remain at `/legacy/`.

### Backoffice design preview

```sh
pnpm --dir apps/backoffice preview:design
```

Open <http://127.0.0.1:4187>. This independently styled prototype is separate from
the live History desk and server build.

### Languages module

The live-data language review page is served at
<http://127.0.0.1:3210/modules/languages/> after building the backoffice and
starting the server. It uses the same owner login, with independently scoped
totals, video/evidence review, persisted manual classifications, and optional
analysis providers. [Module details](docs/languages-module.md).

Production: <https://ytdash.gromobran.com/modules/languages/>. Use the existing
owner login; this page reads actual viewing records.

### Android

```sh
cd apps/android
ANDROID_HOME=/path/to/android-sdk ./gradlew :owntube:testDebugUnitTest :smarttubetv:assembleStownRelease
```

OwnTube's package is `com.ultrox.owntube`. Signed APKs appear under
`apps/android/smarttubetv/build/outputs/apk/stown/release/`.
The ignored `apps/android/keystore.properties` uses the existing signing identity.
See [Android tracking and upstream maintenance](apps/android/owntube/README.md).

### Checks

```sh
./scripts/check-web.sh        # Builds both web components; Rust + extension unit tests
./scripts/check-web.sh --e2e  # Also runs the isolated Chrome → server → history checks
```

Browser checks require Chromium with extension loading enabled; set `CHROME_BIN`
or use an installed Playwright Chrome-for-Testing build. No production credentials
or viewing database are needed.

For the Android-to-server HTTP contract check, first build the server binary:

```sh
cd server
cargo build --locked
cd ../apps/android
python3 owntube/test-observer.py ../../server/target/debug/youtube-observer
```

## Architecture and provenance

- [Component boundaries](docs/architecture.md)
- [Repository migration](docs/repository-migration.md)
- [Backoffice scope](docs/backoffice-brief.md)
- [Deployment](deploy/README.md)

The Android app retains its SmartTube history and credits. The server, history
dashboard, and extension were imported from `ultrox/marko-extentions` at
`2439d97`. Existing protocol names and operational service identities are retained
for compatibility.

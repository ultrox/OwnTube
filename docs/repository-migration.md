# Repository organization — 2026-11-13

## Sources

- Android: OwnTube `09bf1ee5e`, moved as a unit into `apps/android/`.
- Observer: `ultrox/marko-extentions` `2439d97`, imported from its
  `youtube-observer/` directory.
- Browser test helper: `foundation/tooling/browser.mjs` from the same source
  revision, now `server/tests/support/browser.mjs`.

Only tracked Observer source files were imported. Runtime databases, owner/device
keys, build output, dependency folders, and historical backups were not imported.
The Android project's existing ignored signing configuration and build directories
moved with the Android project.

## Mapping

| Previous location | Current location |
| --- | --- |
| OwnTube root Gradle project and Android modules | `apps/android/` |
| `youtube-observer/src`, `Cargo.toml`, `Cargo.lock` | `server/` |
| `youtube-observer/dashboard/` | `apps/backoffice/history/` |
| `youtube-observer/extension/` | `apps/chrome-extension/src/` |
| `youtube-observer/tests/*.test.mjs` | `apps/chrome-extension/tests/` |
| `youtube-observer/tests/e2e`, `tests/fixtures` | `server/tests/` |
| `youtube-observer/tooling/` | `server/tooling/` |
| Dockerfile, Compose, deployment config | `deploy/` |
| Observer product brief | `docs/observer-original-brief.md` |

The combined web/extension build script was split into component-owned scripts.
The new manifests and lockfiles are independent; no pnpm workspace is required.
Integration-test imports now point within OwnTube. Android CI paths and the
branding helper follow the new Android directory.

## Cutover boundary

OwnTube is the new development home for the imported components. The original
`marko-extentions/youtube-observer` checkout is retained as the pre-migration
reference; it was not deleted or modified during this import. Do future feature
work here, and retire the old copy deliberately after release cutover.

This work does not deploy a server, move production data, install a new extension,
or update the TV. The live domain, API paths, binary name, keys, schema behavior,
and production volume names are retained. Historical release paths in
`server/README.md` describe actual past deployments and remain accurate as history.

The Compose project name is explicitly `youtube-observer`, matching its old
directory-derived default. Anyone who used a custom `COMPOSE_PROJECT_NAME` or
`-p` must continue to use that same name to select their existing volume.

## Verification

Checked from the new locations on 2026-11-13:

- Android: 45 unit regressions passed; the separate live HTTP contract test against
  a disposable local server passed. All four signed release APKs built and passed
  `apksigner verify`. The existing signing-key path still resolves.
- Extension: bundle built; all 26 Node tests passed using the source baseline's
  esbuild and fake-indexeddb versions.
- History UI: Elm production build passed.
- Server: 16 Rust tests passed; the production-copy parity test remains opt-in
  and was skipped. `cargo fmt --check` passed.
- Both Chrome/server/history end-to-end tests passed, including offline queues,
  lost acknowledgements, restarts, pairing, and independent dashboard scopes.
- Docker: local ARM64 image built; its smoke check passed login, static assets,
  non-root runtime, and persistence after recreation. The builder uses Debian's
  Elm compiler and skips npm's incompatible Linux ARM64 installer.
- Compose configuration parsed successfully. Both Android submodule worktrees
  remain clean at their original pinned commits.

Production deployment, signed-in Chrome migration, and on-device installation
were not part of these checks.

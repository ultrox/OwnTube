# OwnTube component boundaries

This is a directory-organized monorepo. Gradle builds Android, Cargo builds the
server, and each web component has its own package manifest and lockfile. There is
no root package workspace, cross-language build graph, or generated client layer.

## Components

**Android (`apps/android`)** retains the complete upstream project layout within
one directory. OwnTube-specific tracking lives in its `owntube` library. The two
Git submodules remain pinned and unmodified. Playback resolution and streaming
stay in the app; the server does not proxy media.

**Chrome extension (`apps/chrome-extension`)** captures playback and sends durable
cumulative records. It owns its Manifest V3 bundle, permissions, storage, and unit
tests. It calls the server over HTTP; it imports no server or web UI implementation.

**Server (`server`)** owns authentication, paired devices, SQLite migrations,
viewing records, and the HTTP API. Cross-component browser tests live here and
exercise the actual extension and history UI against a disposable local database.
The historical executable name `youtube-observer` remains for operational
compatibility.

**Backoffice (`apps/backoffice`)** owns the web UI. The existing Elm history UI and
the new curation design have separate sources and styling. The production build
serves the history UI and the independent Languages module at
`/modules/languages/`; the broader curation preview runs independently with local data.

**Languages** owns its UI, filters, API and append-only assessment table. Corrections
target one recorded metadata version on one device; they do not rewrite evidence
or the global History read model. Saved-audio-metadata analysis and an optional
external provider produce estimates, with manual review protected from automation.
See [module details](languages-module.md).

**Contracts (`contracts`)** documents public cross-client behavior. It does not
share UI widgets, player models, Rust storage types, or generated code among clients.

**Deploy (`deploy`)** assembles server and backoffice artifacts into an image.
Browser extension and Android artifacts are built separately. Existing hostname,
service, and volume names remain explicit deployment settings.

## Next feed-control slice

One personal configuration for Marko: suggestions and explicit blocks, preview,
then publishing to OwnTube Home. Rule precedence needs a decision before real feed
enforcement: the original plan gives hard blocks priority, while the approved
interactive preview implements specific rules overriding general rules.
The future feed contract should be reusable by OwnTube 2 without importing
SmartTube or player internals.

Viewing records are not recommendation impressions. Candidate retrieval, displayed
cards, and curation decisions need their own records when implemented. AI policy,
custom training, viewer profiles, and media caching remain open design work.

## Upstream maintenance

Preserve the Android subtree layout and make OwnTube-specific integration changes
small. Git retains the original history and detects the directory move. Upstream
merges require review of renamed/new Android paths, `.gitmodules`, workflows, and
root README/license changes; do not accept upstream files back into the monorepo
root blindly. `scripts/sync-upstream.sh --check` performs a dry merge analysis
from a clean committed tree before the real merge.

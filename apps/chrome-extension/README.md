# OwnTube Chrome collector

`src/` owns the Manifest V3 collector, popup, pairing UI, capture logic, and durable
IndexedDB outbox. `tests/` verifies capture and delivery behavior.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Load this directory's `dist/` using Chrome's **Load unpacked**. Use a disposable
profile for development; a changed extension path may create a different extension
identity rather than updating an existing collector.

Pair to the local server or the existing production origin through **Server &
pairing**. The manifest identity, permissions, database names, and wire protocol
are carried over from Observer. This migration introduces no feed filtering.

End-to-end checks belong to `../../server/tests/e2e/`; run
`../../scripts/check-web.sh --e2e` from here.

## Selected audio (0.2.1)

`language-v3` reads the selected audio track, including YouTube's encoded track
IDs and nested original/dub metadata. Default audio, captions and text do not
substitute for an unresolved selection. Their original values remain in evidence.
Search text classification is separate.

For the existing Chrome installation, 0.2.1 is staged at its original path:
`/Users/marko/code/marko-extentions/youtube-observer/extension/dist`.
Reload **YouTube Observer** in `chrome://extensions`, then refresh YouTube tabs.
Do not remove/re-add the extension: the existing identity retains its pairing
and durable queue. Staging files does not reload an already-running extension.
Prior generated files are backed up at
`~/.local/state/youtube-observer/backups/extension-before-selected-audio-20261113/`.

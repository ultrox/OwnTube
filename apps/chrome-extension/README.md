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

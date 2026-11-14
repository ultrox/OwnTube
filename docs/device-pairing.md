# Short-code browser pairing

Chrome 0.3.0 opens a dedicated setup tab from the unpaired popup. **Connect**
requests host access inside the click gesture, then displays an eight-character
code. The default origin is `https://ytdash.gromobran.com`.

The owner opens `/connect/` (linked from History and Languages), signs in if needed,
enters the code, chooses an existing person or adds a name, and approves.
The setup tab polls every five seconds; the existing thirty-second upload alarm
also resumes pending setup. The browser saves its connection automatically.

## Authentication and storage

- Before contacting the server, the extension persists a cryptographically random
  256-bit secret in IndexedDB's settings. A worker restart or lost HTTP response
  retains this secret. The UI and status messages never expose it.
- `POST /api/pairing/start` uses the 64-hex secret as a bearer credential and
  returns `{state:"pending",code,expiresAt,pollAfter:5}`. Repeated starts with
  the same secret return the same pending request or approved device.
- Codes use eight characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, displayed
  `ABCD-EFGH`, and expire after ten minutes. Case, whitespace and hyphens are
  ignored by approval. New starts remove expired request rows. Starts are bounded
  globally to twenty new requests per minute and one hundred retained rows.
- SQLite's `pairing_requests` stores only the secret's hash, code, timestamps,
  and approved device ID. This is an additive table.
- `GET /api/pairing` returns people only to an authenticated owner.
- `POST /api/pairing/approve` requires owner authentication and JSON
  `{code,label,person}`. `person` is an existing ID or a new name; both person and
  label are required. Person creation, device creation and approval share one
  transaction. Retrying an approved, unexpired code returns the same device.
- `POST /api/pairing/status` requires the browser secret, not the short code.
  It returns pending, expired, or approved device identity. Approved browsers can
  recover after request cleanup using the hash already stored on their device.
- Pending secrets cannot ingest. After approval the same secret authenticates
  the new device; no owner credential is transferred to the extension.
- Pairing responses are `no-store`; extension requests omit cookies, reject
  redirects and use a fifteen-second timeout.

## Recovery and existing browsers

Offline and lost-response attempts retain the pending secret and retry. Expired
codes can be replaced from setup. Owner retries cannot create duplicate devices.
Existing configurations bypass short-code setup. Applying approval conditionally
checks configuration in the same IndexedDB transaction, preserving a connection
that was manually configured while polling. Existing queued records remain under
the outbox's device-switch protections.

Advanced setup accepts HTTPS origins or loopback HTTP and existing device keys.
Updating an unpacked extension in place preserves its identity, IndexedDB queue,
and credentials. Removing/reinstalling or moving its directory can change that
identity; the ZIP's installation guide explains the in-place update.

## Verification

`pnpm test` in `apps/chrome-extension` covers durable secrets, lost replies,
restart, expiry, offline retries, concurrent manual setup, and origin validation.
`cargo test --locked pairing::` in `server` covers transaction rollback, concurrent
approval, recovery after cleanup, request limits and authorization.
`pnpm test:e2e` in `server` runs isolated Chromium against disposable databases,
including short-code setup, owner login/new person, expiry, worker restart,
automatic connection and real content-script playback upload. The older pipeline
also exercises advanced key setup, durable queues and backend restarts.

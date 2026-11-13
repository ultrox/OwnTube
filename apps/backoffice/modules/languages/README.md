# Languages module

Watch time by the language of the **audio that actually played**, background included, with
review, manual classification, saved-evidence analysis, reset and an append-only audit. A
standalone page in the approved backoffice design, served at `/modules/languages/` and using the
owner session cookie. Contract: [`contracts/languages.md`](../../../../contracts/languages.md).
Design notes: [`docs/backoffice-design.md`](../../../../docs/backoffice-design.md) §14.

| File | Role |
| --- | --- |
| `index.html`, `languages.css` | Page shell and styles. Self-contained; no fonts or files from elsewhere. |
| `languages.js` | The UI (ES module): sign-in, scope, language table, review list, inspector. |
| `api.js` | Live adapter: same-origin `fetch` with the owner cookie, `{error}` → `ApiError`. |
| `demo.js` | Demo adapter: the same contract in memory with fictional data. Loaded **only** for `?demo=1`. |
| `check.mjs` | Behaviour check (mock contract or live local server). Not shipped. |
| `tests/seed-dev.mjs` | Seeds fictional fixtures into a local dev server through the real APIs. Not shipped. |

The build copies `*.html|css|js|svg|woff2` to `dist/modules/languages/` and skips `tests/` and
`.mjs` scripts.

## Modes

- **Live** (`/modules/languages/`): checks `GET /api/session`; without a session it shows its own
  sign-in (`POST /api/login {token}`, cookie scoped to `/api`). Nothing is cached or invented. If an
  API call fails, it shows the server's `{error}` with *Try again*, never sample data.
- **Demo** (`?demo=1`): a permanent "Demo · sample data" strip and "Demo data" in every scope line.
  It makes no `/api` requests, and corrections reset on reload. The design preview links here through
  its `modules → ../modules` symlink, so both use the same files.

## Behaviour that matters

- **Scope vs rows.** Period (7/30/90), device and person set every number in the ledger and the
  language table. Language, status (all/review/confirmed/estimated) and search only narrow the
  video rows, which come 20 per page. All filters live in the URL hash.
- **Not one spoken language.** `mul` (mixed), `zxx` (no speech) and `und` (unknown) are listed
  apart from spoken languages. Unknown is marked as needing a decision.
- **One row = one recorded version on one device.** A classification applies to every play of that
  exact metadata version on that device, never to other devices, dubs or versions. The inspector
  says so above the form.
- **Decisions:**
  - Manual classification sends `baseRevision`, `lang` and an optional note. It is shown as
    *Confirmed*, or as undetermined for `und`, with confidence "human".
  - *Analyze* uses only the selected-audio language label saved in the evidence. A missing label
    stays unknown; default audio, titles and caption lists are never used to infer it. It is
    disabled while a manual classification stands (source `manual`), because analysis never
    overwrites one.
  - When the server advertises more than `saved-evidence` in `providers`, a source selector appears.
    The external choice states that only saved evidence is sent, no media or keys. Every analysis
    result is labelled an estimate.
  - *Reset to collector* is audited too.
- **Conflicts.** A 409 (stale revision, or analysis refused) shows the server's message and
  *Refresh this version*. Your note survives the refresh.
- **Evidence.**
  - The saved title and description, audio fields (Android's selected audio is a decoder label),
    caption tracks (never a transcript), text detector, and the raw snapshot.
  - The raw snapshot shows the exact `evidenceText`, its SHA-256 re-checked against `evidenceId`
    in the browser, and a labelled re-encoded view.
  - The audit history shows the latest entries, newest first, and says when older ones are kept
    (`historyHasMore`).
- **Context naming.** The contract doesn't say whether a device is a browser or a TV, so the module
  writes "on-tab/foreground". It switches to "on-tab" or "foreground" automatically if `devices[]`
  gains `kind: "browser" | "tv"`.
- **Thumbnails.** Live mode loads `i.ytimg.com/vi/<id>/mqdefault.jpg` without a referrer. If the
  image fails, the video ID shows instead.

## Check

```sh
node apps/backoffice/modules/languages/check.mjs
node apps/backoffice/modules/languages/check.mjs --live http://127.0.0.1:3211 --token-file <admin-token>
```

- **Mock (47 assertions).** An in-process mock of the contract on an ephemeral loopback port, with
  auth, recorded requests and injected failures, drives the real `api.js` in isolated headless
  Chromium. It covers:
  - the sign-in gate and wrong key
  - exact request parameters, and that filters never change scope numbers
  - paging and URL state
  - the inspector request scope and the exact manual body
  - the analysis lock, reset, provider choice and stale 409 → refresh
  - a server error and retry, and session expiry
  - hostile titles, reasons, notes and evidence rendering as text
  - the phone layout, and demo labelling with zero API calls
- **Live (14).** Requires a loopback URL. It runs the same UI against a real local server seeded
  with `tests/seed-dev.mjs`:
  - the ledger and rows match the API
  - exact evidence text and digest
  - saved-evidence analysis, a real 409, and a manual classification with its note
  - the analysis lock
  - the other device's copy unchanged

  These are real, audited actions.
- Chromium blocks all non-loopback hosts during checks. Screenshots go to `$OWNTUBE_CHECK_OUT` or
  `<tmp>/owntube-languages-check`.

## Seed a local dev server

```sh
node apps/backoffice/modules/languages/tests/seed-dev.mjs http://127.0.0.1:3211 <path-to-admin-token>
```

This creates the people Owner and Guest, three devices (Living room TV, Bedroom TV, Laptop), and 19
fictional recorded versions (IDs `fx…`) through `/api/people`, `/api/devices` and `/api/ingest`. The
data covers German, English, Serbian (Latin and Cyrillic), French and Japanese; undetermined Android
records; a German dub on the TV of a video that played in English on the laptop; background-only
and unspecified-only context; plays without snapshots; and one record with hostile title and
evidence text. Loopback only; it never prints keys.

# Languages module

Watch time by the language of the **audio that actually played**, background included, with
review, manual classification, saved-evidence analysis, reset and an append-only audit. A
standalone page in the approved backoffice design, served at `/modules/languages/` and using the
owner session cookie. Contract: [`contracts/languages.md`](../../../../contracts/languages.md).
Design notes: [`docs/backoffice-design.md`](../../../../docs/backoffice-design.md) §14.

| File | Role |
| --- | --- |
| `index.html`, `languages.css` | Page shell and styles. Self-contained; no fonts or files from elsewhere. |
| `languages.js` | The UI (ES module): sign-in, scope, language table, one row per video, the video inspector. |
| `api.js` | Live adapter: same-origin `fetch` with the owner cookie; `{error}` and unreadable answers → `ApiError`. |
| `demo.js` | Demo adapter: the same contract (video groups and bulk decisions included) in memory with fictional data. Loaded **only** for `?demo=1`; the check's mock serves it too. |
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
  rows, which come 20 videos per page. All filters live in the URL hash.
- **Not one spoken language.** `mul` (mixed), `zxx` (no speech) and `und` (unknown) are listed
  apart from spoken languages. Unknown is marked as needing a decision.
- **One row = one video** (`group=video`), with every recorded version of it in the period, device
  and person scope.
  - **Time:** the row's watched time and context are the sum over all its versions.
  - **Meta:** it names every device the versions played on and, when there is more than one,
    "N recorded versions".
  - **Filters:** a filter keeps a whole video when any of its versions matches, and says "2 of 7
    versions match".
  - **Language line:** the shared language and status, with a quiet note of where it comes from
    ("from the selected audio track", "collector, from captions", "your classification").
  - **Disagreement:** when versions disagree, the row says **Mixed** with quiet counts ("German ×2 ·
    Unknown ×2"), never one confident language. When every version says the audio is mixed, it
    reads "Mixed languages" (`mul`).
- **Starting estimates.** Without an explicit decision, a version whose saved evidence names the
  selected audio language starts as that language, *Estimated* with high confidence, and needs no
  review. Otherwise it starts from the collector's estimate.
- **Decisions, in the inspector of one video:**
  - Rows offer **? / DE / EN / BCS** for immediate audited classification of every
    recorded version in that row's scope. `?` explicitly marks the language unknown;
    BCS means Bosnian / Croatian / Serbian (`bcs`). The saved choice is highlighted.
    Pending saves disable the row's buttons; failures stay inline, with Refresh.
  - The form opens on the existing manual choice, or else the most-watched known language. One
    *Save* or *Reset* covers **all N recorded versions in this scope**.
  - The inspector footer says **Close** until the language or note is edited, then
    **Save & close**. It saves using the selected target and closes only on success.
  - That is one atomic request, `POST /api/modules/languages/assessment/bulk`, listing every version
    with its expected revision. If any version changed meanwhile, the server refuses it (409),
    nothing is saved, and *Refresh this video* re-reads the group; your note survives.
  - Versions recorded later start from their own evidence.
  - When versions name different known audio languages (a possible dub), the inspector says so.
    It compares their interpretations, else the collector's recorded values, and then says the
    difference is the collector's. Unknown never counts: `und`, empty, the collector's `other` and
    malformed codes, read like the server's `language()`. *Apply to: Selected version only* then
    uses the per-version endpoint instead.
  - Manual decisions show as *Confirmed* (or undetermined for `und`) with confidence "human".
  - *Reset* restores the collector's original interpretation and is audited.
- **The selected version.** A quiet picker lists the versions, newest first, and opens on the
  newest. For the selected version the inspector shows:
  - its own interpretation and recorded value;
  - *Analyze saved evidence* (selected-audio label only; never across versions, and disabled while a
    manual decision stands);
  - its audit;
  - its exact saved evidence.

  After a save the same version stays selected. When the server advertises more than
  `saved-evidence`, a provider selector appears, and the external choice states that only saved
  evidence is sent.
- **Evidence.**
  - The saved title and description, audio fields (Android's selected audio is a decoder label),
    caption tracks (never a transcript), text detector, and the raw snapshot.
  - The raw snapshot shows the exact `evidenceText`, its SHA-256 re-checked against `evidenceId`
    in the browser, and a labelled re-encoded view. A result only lands in an inspector still
    showing that exact snapshot.
  - The audit history shows the latest entries, newest first, and says when older ones are kept
    (`historyHasMore`).
- **Context.**
  - When a device has an owner context correction (`contextOverride`), the inspector notes it
    quietly ("Playback on TV counts as foreground (owner correction, date): reason").
  - The contract doesn't carry device kinds, so context reads "on-tab/foreground".
- **Robust reading.** An empty or unreadable successful answer is an error, never zero. A server
  that ignores `group=video` still works: each version is shown as its own row.
- **Thumbnails.** Live mode loads `i.ytimg.com/vi/<id>/mqdefault.jpg` without a referrer. If the
  image fails, the video ID shows instead.

## Check

```sh
node apps/backoffice/modules/languages/check.mjs
node apps/backoffice/modules/languages/check.mjs --live http://127.0.0.1:3211 --token-file <admin-token>
```

- **Mock.** An in-process mock of the contract, served by `demo.js` on an ephemeral
  loopback port with auth, recorded requests and injected failures, drives the real `api.js` in
  isolated headless Chromium. It covers:
  - the sign-in gate and wrong key; exact request parameters (`group=video`); filters never change
    scope numbers;
  - one video with 17 versions as one row with summed time;
  - 20 videos per page however many versions they hold, with page 2 continuing without repeats;
  - Mixed rows and a partially matching filter;
  - versions whose selected audio says English reading "English · Estimated" with no review;
  - the newest version's evidence first, and another version on request;
  - one atomic bulk request with every expected revision, and the selected version kept after
    saving;
  - a stale version refusing the whole decision (nothing saved), refresh, and saving again;
  - "Selected version only" for a dub; the dub warning when only the collector's recorded audio
    still differs, and none for the collector's unknown (`other`) beside known English;
  - the single-version flow (exact body, analysis lock, reset to the collector, analysis of the
    selected version); provider choice;
  - errors and expiry; hostile text, including an older version's title in the picker;
  - quick language choices, audit/evidence preservation, stale revisions, duplicate clicks,
    save failures, filtered-row removal, and inspector Save & close for both targets;
  - a server without grouping;
  - long names at 390 px, the phone layout, and demo labelling with zero API calls.
- **Live.** Requires a loopback URL. It runs the same UI against a real local server seeded
  with `tests/seed-dev.mjs` and the History desk's fictional fixtures:
  - ledger and video groups match the API;
  - a fictional two-version video: one decision on both, a real stale-version 409 with nothing
    saved, then a reset of both;
  - the cross-device dub: exact evidence and digest, the selected version alone, the analysis lock,
    and the other device's version unchanged.

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

# History desk

The backoffice root (`/`): **History · Watched** (`#/history`) and **History · Searches**
(`#/history/searches`) on live data, in the approved design. Contract:
[`contracts/history.md`](../../../contracts/history.md). Design notes:
[`docs/backoffice-design.md`](../../../docs/backoffice-design.md) §15.

The masthead links to **Languages** (`modules/languages/`) and to the **legacy** Elm dashboard
(`legacy/`), which keeps device management and pairing. The side note also links to
`diagnostics.html` and `android-integration.html`. There are no curation controls yet.

| File | Role |
| --- | --- |
| `index.html`, `desk.css` | Page shell and styles. Self-contained; same tokens and masthead as Languages. |
| `desk.js` | The UI (ES module): routes, scope, Watched, Searches, evidence inspector, own sign-in. |
| `api.js` | Live adapter: same-origin `fetch` with the owner cookie. `{error}` and unreadable answers become `ApiError`. |
| `check.mjs` | Behaviour check against a mock of the contract, or a live local server. Not shipped. |
| `tests/mock-server.mjs` | The mock: fictional fixtures, auth, recorded requests, injected delays and failures. Not shipped. |
| `tests/seed-dev.mjs` | Fictional fixture devices for a local dev server, through ingestion only. Not shipped. |

The build versions the runtime import graph: `api.js` and the shared
`../shared/recorded-versions.js` first, then `desk.js`, `desk.css` and `index.html`.
History and Languages share version identity, the picker and exact-evidence digest verification.

## Behaviour that matters

- **Live only.** There is no demo mode and no sample data. A failed request shows the server's
  `{error}` and *Try again*. A successful answer that isn't readable JSON, or lacks its `rows` and
  `daily` lists, is shown as an error, never as zero.
- **Routes and state.** Period, device and person are shared by both views and live in the hash
  (`?days&device&person`). Each view keeps its own filter text and page (`q`, `page`). Languages
  keeps its own state; History never calls it. Unknown routes open `#/history`.
- **Person and device** narrow together. The server selects their intersection, so the device list
  shows only the chosen person's devices; changing the person clears a device that isn't theirs.
  *Unassigned devices* appears when any device has no person. Revoked devices stay selectable.
- **Snapshots.** Each view pages through one server snapshot: Watched sends `generation` + `until`,
  Searches sends `before` + `until`.
  - The pair is kept when the page or the filter changes, so the scope numbers never move while you
    filter.
  - It is dropped when the period, device or person changes, and on *Refresh* (which returns to
    page 1).
  - A 410 drops it too. The list reloads page 1 from current records and says: "The saved list is no
    longer available, so this shows the current records from page 1."
- **No numbers under the wrong labels.** While a new scope loads, its loading line replaces the
  previous figures; a failed scope load shows only the problem. A slower, older answer never replaces
  a newer one, and the status line keeps describing the rows on screen until the new ones arrive.
- **Days and times are the server's.** Rows are grouped by their `date` in server order; times use
  the response's `timezone`; Today and Yesterday come from the snapshot's `until`. Day headers carry
  the whole day's totals from `daily`, say how many entries match a filter, and say when a day
  continues on another page.
- **Entries.** A native entry is one recorded viewing of a video on one device and day. Metadata
  updates stay inside the entry, with summed watch time and union coverage. Distinct visits stay
  separate. Text matches any version before paging and retains the whole entry. It shows
  its first and last recorded playback as a range (`13:02–15:20`), never a reconstructed session. A
  `legacy-day` entry reads **Recorded that day**; the inspector gives its first and latest samples.
- **Context** is named by source: *on-tab* for browsers, *foreground* for TVs, *on-tab / foreground*
  for mixed or unidentified sources; *context not recorded* when nothing was recorded.
- **Coverage:**

  | Data | Shown as |
  | --- | --- |
  | percent, complete | `80% covered` (rounded down; `<1%` above zero) |
  | `coverageComplete: false` | `at least 80% covered`; the inspector adds "some samples have no ranges" |
  | seconds without a percent | `12 min covered` |
  | neither | `coverage not recorded` |

  The thumbnail bar appears only with a percentage. It has a dotted end when partial, and is drawn in
  ink when there is no thumbnail.
- **Searches.**
  - The count covers every search in scope, and day headers use the server's daily counts.
  - The server filters all searches, not only the loaded page.
  - Capability wording:
    - `not-recorded` (a known TV scope): the count shows "—" with "not recorded on TVs", never 0.
    - `unknown`: "No searches recorded…", with no claim either way.
    - A mixed scope: the source note names which devices record searches, which record playback
      only, and which haven't been identified.
  - A known query language shows as a quiet code. It is estimated from the query text; `other`, `und`
    and empty values stay hidden.
- **Evidence inspector**, for one entry, in this order:
  1. The entry's playback context and recorded times, with the entry named precisely.
  2. A saved-version picker when needed, newest first; entry totals stay fixed while evidence changes.
     The collector's language estimate is labelled as derived. It links to that exact version in Languages,
     where corrections live.
  3. The saved source values and the text detector.
  4. The raw snapshot: the exact `evidenceText`, its SHA-256 recomputed in the browser, and a
     re-encoded "Formatted" view. A digest mismatch is shown as stored, never rewritten.

  No snapshot and invalid JSON are stated explicitly. A late answer for a closed inspector or
  previous version, including its digest, never replaces the current selection.
- **Sign-in and sign-out** use `/api/session`, `/api/login` and `/api/logout`. Sign-out completes only
  when the server confirms it (or the session is already gone); otherwise you stay signed in and see
  the error.
- **Untrusted text** (titles, channels, queries, descriptions, raw JSON) is inserted only as escaped
  text. Thumbnails come from `i.ytimg.com` without a referrer; the video ID shows if they fail.

## Check

```sh
node apps/backoffice/desk/check.mjs
node apps/backoffice/desk/check.mjs --live http://127.0.0.1:3211 --token-file <admin-token> [--dist]
```

- **Mock (105 assertions).** Headless Chromium runs in another time zone than the server, against
  `tests/mock-server.mjs`. It covers:
  - the sign-in gate;
  - exact requests, including where the snapshot pair is and isn't sent;
  - ledger and day totals; server dates across midnight; row order and context sums;
  - context naming and coverage wording; Shorts; metadata splits; legacy days;
  - paging and continuation; filters that never move the scope numbers; person and device
    intersection;
  - slow, failed and unreadable scope loads, and a stale answer arriving last;
  - Refresh, and a 410 on both views with its announcement;
  - search capability states, query languages and same-second searches;
  - independent filters with a shared scope;
  - every inspector state, including digest match and mismatch, invalid JSON, a missing snapshot,
    Android values, hostile text, an evidence failure and the late-answer race;
  - session expiry, failed and successful sign-out, links, deep links, unknown routes and the skip
    link;
  - the phone layout with long names; reads only (GET, apart from sign-in and sign-out); no page
    errors.
- **Live (24).** Loopback only. It runs against a local server seeded with `tests/seed-dev.mjs`.
  - By default this folder's files are served through a same-origin proxy, so the server's `dist`
    can be stale; `--dist` tests the server's own build.
  - It verifies that:
    - totals, rows and pages match the API;
    - the server's grouping (shared viewing IDs, metadata split, midnight split, partial coverage,
      legacy day) reaches the screen;
    - a real 410 follows one fictional upload through a seeded device key;
    - the exact evidence text matches its digest;
    - searches are filtered on the server;
    - TV and unidentified capability are reported;
    - the phone layout fits.
- Chromium blocks every non-loopback host during checks. Screenshots go to `$OWNTUBE_CHECK_OUT` or
  `<tmp>/owntube-desk-check`.

## Seed a local dev server

```sh
node apps/backoffice/desk/tests/seed-dev.mjs http://127.0.0.1:3211 <path-to-admin-token>
```

This creates three fictional devices labelled `Desk check · …`: a browser (Owner), a TV (Guest) and
an unassigned tablet with a long name. It then uploads about 250 events through `/api/ingest` only:

- viewings in 15-minute slices that share a viewing ID, on-tab and background;
- a metadata change mid-viewing and a viewing across the server's midnight;
- a slice without coverage ranges, a replay and a Short;
- hostile and long unbroken text;
- two days from an older collector (`watch` samples);
- 26 searches.

The device keys stay in a private state file (mode 600) under the OS temp directory, which the live
check reads. A second run refuses to add devices unless given `--again`. `--resume` reuses the
devices after a failed upload. The seed refuses non-loopback servers and never prints keys.

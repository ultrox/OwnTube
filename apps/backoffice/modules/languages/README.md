# Languages module

Watch time by the language of the **audio that actually played**, background included, with
review, manual classification, saved-evidence analysis, reset and an append-only audit. A
standalone page in the approved backoffice design, served at `/modules/languages/` and using the
owner session cookie. Contract: [`contracts/languages.md`](../../../../contracts/languages.md).
Design notes: [`docs/backoffice-design.md`](../../../../docs/backoffice-design.md) §14.

## Compare periods

The view answers three questions in order, for two saved period groups: which group averaged
more, whether the two groups are comparable, and what each language did.

**Setup band ("What's compared").** Each group shows its name, a summary of its saved periods,
and **+ Add period** beside **+ Add language**. **Edit names & dates** opens the name and
inclusive From/Through inputs; it opens by itself while a group has no periods, and
**+ Add period** opens it on the new range. **Save & compare** appears only when there are unsaved
changes and folds the editor away again; **Refresh** reloads the saved version (**Discard edits**
while a draft exists). Group names and all ranges are saved on the server. Multiple ranges combine
into one result per group. Repeated days count once; groups cannot share dates. Changing
device/person keeps unsaved edits. Conflicting saves retain the draft and offer an explicit reload.
While a draft is unsaved, the results below say they still show the last saved comparison.

**The lead.** One sentence names the group with the higher average ("SLN averaged 91.9 more
minutes of German a day than FREE"), followed by both rates as bars on one scale. The difference
is the hatched end of the longer bar. Neither group is treated as the baseline or as "the one
using it": the two colours identify groups and never mean better or worse.

- Every rate is minutes per selected **calendar** day, rounded to one decimal; differences are
  computed from those printed figures so they always reconcile.
- The percentage is relative to the lower daily rate and is omitted when that rate prints as 0.0.
  Only a true zero is called "none"; positive playback that rounds to 0.0 reads "<0.1" and "under
  0.1 min a day". A true zero draws no bar; a trace keeps a thin marker.
- With selected languages, a separate line gives each group's share of all watch time and names
  the group whose share is higher, in **percentage points**. That group need not be the one with
  the higher daily average. A group with no watch time at all has no share and no difference.
- Equal rates, no playback in either group and a group without periods each get their own plain
  sentence; an empty group has no average.

**Are the periods comparable?** Each group is drawn as one cell per unique selected calendar day
(a proportional bar beyond 31 days). The shorter group gets dashed cells for the days it lacks and
the heading says exactly how many more days it needs. Today is hatched because it is not over.
Days with recorded playback are given as a count beside calendar days; days without playback
still count in the daily denominator. The response has totals per group, not per day, so the
cells count days and do not show which dates had playback.

**By language.** One row per language with a bar for each group on a single shared scale, the
total time and share beside each bar, and the higher group with its difference at the end. Under
it, "share +N pts · group" names the group with the larger share for that language. Unknown,
mixed and no-speech rows come last. With exactly one selected language this section is omitted:
the lead already is that language.

**Behind the averages.** A ruled table of selected days, days with playback, watch time, context
totals and review time per group.

**Languages** is a shared saved selection for both period groups. Use **+ Add language** in either
group to search, remove a chip to exclude a language, then **Save & compare**. Results then lead
with the chosen languages combined and list each one. **Use all languages** restores the full view.
Shares stay relative to all recorded watch time; selecting two languages does not rebase their sum
to 100%. Period lengths are unchanged, and zero-watch selected languages stay visible. Suggestions
contain only assessed languages with recorded playback in either saved period group for the current
device/person scope. Saving changed periods refreshes the suggestions. The row-classification
**Other…** picker still supports the full catalog so genuinely new audio languages can be classified.

On phones the groups stay side by side in the setup band, every bar sits under its label, and
nothing scrolls sideways.

| File | Role |
| --- | --- |
| `index.html`, `languages.css` | Page shell and styles. Self-contained; no fonts or files from elsewhere. |
| `languages.js` | The UI (ES module): sign-in, scope, language table, one row per video, the video inspector. |
| `api.js` | Live adapter: same-origin `fetch` with the owner cookie; `{error}` and unreadable answers → `ApiError`. |
| `comparison.js` | Compare periods view: setup band and editor, the lead, period lengths, per-language bars, conflict handling and independent drafts. Exports its arithmetic (`rateStory`, `shareStory`, `dayGap`, `percentText`, `rangeText`) for the check. |
| `language-picker.js` | Searchable occasional-language dialog, names/codes/native names and audited row saving. |
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
  - **Open in YouTube ↗:** a direct link beside the quick language choices, also in the
    inspector, opens the video in a new tab while keeping the current filters and edits.
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
  - **Other…** opens a searchable picker (e.g. Russian/`ru`, Japanese/`ja`).
    Selecting a result saves through the same revision-checked bulk flow.
    Escape cancels and restores focus; rare languages do not become shortcuts.
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
  - Compare periods: the difference arithmetic as plain functions (including a trace baseline versus
    a true zero, and share leader versus daily-rate leader); focus after add, save, discard and
    remove; group colour contrast in both themes; saved multi-range periods, the
    folded editor, shared languages, overlap and conflict refusals, drafts across scopes; and fixed
    responses (`comparison` on `/__mock`) for unequal lengths with a partial today, the first group
    leading, a zero lower rate, equal rates, no playback, an empty group, and many languages with
    long hostile labels at 390 px;
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

# OwnTube backoffice — design

Status, November 2026. The design prototype runs at `apps/backoffice/design-preview/`
(`pnpm --dir apps/backoffice preview:design` → http://127.0.0.1:4187/), with sample data and browser
storage only. It remains the visual and behavioural spec, especially for curation.

Production pages are built from it as vanilla ES modules on the server's APIs:
- the **History desk** at `/` (§15);
- the **Languages** module at `/modules/languages/` (§14).

The previous Elm dashboard stays at `/legacy/` for device management and pairing.

## 1. What it is for

One owner (Marko) decides what the OwnTube TV shows. **Curation is the main job:** suggest videos,
channels and playlists; block videos and channels; check the result; publish it deliberately.
**History** is a sibling view, there to act on what actually played, with a small set of honest
numbers. AI curation is planned but does not exist, so the UI does not pretend it does (§10).

## 2. What it replaces

History now reads the server. The History desk (§15) is the backoffice root, and the ytdash
(Observer) dashboard has moved to `/legacy/`. Device management stays there until a **Devices** page
replaces it. **The server and its APIs stay**:
- ingestion and receipts;
- cumulative viewing records and evidence snapshots;
- device keys and pairing (`GET /api/device`);
- diagnostics (`/api/diagnostics`, `/api/metrics/client`).

Only the screens change. History had to reach parity on these:

| Required | In the backoffice |
| --- | --- |
| What played, watch time, distinct videos, average per calendar day, 7/30/90 days, per device | History · Watched, its ledger and day totals (§8, §15) |
| Background playback, never hidden | Every entry shows its foreground/on-tab vs background split, with unspecified kept separate. The ledger has one split sentence for the period (§8, §15). |
| Past YouTube searches | History · Searches (§8, §15). Browsers record searches. Known TVs say "not recorded", and unidentified devices make no claim. |
| Evidence behind a watched video | The **Evidence** inspector on every entry (§8a, §15). |
| Languages breakdown | The **Languages** module (§14). It goes further than ytdash: review, manual classification, saved-evidence analysis and an audit. |

Not carried over yet, by decision rather than oversight: Videos/Shorts share, completed viewings,
person cards, collector-delivery view. Each remains available from the server;
bring one back only when a curation decision needs it, as a list or a sentence, not a chart. Device
management becomes a plain **Devices** page when pairing moves into the backoffice.
`/diagnostics.html` stays as is.

## 3. Art direction: a desk and a monitor

ytdash is what this deliberately is not: Space Grotesk and Inter, coral on navy, rows of metric
tiles, donut charts, and cards inside cards, all at the same weight. The backoffice has two surfaces
that never mix:

- **The desk** (light neutral, optional dark) is where editing happens. It is typeset like a
  newspaper page or a TV listings column: hairline rules instead of boxes, a strong rule under
  section heads, generous text, no shadows except on overlays.
- **The monitor** (dark) is the TV. It uses OwnTube's real TV palette, `#0F171F` with the mint
  `#52E8BA` from the app icon, and a TV-like sans. Dark here always means "what the TV will show".

Editing borrows from proofreading and tracked changes. Anything changed since the published
revision gets an ochre **change bar** in the margin. Removals stay visible as **struck "ghost" rows**
until published. Every change can be reverted on its own. Broadcast vocabulary appears only where it
is useful: Draft vs Published is a vision mixer's Preview vs Program, revisions are numbered (r14),
and the TV preview moves with arrow keys like a remote.

Deliberately absent: gradients, purple or "AI" branding, card grids, giant hero copy, decorative
pills, metric tiles, charts.

## 4. Typography

| Role | Face (prototype) | Why |
| --- | --- | --- |
| Content: titles, notes, headings, figures | **Charter** | Sturdy at 12–17 px (it was drawn for low-resolution output), compact enough to keep long YouTube titles to two lines, with real italics for the owner's notes. Apple's Charter covers German, Serbian Latin and Serbian Cyrillic (checked against `ЂђЋћЏџЉљЊњ`, `ČćĐđŠšŽž`, `äöüß`). |
| Controls | system UI | Native, crisp, no download; the identity comes from content and data type. |
| Data: IDs, durations, times, revisions, labels | **PT Mono** | Tabular figures, Cyrillic, arrows; it reads as "the system speaking". |
| The TV | Roboto → system sans | Matches the Android TV app, so the monitor looks like the TV rather than the desk. |

Every title carries the `lang` of its original language (`de`, `sr-Cyrl`, …) for correct shaping,
hyphenation and screen-reader pronunciation. For production, self-host OFL equivalents (Charis SIL or
XCharter for Charter, PT Mono), subsetted to Latin Extended and Cyrillic. Ledger figures use Charter
lining tabular numerals at 31 px with 14 px units ("4 h 50 min"), so figures dominate and units recede.

## 5. Colour

Only three accent colours exist, and each means one thing. Each always comes with a glyph and words,
never colour alone.

| Mark | Light | Dark | Meaning |
| --- | --- | --- | --- |
| Suggest (teal) `+` | `#0A6B58` (5.6:1) | `#4FD0AD` | on the TV because you said so |
| Block (vermilion) `⊘` | `#B3341C` (5.3:1) | `#FF8466` | kept off the TV |
| Change (ochre) bar | `#A97800` bars (3.4:1), `#7A5600` text (5.8:1) | `#D9A22E` / `#E6B450` | edited, not yet published |

Desk: paper `#EFEFEB` (neutral, not cream), ink `#171816` (15.5:1), secondary ink 7.3:1, tertiary 4.6:1,
control borders 3.1:1. Every text pair meets WCAG AA in both themes. The change signs in the publish
sheet are coloured by their *effect on the TV*: teal = appears, vermilion = disappears, ochre = moves
or note.

## 6. Layout and states

**Header:** brand · Curation / History (plus *On the TV* below 1180 px) · draft status
("Draft · 4 changes") and **Review & publish**. A dark strip above it always says this is a
local prototype with sample data.

**Curation, ≥ 1180 px:** three columns.
1. Index: *Add by link* plus the five lists with counts and change bars.
2. The working list. Ordered lists show the TV order as `01, 02…`.
3. *On the TV*: Draft or Published, *Show hidden*, Full screen.

At 860–1179 px the TV becomes its own tab. Below 860 px it's one column: index → list drill-down,
a `⋯` per row opening a bottom sheet with every action, and a sticky bottom bar when there are
unpublished changes.

**History:** a *Watched / Searches* switch sits under the heading. These are link tabs
(`#/history`, `#/history/searches`), deep-linkable and above the filters on phones too. The filters
are text filter, Device (grouped "TVs · playback only" and "Chrome · playback and searches") and
Period. Each view opens with its ledger.

- **Watched** groups plays by calendar day. Each play has a mono time, a thumbnail with a coverage
  bar, watched time with its context line ("9 min on-tab · 2 min background", "all foreground",
  "context not recorded"), coverage, curation marks, and *Suggest* / *Block channel* / *Evidence*.
- **Searches** lists time · query · device and source, grouped the same way.

| Thing | States the prototype shows |
| --- | --- |
| Draft | clean ("Published r14 · 2 days ago" + Revisions) · changed (count, bars, publish) |
| List row | normal · changed (bar + "Moved 5 → 3 in draft · Revert") · ghost (struck) · note editing · override ("Shown although X is blocked") · details not looked up |
| TV card | shown · changed (ochre bar) · hidden by a rule (strike + "Hidden · channel blocked", only with *Show hidden* or while pointing at the rule) · lit · remote focus |
| Lists | empty (what to do next) · filter with no match · reordering paused while filtering |
| Add by link | hint · error (not YouTube, Mix) · one or several candidates · already suggested/blocked |
| Publish | changes with per-change Revert · note · confirm discard · nothing to publish · restore any revision · "this preview has no TVs" |
| History · Watched | context mixed / all foreground or on-tab / all background / not recorded · filtered ("2 of 4 plays shown") · nothing in period |
| History · Searches | listed · latest 20 of N (count still covers the scope) · filtered ("2 of the 19 listed searches match") · no match · nothing in period · TV selected ("doesn't record searches", count shown as —) |
| Evidence | Chrome snapshot · OwnTube Android snapshot (`not-run`, default audio not exposed, decoder label) · truncated description · description not exposed + failed getter · no snapshot · digest matches / doesn't / can't be checked · exact vs formatted raw text |
| Environment | storage unavailable · state changed in another tab (adopted, announced) · reset confirm |

## 7. Curation rules

- The **draft** is a document; **publishing** freezes it as immutable revision N. TVs apply the latest
  published revision only.
- **Specific beats general.** A suggested video shows even if its channel is blocked; a blocked
  video hides even if its channel is suggested. One item cannot be both: suggesting a blocked item
  unblocks it, and the toast says so.
- New suggestions go **first** in their row, where they are visible on the TV. Playlists can be
  suggested, not blocked. Mixes are refused (generated per viewer).
- The diff knows *added, removed, moved, note*. Moves use a longest-increasing-subsequence, so one
  move doesn't flag every row. Re-adding something restores its published position, so undoing by
  hand leaves no phantom change.
- Undo (toast, `⌘Z`) covers every draft edit. Confirmation is reserved for *Discard* and *Reset*.

## 8. History numbers

| Figure | Definition |
| --- | --- |
| Watched | Sum of recorded wall-clock playback in the period on the selected device(s), background included. Playback, not attention; replays add time. |
| Distinct videos | Video IDs with any recorded playback in the scope, each counted once. |
| Per calendar day | Watched ÷ **every** calendar day in the period (7/30/90, including today and days without playback). The divisor is printed ("÷ 7 calendar days"); dividing by active days is never done. |

- **Scope:** period, device and person set every number, including each day's total. The text
  filter only narrows rows; the ledger says so, and a day shows "2 of 4 entries match" while
  filtering.
- **Playback context.** Every entry splits into foreground (or on-tab), background and unspecified.
  The three always add up to Watched, and the check asserts it for every row and scope.
  - Naming follows the source. Chrome reports *on-tab* (tab visible); OwnTube on Android TV reports
    *foreground* (player activity in front). Production takes the source from the server's device
    `kind`; mixed or unidentified scopes say "on-tab / foreground".
  - Neither proves attention.
  - Records without context (older collectors, legacy rows) are *unspecified*, never assumed
    foreground.
  - The ledger adds one sentence ("Of that: 4 h 28 min on-tab or foreground · 55 min background ·
    29 min unspecified"), not a chart.
  - Scope: a History entry is one recorded viewing of one version on one device and day, and its
    split is that entry's. Older collectors' records are one entry per version, device and day
    (*Recorded that day*). ytdash's video rows aggregated per person, video and range, so the label
    always names the scope it shows.
- **Searches.** The count is every search in the period on the selected device(s). A search row has
  time, query and device, and no seconds, coverage or context. Searches come from the browser
  collector (recorded when a YouTube results page opens; repeats within 5 s are ignored). A known TV
  shows "—" with "not recorded on TVs", never 0.
  - **Production** pages through all of them, 20 at a time, with the filter applied on the server
    across every search ("8 of 33 searches match").
  - **The prototype** still mirrors the old dashboard: it lists the latest 20, says "Listing the latest
    20 of 26", and filters only the listed rows.
- **Calendar days** are the server's. The API computes them in its `TIMEZONE` (default
  `Europe/Zurich`) and returns each entry's `date`, the range and the divisor. The desk groups by that
  date and shows times in that zone, whatever the browser's zone is. (The prototype uses the browser's
  zone, named in its ledger.) Viewing records are split at 15-minute UTC boundaries and grouped per
  local date, so cross-midnight playback lands on both days.
- Empty days mean "no recorded playback", not proof that nothing was watched. The History side note
  and this definition keep that wording.

## 8a. Evidence inspector

Every play row has **Evidence**. It opens an inspector that keeps three things visibly apart, in
this order:

1. **Playback context · this play**: Foreground or On-tab, Background, Unspecified, and the total
   (background included).
2. **Language estimate · derived**: the collector's estimate with confidence and the signal it used
   (audio track, auto-generated captions, text detector, heuristics). It is labelled as not being
   a source value.
3. **Source values · as saved**: saved title (with `titleSource` on Android), selected and default
   audio, caption *tracks*, and the description (scrollable) with its source, its saved length, and
   the collector's truncation flag (cut at 10,000 characters). Below that, **Text detector**: the
   text estimate, engine, input, status, algorithm and candidates.

Then comes **Raw source snapshot** (collapsed). It shows the SHA-256 evidence ID with Copy, a digest
check recomputed in the browser, the size in bytes, and the **exact saved text**. A "Formatted" view
re-encodes the text for reading and says it is not byte-identical.

Rules carried from ytdash and the collectors:

- **Saved, not fresh.** The header and footer say "Saved evidence, not a fresh YouTube lookup" and
  name the collector: Chrome `language-v2`, or OwnTube `owntube-source-v1`, which records values as
  SmartTube exposed them, not raw YouTube responses.
- **Missing means "Not recorded"**, with the reason only when the snapshot itself states one:
  - `languageAnalysis: not-run` gives no language estimate on Android.
  - `defaultAudioLanguageStatus: not-exposed-by-MediaFormat` gives no default audio on Android.
  - `descriptionAvailable: false` means the description wasn't exposed.
  - Empty Chrome audio fields mean YouTube reported none.
  - Android's selected audio is a player-normalized *decoder label*, not spoken-language detection.
  - A caption kind is shown only if recorded (asr → auto-generated).
  - YouTube's `und` is shown as "undetermined, as YouTube reported it".
  - A failed getter (`mappingError`) is stated, with the partial values kept.
- **Captions are a track list, not a transcript.** Caption text isn't saved, and the inspector says
  so. Android's excluded translation options are counted, not listed.
- **Revisions.** Each play keeps the snapshot saved with it. The same video can carry different
  snapshots on different plays (in the sample, a TV snapshot and a later Chrome snapshot with a
  revised description). The server keeps them all. The inspector shows this play's snapshot and says
  there is no revision browser yet.
- **No snapshot** (for example an older collector): the inspector says so, shows the play record's
  title, channel and ID, and infers nothing else.
- **Untrusted text.** Titles, descriptions and raw JSON are inserted only as escaped text. The
  sample includes a description containing `<img onerror>` and `<script>`, and the check proves it
  renders literally and never runs.

## 9. Accessibility

- Landmarks, skip link, one `h1` per view, labelled sections, and `lang` on every title.
- Links for navigation (deep-linkable hash routes); buttons for actions; `aria-current` and `aria-pressed`.
- Dialogs use `showModal`, return focus to their opener, and close on Esc or backdrop. The toast and
  status live regions move *into* the open dialog, so Undo stays reachable and announcements aren't
  swallowed by inert content.
- Re-renders keep focus, caret and scroll by stable keys. A move keeps focus on the moved row.
  `Alt ↑/↓` reorders, with a spoken position.
- The TV preview is one tab stop with arrow keys inside (a roving tabindex), like a remote.
- History's *Watched / Searches* are links with `aria-current`, and switching keeps focus on the
  switch and announces the view. The evidence inspector focuses Close first, closes on Esc or Done,
  and returns focus to the row's Evidence button. Its scrollable description and raw text are
  focusable, labelled regions. It becomes a bottom sheet on phones without horizontal scrolling.
- Non-colour cues everywhere; `prefers-reduced-motion`; `forced-colors` mappings. Targets meet
  WCAG 2.2's 24 px minimum (most desktop controls are 30–34 px, segmented buttons about 26 px; phone
  controls are 36–48 px).
- **Known gaps:** a card's accessible name is an `aria-label` (loses per-title `lang`); there's no
  drag-and-drop (buttons and keys instead); no screen-reader session has been run yet.

## 10. What the prototype does not pretend

No AI suggestions. No real publishing, device sync or delivery status ("this preview has no TVs").
The TV's own rows are a fixed sample, labelled as such. Pasted links are not looked up. History
numbers come only from sample plays and say so. No TV search capture is shown, because OwnTube on
Android TV records playback only. Evidence is saved sample data, never a live lookup. Its digests
are real SHA-256 values of the sample strings.

**AI later:** a separate *Proposals* inbox where each item shows who proposed it and why. Accepting
one creates an ordinary draft change; nothing auto-publishes. The owner's notes on suggestions and
blocks become labelled examples.

## 11. Integration path

**Production pages.** History (§15) and Languages (§14) were built as vanilla ES modules rather than
in Elm. They keep the prototype's tokens and class names, and port its behaviour.

**Elm (`apps/backoffice`)** remains a possible structure for curation. Keep the tokens and class
names. Split views as `Curation.Index`, `Curation.List`, `Curation.Monitor`, `Item`, `Publish` and
`Ui.Tokens`. The state shape (draft document, revisions, diff) maps directly to Elm types.

**Server (`server/`, Rust + SQLite).** Proposed additions, with JSON Schemas in `contracts/`:

- `GET /api/curation` → draft, draft version, latest revision.
  `PATCH /api/curation/draft` (operations, `If-Match: <draft version>`) returns 409 when another tab or
  device edited first.
- `POST /api/curation/revisions` `{ basedOn, note }` → immutable revision N. Restoring creates a new draft.
- Device side: `GET /api/device/curation` with the device key and `If-None-Match` returns the published
  policy `{ revision, suggested{videos,channels,playlists}, blocked{videos,channels} }`. The device
  reports the revision it applied, which feeds the **TVs** section of the publish sheet.
- Metadata: the server resolves pasted IDs (pending → resolved / unavailable) for title, channel, duration.
- Feed preview: the TV reports the rows it showed (feed snapshot). Until that exists, the monitor shows
  curated rows plus the last snapshot, never invented rows.
- History: **done**. `GET /api/history`, `/api/history/searches` and `/api/history/evidence`
  ([`contracts/history.md`](../contracts/history.md)) are computed from the existing viewing records.
  - They return scope totals, per-day totals and entries with their own context split and coverage.
  - The responses are paged through a snapshot (`generation`/`before` + `until`), and totals never
    depend on the page.
- Device **collector kind**: **done**. `devices[].kind` (`browser`, `tv`, `mixed`, `unknown`) and
  `searchCapability` are inferred from saved collector evidence and recorded searches, never from
  labels.

**Wiring limits found in the old dashboard query** (`server/src/store.rs`). The History endpoints
resolve most of them:

- **Searches.** The dashboard listed only the latest 20 searches and returned neither a cursor nor a
  server-side filter.
  - **Resolved:** `/api/history/searches` pages with `before` + `until`, filters every search on the
    server, returns per-day counts, and includes each search's trigram language estimate.
  - **Still not returned:** the link from a search to the first result opened within 30 minutes (the
    watch event's `searchId`), so it isn't shown.
- **Evidence.** Snapshots are stored as exact strings in `evidence(id, payload)` with
  `id = SHA-256(payload)`.
  - **Resolved:** `/api/history/evidence` returns the stored string (`evidenceText`) with the parsed
    snapshot, so the inspector shows and checks the exact text. A stored text that doesn't match its
    ID is shown as a mismatch, never rewritten; the production copy has two such historical records.
  - **Still missing:** a list of a video's snapshots (`GET /api/videos/{id}/evidence`), so the
    inspector shows only the entry's own snapshot.
- **Context.** Today's dashboard returns foreground/background/unspecified totals per person, video
  and range. The per-play split above is new surface, not new data.

**TV apps.** OwnTube (the SmartTube fork) and later OwnTube2 apply blocks to every row they render and
show the *Suggested* rows in owner order. Where else blocks apply (search, up next) is decided per app.

## 12. Open questions

Where exactly the suggested rows sit on the TV home; whether blocks reach search and up next in
SmartTube; whether History should use the server's time zone or an owner preference; and how much a
feed snapshot may record.

## 13. Files and checks

`apps/backoffice/design-preview/`: `index.html`, `styles.css`, `app.js`, `fixtures.js`, `README.md`, and
`check.mjs`, a zero-dependency headless-Chromium behaviour check with 106 assertions. Beyond
curation, it covers:

- History numbers and their boundaries.
- Context sums for every row and scope, with mixed, background-only and missing cases.
- Search scope, the listing limit and filters.
- Evidence integrity (SHA-256 of the exact text), missing values, truncation and escaping.
- The phone layout and focus return, and the schema-1 to schema-2 state migration (draft edits kept).
- The Languages link: the preview serves the module's own files.

Production pages live next to the preview, each with its own checks:
- the Languages module in `apps/backoffice/modules/languages/` (§14);
- the History desk in `apps/backoffice/desk/` (§15).

Screenshots go to the OS temp directory, not the repository.

## 14. Languages module

A standalone production page at `/modules/languages/`, in the same design: desk, ledger, rules,
Charter/system UI/PT Mono. It has its own sign-in through `/api/session` and `/api/login` (the owner
cookie). It targets `contracts/languages.md`; the files and checks are described in the module's
`README.md`.

**What "language" means.** It is the audio that actually played (the selected audio track), not
the title's or the captions' language. *Mixed* (`mul`) and *no speech* (`zxx`) are answers of their
own, listed apart from *unknown* (`und`), which is marked as needing a decision.

**Layout.**
- **Scope column:** Device (grouped by person when there is more than one person), Person (shown
  only then), and Period 7/30/90.
- **Ledger:** Watched, Distinct videos and Needs review, plus two sentences. "By decision" covers
  confirmed by you, estimated, and the undetermined remainder. "By context" covers on-tab/foreground,
  background and unspecified.
- **Languages table:** share of watch time, with a quiet proportion rule. Each row is a toggle that
  filters the videos.
- **Videos:** one row per recorded version on one device. Each shows the current interpretation
  (status glyph and word, plus "Needs review") beside the collector's own value, watch time with its
  context, and *Review* or *Inspect*. Status, language and search narrow rows only; the scope
  numbers never move. The channel · device · last-played line keeps each item whole when it fits
  on the next line. A channel or device name longer than the row wraps inside it, never widening
  the page.

**Inspector, for one recorded version.**
- **Scope notice:** this exact metadata version on this device; other devices, dubs and versions
  keep their own.
- **Current interpretation:** language, status, confidence (including "human"), source and reason,
  with the collector's recorded value.
- **Spoken-language form:** common languages, `mul`/`zxx`/`und`, or another BCP 47 code, with a
  recommended note.
- **Automatic:** *Analyze saved evidence*, with a provider selector only when the server advertises
  one, and *Reset to collector*. Analysis is disabled while a manual classification stands, and its
  results are always called estimates. The external provider's note says only saved evidence is
  sent.
- **Audit:** newest first and append-only, saying so when older entries are kept. A stale-revision
  409 asks you to refresh and keeps your note.
- **Saved evidence:** source values, text detector, and the exact raw text with its SHA-256
  checked. This is the History inspector's model (§8a).

**Demo, never as a fallback.** `?demo=1` loads a separate in-memory adapter with fictional data,
behind a permanent strip, and makes no API calls. Live failures show the server's error and *Try
again*. The design preview links to the demo through a `modules → ../modules` symlink, so there is
one implementation.

**Contract decisions.**
1. **Device kind.** The Languages contract doesn't carry `devices[].kind` yet, so context reads
   "on-tab/foreground". The module switches to "on-tab" or "foreground" by itself once it does.
   History's devices already carry it.
2. **Review.** Conservative review is intentional: collector estimates always need review. A
   high-confidence re-analysis of the selected audio label clears it.
3. **409 errors.** The server's 409 message is enough for now. A structured `code` (stale revision vs
   manual lock) may come later.

**Navigation.** Live, the masthead reads History (`../../#/history`) · Languages, with a quiet
*Legacy* link to the old dashboard. The demo keeps the preview's navigation.

## 15. History desk

The backoffice root (`/`) in production. It shows **History · Watched** (`#/history`) and
**History · Searches** (`#/history/searches`) on live data, in the prototype's design (§6, §8, §8a).
It targets [`contracts/history.md`](../contracts/history.md). Files, routes and checks are described
in `apps/backoffice/desk/README.md`.

**What changed from the prototype, and why.**
- **No curation.** There are no *Suggest*, *Block channel* or curation marks, and no Curation nav
  item; curation integration is the next milestone. There is no demo mode; the preview keeps the
  sample data.
- **Entries, not plays.** A native entry is one recorded viewing of one version on one device and
  day. Older collectors saved samples without a visit identity, so their entries are one version per
  device and day and read **Recorded that day**; nothing invents distinct plays.
- **Times.** The time column shows each entry's first and last recorded playback as one range
  (`13:02–15:20`), because neither end is a session start or end. Rows are sorted by the latest
  recording, so the range's end follows the list. The inspector words it the same way. For
  older-collector entries it gives the first and latest samples.
- **Coverage** is the union within the entry; replays add watched time only. When some slices have
  no ranges, the row says "at least 80% covered". Without a percentage it shows seconds, and with
  neither it says "coverage not recorded". The thumbnail bar has a dotted end when partial and is
  drawn in ink when there is no thumbnail.
- **Searches** are complete and server-filtered, with per-day counts. Capability comes from the
  server: a known TV is "not recorded", an unidentified device makes no claim, and a mixed scope gets
  a source note naming each group. A quiet language code, estimated from the query text, appears
  only when it is known.

**Scope, snapshots and honesty about loading.**
- Period, device and person are shared by both views; each view keeps its own filter. Person and
  device narrow together.
- Paging and filtering read one server snapshot. *Refresh*, a scope change or a 410 starts a new one
  at page 1. After a 410 the page says the saved list is no longer available and shows current
  records.
- Old figures never stay on screen under a new scope's labels, and a slower, older answer never
  replaces a newer one.

**Ledger.** The ledger is the prototype's: Watched, Distinct videos and Per calendar day
(÷ every calendar day). It ends with the "Of that" context sentence and the scope note. Its dateline
ends with the snapshot time ("As of 14:32") and a quiet *Refresh*.

**Layout.** The filter column stays in view while the list scrolls. On phones the heading and the
Watched/Searches switch come first, device and person sit side by side, and the inspector is a
bottom sheet. Long channel, device, title and query text wraps inside its row; a 390 px sweep of
every page of the production copy found nothing wider than the screen.

**Checked against real data** (an isolated, read-only production copy):
- The ledger matches the API for 7 and 90 days.
- In 90 days, 417 of 465 entries are older-collector days.
- Both historical digest mismatches show as "Does not match", with the exact stored text.

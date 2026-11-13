# OwnTube backoffice — design preview

A local, static prototype of the OwnTube backoffice: curating what the TV shows, previewing the result,
publishing it as a numbered revision, and History: what played (with background playback and a
numbers ledger), what was searched, and the saved evidence behind each play. Vanilla HTML/CSS/JS, no
build, independent of the Elm app in `apps/backoffice`.
Design rationale: [`docs/backoffice-design.md`](../../../docs/backoffice-design.md).

## Run

```sh
pnpm --dir apps/backoffice preview:design   # http://127.0.0.1:4187/
```

Any static server works (`python3 -m http.server 4187 --bind 127.0.0.1 --directory apps/backoffice/design-preview`).
Deep links: `#/curation/suggested-videos` (also `suggested-channels`, `suggested-playlists`,
`blocked-videos`, `blocked-channels`), `#/tv` (own tab below 1180 px wide), `#/history` (Watched),
`#/history/searches`.

**Languages** in the masthead opens the real module (`../modules/languages/`) in explicit demo mode
(`modules/languages/?demo=1`). The `modules → ../modules` symlink lets this preview server serve the
module's own files, so there is one implementation. See `apps/backoffice/modules/languages/README.md`.

## What is real and what is simulated

- **Sample data only.** Every channel, video, playlist, revision and history entry comes from
  `fixtures.js` and is fictional (IDs start with `smp`). Times are offsets from when the sample was seeded.
- **Edits stay in this browser** (`localStorage`). **Publishing** appends a numbered revision there;
  no TV or server is contacted. Another tab's edits are adopted, not overwritten.
- **Links you paste** are parsed locally (video, Short, live, channel, `@handle`, playlist; Mixes are
  refused). Titles are not looked up; the item shows its ID. The only network request in the whole
  preview is the thumbnail for a pasted *video* link, from `i.ytimg.com` without a referrer. Switch it
  off in **Preview settings**.
- The TV's own rows (**Home**, **Subscriptions**) are a fixed sample feed. The History numbers are
  computed from the sample history and labelled as such.
- **Devices are sampled the way the collectors really work.** Two OwnTube TVs record playback only
  (Bedroom TV stands in for an older build with no context or snapshots), and a Chrome laptop records
  playback and YouTube searches. A TV therefore shows searches as "not recorded", never as zero.
- **Evidence snapshots** are fictional but shaped like the Chrome and OwnTube Android collectors' output.
  Each is an exact JSON string whose evidence ID is its real SHA-256, and the inspector re-checks it in
  the browser. The cases are complete, Android `not-run` language analysis, a 10,000-character truncated
  description, a description that wasn't exposed plus a failed getter, no snapshot at all, and a
  description containing markup that must render as text.
- **Reset sample** (top strip) restores everything. **Preview settings** also sets light/dark.

## Files

| File | What it holds |
| --- | --- |
| `index.html` | Page shell, dialogs, live regions |
| `styles.css` | Tokens (desk, TV, marks; light and dark), layout for desktop, tablet and phone |
| `app.js` | State, diff and revisions, rules, rendering, routing, keyboard, artwork for sample items |
| `fixtures.js` | The sample catalogue, feed, draft, revisions r12–r14, devices, plays, searches and evidence snapshots |
| `check.mjs` | Behaviour check (below) |

## Check

```sh
node apps/backoffice/design-preview/check.mjs [http://127.0.0.1:4187/] [--no-shots]
```

Drives an isolated headless Chromium (`$CHROME_BIN`, else Playwright's Chrome for Testing, else Helium)
with a throwaway profile, so it never touches your own preview state, and with remote thumbnails
off, so it needs no network. 104 assertions:

- **Curation:** draft/publish/restore/discard, undo inside dialogs, link parsing, ordering and notes,
  per-change revert, ghost rows, rule highlighting, remote-style keys.
- **History numbers:** checked against an independent reading of the rules, covering totals,
  distinct videos, the calendar-day divisor, filter vs scope, the device filter, and plays just
  inside and outside the 7-day boundary.
- **Playback context:** every row and every period/device scope adds up (watched = foreground +
  background + unspecified); mixed, background-only and missing-context plays are labelled;
  "on-tab" vs "foreground" naming follows the source.
- **Searches:** 7/30/90-day and device scope, the latest-20 listing limit, filter vs count, TVs as
  "not recorded", literal query text, no watch metrics.
- **Evidence:** every ID is the SHA-256 of its exact text, the raw view is byte-identical, missing
  values read "Not recorded", truncation, and saved markup never executes.
- **Phone layout and migration:** focus return on Esc/Done, and stored schema-1 state upgrading in place
  without losing draft edits.

Screenshots go to `$OWNTUBE_CHECK_OUT` or `<os tmpdir>/owntube-design-preview-check`, never into the
repository. Exit code 1 on any failure.

## Keyboard

`A` paste a link · `/` filter or search · `1`–`5` switch lists · `Alt ↑/↓` move a suggestion ·
arrows/Enter in the TV preview (like a remote) · `H` show hidden · `P` review & publish ·
`⌘Z` undo · `?` all shortcuts.

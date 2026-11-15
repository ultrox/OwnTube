# Calendar picker

Release: `owntube-calendar-picker-20261115-1`.

## Verification

- Rust: 49 passed, one production-copy-only test ignored.
- Full mock browser suite: 284 passed.
- Final focused calendar suite: 44 passed, including focus and clipped previews.
- Real-local comparison and calendar suite: 43 passed.
- Frontend production build and whitespace checks passed.
- Desktop and phone screenshots inspected in light and dark themes.
- Fresh production backup verified on server and Mac, including both person plans.
- Actual AMD64 candidate: 43 comparison/calendar checks passed on a restored backup.
- Candidate and public browsers matched 12 assets, both people's device options,
  all 42 calendar dates and saved configurations. Public desktop/phone screenshots
  inspected in both themes. No production decisions written.
- Candidate and production preserved six frozen history scopes, 386 assessments,
  source records, credentials, both person plans and shared comparison revision 11.
  Integrity and foreign keys passed; all nine unrelated proxy targets were unchanged.

## Deployment

Deployed from `5afed0f5a` using Kamal's healthy handover and deployment lock.
Container `28e8ca079648`, image
`sha256:4829547279cf0cfa26b3497f191b752e80ce4b7105649148778c1d68578e95ac`.
Source archive SHA-256:
`d55dc3bf5558e4733cfc116ed53474a0f5abe99b733055348d6610558921957f`.
Reports are retained under
`/home/marko/releases/youtube-observer/owntube-calendar-picker-20261115-1/`.

## Design decisions

Implements section 13 of the November 15 handover and the Picker artboard using
system fonts and existing light/dark tokens. Person-owned experiments remain the
storage model. Device filters change measured data only.

- Section 13's six visible weeks plus three weeks of padding on either side takes
  precedence over section 3.7's earlier eight-week suggestion. Requests are bounded
  to 120 days, including additional elapsed dates needed by off-screen draft cards.
- No recorded playback means past dates are untracked; today and future dates
  remain selectable for planning. While the first recording is loading, dates
  remain interactive; validation checks new periods once scope bounds arrive.
- Existing saved periods before the current device's first recording remain
  readable and editable by name, preserving person-owned plans when filtering devices.
- Unplaced cards are draft-only and block saving until placed or removed. An empty
  list of periods remains a valid saved configuration.
- Selected language colours follow lead-first ordering. With no measured comparison
  lead yet, the first available selected or recorded language is used.
  An explicit combined lead uses one accent segment for the combined selection.
- The rail fetches all elapsed draft dates, including off-screen periods. It shows
  loading instead of presenting partial cached totals as complete measurements.
- Calendar interactions do not save. Results below the picker continue to show
  the saved plan until a revision-checked save succeeds.

## Data and rollback

Adds one read-only owner endpoint. No schema or stored-configuration migration.
Image rollback to the person-experiments release preserves every plan, revision,
classification and recorded measurement. Keep the current data volume.

Backup: `/home/marko/Backups/youtube-observer/before-owntube-calendar-picker-20261115-1`,
mirrored under `~/.local/state/youtube-observer/backups/` on the Mac.
Verified SHA-256:
`89f908435261b24ff068cef19112eead730ce8c49ed1dac597a0182682d51238`.
Rollback: `kamal rollback owntube-person-experiments-20261115-1 -c deploy/deploy.yml`.

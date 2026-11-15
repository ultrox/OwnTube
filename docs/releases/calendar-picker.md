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

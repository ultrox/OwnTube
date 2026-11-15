# Named experiments

Release: `owntube-named-experiments-20261115-1`.

## Flow

Choose a person, then browse their experiments. Create a named experiment and use
the calendar to plan its periods. Open any experiment to view results or edit;
list actions rename, duplicate or delete it. Cards show date range, languages and
Planned, Running, Ready to conclude or Concluded status.

Devices filter only the open experiment's measurements. Local drafts are keyed by
person and experiment, and in-flight saves retain their original target. Duplication
copies the saved plan and clears its conclusion; it does not copy an unsaved draft.

## Migration and data

Adds `language_experiments` and `language_experiment_imports`. Startup imports each
previous person plan once as "My first experiment", preserving its exact configuration,
revision and timestamps. Import markers survive deletion so an imported experiment
cannot reappear after restart. Old person rows and the shared comparison are retained.

All mutations check person ownership and revision. Deletes affect only the selected
experiment; a stale save cannot recreate it. Viewing, evidence and reviews are unchanged.
Old browser saves through the person-only endpoint receive a reload instruction.

## Verification

51 Rust tests passed, with one production-copy-only test skipped. The full mock
browser suite passed 306 checks; 24 final focused checks include same-person
switching and returning to the list during an in-flight save. The real-local
server passed 62 checks, including the calendar. Desktop and phone layouts were
inspected in light and dark themes.

The actual AMD64 image passed 62 restored-production-copy browser checks.
Before those mutation checks, the copy matched six frozen history scopes and
386 reviews, and both imported plans matched their previous configs, revisions
and timestamps exactly.

Deployed from `032a6e4b0`. Public HTTPS verification matched 13 assets, both
people's lists, device options and saved plans. The calendar retains its 42-day
grid. Source records, credentials, reviews and shared revision 11 were preserved;
all nine unrelated proxy targets remained unchanged. Public checks wrote no
experiment or review decisions. See [deployment identity](../../server/README.md#current-release-owntube-named-experiments-20261115-1).

## Rollback

Prefer a forward fix after named experiments have been edited. The previous calendar
image can run with the additive tables intact, but displays the old person-plan
snapshot and cannot display newer named experiments. Any old-image edits would need
an explicit conflict-aware reconciliation before returning to this release.
Keep the current data volume; never restore the full backup over newer history.

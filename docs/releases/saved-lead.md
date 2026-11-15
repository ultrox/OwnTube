# Saved experiment lead

Release: `owntube-saved-lead-20261115-1`.

Choose a language or the combined selection under **Lead with**, then choose
**Save lead**. The default is stored on that experiment and restored when opening
it from the list or a fresh page. A bookmarked `lead` can still preview another
choice. Duplication copies the saved preference.

The optional `leadLanguage` config field is revision-checked and works on concluded
experiments. Saving it uses the saved periods and languages while keeping separate
unsaved period edits and updating their base revision. Removing the chosen language
from a nonempty selection clears the preference. Existing plans without a saved
lead keep automatic selection, and reads do not rewrite them.

Checks before image build: 52 Rust tests passed, with one production-copy-only
test skipped; 199 mock comparison/calendar checks and 68 real-local checks passed.
Coverage includes persistent and combined leads, conclusion locks, separate drafts,
revision conflicts, copying and restart persistence.

Deployed from `5bce00bf4` after the AMD64 restored-copy suite passed 68 checks.
Candidate and public verification matched 13 assets, both people's experiment
lists, saved plans and device filters, plus the Save lead control in desktop
and phone layouts. Six frozen history scopes, 386 reviews, existing experiments
and shared revision 11 were preserved. All nine unrelated proxy targets remained
unchanged. Public checks wrote no experiment or review decisions.
See [deployment identity](../../server/README.md#current-release-owntube-saved-lead-20261115-1).

No schema migration. Prefer a forward fix after a lead has been saved: previous
images reject the new config field. An image rollback would first require a
targeted, backed-up removal of `leadLanguage` from affected experiment configs.
Keep the current volume and all newer viewing, reviews and plans.

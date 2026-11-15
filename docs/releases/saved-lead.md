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

No schema migration. Prefer a forward fix after a lead has been saved: previous
images reject the new config field. An image rollback would first require a
targeted, backed-up removal of `leadLanguage` from affected experiment configs.
Keep the current volume and all newer viewing, reviews and plans.

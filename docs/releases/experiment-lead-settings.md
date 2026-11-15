# Lead language in experiment setup

Release: `owntube-lead-settings-20261115-1`.

Creating an experiment asks for its name and lead language. Both are saved in
one operation before the calendar opens. Spoken languages are available even
before they have recorded viewing, and each card identifies its saved lead.

The lead lives in **Experiment settings** above the calendar and results,
alongside compared languages. Changes save automatically with a small status
message and explicit retry on failure. The separate results-level lead buttons
and Save lead button are removed.

Revision checks, concluded plans, independent period drafts and duplication keep
their previous behavior. Automatic clears the preference; combined languages
remain available. Choosing a new default clears any bookmark's lead override.

No schema migration or changes to existing configs. The previous saved-lead image
can read these plans, but does not offer lead selection during creation.
Keep the current volume for any image-only rollback.

Before image build: 52 Rust tests, 207 mock comparison/calendar checks and
74 real-local checks passed. One production-copy-only Rust test was skipped.
Coverage includes creation with an explicit lead, independent experiments,
duplication, concluded plans, automatic-save errors/retry and preserved drafts.
Creation dialogs were inspected on desktop and phone in light/dark themes.

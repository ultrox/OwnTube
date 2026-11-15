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

## Build and recovery

Source commit: `b15cf589b`. Server-local AMD64 image:
`localhost:5555/youtube-observer:owntube-lead-settings-20261115-1`.
Image identity:
`sha256:d4a0e70a51ce93ac91f284d352dac8e800e60779987f41de2f6bc45cf0701959`.
Tracked-source archive SHA-256:
`95ecbcdd81bcfb882d6fb4445f1637cfeacc7c741e593f247114b124136e278f`.

Verified backup `before-owntube-lead-settings-20261115-1` is retained on hserver
under `/home/marko/Backups/youtube-observer/` and mirrored locally under
`~/.local/state/youtube-observer/backups/`. SQLite SHA-256:
`8c8e4beb518811c975f5b06e5f428ef0e5505ecefd5955a67afac3edfa8e5b57`.
Integrity and foreign keys passed. The restored candidate preserved all three
named experiments, both import markers, previous person snapshots, shared
revision 11, 386 assessments, credentials and six frozen history scopes.

## Deployment verification

Deployed on 2026-11-15 using
`kamal app boot -c deploy/deploy.yml --version owntube-lead-settings-20261115-1`.
Container `155e9fe2d870` is running the verified image as UID 10001. Healthy
handover completed and the deployment lock was released.

All 74 actual AMD64 candidate browser checks passed. Candidate and public checks
matched 13 assets, both people's experiment lists and device options, required
creation lead selection and top-level settings. Desktop 1320px and phone 390px
layouts passed in light/dark themes. Public checks wrote no experiment decisions.

Production preservation checks matched the restored-copy guarantees above,
including all three exact experiment rows. All nine unrelated proxy targets
remained unchanged. Reports and screenshots are retained under
`/home/marko/releases/youtube-observer/owntube-lead-settings-20261115-1/`.
The previous saved-lead image and stopped container `7e1f16b34fad` are retained.

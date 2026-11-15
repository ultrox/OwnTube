# Comparison v2

Release: `owntube-comparison-v2-20261115-1`.

## Included

- Ordered periods, pooled labels, adjacent moves and reversible featured comparisons.
- Experiment planner, inclusive dates, future periods and conclude/reopen.
- Directional daily-rate stories, separate time/share lenses, observation windows,
  waffles, dumbbells and contribution charts.
- Responsive system-font layouts in light and dark themes, chart text equivalents,
  keyboard focus, native confirmation dialogs and forced-colors boundaries.
- Revision-checked saves, preserved drafts across scopes and recorded-language suggestions.

## Handover defaults

| Question | Default |
| --- | --- |
| Q1 | Concluding locks periods only. Numbers remain live as classifications change. |
| Q2 | Equal completed windows have no minimum-day threshold. Below 28 combined days, show a short-record note. |
| Q3 | Lead language is automatic by absolute share shift, then rounded rate shift, then code. Override is hash-only. |
| Q4 | Move dates are shown in the planner and sequence. No reminder service. |
| Q5 | Empty/future-only plans suggest recorded languages from the last 30 days in scope, plus saved selections. |
| Q6 | Feature the first adjacent move by default. |
| Q7 | Captions say "{label} starts". No per-period note field. |

## Migration and limits

GET interprets v1 groups as normalized chronological periods without rewriting
the singleton row. A successful v2 save migrates that row and increments its
revision. Stale v1 POST requests receive 422 with a reload instruction.

Limits: 128 periods, 366 days ahead and 3,660 unique calendar days. Same-label
overlapping/touching periods merge. Different labels cannot overlap. Future days
never enter rate denominators; partial today counts as one elapsed day.

## Verification

- Full Rust suite: 47 passed, one separate production-copy test ignored.
- Full mock browser regression suite: 226 passed before final focus/presentation refinements.
- Final focused comparison suite: 116 passed, including both themes, three widths,
  lead/combined/reverse controls and focus restoration.
- Real-server fixture exercise found and fixed property-order-dependent conclusion
  validation. The focused real-server comparison rerun passed all 24 checks.
- Disposable production backup: six frozen history scopes matched, all 376
  assessments and original source/credential records preserved. GET left revision
  11 untouched; v2 save, conclude and reopen advanced the copy to revision 14.
- Desktop and phone screenshots inspected in both schemes for the required
  equal/unequal, running/upcoming, concluded, language-selection, no-share and
  decrease states. Width assertions cover 1320, 859 and 390 pixels.

## Backup and rollback

Verified backup on hserver:
`/home/marko/Backups/youtube-observer/before-owntube-comparison-v2-20261115-1`.
Mac mirror: `~/.local/state/youtube-observer/backups/before-owntube-comparison-v2-20261115-1`.
Database SHA-256:
`1255a714b114fa93b84daebac4f706f90cb273faff7671cd856fa8592e7163e4`.

Previous image: `localhost:5555/youtube-observer:owntube-device-removal-20261114-1`,
ID `sha256:f9b8abc2a89242fe458c1134ba7d4d0b76b129a44e000145d0aa9fb6510fb31c`.

Before any v2 save, the old image can read the unchanged v1 row. After a v2 save,
an image-only rollback cannot read that row. Preserve the current database and
export its comparison row first. For an old-image rollback, convert only the
comparison configuration to the old two-group format in a transaction with a
new revision, or restore only its backed-up configuration with a new revision.
Experiments with more than two labels, future dates or conclusion state need an
explicit mapping to the old format. Do not restore the whole old database over
new watch history or reviews. Prefer a forward fix when the current experiment
cannot be represented by v1.

## Deployment

Deployed on 2026-11-15 from `f19dbf112`. Public verification matched all ten
frontend assets and owner authentication. Desktop and phone screenshots were
inspected in both themes. Six frozen scopes, all 376 assessments, source records
and credentials were preserved; integrity and foreign keys passed. The saved
comparison remained at revision 11 in v1 storage, and verification wrote no
production decisions.

Deployment identity and public verification are recorded in
[`server/README.md`](../../server/README.md#previous-release-owntube-comparison-v2-20261115-1).

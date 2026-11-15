# Person-oriented experiments

Release: `owntube-person-experiments-20261115-1`.

## Behavior

- Choose a person before planning. Each person has independent periods, selected
  languages, conclusion state and revision.
- Person comes before Device. The device picker only offers that person's
  devices; switching people clears an incompatible device. Invalid bookmarks
  are repaired before loading comparison results.
- All devices or one device changes the measured results, never plan ownership.
- Unsaved drafts stay with their person for the current page session. Saves
  in flight retain their original person even when the selection changes.
- The previous shared comparison remains read-only under Everyone. No person's
  ownership is inferred for that old plan.

## Storage and API

The additive `person_language_comparisons` table uses the stable person ID as its
primary key. The old `language_comparison` row is preserved unchanged.
Reads and saves use `?person=<id>`; saves without a person or with a device filter
are rejected. The API rejects devices belonging to a different person.
History, evidence, classifications and device credentials are unaffected.

## Verification

- Rust: 48 passed, one production-copy-only test ignored.
- Full browser regression suite: 244 passed.
- Real-local comparison suite: 34 passed.
- Tests cover independent persisted plans, revision conflicts, conclusion
  isolation, device totals, invalid combinations, per-person drafts and switching
  people while saving.
- Desktop and phone screenshots inspected in light and dark themes.
- Actual AMD64 candidate: all 34 comparison checks passed on a restored production
  backup, with independent saves and conclude/reopen.
- Public browser: ten assets matched; both people's device options matched;
  incompatible bookmarks repaired; saved configurations unchanged; no production
  decisions written.
- Candidate and production: six frozen scopes, 384 assessments, source records,
  credentials and shared revision 11 preserved. Integrity and foreign keys passed.

## Deployment

Deployed from `9781616e0` with healthy Kamal handover and lock release. Container
`c26a8e966ae5`, image
`sha256:08c88bdbd8e4b4bb4f6d8f01246c8236af057fbe1df8480305cb4ca615b27f1e`.
Full identity and verification records:
[`server/README.md`](../../server/README.md#previous-release-owntube-person-experiments-20261115-1).

## Backup and rollback

Backup: `/home/marko/Backups/youtube-observer/before-owntube-person-experiments-20261115-1`,
mirrored under `~/.local/state/youtube-observer/backups/` on the Mac.
Both copies passed integrity, foreign keys, restored counts and matching SHA-256:
`6fd3e4d9e8996583324a06b96f4427339285f5263441101356e7b6bfbc3af027`.
Backup contains 384 assessments and shared comparison revision 11.

Previous release: `owntube-comparison-v2-20261115-1`.
An image-only rollback keeps the additive person table, but the previous image
cannot display or edit those person plans. It displays the retained shared
comparison instead. Keep the current data volume and prefer a forward fix.
Never restore the whole backup over newer watch history or reviews.

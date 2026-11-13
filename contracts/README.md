# Shared contracts

Cross-client API documentation belongs here. Contracts must describe HTTP/JSON
behavior independently of Android, browser, Elm, Rust storage, and player types.

## Implemented: playback tracking

- [Published integration guide](https://ytdash.gromobran.com/android-integration.html)
- [Guide source](../apps/backoffice/history/android-integration.html)
- [Android delivery semantics](../apps/android/owntube/README.md)
- [Executable Android/server contract check](../apps/android/owntube/test-observer.py)
- [Server protocol tests](../server/src/tests.rs)

Stable viewing/event IDs, increasing revisions, cumulative seconds, coverage, and
evidence references are already implemented. Acknowledgements identify the
submitted revision so an in-flight response cannot discard newer measurements.

## Planned: feed control

The curation API is not implemented. Its design must cover suggestions, firm
exclusions, published revisions, and inspectable composition results. Blocks
override suggestions. Recommendation exposure and viewing duration are separate
concepts. The contract must support the current app and future OwnTube 2 without
exposing player-specific models.

## Implemented: optional Languages module

[Language review API](languages.md): independently scoped tally, saved evidence,
reversible owner corrections and analysis-provider contract. Its assessments
never mutate the recorded playback or global history read model.

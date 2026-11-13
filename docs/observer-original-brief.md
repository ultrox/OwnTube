# YouTube Observer

## What this actually is
A small, single-operator collection service: a thin Chrome extension measures YouTube playback and queues events locally; a Rust server stores them in SQLite and serves an Elm dashboard. Devices have optional person labels. Language-learning progress is one possible analysis of this data, rather than the data's permanent product boundary.

## Why now
Local tracking is useful, but watch time and source evidence need a central home that can eventually receive events from other devices, including television.

## Definition of done
Pair a browser from the dashboard, watch a regular video or Short, and see its watch time and metadata arrive in a batch. Offline events survive browser/worker restarts, retries do not duplicate totals, and acknowledgements remove only events the server saved. One owner can inspect and filter data from multiple labelled devices. Run locally and deploy the same server with a persistent SQLite volume.

## Out of scope
Television collection is explicitly deferred; Chrome is the first collector. No separate household-user accounts, public signup, billing, distributed queues or microservices.

## Open risks
The production host is not chosen: ship Docker instructions and a configurable URL. YouTube's undocumented report formats can change, so primary watch time remains independently measured. Abrupt browser/process termination can lose a final not-yet-sampled tail; acknowledged local events must not be lost.

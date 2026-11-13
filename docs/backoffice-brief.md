# OwnTube backoffice brief

## What this actually is

A personal control room for Marko's OwnTube feed: add worthwhile suggestions,
exclude unwanted videos or channels, inspect the resulting feed, and publish
changes. It lives under the OwnTube umbrella alongside the native app, browser
extension, existing viewing history, and server. Its visual design is independent
of the current ytdash dashboard.

## Why now

Playback tracking now works across the browser and TV. Marko wants practical
control over what is offered next, before spending time defining AI scoring or
building a training system. The existing repository layout and dashboard design
are poor foundations for that work.

## Definition of done

The current foundation milestone is a clean component layout, independently
buildable existing software, and a locally inspectable, carefully designed
backoffice preview. The first functional milestone afterward is editing personal
suggestions/blocks and seeing the published result in OwnTube Home.

## Out of scope

Monorepo orchestration tooling; a replacement player; importing OwnTube 2 now;
multi-viewer policy; AI scoring/training; media downloads. These do not establish
the initial personal feed-control loop.

## Open risks

The design needs Marko's review. Feed API details, offline policy, metadata
resolution, pagination behavior, and coverage beyond Home need implementation
decisions. A repository migration is not a production cutover. The Chrome
extension's installed identity and pending records must survive any later
installation change.

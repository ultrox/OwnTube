# Languages module v1

Independent owner-authenticated routes under `/api/modules/languages`. Existing
history, ingestion, evidence and `/api/languages` behavior stays independent.
The subject is **audio actually played**. Review groups a video's current saved
versions; assessments remain audited per device/version.

## Read

### Named experiments

Each person has a list of named experiments. The UI starts at the list; opening an
item adds `experiment=<id>` to the hash. Person changes return to that person's
list. Device filters affect an open experiment's measurements only. Drafts are
kept by person and experiment for the page session.

All routes require an owner session and `?person=<person-id>`:

- `GET /api/modules/languages/experiments` returns `{experiments, today}`.
  Entries include `id`, `personId`, `name`, `revision`, `createdAt`, `updatedAt`,
  `start`, `end`, `periodCount`, `selectedLanguages`, `leadLanguage` and `status`.
  Status is `planned`, `running`, `ready` (all periods ended), or `concluded`.
- `POST /api/modules/languages/experiments` with `{name}` creates an empty plan.
  The creation form requires a `leadLanguage` choice, stored atomically with the
  new plan. The API accepts omitted `leadLanguage` for older callers.
  Names are trimmed, nonempty and at most 120 characters. Duplicate names are valid.
  Optional `{sourceId, baseRevision}` copies that person's saved plan and languages
  into a new revision-zero experiment, with its conclusion cleared.
- `PATCH /api/modules/languages/experiments/<id>` with `{name, baseRevision}`
  renames it and increments the shared revision.
- `DELETE /api/modules/languages/experiments/<id>` with `{baseRevision}` deletes
  that plan only. Viewing history, evidence and classification records remain.
- `GET` and `POST /api/modules/languages/experiments/<id>` read measurements and
  save the plan as described below. Only GET accepts a device filter.

Stale mutations fail atomically with 409. Missing/deleted experiments and IDs
belonging to another person return 404. Device-scoped mutations return 422.
Deletion cannot be undone by a stale plan save.

The plan's optional `leadLanguage` saves the default "Lead with" choice for that
experiment: a language code or `all` for the combined selection. Without it the
view chooses automatically. A `lead` bookmark can preview another choice.
The **Lead language** field in the experiment settings automatically saves a
change with revision checking, including on concluded experiments, while
retaining any separate unsaved period draft. Failed saves show an error and retry.
Choosing Automatic clears the preference. Selecting a new default clears any
`lead` bookmark override. The creation form offers spoken languages, including
ones not yet recorded; an unrecorded lead remains selected with zero measurements.
Duplicating an experiment copies its saved lead. Removing that language from a
nonempty language selection clears its saved lead.

`language_experiments` stores stable IDs, person ownership, names and plans.
Startup copies every previous `person_language_comparisons` row once, preserving
its exact config, revision, conclusion and update time, as "My first experiment".
An independent import marker prevents deleted imported plans from reappearing.
The previous person rows and shared comparison remain unchanged for reference.
Old person-scoped comparison POSTs return 409 with a reload instruction.

### Saved period comparison v2

The editor uses a six-week custom calendar with daily measured language bars,
clipped placement, keyboard navigation, touch preview confirmation and four template
patterns. Typed dates remain in a collapsed fallback. Draft previews do not change
the saved-result panels.

### Daily viewing for the comparison picker

`GET /api/modules/languages/comparison/days?from=YYYY-MM-DD&to=YYYY-MM-DD&person=&device=`
requires the owner session and uses the same person/device validation as comparison.
The inclusive range must contain 1 to 120 days; malformed dates, reversed ranges
and invalid scope combinations return 422.

Returns `{days, firstRecordedDate, today, timezone, asOf}`. Each daily row is
`{date, allSeconds, reviewSeconds, languages: [{lang, seconds}]}`. Language rows
include every assessed code with positive measured time, independent of the saved
language selection. Review seconds cover all languages. Rows run from the later
of `from` and the scoped first recording to the earlier of `to` and today.
Zero-playback days have zero totals and empty language lists; earlier and future
days are omitted. A scope without playback returns `firstRecordedDate: null`.
One read transaction uses existing compact measurements, assessment precedence,
exact local midnights and DST clipping. Cumulative measurements are never interpolated.

The picker caches dates per scope, fetches six visible weeks plus three weeks on
each side, and loads missing elapsed draft dates in requests of at most 120 days.
Refresh, discard and scope changes invalidate the cache. Missing data is shown as
loading or an explicit retryable error, never a measured zero.

### Saved configuration and measurements

`GET /api/modules/languages/experiments/<id>?person=<person-id>&device=` reads that
experiment and calculates current assessed language watch time
across their devices. An optional device narrows results without changing the
experiment, its revision or its saved selection. Unknown people/devices and
cross-person device combinations return 422.
It is independent of Overview's days, language, status and search filters.

`POST /api/modules/languages/experiments/<id>?person=<person-id>` saves the complete
configuration for that experiment. A person is required; a nonempty device on save
is rejected with 422 because devices only filter results:

```json
{
  "baseRevision": 0,
  "selectedLanguages": ["de", "ja"],
  "periods": [
    {"label": "Off", "start": "2026-11-14", "end": "2026-11-23"},
    {"label": "On", "start": "2026-11-24", "end": "2026-12-03"},
    {"label": "Off", "start": "2026-12-04", "end": "2026-12-13"}
  ],
  "concludedAt": null
}
```

Both endpoints require the owner session. Save returns the configuration with
the next `baseRevision`; stale revisions fail atomically with 409. Configurations
are stored in `language_experiments` and survive restart. Each experiment has
independent periods, languages, conclusion state and revision.
A newly created experiment starts empty at revision 0.
There are 0 to 128 periods, each with a trimmed nonempty label up to 80 characters.
Dates are strict YYYY-MM-DD, from 2000 onward, at most 366 days after today in the
server time zone. Both endpoints are included; at most 3,660 unique days are allowed
across the whole experiment. Saves sort periods by start and merge overlapping or
touching periods with the same exact label. Different labels cannot overlap (422).
Groups are derived from exact labels, in first chronological appearance order.

The old singleton `language_comparison` is retained unchanged. Legacy comparison GET without a
person reads that previous shared comparison for reference, interpreting v1
`groups` in memory. It does not assign the old plan to anyone. Unscoped POST
is rejected, including from an older browser. Reads never rewrite saved rows.
POST accepts v2 only and rejects `groups` with a clear 422 reload message.

Read returns `{personId, experiment, config, periods, groups, availableLanguages, timezone, today, asOf}`.
`experiment` contains the ID, owner, name, revision and timestamps.
`personId` is empty only for the previous shared comparison.
`availableLanguages` is the union of saved selected codes and assessed languages
with positive playback in elapsed saved days and the current device/person scope.
If no period has elapsed days, suggestions use the last 30 days in that scope.
The picker never offers the global catalog or arbitrary typed codes.
Each period and derived group has
`calendarDays`, `activeDays`, `includesToday`, `seconds`, `minutesPerDay`,
`foregroundSeconds`, `backgroundSeconds`, `unspecifiedSeconds`, `reviewSeconds`
and `languages: [{lang, seconds, minutesPerDay, share}]`. Share is a fraction
of **all** watch time, including unknown/mixed/no-speech. Results also carry
`label`, `plannedDays` and `status`. Periods have `start` and `end`; groups have
`periods`, zero-based indexes into the chronological period results.

`calendarDays` counts elapsed days only, including partial today. `plannedDays`
includes future days. Status is `upcoming` with no elapsed day, `complete` when
every day is before today, otherwise `running` (including pooled gaps before a
future period). Upcoming results have zero seconds and null average/share.
Elapsed days with no recording count in the denominator;
recorded active days are separate. A group with selected days but no playback
has zero time and no language rows unless languages were explicitly selected;
shares are undefined when there is no scoped watch time, not zero.

Local midnight boundaries respect DST. Measurements use the existing compact
facts, legacy boundary clipping, assessment precedence and device context
corrections, in a consistent read transaction. Cumulative measurements are never
interpolated. Today counts as one partial calendar day and is flagged explicitly.
No recording or language audit rows are changed by comparison saves.

`selectedLanguages` is shared by every period and group, saved with the same revision
check. It defaults to `[]` (all languages), including for older saved configurations.
Up to 128 valid language codes are accepted; saving normalizes and deduplicates
them. With a selection, group seconds, context, review time, active days and
daily averages cover only those languages. Calendar days retain the full chosen
date denominator. `allSeconds` is the complete scoped watch time; group `share`
and per-language shares use that denominator so a selection does not misleadingly
become 100%. Chosen languages with no playback return a zero row. The UI shows
the combined selection and its per-language rows. Choosing all restores the full
comparison.

`concludedAt` is null or a date after every period ends and no later than today.
Concluding requires at least one period and every period complete, otherwise 422.
While concluded, periods cannot change, but language selection remains editable.
Reopening is a separate revision-checked save with `concludedAt: null`; edit the
periods only after that succeeds. Concluding locks periods, not measured results:
new classifications remain visible. No snapshot or reminder is created.

Client view state is hash-only: `mode=sequence|pooled`, one-based `move`,
`lead=<language>|all`, and optional `dir=rev`. Default mode is pooled when labels
repeat, otherwise sequence. Moves are adjacent pairs; the first is featured by
default. Automatic lead uses greatest absolute share shift, then rate shift, then
alphabetical code. Rate and share differences use displayed one-decimal values.

The UI asks for a person before planning. Person appears before Device; selecting
a person limits the device options and clears an incompatible selection, including
bookmarked combinations. Drafts are retained separately per person for the current
page session. Switching devices preserves that person's draft. An in-flight save
keeps its original person identity even if the picker changes before it finishes.

### Overview

`GET /api/modules/languages?days=7&device=&person=&language=all&status=all&query=&page=1`

Days: 7/30/90 in the server time zone. `language`: `all` or a language code,
including `und` (unknown), `mul` (mixed), `zxx` (no speech).
`status`: `all`, `review`, `confirmed`, `estimated`. Query: up to 200 characters.

Returns period/device/person totals, context split, `languages` (list of
`{lang,seconds,videoCount}`), `reviewSeconds`, `confirmedSeconds`, `estimatedSeconds`,
distinct `videoCount`, `devices`, `people`, and filtered/paged `videos`.
Language/status/query only filter rows; never the scope totals. Pages hold 20 rows.
One row groups a device and exact immutable metadata snapshot:

```
{deviceId,deviceLabel,metadataId,videoId,title,channel,seconds,
 foregroundSeconds,backgroundSeconds,unspecifiedSeconds,lastWatched,evidenceId,
 recorded:{lang,source,conf},
 assessment:{lang,status,source,confidence,reason},revision,needsReview}
```

Statuses: `confirmed` (manual classification), `estimated`, `undetermined`.
`revision` is zero until the first assessment action.
`providers` lists available analysis choices (`saved-evidence`, optionally `external`).

With no explicit assessment, a valid selected-audio language in digest-verified
saved evidence is interpreted automatically, including historical records.
It returns `status:"estimated"`, `source:"selected-audio-metadata"`,
`confidence:"high"` and `needsReview:false`, with revision zero and no audit write.
This uses the played track's label rather than title or translated caption text.
Missing/invalid selected audio or mismatched evidence digests keep the collector
baseline. Existing assessments, including explicit resets, always take precedence.
The `recorded` fields remain the exact original collector estimate.

### Grouped video list

The UI requests `group=video` alongside the existing filters. Omitting it keeps
the version-level API above. Other group values return 422.
One `videos` entry represents a video across the selected period/device/person.
Grouping happens before pagination; `count` and `pages` count videos.

```
{id:videoId,videoId,title,channel,seconds,
 foregroundSeconds,backgroundSeconds,unspecifiedSeconds,lastWatched,
 deviceLabel,devices:[{id,label,contextOverride}],versionCount,matchedVersionCount,
 versions:[...version rows...],assessment,recorded,needsReview}
```

All scoped versions contribute time and remain in `versions`, newest first.
Title/channel come from the newest version. Language/status/query select a video
when any version satisfies all active filters; `matchedVersionCount` reports how
many. The group's time includes even nonmatching versions. Scope totals and
language breakdown remain independent of these list filters.

Summary fields retain common values; disagreements use `lang:"mul"` and
status/source/confidence (or recorded source/conf) `"mixed"`. `needsReview` is true
when any version needs review. Evidence requests always target a specific nested
version. Version rows and device metadata include `contextOverride` (null or the
audited device correction described in `history.md`).

`GET /api/modules/languages/evidence?device=...&metadata=...` returns the identity,
recorded values, current assessment/revision, exact `evidenceText`, parsed
`evidence`, and append-only `history` (newest first, latest 100 entries;
`historyLimit` and `historyHasMore` make that boundary explicit). Evidence fields
may be null.

## Assess

`POST /api/modules/languages/assessment`

```
{deviceId,metadataId,baseRevision,action:"manual"|"analyze"|"reset",
 lang?:string,note?:string,provider?:"saved-evidence"|"external"}
```

Manual classifications use a language code or `und`/`mul`/`zxx`. A nonblank note is
recommended to explain the correction. Reset adds an audit entry and restores the
original collector interpretation. Analyze evaluates saved evidence; automatic
results never overwrite a manual classification. Stale revisions return 409.

Returns `{ok:true,revision,assessment}`. Errors are `{error:string}`. All reads and
writes require the owner cookie; device bearer keys cannot annotate records.
No operation rewrites original evidence, viewing records, or global watch totals.

### One grouped review action

`POST /api/modules/languages/assessment/bulk`

```
{videoId,targets:[{deviceId,metadataId,baseRevision}],
 action:"manual"|"reset",lang?:string,note?:string}
```

Accepts 1–1000 unique device/version targets, all observed for this video. The UI
submits all versions in the displayed group, including versions not matching list
filters. Every target is validated within one transaction; any stale revision
returns 409 and rolls back the entire action. Invalid targets return 422/404.
Successful response:

```
{ok:true,updated:N,versions:[{deviceId,metadataId,revision,assessment}]}
```

Each target receives its own ordinary append-only assessment. Manual `und` marks
the group deliberately undetermined; reset restores each version's own recorded
interpretation. Those decisions apply to the target identities across history,
including outside the visible date range. They do not create a rule for future
metadata/audio versions or unselected devices. Automatic analysis remains an
explicit single-version action and cannot overwrite any manual choice.

## Optional external analyzer

Server configuration: `LANGUAGE_ANALYZER_URL`, optional `LANGUAGE_ANALYZER_TOKEN`.
HTTPS is required except for loopback development. No redirects are followed.
Analysis is explicit per-record, with a bounded timeout and response size.
The provider receives saved evidence, not authenticated media URLs or device keys.

Request:
```
{schemaVersion:1,scope:"played-audio",videoId,evidenceId,evidence,recorded}
```
Response:
```
{scope:"played-audio",lang:"de",confidence:"high"|"medium"|"low",
 basis:"audio"|"transcript"|"metadata"|"text",reason:"..."}
```

Responses remain estimates. Text/transcript/metadata-only results still need
review because their relationship to the audio heard may be uncertain.
The API adapter does not fetch audio or transcripts itself. Without an endpoint,
saved-audio-metadata analysis and manual review work normally.

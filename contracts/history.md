# History and Searches v1

Owner-authenticated read endpoints. Original collector language interpretation is
shown here; optional Languages assessments do not change History. Playback context
can carry an explicit audited owner correction.

## Watched

`GET /api/history?days=7&device=&person=&query=&page=1`

Days 7/30/90; query at most 200 characters. Period/device/person define the
summary. Text narrows rows only. Page size is 20, newest recording first.
For subsequent pages supply the first response's `generation` and `until`.
They are an optional pair. A changed ingestion generation returns 410 with
`{error}`; refresh page one without the pair and announce the refresh.

Response:
```
{seconds,foregroundSeconds,backgroundSeconds,unspecifiedSeconds,videoCount,
 perCalendarDaySeconds,days,timezone,since,until,generation,devices,people,
 daily:[{date,seconds,foregroundSeconds,backgroundSeconds,unspecifiedSeconds,
         rowCount,filteredCount}],
 count,filteredCount,page,pages,pageSize:20,rows:[...]}
```

`count` includes all recorded rows in scope, `filteredCount` includes matches
across all pages. Daily totals/counts likewise cover all pages. Zero-record days
are included. Calendar boundaries and `date` strings use the server timezone;
the UI must not regroup records using the browser timezone.

Row:
```
{id,deviceId,deviceLabel,deviceKind,personId,person,viewingId,metadataId,
 videoId,title,channel,isShort,durationSeconds,evidenceId,
 recorded:{lang,source,conf},date,firstWatched,lastWatched,seconds,
 foregroundSeconds,backgroundSeconds,unspecifiedSeconds,
 coveredSeconds,coveragePercent,coverageComplete,rowKind,contextOverride,
 versionCount,versions:[...version rows...]}
```

Native `rowKind:"viewing"` groups the same recorded viewing, video, device and
local date across **all metadata versions** and bucket/context slices. A metadata
update is not another visit. Distinct recorded viewing IDs, devices, videos and
dates remain separate. Group IDs exclude metadata identity and stay stable as
more versions arrive. `viewingId` is recorded, never inferred from timing.
Legacy `rowKind:"legacy-day"` groups video/device/date because legacy samples have
no reliable visit identity; `viewingId:null`. Label these **Recorded that day**,
not separate plays.

Grouping happens before pagination and daily/count summaries. Text matches any
version's title/channel/video ID and retains the entire entry and its time.
`versions` contains every contributing device/metadata version, newest playback
first (metadata ID breaks ties), and `versionCount` names its size. Each nested
version has the former row shape above, without `versions`/`versionCount`; native
versions use `rowKind:"viewing-version"`. Title/channel/duration/metadataId/evidenceId
and `recorded` on the entry describe the latest version, not a synthesized
classification of every version. Evidence inspectors explicitly select a nested
version; exact saved text and Languages links use that version's identity.

Times describe recorded bounds, not inferred attention or reconstructed session
start. Entry time/context sums its versions. Coverage is the **union across all
versions**; overlapping ranges and replays never inflate unique coverage.
`coveredSeconds` and percent are null if no ranges were recorded; percent is also
null without a usable latest duration. It is capped at 100 for display.
`coverageComplete:false` means some contributing slices have no ranges: present
available coverage as partial. Inspectors distinguish whole-entry time/coverage
from the selected version's evidence and time.

## Evidence

`GET /api/history/evidence?device=...&metadata=...`

```
{deviceId,metadataId,videoId,title,evidenceId,evidenceText,evidence,
 recorded:{lang,source,conf}}
```

`evidenceText` is exact saved text for SHA-256 verification, `evidence` is parsed.
Both can be null. The UI supplies the current row's time/context alongside this
snapshot, clearly naming the row scope. No fresh YouTube lookup or evidence
rewriting. The target must be an observed metadata version on that device.

## Searches

`GET /api/history/searches?days=7&device=&person=&query=&page=1`

For paging, send the response's **`before` and `until` together**. `before` is the
maximum legacy event sequence at the initial read, so later uploads do not shift
the list. Query filters all saved searches in scope, not just the first 20.
Changing scope or explicitly refreshing starts page one without the pair.
Changing only query starts page one **with the same pair**, keeping scope counts
stable. Watched likewise keeps its `generation`/`until` pair on query changes.

```
{days,timezone,since,until,before,devices,people,count,filteredCount,
 page,pages,pageSize:20,searchCapability,daily:[{date,count,filteredCount}],
 rows:[{id,eventId,deviceId,deviceLabel,deviceKind,personId,person,
        query,t,date,timeLabel,lang,source,conf}]}
```

Rows sort by `t DESC, id DESC`, preserving same-time searches as distinct events.
Daily counts cover the scope/all matching rows, not just the current page.
No watch time or coverage is attached to a search.

## Devices and source labels

Both list endpoints return:
```
devices:[{id,label,personId,person,kind,searchCapability,contextOverride}]
people:[{id,name}]
```

`kind`: `browser`, `tv`, `mixed`, `unknown`, inferred from saved collector evidence
and actual search records, never from the owner's device label.
`searchCapability`: `recorded` for observed browser/search capture,
`not-recorded` for a known TV-only source, otherwise `unknown`.
The Searches response also combines this for the selected device/person scope.
Use “not recorded on TVs” only for known TV-only scopes, otherwise “no searches
recorded” where empty. Foreground means on-tab only for a known browser; mixed and
unknown scopes use “on-tab / foreground”. Capabilities describe observed
collectors, not a promise of future capture.

Existing session/login/logout and device management stay unchanged. These routes
never mutate history, evidence, language assessments or curation.

## Owner playback-context correction

`POST /api/devices/{id}/playback-context`

```
{context:"foreground"|null,reason:"Owner's reason"}
```

Owner authentication is required; device credentials cannot call this route.
Only `foreground` or null (reset) is accepted, with a nonblank reason up to 1000
bytes. Returns `{deviceId,revision,context}`; nonexistent devices return 404.
The append-only `device_context_overrides` table stores device, revision, context,
reason and creation time. The latest null entry disables the correction.

An active correction reattributes all existing and future watch facts from that
device to foreground, after original-context legacy overlap clipping. History,
Languages and the legacy dashboard share this effective attribution. Total seconds,
coverage, original events, slices, metadata and saved evidence are unchanged.
Applying/resetting advances the viewing generation, invalidating old History
snapshots. Other devices are unaffected.

`contextOverride` is null or `{context:"foreground",reason,revision,created}`.
Inspectors label corrected attribution and retain access to original evidence.
Reset appends a revision and restores the collector's original context everywhere.

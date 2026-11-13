# History and Searches v1

Owner-authenticated, read-only endpoints. Original collector interpretation is
shown here; optional Languages assessments do not change History.

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
 coveredSeconds,coveragePercent,coverageComplete,rowKind}
```

Native `rowKind:"viewing-version"` groups the same recorded viewing, exact
metadata version, device and local date across bucket/context slices. Different
metadata/evidence versions and dates remain separate. `viewingId` is recorded.
Legacy `rowKind:"legacy-day"` groups metadata/device/date because legacy samples
have no reliable visit identity; `viewingId:null`. Label these **Recorded that
day**, not separate plays. Times describe recorded bounds, not inferred attention
or a reconstructed session start. Coverage is the union within this row; replays
increase elapsed time without increasing already-covered media. `coveredSeconds`
and percent are null if no ranges were recorded; percent is also null without a
usable duration. It is capped at 100 for display. `coverageComplete:false` means
some contributing slices have no ranges: present available coverage as partial.

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
devices:[{id,label,personId,person,kind,searchCapability}]
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

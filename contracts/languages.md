# Languages module v1

Independent owner-authenticated routes under `/api/modules/languages`. Existing
history, ingestion, evidence and `/api/languages` behavior stays independent.
The subject is **audio actually played**. Review groups a video's current saved
versions; assessments remain audited per device/version.

## Read

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

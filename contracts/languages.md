# Languages module v1

Independent owner-authenticated routes under `/api/modules/languages`. Existing
history, ingestion, evidence and `/api/languages` behavior stays independent.
The subject is **audio actually played**. A correction targets the exact stored
metadata version on one device, not all dubs or future observations of a video.

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

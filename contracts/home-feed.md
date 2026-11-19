# Cached feeds and Curated

The TV receives immutable, published snapshots. Curated reads and edits the same
stored rows. No pagination request fetches YouTube.

## TV protocol

`POST /api/device/home`, authenticated with an active device bearer:

```json
{
  "category": "home",
  "accountKey": "stable-sha256-of-selected-account",
  "language": "en",
  "country": "CH",
  "utcOffsetMinutes": 60,
  "visitorData": "",
  "cursor": null
}
```

Categories: `home`, `music`, `news`, `gaming`, `sports`, `live`, `trending`.
Separate `X-YouTube-Authorization` and `X-YouTube-Page-Id` headers supply current
YouTube authorization for refresh. The device bearer never goes to YouTube.
Access tokens are used transiently and are not persisted.

Cache identity includes device ID, selected-account identity, profile, category
and locale. Access-token rotation does not invalidate a new client's cache.
Old clients without `accountKey` are isolated by their access-token hash.

The initial build returns **202** with `{"status":"building"}`; Android retries
while displaying its loading indicator. A refresh failure is explicit and retried
after five minutes. Once a publication exists, stale content remains available
while refreshing or after errors.

```json
{
  "version": 1,
  "source": "owntube",
  "feedId": "opaque-feed-identity",
  "snapshotVersion": 2,
  "rows": [{
    "id": "home:stable-title-hash:0",
    "title": "Recommended",
    "items": [{
      "videoId": "jNQXAC9IVRw",
      "channelId": null,
      "playlistId": null,
      "title": "Me at the zoo",
      "subtitle": "jawed",
      "thumbnail": "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
      "badge": null,
      "isLive": false,
      "isUpcoming": false,
      "isShorts": false
    }],
    "next": "cached-row-cursor"
  }],
  "next": "cached-page-cursor"
}
```

Top-level `next` loads more rows; row `next` loads more cards. Each cursor pins
the feed identity, immutable version and offset, and is checked against the
authenticated request's cache identity. Another account/device cannot use it.
Publishing never changes an in-progress scroll. At least sixteen versions and
every version less than 24 hours old are retained; older cursors return 410.

Eight rows / twelve cards per row are delivered per page. The materialized source
is bounded at 32 rows / 48 cards per row / 100 upstream requests, with a two-minute
build timeout. Limits are visible in Curated. Unsupported promotional/action
tiles are omitted; this is a finite browsing snapshot, not infinite YouTube.

## Refresh and persistence

SQLite stores source snapshots, drafts, published overlays and immutable versions.
Every six hours (UTC windows), a category becomes due for background refresh.
The next first-page TV request supplies current YouTube authorization and starts
one refresh job. No credentials are stored for unattended offline fetching.
An owner can explicitly queue an earlier refresh.

Refresh rebases both saved draft and published rules against the new source.
The published rules produce the next automatic publication; drafts remain drafts.
Explicit removals always win. Additions remain in their chosen rows. Explicit
ordering places surviving ordered cards first, followed by new recommendations.
An added video's destination row is retained if YouTube removes that shelf.
Row identity uses category, title and duplicate-title occurrence; renamed upstream
rows do not silently inherit another row's rules.

`OWNTUBE_HOME_RULES` still enables the gateway; `{}` is sufficient. Its old
experimental insertion/block lists are superseded by the database editor and are
not applied to cached publications. The separate "Added in OwnTube" row is gone.

## Owner API

All routes require an owner session cookie; a device bearer cannot edit.

- `GET /api/curation`: cached feeds, categories, limits and cadence.
- `GET /api/curation/{id}`: source rows, composed draft rows, exact published rows,
  draft/published edits, revision, source generation, published version, latest
  version requested by the TV, refresh timestamps and errors.
- `PUT /api/curation/{id}`: save draft `{revision,generation,edits}`.
- `POST /api/curation/{id}/publish`: atomically save and publish that same shape.
- `POST /api/curation/{id}/refresh`: mark due for the next TV connection.
- `POST /api/curation/resolve`: `{video:"YouTube URL or ID"}` → card metadata
  via the fixed YouTube oEmbed endpoint.

```json
{
  "cardLimit": 48,
  "removed": ["video:abcdefghijk"],
  "blockedChannels": [],
  "rows": {
    "home:stable-title-hash:0": {
      "title": "Recommended",
      "limit": 6,
      "added": [],
      "order": ["video:jNQXAC9IVRw", "video:another-id"]
    }
  }
}
```

Edits are scoped to that device/account/category. Channel removal requires a
known upstream channel ID. Revision and source generation checks return **409**
if another editor or refresh changed the basis of the preview. A successful
publish stores exactly the preview computed from the accepted generation/edits.
TV version reporting means the last version requested, not a display acknowledgement.

`cardLimit` is the category's default maximum cards per row (1–48; omitted/null
means 48). A row's optional `limit` overrides it (1–48; omitted/null inherits the
category default). Limits apply after ordering, additions, deduplication and
removals. They are saved and published with the other edits and survive refreshes.
The source cache retains its full rows, so raising a cap restores available cards.
TV pagination cannot reveal cards past the published cap.

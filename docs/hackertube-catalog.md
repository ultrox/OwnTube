# HackerTube source library

Curated's **Browse HackerTube** opens a local library of HN-recommended videos.
Choose a topic, optionally search, select an existing destination row and position,
then add an individual video or the first N ranked picks. These are ordinary draft
insertions: inspect the preview, save, and publish. Category/row caps still apply.
The published feed does not depend on HackerTube being online.

## Import

Download the official archive once from <https://hackertube.org/data>, then run:

```sh
python3 scripts/import-hackertube.py \
  --archive /absolute/path/hackertube-data.zip \
  --data /absolute/path/to/owntube-data
```

Use the directory containing the server's existing `observer.sqlite3`. The importer
uses only Python's standard library (Python 3.11+). It reads the archive directly,
validates all included records, then transactionally replaces the `hackertube`
catalog. It makes no network requests and does not change saved feeds or drafts.
Reimporting the same archive is idempotent. Download a newer export and rerun to
update the library; previously inserted/published cards retain their metadata.

All catalog tables are defined in `server/src/catalog.sql`, shared by the Rust
server and importer. Browse APIs require an owner session:

- `GET /api/catalog/hackertube`: source metadata, export date, checksum, areas,
  topics and filtered video counts.
- `GET /api/catalog/hackertube/videos?category=...&q=...&offset=0&n=24`: ranked local
  results, up to 48 per request. Category and search are optional.

Ranking is source `score` descending, then video ID for deterministic ties.
Search is a case-insensitive substring match over title, channel, summary and
recommendation explanation. Imported cards use uploader thumbnails (`hqdefault`),
and their subtitles credit HackerTube.

## Selection and provenance

The agreed filter is **`hn.recommenders > 0` and `shelf_life != "news"`**.
A video can have both recommendations and criticism; criticism is not itself an
exclusion. “Dated” videos are included. Labels and summaries are AI-generated.
The dataset does not provide current availability or durations; those are not
verified by this import.

The 2026-10-31 export imported on 2026-11-16 contains:

- 6,454 total records; **4,654 accepted videos**
- 150 topics across 16 areas
- Archive SHA-256:
  `c61bd220d1f3899152f63e6b159eece612f4da49727cc9e970bebba70279892e`

The dataset is released under [ODC-By 1.0](https://opendatacommons.org/licenses/by/1-0/).
Credit [HackerTube](https://hackertube.org) and
[open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news).
Those credits and license links appear in the library. Comments remain the work
of their authors; this import uses video cards and taxonomy, not comment bodies.

## Verification

```sh
python3 scripts/test_import_hackertube.py
node --test apps/backoffice/modules/curated/model.test.js
cd server
cargo test --locked
```

Tests cover filter semantics (including mixed praise/criticism), repeated imports,
invalid imports preserving existing work, owner authentication, category/search
queries, deterministic pagination, batch insertion order and existing card caps.
The real local catalog was browsed by topic and six top picks were inserted at
position 2 in an editor preview. The saved feed remained unchanged and that
test-only preview was discarded. No HackerTube picks were automatically published.

//! Durable product records. Sampling ticks are imported once, never scanned by dashboards.
//! A new collector overwrites cumulative, revisioned viewing slices instead of appending ticks.
use crate::{Error, Result, invalid, now, store::hash};
use axum::http::StatusCode;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const BUCKET_MS: i64 = 900_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub video_id: String,
    pub title: String,
    pub channel: Option<String>,
    pub is_short: Option<bool>,
    pub duration_seconds: Option<f64>,
    pub lang: String,
    pub source: String,
    pub conf: String,
    pub evidence_id: Option<String>,
    pub search_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Fact {
    pub legacy: bool,
    pub latest_end: f64,
    pub device: String,
    pub bucket: i64,
    pub metadata: Metadata,
    pub context: usize,
    pub seconds: f64,
    pub first: f64,
    pub last: f64,
    pub latest_t: f64,
    pub order: i64,
    pub ranges: Vec<[f64; 2]>,
}

pub fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS viewing_state(id INTEGER PRIMARY KEY CHECK(id=1),legacy_seq INTEGER NOT NULL,generation INTEGER NOT NULL);
        INSERT OR IGNORE INTO viewing_state VALUES(1,0,0);
        CREATE TABLE IF NOT EXISTS video_metadata(id TEXT PRIMARY KEY,video_id TEXT NOT NULL,lang TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS video_metadata_video ON video_metadata(video_id);
        CREATE TABLE IF NOT EXISTS viewing_slices(device TEXT NOT NULL REFERENCES devices(id),id TEXT NOT NULL,viewing_id TEXT NOT NULL,bucket INTEGER NOT NULL,metadata_id TEXT NOT NULL REFERENCES video_metadata(id),context INTEGER NOT NULL,seconds REAL NOT NULL,first REAL NOT NULL,last REAL NOT NULL,latest_t REAL NOT NULL,latest_order INTEGER NOT NULL,ranges TEXT NOT NULL,revision INTEGER NOT NULL,body_hash TEXT NOT NULL,origin TEXT NOT NULL,received INTEGER NOT NULL,latest_end REAL NOT NULL,PRIMARY KEY(device,id));
        CREATE INDEX IF NOT EXISTS viewing_slices_window ON viewing_slices(bucket,device);
        CREATE INDEX IF NOT EXISTS viewing_slices_device ON viewing_slices(device,bucket);
        CREATE INDEX IF NOT EXISTS viewing_slices_recent ON viewing_slices(origin,last DESC);
        CREATE INDEX IF NOT EXISTS viewing_slices_activity ON viewing_slices(device,origin,last DESC);
        CREATE INDEX IF NOT EXISTS viewing_slices_viewing ON viewing_slices(device,viewing_id);")
}

fn parse<T: serde::de::DeserializeOwned>(text: &str) -> rusqlite::Result<T> {
    serde_json::from_str(text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

pub fn union(mut ranges: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    ranges.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    let mut merged: Vec<[f64; 2]> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut()
            && range[0] <= last[1]
        {
            last[1] = last[1].max(range[1]);
        } else {
            merged.push(range);
        }
    }
    merged
}

fn context(value: &Value) -> usize {
    match value["playbackContext"].as_str() {
        Some("foreground") => 0,
        Some("background") => 1,
        _ => 2,
    }
}

// Both inputs are already disjoint and ordered on disk. Merge in linear time,
// rather than collecting and sorting years of repeated coverage for each video.
pub fn merge_sorted(a: &[[f64; 2]], b: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut result: Vec<[f64; 2]> = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        let range = if j == b.len() || (i < a.len() && a[i][0] <= b[j][0]) {
            let r = a[i];
            i += 1;
            r
        } else {
            let r = b[j];
            j += 1;
            r
        };
        if let Some(last) = result.last_mut()
            && range[0] <= last[1]
        {
            last[1] = last[1].max(range[1]);
        } else {
            result.push(range);
        }
    }
    result
}

fn metadata(db: &Connection, value: &Metadata) -> rusqlite::Result<String> {
    let payload = serde_json::to_string(value).unwrap();
    let id = hash(&payload);
    db.execute(
        "INSERT OR IGNORE INTO video_metadata VALUES(?,?,?,?)",
        params![id, value.video_id, value.lang, payload],
    )?;
    Ok(id)
}

// One transaction per bounded import chunk. The checkpoint and changes commit together.
// Returning false means caught up. Resuming after a crash cannot duplicate watch time.
pub fn import_chunk(db: &mut Connection) -> rusqlite::Result<bool> {
    let tx = db.transaction()?;
    let through: i64 =
        tx.query_row("SELECT legacy_seq FROM viewing_state WHERE id=1", [], |r| {
            r.get(0)
        })?;
    let rows: Vec<(i64, String, String)> = tx
        .prepare("SELECT seq,device,payload FROM events WHERE seq>? ORDER BY seq LIMIT 2000")?
        .query_map([through], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if rows.is_empty() {
        return Ok(false);
    }
    import_rows(&tx, &rows)?;
    tx.commit()?;
    Ok(true)
}

pub fn import_rows(db: &Connection, rows: &[(i64, String, String)]) -> rusqlite::Result<()> {
    let mut groups: BTreeMap<(String, String), Fact> = BTreeMap::new();
    for (seq, device, payload) in rows {
        let event: Value = parse(payload)?;
        if event["kind"] != "watch" {
            continue;
        }
        let meta: Metadata = parse(payload)?;
        let meta_id = metadata(db, &meta)?;
        let t = event["t"].as_f64().unwrap();
        let seconds = event["seconds"].as_f64().unwrap();
        let end = t + seconds * 1000.;
        let coverage: Option<[f64; 2]> = event
            .get("coverage")
            .map(|v| serde_json::from_value(v.clone()).unwrap());
        let ctx = context(&event);
        let mut cursor = t;
        let mut remaining = seconds;
        while cursor < end {
            let bucket = (cursor / BUCKET_MS as f64).floor() as i64 * BUCKET_MS;
            let next = end.min((bucket + BUCKET_MS) as f64);
            let part = if next == end {
                remaining
            } else {
                (next - cursor) / 1000.
            };
            let id = format!("legacy-{bucket}-{ctx}-{meta_id}");
            let fact = groups.entry((device.clone(), id)).or_insert_with(|| Fact {
                legacy: true,
                latest_end: next,
                device: device.clone(),
                bucket,
                metadata: meta.clone(),
                context: ctx,
                seconds: 0.,
                first: cursor,
                last: next,
                latest_t: t,
                order: *seq,
                ranges: Vec::new(),
            });
            fact.seconds += part;
            fact.first = fact.first.min(cursor);
            fact.last = fact.last.max(next);
            if (t, *seq) > (fact.latest_t, fact.order) {
                fact.latest_t = t;
                fact.order = *seq;
                fact.latest_end = next;
            }
            if let Some([a, b]) = coverage {
                fact.ranges.push([
                    a + (b - a) * (cursor - t) / (seconds * 1000.),
                    a + (b - a) * (next - t) / (seconds * 1000.),
                ]);
            }
            remaining -= part;
            cursor = next;
        }
    }
    for ((device, id), mut fact) in groups {
        let previous:Option<(f64,f64,f64,f64,i64,String,f64)>=db.query_row("SELECT seconds,first,last,latest_t,latest_order,ranges,latest_end FROM viewing_slices WHERE device=? AND id=?",params![device,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
        if let Some((seconds, first, last, t, order, ranges, latest_end)) = previous {
            fact.seconds += seconds;
            fact.first = fact.first.min(first);
            fact.last = fact.last.max(last);
            if (t, order) > (fact.latest_t, fact.order) {
                fact.latest_t = t;
                fact.order = order;
                fact.latest_end = latest_end;
            }
            fact.ranges.extend(parse::<Vec<[f64; 2]>>(&ranges)?);
        }
        fact.ranges = union(fact.ranges);
        let meta_id = metadata(db, &fact.metadata)?;
        db.execute("INSERT INTO viewing_slices VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device,id) DO UPDATE SET seconds=excluded.seconds,first=excluded.first,last=excluded.last,latest_t=excluded.latest_t,latest_order=excluded.latest_order,ranges=excluded.ranges,received=excluded.received,latest_end=excluded.latest_end",params![device,id,format!("legacy-{}",fact.metadata.video_id),fact.bucket,meta_id,fact.context as i64,fact.seconds,fact.first,fact.last,fact.latest_t,fact.order,serde_json::to_string(&fact.ranges).unwrap(),0,"","legacy",now(),fact.latest_end])?;
    }
    if let Some((seq, _, _)) = rows.last() {
        db.execute(
            "UPDATE viewing_state SET generation=generation+?-legacy_seq,legacy_seq=? WHERE id=1",
            params![seq, seq],
        )?;
    }
    Ok(())
}

pub fn generation(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row("SELECT generation FROM viewing_state WHERE id=1", [], |r| {
        r.get(0)
    })
}

pub fn accept(db: &Connection, device: &str, event: &Value) -> Result<()> {
    let meta: Metadata =
        serde_json::from_value(event.clone()).map_err(|_| invalid("Invalid viewing metadata"))?;
    let revision = event["revision"]
        .as_i64()
        .filter(|r| *r > 0 && *r <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid("Invalid viewing revision"))?;
    let viewing = event["viewingId"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 100
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        })
        .ok_or_else(|| invalid("Invalid viewing identity"))?;
    let bucket = event["bucket"]
        .as_i64()
        .filter(|b| *b >= 0 && *b % BUCKET_MS == 0)
        .ok_or_else(|| invalid("Invalid viewing bucket"))?;
    let first = event["t"].as_f64().unwrap();
    let last = event["lastWatched"]
        .as_f64()
        .filter(|t| t.is_finite() && *t > first && *t <= now() as f64 + 60000.)
        .ok_or_else(|| invalid("Invalid viewing end"))?;
    let seconds = event["seconds"].as_f64().unwrap();
    if first < bucket as f64
        || last > (bucket + BUCKET_MS) as f64
        || seconds > (last - first) / 1000. + 0.001
    {
        return Err(invalid("Viewing totals exceed their time interval"));
    }
    let ranges: Vec<[f64; 2]> = serde_json::from_value(event["coverage"].clone())
        .map_err(|_| invalid("Invalid viewing coverage"))?;
    if ranges.len() > 2000
        || ranges.iter().any(|[a, b]| {
            !a.is_finite()
                || !b.is_finite()
                || *a < 0.
                || b <= a
                || *b > meta.duration_seconds.unwrap_or(0.)
        })
    {
        return Err(invalid("Invalid viewing coverage"));
    }
    let ranges = union(ranges);
    if ranges.iter().map(|r| r[1] - r[0]).sum::<f64>() > seconds * 16. + 0.5 {
        return Err(invalid("Viewing coverage exceeds measured playback"));
    }
    let event_id = event["eventId"].as_str().unwrap();
    if event_id.starts_with("legacy-") || viewing.starts_with("legacy-") {
        return Err(invalid("Reserved viewing identity"));
    }
    let collision: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM events WHERE device=? AND event_id=?)",
        params![device, event_id],
        |r| r.get(0),
    )?;
    if collision {
        return Err(Error(
            StatusCode::CONFLICT,
            "Identity already belongs to a legacy event".into(),
        ));
    }
    let body_hash = hash(&event.to_string());
    let meta_id = metadata(db, &meta)?;
    let ctx = context(event);
    type Existing = (i64, String, String, i64, String, i64, f64, f64, f64, String);
    let previous:Option<Existing>=db.query_row("SELECT revision,body_hash,viewing_id,bucket,metadata_id,context,seconds,first,last,ranges FROM viewing_slices WHERE device=? AND id=?",params![device,event_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?))).optional()?;
    if let Some((
        old,
        body,
        old_view,
        old_bucket,
        old_meta,
        old_ctx,
        old_seconds,
        old_first,
        old_last,
        old_ranges,
    )) = previous
    {
        if revision == old && body_hash != body {
            return Err(Error(
                StatusCode::CONFLICT,
                "Viewing revision already has different data".into(),
            ));
        }
        if revision <= old {
            return Ok(());
        }
        let old_ranges: Vec<[f64; 2]> = parse(&old_ranges)?;
        if old_view != viewing
            || old_bucket != bucket
            || old_meta != meta_id
            || old_ctx != ctx as i64
            || first != old_first
            || last < old_last
            || seconds < old_seconds
            || old_ranges.iter().any(|old| {
                !ranges
                    .iter()
                    .any(|new| new[0] <= old[0] && new[1] >= old[1])
            })
        {
            return Err(Error(
                StatusCode::CONFLICT,
                "Viewing revisions must preserve metadata and accumulated playback".into(),
            ));
        }
    }
    db.execute(
        "UPDATE viewing_state SET generation=generation+1 WHERE id=1",
        [],
    )?;
    let order = generation(db)?;
    db.execute("INSERT INTO viewing_slices VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(device,id) DO UPDATE SET seconds=excluded.seconds,last=excluded.last,latest_t=excluded.latest_t,latest_order=excluded.latest_order,ranges=excluded.ranges,revision=excluded.revision,body_hash=excluded.body_hash,received=excluded.received,latest_end=excluded.latest_end",params![device,event_id,viewing,bucket,meta_id,ctx as i64,seconds,first,last,last,order,serde_json::to_string(&ranges).unwrap(),revision,body_hash,"viewing",now(),last])?;
    Ok(())
}

pub fn facts(
    db: &Connection,
    since: i64,
    until: i64,
    coverage: bool,
) -> rusqlite::Result<Vec<Fact>> {
    let mut query=db.prepare("SELECT s.device,s.bucket,m.payload,s.context,s.seconds,s.first,s.last,s.latest_t,s.latest_order,CASE WHEN ? THEN s.ranges ELSE '[]' END,s.origin,s.latest_end FROM viewing_slices s JOIN video_metadata m ON m.id=s.metadata_id WHERE s.bucket>=? AND s.bucket<?")?;
    let rows = query
        .query_map(
            params![coverage, since.div_euclid(BUCKET_MS) * BUCKET_MS, until],
            |r| {
                Ok(Fact {
                    device: r.get(0)?,
                    bucket: r.get(1)?,
                    metadata: parse(&r.get::<_, String>(2)?)?,
                    context: r.get::<_, i64>(3)? as usize,
                    seconds: r.get(4)?,
                    first: r.get(5)?,
                    last: r.get(6)?,
                    latest_t: r.get(7)?,
                    order: r.get(8)?,
                    ranges: parse(&r.get::<_, String>(9)?)?,
                    legacy: r.get::<_, String>(10)? == "legacy",
                    latest_end: r.get(11)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn progress(db: &Connection) -> rusqlite::Result<Value> {
    let (seq, generation): (i64, i64) = db.query_row(
        "SELECT legacy_seq,generation FROM viewing_state WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let records: i64 = db.query_row("SELECT COUNT(*) FROM viewing_slices", [], |r| r.get(0))?;
    let latest: i64 = db.query_row("SELECT COALESCE(MAX(seq),0) FROM events", [], |r| r.get(0))?;
    Ok(
        json!({"readModel":"disk-backed cumulative viewing records","processedLegacySeq":seq,"acceptedLegacySeq":latest,"legacyLag":latest-seq,"committedRevision":generation,"compactRecords":records,"processedAt":now()}),
    )
}

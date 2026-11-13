//! Read-only editorial History. Visits are only identified when the collector saved an ID.
use crate::{
    App, Error, Result,
    analytics::{Analytics, Window},
    compact::{self, Metadata},
    invalid, now, owner,
    store::{Store, dashboard_metadata, hash},
};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use chrono::TimeZone;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const PAGE_SIZE: usize = 20;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    days: Option<u32>,
    #[serde(default)]
    device: String,
    #[serde(default)]
    person: String,
    #[serde(default)]
    query: String,
    page: Option<usize>,
    generation: Option<i64>,
    before: Option<i64>,
    until: Option<i64>,
}
impl Filters {
    fn validate(&self, searches: bool) -> Result<()> {
        let token = if searches {
            self.before
        } else {
            self.generation
        };
        if ![7, 30, 90].contains(&self.days.unwrap_or(7))
            || self.page == Some(0)
            || self.query.chars().count() > 200
            || self.device.len() > 200
            || self.person.len() > 200
            || token.is_some() != self.until.is_some()
            || token.is_some_and(|n| n < 0)
            || self.until.is_some_and(|n| n <= 0 || n > now())
            || (searches && self.generation.is_some())
            || (!searches && self.before.is_some())
        {
            return Err(invalid("Invalid history filters or paging snapshot"));
        }
        Ok(())
    }
    fn selects(&self, d: &Value) -> bool {
        (self.device.is_empty() || d["id"] == self.device)
            && (self.person.is_empty()
                || d["personId"] == self.person
                || (self.person == "unassigned" && d["personId"].is_null()))
    }
}

fn decode<T: serde::de::DeserializeOwned>(text: &str) -> Result<T> {
    serde_json::from_str(text).map_err(|_| {
        Error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid saved history data".into(),
        )
    })
}

/// Device labels are user-editable: never infer a collector from "TV" or "Laptop".
fn metadata(db: &Connection) -> Result<(Vec<Value>, Vec<Value>)> {
    let (mut devices, people) = dashboard_metadata(db)?;
    let mut kinds: BTreeMap<String, (bool, bool)> = BTreeMap::new();
    let mut stmt = db.prepare(
        "SELECT DISTINCT s.device,json_extract(m.payload,'$.source'),
         json_extract(e.payload,'$.collector'),json_extract(e.payload,'$.algorithmVersion')
         FROM (SELECT DISTINCT device,metadata_id FROM viewing_slices) s
         JOIN video_metadata m ON m.id=s.metadata_id
         LEFT JOIN evidence e ON e.id=json_extract(m.payload,'$.evidenceId')",
    )?;
    for item in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })? {
        let (device, source, collector, algorithm) = item?;
        let flags = kinds.entry(device).or_default();
        flags.0 |= algorithm
            .as_deref()
            .is_some_and(|a| a.starts_with("language-"));
        flags.1 |= source == "android-player"
            || collector
                .as_deref()
                .is_some_and(|c| c.starts_with("owntube-source-"));
    }
    let mut searches = db.prepare("SELECT DISTINCT device FROM events WHERE kind='search'")?;
    for device in searches.query_map([], |r| r.get::<_, String>(0))? {
        kinds.entry(device?).or_default().0 = true;
    }
    for d in &mut devices {
        let (browser, tv) = kinds
            .get(d["id"].as_str().unwrap())
            .copied()
            .unwrap_or_default();
        d["kind"] = json!(match (browser, tv) {
            (true, true) => "mixed",
            (true, false) => "browser",
            (false, true) => "tv",
            _ => "unknown",
        });
        d["searchCapability"] = json!(if browser {
            "recorded"
        } else if tv {
            "not-recorded"
        } else {
            "unknown"
        });
    }
    Ok((devices, people))
}

fn recorded(m: &Metadata) -> Value {
    json!({"lang":m.lang,"source":m.source,"conf":m.conf})
}

struct Row {
    device: Value,
    meta: Metadata,
    metadata_id: String,
    viewing_id: Option<String>,
    date: String,
    first: f64,
    last: f64,
    context: [f64; 3],
    ranges: Vec<[f64; 2]>,
    coverage_complete: bool,
}
impl Row {
    fn seconds(&self) -> f64 {
        self.context.iter().sum()
    }
    fn value(&self) -> Value {
        let covered =
            (!self.ranges.is_empty()).then(|| self.ranges.iter().map(|r| r[1] - r[0]).sum::<f64>());
        let percent = covered
            .zip(self.meta.duration_seconds.filter(|d| *d > 0.))
            .map(|(c, d)| (c / d * 100.).min(100.));
        let id = hash(
            &json!([
                self.device["id"],
                self.viewing_id,
                self.metadata_id,
                self.date
            ])
            .to_string(),
        );
        json!({
            "id":id,"deviceId":self.device["id"],"deviceLabel":self.device["label"],
            "deviceKind":self.device["kind"],"personId":self.device["personId"],"person":self.device["person"],
            "viewingId":self.viewing_id,"metadataId":self.metadata_id,"videoId":self.meta.video_id,
            "title":self.meta.title,"channel":self.meta.channel,"isShort":self.meta.is_short,
            "durationSeconds":self.meta.duration_seconds,"evidenceId":self.meta.evidence_id,
            "recorded":recorded(&self.meta),"date":self.date,"firstWatched":self.first,"lastWatched":self.last,
            "seconds":self.seconds(),"foregroundSeconds":self.context[0],"backgroundSeconds":self.context[1],
            "unspecifiedSeconds":self.context[2],"coveredSeconds":covered,"coveragePercent":percent,
            "coverageComplete":self.coverage_complete,
            "contextOverride":self.device["contextOverride"],
            "rowKind":if self.viewing_id.is_some() {"viewing-version"} else {"legacy-day"}
        })
    }
}

#[derive(Default)]
struct Day {
    context: [f64; 3],
    count: usize,
    filtered: usize,
}

impl Store {
    pub async fn history(&self, filter: Filters, tz: chrono_tz::Tz) -> Result<Value> {
        filter.validate(false)?;
        self.sync_legacy().await?;
        self.read(move |db| {
            // Store::read supplies one SQLite snapshot for generation, totals and page.
            let generation = compact::generation(db)?;
            if filter.generation.is_some_and(|g| g != generation) {
                return Err(Error(StatusCode::GONE, "History changed. Refresh to load current records.".into()));
            }
            let days = filter.days.unwrap_or(7);
            let window = Window::new(days, filter.until.unwrap_or_else(now), i64::MAX, tz);
            let (devices, people) = metadata(db)?;
            let selected: BTreeMap<_, _> = devices.iter().filter(|d| filter.selects(d))
                .map(|d| (d["id"].as_str().unwrap(), d)).collect();
            let facts = Analytics::load(db, &window)?;
            let mut rows: BTreeMap<(String, Option<String>, String, String), Row> = BTreeMap::new();
            for f in facts.facts() {
                let Some(device) = selected.get(f.device.as_str()) else { continue };
                let date = tz.timestamp_millis_opt(f.first.floor() as i64).unwrap().date_naive().to_string();
                let mid = hash(&serde_json::to_string(&f.metadata).unwrap());
                let viewing = (!f.legacy).then(|| f.viewing_id.clone());
                let key = (f.device.clone(), viewing.clone(), mid.clone(), date.clone());
                let r = rows.entry(key).or_insert_with(|| Row {
                    device: (*device).clone(), meta: f.metadata.clone(), metadata_id: mid, viewing_id: viewing,
                    date, first: f.first, last: f.last, context: [0.; 3], ranges: Vec::new(), coverage_complete: true,
                });
                r.first = r.first.min(f.first);
                r.last = r.last.max(f.last);
                r.context[f.context] += f.seconds;
                r.ranges = compact::merge_sorted(&r.ranges, &f.ranges);
                r.coverage_complete &= !f.ranges.is_empty();
            }
            let mut daily: BTreeMap<String, Day> = window.dates.iter().map(|d| (d.clone(), Day::default())).collect();
            let mut context = [0.; 3];
            let mut video_ids = BTreeSet::new();
            let count = rows.len();
            let query = filter.query.trim().to_lowercase();
            let mut matched = Vec::new();
            for r in rows.into_values() {
                let day = daily.get_mut(&r.date).expect("fact belongs to window");
                day.count += 1;
                for i in 0..3 {
                    context[i] += r.context[i];
                    day.context[i] += r.context[i];
                }
                video_ids.insert(r.meta.video_id.clone());
                if query.is_empty() || format!("{} {} {}", r.meta.title, r.meta.channel.as_deref().unwrap_or(""), r.meta.video_id).to_lowercase().contains(&query) {
                    day.filtered += 1;
                    matched.push(r);
                }
            }
            matched.sort_by(|a,b| b.last.total_cmp(&a.last)
                .then(a.device["id"].as_str().cmp(&b.device["id"].as_str()))
                .then(a.viewing_id.cmp(&b.viewing_id)).then(a.metadata_id.cmp(&b.metadata_id))
                .then(a.date.cmp(&b.date)));
            let filtered = matched.len();
            let pages = filtered.div_ceil(PAGE_SIZE).max(1);
            let page = filter.page.unwrap_or(1).min(pages);
            let seconds: f64 = context.iter().sum();
            Ok(json!({
                "seconds":seconds,"foregroundSeconds":context[0],"backgroundSeconds":context[1],
                "unspecifiedSeconds":context[2],"videoCount":video_ids.len(),"perCalendarDaySeconds":seconds/f64::from(days),
                "days":days,"timezone":tz.to_string(),"since":window.since,"until":window.until,"generation":generation,
                "devices":devices,"people":people,"count":count,"filteredCount":filtered,"page":page,"pages":pages,"pageSize":PAGE_SIZE,
                "daily":daily.into_iter().map(|(date,d)| json!({"date":date,"seconds":d.context.iter().sum::<f64>(),
                    "foregroundSeconds":d.context[0],"backgroundSeconds":d.context[1],"unspecifiedSeconds":d.context[2],
                    "rowCount":d.count,"filteredCount":d.filtered})).collect::<Vec<_>>(),
                "rows":matched.iter().skip((page-1)*PAGE_SIZE).take(PAGE_SIZE).map(Row::value).collect::<Vec<_>>()
            }))
        }).await
    }

    pub async fn history_searches(&self, filter: Filters, tz: chrono_tz::Tz) -> Result<Value> {
        filter.validate(true)?;
        self.sync_legacy().await?;
        self.read(move |db| {
            let days = filter.days.unwrap_or(7);
            let window = Window::new(days, filter.until.unwrap_or_else(now), i64::MAX, tz);
            let before = match filter.before {
                Some(n) => n,
                None => db.query_row("SELECT COALESCE(MAX(seq),0) FROM events", [], |r| r.get(0))?,
            };
            let (devices, people) = metadata(db)?;
            let selected: BTreeMap<_, _> = devices.iter().filter(|d| filter.selects(d))
                .map(|d| (d["id"].as_str().unwrap(), d)).collect();
            let capability = if selected.values().any(|d| d["searchCapability"] == "recorded") {
                "recorded"
            } else if !selected.is_empty() && selected.values().all(|d| d["searchCapability"] == "not-recorded") {
                "not-recorded"
            } else { "unknown" };
            let mut stmt = db.prepare("SELECT seq,event_id,device,t,payload FROM events
                WHERE kind='search' AND t>=? AND t<? AND seq<=? ORDER BY t DESC,seq DESC")?;
            let saved = stmt.query_map(params![window.since,window.until,before], |r| {
                Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,
                    r.get::<_,f64>(3)?,r.get::<_,String>(4)?))
            })?;
            let query = filter.query.trim().to_lowercase();
            let mut count = 0;
            let mut rows = Vec::new();
            let mut daily: BTreeMap<String, (usize, usize)> = window.dates.iter()
                .map(|date| (date.clone(), (0, 0))).collect();
            for item in saved {
                let (id, event_id, device_id, t, payload) = item?;
                let Some(device) = selected.get(device_id.as_str()) else { continue };
                let e: Value = decode(&payload)?;
                count += 1;
                let stamp = tz.timestamp_millis_opt(t.floor() as i64).unwrap();
                let date = stamp.date_naive().to_string();
                let day = daily.get_mut(&date).expect("search belongs to window");
                day.0 += 1;
                if !query.is_empty() && !e["query"].as_str().unwrap_or("").to_lowercase().contains(&query) {
                    continue;
                }
                day.1 += 1;
                rows.push(json!({
                    "id":id,"eventId":event_id,"deviceId":device_id,"deviceLabel":device["label"],
                    "deviceKind":device["kind"],"personId":device["personId"],"person":device["person"],
                    "query":e["query"],"t":t,"date":date,
                    "timeLabel":stamp.format("%H:%M").to_string(),"lang":e["lang"],"source":e["source"],"conf":e["conf"]
                }));
            }
            let filtered = rows.len();
            let pages = filtered.div_ceil(PAGE_SIZE).max(1);
            let page = filter.page.unwrap_or(1).min(pages);
            Ok(json!({
                "days":days,"timezone":tz.to_string(),"since":window.since,"until":window.until,"before":before,
                "devices":devices,"people":people,"count":count,"filteredCount":filtered,"page":page,"pages":pages,
                "pageSize":PAGE_SIZE,"searchCapability":capability,
                "daily":daily.into_iter().map(|(date,(count,filtered))|
                    json!({"date":date,"count":count,"filteredCount":filtered})).collect::<Vec<_>>(),
                "rows":rows.into_iter().skip((page-1)*PAGE_SIZE).take(PAGE_SIZE).collect::<Vec<_>>()
            }))
        }).await
    }

    pub async fn history_evidence(&self, device: String, id: String) -> Result<Value> {
        if device.is_empty()
            || device.len() > 200
            || id.len() != 64
            || !id.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(invalid("Invalid recorded version identity"));
        }
        self.read(move |db| {
            let saved: Option<(String, Option<String>)> = db.query_row(
                "SELECT m.payload,e.payload FROM video_metadata m
                 LEFT JOIN evidence e ON e.id=json_extract(m.payload,'$.evidenceId')
                 WHERE m.id=? AND EXISTS(SELECT 1 FROM viewing_slices s WHERE s.device=? AND s.metadata_id=m.id)",
                params![id,device], |r| Ok((r.get(0)?,r.get(1)?)),
            ).optional()?;
            let (payload, text) = saved.ok_or_else(|| Error(StatusCode::NOT_FOUND, "Recorded version not found".into()))?;
            let meta: Metadata = decode(&payload)?;
            let evidence = text.as_deref().map(decode::<Value>).transpose()?;
            Ok(json!({
                "deviceId":device,"metadataId":id,"videoId":meta.video_id,"title":meta.title,
                "evidenceId":meta.evidence_id,"evidenceText":text,"evidence":evidence,"recorded":recorded(&meta)
            }))
        }).await
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    device: String,
    metadata: String,
}

pub async fn watched(
    State(app): State<App>,
    headers: HeaderMap,
    Query(filter): Query<Filters>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.history(filter, app.timezone).await?))
}
pub async fn searches(
    State(app): State<App>,
    headers: HeaderMap,
    Query(filter): Query<Filters>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(
        app.store.history_searches(filter, app.timezone).await?,
    ))
}
pub async fn evidence(
    State(app): State<App>,
    headers: HeaderMap,
    Query(target): Query<Target>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(
        app.store
            .history_evidence(target.device, target.metadata)
            .await?,
    ))
}

#[cfg(test)]
mod tests;

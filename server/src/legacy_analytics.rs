//! Frozen pre-rewrite oracle, used only by migration parity tests.
//! Decode each watch event once, rather than re-decoding the entire history per request.
#![allow(dead_code)] // Frozen oracle deliberately retains the pre-rewrite API.
use crate::Result;
use chrono::{Days, TimeZone};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
};

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    video_id: String,
    title: String,
    channel: Option<String>,
    is_short: Option<bool>,
    duration_seconds: Option<f64>,
    lang: String,
    source: String,
    conf: String,
    evidence_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    t: f64,
    seconds: f64,
    coverage: Option<[f64; 2]>,
    playback_context: Option<String>,
    #[serde(flatten)]
    metadata: Metadata,
}

struct Watch {
    seq: i64,
    device: usize,
    t: f64,
    seconds: f64,
    coverage: Option<[f64; 2]>,
    context: usize,
    metadata: Arc<Metadata>,
}

#[derive(Default)]
pub struct WatchCache {
    through: i64,
    devices: Vec<String>,
    watches: Vec<Watch>,
    metadata: HashMap<(usize, String), Arc<Metadata>>,
}

pub struct Window {
    pub since: i64,
    pub until: i64,
    pub before: i64,
    pub dates: Vec<String>,
    boundaries: Vec<f64>,
}

impl Window {
    pub fn new(days: u32, until: i64, before: i64, tz: chrono_tz::Tz) -> Self {
        let today = tz.timestamp_millis_opt(until).unwrap().date_naive();
        let first = today
            .checked_sub_days(Days::new((days - 1) as u64))
            .unwrap();
        let mut dates = Vec::new();
        let mut boundaries = Vec::new();
        for offset in 0..=days {
            let date = first.checked_add_days(Days::new(offset as u64)).unwrap();
            boundaries.push(
                tz.from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
                    .earliest()
                    .unwrap()
                    .timestamp_millis() as f64,
            );
            if offset < days {
                dates.push(date.to_string());
            }
        }
        Self {
            since: boundaries[0] as i64,
            until,
            before,
            dates,
            boundaries,
        }
    }

    fn clip(&self, watch: &Watch) -> Option<(f64, f64, f64)> {
        if watch.seq > self.before {
            return None;
        }
        let original_end = watch.t + watch.seconds * 1000.;
        let start = watch.t.max(self.since as f64);
        let end = original_end.min(self.until as f64);
        (end > start).then(|| {
            (
                start,
                end,
                watch.seconds - ((start - watch.t) + (original_end - end)) / 1000.,
            )
        })
    }
}

struct DeviceScope {
    selected: bool,
    person_id: Option<String>,
    person: String,
    viewer: String,
}

pub struct Summary {
    pub seconds: f64,
    pub short_seconds: f64,
    pub context: [f64; 3],
    pub languages: BTreeMap<String, f64>,
    pub daily: Vec<Value>,
    pub videos: Vec<Value>,
}

struct Video {
    metadata: Arc<Metadata>,
    person_id: Option<String>,
    person: String,
    seconds: f64,
    context: [f64; 3],
    last_watched: f64,
    ranges: Vec<(f64, f64)>,
}

impl WatchCache {
    pub fn progress(&self) -> Value {
        json!({"readModel":"in-memory candidate","processedSeq":self.through,"watchRecords":self.watches.len(),"processedAt":crate::now()})
    }

    pub fn rows_in_window(&self, window: &Window) -> u64 {
        let first = self
            .watches
            .partition_point(|w| w.t < (window.since - 20000) as f64);
        let end = self.watches.partition_point(|w| w.t < window.until as f64);
        (end - first) as u64
    }
    pub fn sync(&mut self, db: &Connection) -> rusqlite::Result<()> {
        let latest: i64 =
            db.query_row("SELECT COALESCE(MAX(seq),0) FROM events", [], |r| r.get(0))?;
        if latest == self.through {
            return Ok(());
        }
        // Stage all rows first: a read/decode error must not leave a partially advanced cache.
        let mut query = db.prepare("SELECT seq,device,payload FROM events NOT INDEXED WHERE seq>? AND seq<=? AND kind='watch' ORDER BY seq")?;
        let rows = query
            .query_map(params![self.through, latest], |r| {
                let payload: String = r.get(2)?;
                let value: Payload = serde_json::from_str(&payload).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, value))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (seq, device, value) in rows {
            let device = self
                .devices
                .iter()
                .position(|id| *id == device)
                .unwrap_or_else(|| {
                    self.devices.push(device);
                    self.devices.len() - 1
                });
            let key = (device, value.metadata.video_id.clone());
            let metadata = self
                .metadata
                .entry(key)
                .or_insert_with(|| Arc::new(value.metadata.clone()));
            if **metadata != value.metadata {
                *metadata = Arc::new(value.metadata);
            }
            self.watches.push(Watch {
                seq,
                device,
                t: value.t,
                seconds: value.seconds,
                coverage: value.coverage,
                context: match value.playback_context.as_deref() {
                    Some("foreground") => 0,
                    Some("background") => 1,
                    _ => 2,
                },
                metadata: metadata.clone(),
            });
        }
        // Late/offline uploads can precede existing timestamps. Keep exact time/sequence ordering.
        self.watches
            .sort_by(|a, b| a.t.total_cmp(&b.t).then(a.seq.cmp(&b.seq)));
        self.through = latest;
        Ok(())
    }

    fn scopes(&self, devices: &[Value], device: &str, person: &str) -> Vec<DeviceScope> {
        self.devices
            .iter()
            .map(|id| {
                let d = devices.iter().find(|d| d["id"] == *id);
                let person_id = d.and_then(|d| d["personId"].as_str()).map(str::to_owned);
                let name = d.and_then(|d| d["person"].as_str()).unwrap_or("");
                DeviceScope {
                    selected: d.is_some()
                        && (device.is_empty() || device == id)
                        && (person.is_empty()
                            || person_id.as_deref() == Some(person)
                            || (person != "unassigned" && person == name)
                            || (person == "unassigned" && person_id.is_none())),
                    viewer: person_id.clone().unwrap_or_else(|| format!("device:{id}")),
                    person: if person_id.is_some() {
                        name.to_owned()
                    } else {
                        format!(
                            "Unassigned · {}",
                            d.and_then(|d| d["label"].as_str()).unwrap_or("")
                        )
                    },
                    person_id,
                }
            })
            .collect()
    }

    fn in_window<'a>(&'a self, window: &'a Window) -> impl Iterator<Item = &'a Watch> {
        let first = self
            .watches
            .partition_point(|w| w.t < (window.since - 20000) as f64);
        self.watches[first..]
            .iter()
            .take_while(|w| w.t < window.until as f64)
    }

    pub fn languages(
        &self,
        window: &Window,
        devices: &[Value],
        device: &str,
        person: &str,
    ) -> BTreeMap<String, f64> {
        let scopes = self.scopes(devices, device, person);
        let mut totals = BTreeMap::new();
        for watch in self.in_window(window) {
            if scopes[watch.device].selected
                && let Some((_, _, seconds)) = window.clip(watch)
            {
                *totals.entry(watch.metadata.lang.clone()).or_default() += seconds;
            }
        }
        totals
    }

    pub fn review(
        &self,
        window: &Window,
        devices: &[Value],
        device: &str,
        person: &str,
        page: usize,
    ) -> Value {
        let scopes = self.scopes(devices, device, person);
        let mut videos: BTreeMap<String, (Arc<Metadata>, f64)> = BTreeMap::new();
        for watch in self.in_window(window) {
            if scopes[watch.device].selected
                && matches!(watch.metadata.lang.as_str(), "und" | "other" | "")
                && let Some((_, _, seconds)) = window.clip(watch)
            {
                let video = videos
                    .entry(watch.metadata.video_id.clone())
                    .or_insert_with(|| (watch.metadata.clone(), 0.));
                video.0 = watch.metadata.clone();
                video.1 += seconds;
            }
        }
        let mut videos: Vec<_> = videos.into_values().collect();
        videos.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.video_id.cmp(&b.0.video_id)));
        let count = videos.len();
        let pages = count.div_ceil(20).max(1);
        let page = page.min(pages).max(1);
        let videos: Vec<_> = videos.into_iter().skip((page - 1) * 20).take(20).map(|(m, seconds)| json!({"videoId":m.video_id,"title":m.title,"channel":m.channel,"lang":m.lang,"source":m.source,"conf":m.conf,"seconds":seconds})).collect();
        json!({"videos":videos,"count":count,"page":page,"pages":pages})
    }

    pub fn summary(
        &self,
        window: &Window,
        devices: &[Value],
        people: &mut [Value],
        device: &str,
        person: &str,
        tz: chrono_tz::Tz,
    ) -> Result<Summary> {
        let scopes = self.scopes(devices, device, person);
        let mut people_totals: BTreeMap<&str, (f64, BTreeSet<&str>)> = BTreeMap::new();
        let mut videos: BTreeMap<String, Video> = BTreeMap::new();
        let mut daily = vec![(0., 0., [0.; 3]); window.dates.len()];
        let mut result = Summary {
            seconds: 0.,
            short_seconds: 0.,
            context: [0.; 3],
            languages: BTreeMap::new(),
            daily: Vec::new(),
            videos: Vec::new(),
        };
        for watch in self.in_window(window) {
            let Some((start, end, seconds)) = window.clip(watch) else {
                continue;
            };
            let scope = &scopes[watch.device];
            let meta = &watch.metadata;
            if let Some(id) = scope.person_id.as_deref() {
                let p = people_totals.entry(id).or_default();
                p.0 += seconds;
                p.1.insert(&meta.video_id);
            }
            if !scope.selected {
                continue;
            }
            result.seconds += seconds;
            result.context[watch.context] += seconds;
            if meta.is_short == Some(true) {
                result.short_seconds += seconds;
            }
            *result.languages.entry(meta.lang.clone()).or_default() += seconds;
            let mut cursor = start;
            let mut remaining = seconds;
            let mut day = window.boundaries.partition_point(|t| *t <= start) - 1;
            while cursor < end {
                let next = window.boundaries[day + 1].min(end);
                let part = if next == end {
                    remaining
                } else {
                    (next - cursor) / 1000.
                };
                daily[day].0 += part;
                if meta.is_short == Some(true) {
                    daily[day].1 += part;
                }
                daily[day].2[watch.context] += part;
                remaining -= part;
                cursor = next;
                day += 1;
            }
            let key = format!("{}/{}", scope.viewer, meta.video_id);
            let video = videos.entry(key).or_insert_with(|| Video {
                metadata: meta.clone(),
                person_id: scope.person_id.clone(),
                person: scope.person.clone(),
                seconds: 0.,
                context: [0.; 3],
                last_watched: end,
                ranges: Vec::new(),
            });
            video.seconds += seconds;
            video.context[watch.context] += seconds;
            video.metadata = meta.clone();
            video.last_watched = end;
            if let Some([a, b]) = watch.coverage {
                let span = b - a;
                let ms = watch.seconds * 1000.;
                video.ranges.push((
                    a + span * (start - watch.t) / ms,
                    a + span * (end - watch.t) / ms,
                ));
            }
        }
        for p in people {
            if let Some((seconds, ids)) = p["id"].as_str().and_then(|id| people_totals.get(id)) {
                p["seconds"] = json!(seconds);
                p["videoCount"] = json!(ids.len());
            }
        }
        result.daily = window.dates.iter().zip(daily).map(|(date, (seconds, short, context))| json!({"date":date,"seconds":seconds,"shortSeconds":short,"regularSeconds":seconds-short,"foregroundSeconds":context[0],"backgroundSeconds":context[1],"unspecifiedSeconds":context[2]})).collect();
        result.videos = videos.into_iter().map(|(id, mut v)| {
            v.ranges.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut covered = 0.; let mut end = 0_f64;
            for (a, b) in v.ranges { covered += (b - a.max(end)).max(0.); end = end.max(b); }
            let m = &v.metadata;
            json!({"historyId":id,"videoId":m.video_id,"personId":v.person_id,"person":v.person,"seconds":v.seconds,"foregroundSeconds":v.context[0],"backgroundSeconds":v.context[1],"unspecifiedSeconds":v.context[2],"title":m.title,"channel":m.channel,"isShort":m.is_short,"durationSeconds":m.duration_seconds,"lang":m.lang,"source":m.source,"conf":m.conf,"evidenceId":m.evidence_id,"lastWatched":v.last_watched,"lastWatchedLabel":tz.timestamp_millis_opt(v.last_watched as i64).unwrap().format("%d %b · %H:%M").to_string(),"coveredSeconds":covered,"completed":m.duration_seconds.is_some_and(|d| d>0. && covered>=d*0.9)})
        }).collect();
        Ok(result)
    }
}

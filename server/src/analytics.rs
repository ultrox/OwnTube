use crate::{
    Result,
    compact::{self, Fact, Metadata},
};
use chrono::{Days, TimeZone};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub struct Window {
    pub since: i64,
    pub until: i64,
    pub before: i64,
    pub dates: Vec<String>,
}
impl Window {
    pub fn new(days: u32, until: i64, before: i64, tz: chrono_tz::Tz) -> Self {
        let today = tz.timestamp_millis_opt(until).unwrap().date_naive();
        let first = today
            .checked_sub_days(Days::new((days - 1) as u64))
            .unwrap();
        let since = tz
            .from_local_datetime(&first.and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .unwrap()
            .timestamp_millis();
        Self {
            since,
            until,
            before,
            dates: (0..days)
                .map(|n| {
                    first
                        .checked_add_days(Days::new(n as u64))
                        .unwrap()
                        .to_string()
                })
                .collect(),
        }
    }
}

pub struct Analytics {
    facts: Vec<Fact>,
}
pub struct Summary {
    pub seconds: f64,
    pub short_seconds: f64,
    pub context: [f64; 3],
    pub languages: BTreeMap<String, f64>,
    pub daily: Vec<Value>,
    pub videos: Vec<Value>,
}
struct Scope {
    selected: bool,
    person_id: Option<String>,
    person: String,
    viewer: String,
}
struct Video {
    metadata: Metadata,
    person_id: Option<String>,
    person: String,
    seconds: f64,
    context: [f64; 3],
    last: f64,
    latest: (f64, i64),
    ranges: Vec<[f64; 2]>,
}

impl Analytics {
    pub fn load(db: &Connection, window: &Window) -> Result<Self> {
        Self::load_records(db, window, true)
    }
    pub fn load_totals(db: &Connection, window: &Window) -> Result<Self> {
        Self::load_records(db, window, false)
    }
    fn load_records(db: &Connection, window: &Window, coverage: bool) -> Result<Self> {
        let rows = compact::facts(db, window.since, window.until, coverage)?;
        let mut facts = Vec::new();
        for mut fact in rows {
            if fact.last <= window.since as f64 || fact.first >= window.until as f64 {
                continue;
            }
            if fact.first >= window.since as f64 && fact.last <= window.until as f64 {
                facts.push(fact);
                continue;
            }
            if !fact.legacy {
                return Err(crate::invalid(
                    "Cutoff intersects a cumulative viewing. Use a 15-minute UTC boundary or refresh current data.",
                ));
            }
            // Only an incomplete edge bucket needs the original legacy measurements.
            // Never interpolate cumulative totals across pauses or seeks.
            let mut query=db.prepare("SELECT seq,payload FROM events WHERE device=? AND kind='watch' AND t>=? AND t<? ORDER BY t,seq")?;
            let events = query
                .query_map(
                    params![
                        fact.device,
                        fact.bucket - 20000,
                        fact.bucket + compact::BUCKET_MS
                    ],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            fact.seconds = 0.;
            fact.ranges.clear();
            fact.first = f64::INFINITY;
            fact.last = 0.;
            fact.latest_t = 0.;
            fact.order = 0;
            for (seq, payload) in events {
                let event: Value = serde_json::from_str(&payload)
                    .map_err(|_| crate::invalid("Invalid saved event"))?;
                let meta: Metadata = serde_json::from_str(&payload)
                    .map_err(|_| crate::invalid("Invalid saved metadata"))?;
                let ctx = match event["playbackContext"].as_str() {
                    Some("foreground") => 0,
                    Some("background") => 1,
                    _ => 2,
                };
                if meta != fact.metadata || ctx != fact.context || seq > window.before {
                    continue;
                }
                let t = event["t"].as_f64().unwrap();
                let measured = event["seconds"].as_f64().unwrap();
                let end = t + measured * 1000.;
                let start = t.max(window.since as f64).max(fact.bucket as f64);
                let clipped_end = end
                    .min(window.until as f64)
                    .min((fact.bucket + compact::BUCKET_MS) as f64);
                if clipped_end <= start {
                    continue;
                }
                fact.seconds += measured - ((start - t) + (end - clipped_end)) / 1000.;
                fact.first = fact.first.min(start);
                fact.last = fact.last.max(clipped_end);
                if (t, seq) >= (fact.latest_t, fact.order) {
                    fact.latest_t = t;
                    fact.order = seq;
                    fact.latest_end = clipped_end;
                }
                if let Some(a) = event["coverage"].as_array() {
                    let a0 = a[0].as_f64().unwrap();
                    let span = a[1].as_f64().unwrap() - a0;
                    fact.ranges.push([
                        a0 + span * (start - t) / (measured * 1000.),
                        a0 + span * (clipped_end - t) / (measured * 1000.),
                    ]);
                }
            }
            if fact.seconds > 0. {
                fact.ranges = compact::union(fact.ranges);
                facts.push(fact);
            }
        }
        Ok(Self { facts })
    }
    pub fn row_count(&self) -> u64 {
        self.facts.len() as u64
    }
    pub(crate) fn facts(&self) -> &[Fact] {
        &self.facts
    }
    fn scopes(devices: &[Value], device: &str, person: &str) -> BTreeMap<String, Scope> {
        devices
            .iter()
            .map(|d| {
                let id = d["id"].as_str().unwrap();
                let pid = d["personId"].as_str();
                let name = d["person"].as_str().unwrap_or("");
                (
                    id.to_owned(),
                    Scope {
                        selected: (device.is_empty() || device == id)
                            && (person.is_empty()
                                || pid == Some(person)
                                || (person != "unassigned" && name == person)
                                || (person == "unassigned" && pid.is_none())),
                        person_id: pid.map(str::to_owned),
                        person: if pid.is_some() {
                            name.to_owned()
                        } else {
                            format!("Unassigned · {}", d["label"].as_str().unwrap_or(""))
                        },
                        viewer: pid
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("device:{id}")),
                    },
                )
            })
            .collect()
    }
    pub fn languages(
        &self,
        devices: &[Value],
        device: &str,
        person: &str,
    ) -> BTreeMap<String, f64> {
        let scopes = Self::scopes(devices, device, person);
        let mut totals = BTreeMap::new();
        for fact in &self.facts {
            if scopes.get(&fact.device).is_some_and(|s| s.selected) {
                *totals.entry(fact.metadata.lang.clone()).or_default() += fact.seconds;
            }
        }
        totals
    }
    pub fn review(&self, devices: &[Value], device: &str, person: &str, page: usize) -> Value {
        let scopes = Self::scopes(devices, device, person);
        let mut videos: BTreeMap<&str, (&Metadata, f64, (f64, i64))> = BTreeMap::new();
        for f in &self.facts {
            if !scopes.get(&f.device).is_some_and(|s| s.selected)
                || !matches!(f.metadata.lang.as_str(), "und" | "other" | "")
            {
                continue;
            }
            let row = videos.entry(&f.metadata.video_id).or_insert((
                &f.metadata,
                0.,
                (f.latest_t, f.order),
            ));
            row.1 += f.seconds;
            if (f.latest_t, f.order) >= row.2 {
                row.0 = &f.metadata;
                row.2 = (f.latest_t, f.order);
            }
        }
        let mut videos: Vec<_> = videos.into_values().collect();
        videos.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.video_id.cmp(&b.0.video_id)));
        let count = videos.len();
        let pages = count.div_ceil(20).max(1);
        let page = page.min(pages).max(1);
        json!({"count":count,"page":page,"pages":pages,"videos":videos.into_iter().skip((page-1)*20).take(20).map(|(m,seconds,_)|json!({"videoId":m.video_id,"title":m.title,"channel":m.channel,"lang":m.lang,"source":m.source,"conf":m.conf,"seconds":seconds})).collect::<Vec<_>>()})
    }
    pub fn summary(
        &self,
        window: &Window,
        devices: &[Value],
        people: &mut [Value],
        device: &str,
        person: &str,
        tz: chrono_tz::Tz,
    ) -> Summary {
        let scopes = Self::scopes(devices, device, person);
        let mut people_totals: BTreeMap<&str, (f64, BTreeSet<&str>)> = BTreeMap::new();
        let mut videos: BTreeMap<String, Video> = BTreeMap::new();
        let mut daily: BTreeMap<String, (f64, f64, [f64; 3])> = window
            .dates
            .iter()
            .map(|date| (date.clone(), (0., 0., [0.; 3])))
            .collect();
        let mut result = Summary {
            seconds: 0.,
            short_seconds: 0.,
            context: [0.; 3],
            languages: BTreeMap::new(),
            daily: Vec::new(),
            videos: Vec::new(),
        };
        for f in &self.facts {
            let Some(scope) = scopes.get(&f.device) else {
                continue;
            };
            let m = &f.metadata;
            if let Some(id) = scope.person_id.as_deref() {
                let p = people_totals.entry(id).or_default();
                p.0 += f.seconds;
                p.1.insert(&m.video_id);
            }
            if !scope.selected {
                continue;
            }
            result.seconds += f.seconds;
            result.context[f.context] += f.seconds;
            if m.is_short == Some(true) {
                result.short_seconds += f.seconds;
            }
            *result.languages.entry(m.lang.clone()).or_default() += f.seconds;
            let date = tz
                .timestamp_millis_opt(f.first.floor() as i64)
                .unwrap()
                .date_naive()
                .to_string();
            if let Some(day) = daily.get_mut(&date) {
                day.0 += f.seconds;
                if m.is_short == Some(true) {
                    day.1 += f.seconds;
                }
                day.2[f.context] += f.seconds;
            }
            let key = format!("{}/{}", scope.viewer, m.video_id);
            let v = videos.entry(key).or_insert_with(|| Video {
                metadata: m.clone(),
                person_id: scope.person_id.clone(),
                person: scope.person.clone(),
                seconds: 0.,
                context: [0.; 3],
                last: f.latest_end,
                latest: (f.latest_t, f.order),
                ranges: Vec::new(),
            });
            v.seconds += f.seconds;
            v.context[f.context] += f.seconds;
            v.ranges = compact::merge_sorted(&v.ranges, &f.ranges);
            if (f.latest_t, f.order) > v.latest {
                v.metadata = m.clone();
                v.last = f.latest_end;
                v.latest = (f.latest_t, f.order);
            } else if (f.latest_t, f.order) == v.latest {
                v.last = v.last.max(f.latest_end);
            }
        }
        for p in people {
            if let Some((seconds, ids)) = p["id"].as_str().and_then(|id| people_totals.get(id)) {
                p["seconds"] = json!(seconds);
                p["videoCount"] = json!(ids.len());
            }
        }
        result.daily=daily.into_iter().map(|(date,(seconds,short,context))|json!({"date":date,"seconds":seconds,"shortSeconds":short,"regularSeconds":seconds-short,"foregroundSeconds":context[0],"backgroundSeconds":context[1],"unspecifiedSeconds":context[2]})).collect();
        result.videos=videos.into_iter().map(|(id,v)|{let covered:f64=v.ranges.iter().map(|r|r[1]-r[0]).sum();let m=v.metadata;
            json!({"historyId":id,"videoId":m.video_id,"personId":v.person_id,"person":v.person,"seconds":v.seconds,"foregroundSeconds":v.context[0],"backgroundSeconds":v.context[1],"unspecifiedSeconds":v.context[2],"title":m.title,"channel":m.channel,"isShort":m.is_short,"durationSeconds":m.duration_seconds,"lang":m.lang,"source":m.source,"conf":m.conf,"evidenceId":m.evidence_id,"lastWatched":v.last,"lastWatchedLabel":tz.timestamp_millis_opt(v.last as i64).unwrap().format("%d %b · %H:%M").to_string(),"coveredSeconds":covered,"completed":m.duration_seconds.is_some_and(|d|d>0.&&covered>=d*0.9)})
        }).collect();
        result
    }
}

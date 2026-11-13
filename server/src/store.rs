use crate::analytics::{Analytics, Window};
use crate::{Error, Result, invalid, now, unauthorized};
use crate::{compact, snapshots::Snapshots};
use axum::http::StatusCode;
use chrono::TimeZone;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[derive(Clone)]
pub struct Store(
    Arc<Mutex<Connection>>,
    Arc<Mutex<Snapshots>>,
    Arc<Mutex<Connection>>,
    Arc<crate::metrics::Metrics>,
    Arc<Readers>,
);
struct Readers {
    connections: Vec<Arc<Mutex<Connection>>>,
    next: std::sync::atomic::AtomicUsize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Batch {
    pub device_id: String,
    pub events: Vec<Value>,
    #[serde(default)]
    pub evidence: BTreeMap<String, String>,
}
#[derive(Clone)]
pub struct View {
    pub page: usize,
    pub per_page: usize,
    pub before: Option<i64>,
    pub until: Option<i64>,
    pub query: String,
    pub kind: String,
    pub sort: String,
}
impl Default for View {
    fn default() -> Self {
        Self {
            page: 1,
            per_page: 20,
            before: None,
            until: None,
            query: String::new(),
            kind: "all".into(),
            sort: "recent".into(),
        }
    }
}
fn person_id(db: &Connection, value: &str) -> Result<Option<String>> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let existing: Option<String> = db
        .query_row(
            "SELECT id FROM people WHERE id=? OR name=? COLLATE NOCASE",
            params![value, value],
            |r| r.get(0),
        )
        .optional()?;
    if existing.is_some() {
        return Ok(existing);
    }
    if uuid::Uuid::parse_str(value).is_ok() {
        return Err(invalid("Person does not exist"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO people(id,name) VALUES(?,?)",
        params![id, value],
    )?;
    Ok(Some(id))
}

fn id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn text(v: &Value, key: &str, max: usize) -> bool {
    v[key].as_str().is_some_and(|s| s.chars().count() <= max)
}
fn number(v: &Value, key: &str, min: f64, max: f64) -> bool {
    v[key]
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= min && n <= max)
}
fn validate(v: &Value) -> Result<()> {
    if !v.is_object()
        || !v["eventId"].as_str().is_some_and(id)
        || !number(v, "t", 0., (now() + 60000) as f64)
        || v.to_string().len() > 64000
    {
        return Err(invalid("Invalid event identity, timestamp or size"));
    }
    if let Some(e) = v.get("evidenceId")
        && !e
            .as_str()
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(invalid("Invalid evidence reference"));
    }
    match v["kind"].as_str() {
        Some("watch" | "viewing") => {
            let viewing = v["kind"] == "viewing";
            if v.get("playbackContext").is_some()
                && !matches!(
                    v["playbackContext"].as_str(),
                    Some("foreground" | "background")
                )
            {
                return Err(invalid("Invalid playback context"));
            }
            if !v["videoId"]
                .as_str()
                .is_some_and(|s| s.len() == 11 && id(s))
                || !number(v, "seconds", 0.000001, if viewing { 900.001 } else { 20. })
                || !text(v, "title", 500)
                || !text(v, "lang", 64)
                || !text(v, "source", 64)
                || !text(v, "conf", 20)
            {
                return Err(invalid("Invalid watch measurement"));
            }
            if !v["durationSeconds"].is_null() && !number(v, "durationSeconds", 0.001, 31536000.) {
                return Err(invalid("Invalid duration"));
            }
            if !viewing && let Some(c) = v.get("coverage") {
                let good = c.as_array().is_some_and(|a| {
                    a.len() == 2
                        && a[0].as_f64().is_some_and(|start| {
                            start >= 0.
                                && a[1].as_f64().is_some_and(|end| {
                                    end > start
                                        && end <= v["durationSeconds"].as_f64().unwrap_or(0.)
                                        && end - start <= v["seconds"].as_f64().unwrap() * 16. + 0.5
                                })
                        })
                });
                if !good {
                    return Err(invalid("Invalid media coverage"));
                }
            }
        }
        Some("search") => {
            if !text(v, "query", 1000) || v["query"].as_str().unwrap().trim().is_empty() {
                return Err(invalid("Invalid search"));
            }
        }
        Some("network") => {
            if !["watchtime", "playback", "qoe", "timedtext"]
                .contains(&v["endpoint"].as_str().unwrap_or(""))
                || !v["fields"].is_object()
            {
                return Err(invalid("Invalid network report"));
            }
            let fields = [
                "st", "et", "cmt", "len", "au", "state", "el", "is_ad", "final", "volume", "muted",
                "rate", "fs", "fmt", "afmt", "vps", "vis", "bh", "bwm", "bwe", "df", "lang",
                "kind", "tlang",
            ];
            if !v["fields"].as_object().unwrap().iter().all(|(k, v)| {
                fields.contains(&k.as_str())
                    && v.as_str().is_some_and(|s| s.chars().count() <= 2000)
            }) {
                return Err(invalid("Unknown network report field"));
            }
        }
        _ => return Err(invalid("Unknown event kind")),
    }
    Ok(())
}

impl Store {
    pub fn open(path: PathBuf) -> rusqlite::Result<Self> {
        let startup = std::time::Instant::now();
        let mut db = Connection::open(&path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,label TEXT NOT NULL,person TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen INTEGER);
        CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,device TEXT NOT NULL REFERENCES devices(id),event_id TEXT NOT NULL,t INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,evidence_id TEXT REFERENCES evidence(id),received INTEGER NOT NULL,UNIQUE(device,event_id));
        CREATE INDEX IF NOT EXISTS events_time ON events(t);
        CREATE INDEX IF NOT EXISTS events_kind_time ON events(kind,t);
        CREATE INDEX IF NOT EXISTS events_device_time ON events(device,t);")?;
        let tx = db.transaction()?;
        let has_person: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('devices') WHERE name='person_id')",
            [],
            |r| r.get(0),
        )?;
        if !has_person {
            tx.execute_batch("ALTER TABLE devices ADD COLUMN person_id TEXT REFERENCES people(id); CREATE INDEX devices_person ON devices(person_id);")?;
        }
        let legacy: Vec<(String, String)> = tx
            .prepare("SELECT id,person FROM devices WHERE person_id IS NULL AND trim(person)<>''")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (id, name) in legacy {
            let person = person_id(&tx, &name).map_err(|_| rusqlite::Error::InvalidQuery)?;
            tx.execute(
                "UPDATE devices SET person_id=? WHERE id=?",
                params![person, id],
            )?;
        }
        tx.commit()?;
        compact::initialize(&db)?;
        crate::languages::initialize(&db)?;
        while compact::import_chunk(&mut db)? {}
        let metrics = Arc::new(crate::metrics::Metrics::default());
        metrics.pipeline(compact::progress(&db)?);
        metrics.pipeline(json!({"startupMigrationMs":startup.elapsed().as_secs_f64()*1000.}));
        let db = Arc::new(Mutex::new(db));
        // WAL lets session reads/writes proceed while analytics uses the main connection.
        let auth = if path.to_str() == Some(":memory:") {
            db.clone()
        } else {
            let auth = Connection::open(&path)?;
            auth.busy_timeout(std::time::Duration::from_secs(5))?;
            auth.execute_batch("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")?;
            Arc::new(Mutex::new(auth))
        };
        let mut connections = Vec::new();
        for _ in 0..2 {
            if path.to_str() == Some(":memory:") {
                connections.push(db.clone());
                continue;
            }
            let reader =
                Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            reader.busy_timeout(std::time::Duration::from_secs(5))?;
            reader.execute_batch("PRAGMA query_only=ON; PRAGMA cache_size=-4096;")?;
            connections.push(Arc::new(Mutex::new(reader)));
        }
        Ok(Self(
            db,
            Arc::new(Mutex::new(Snapshots::default())),
            auth,
            metrics,
            Arc::new(Readers {
                connections,
                next: std::sync::atomic::AtomicUsize::new(0),
            }),
        ))
    }
    pub fn metrics(&self) -> Arc<crate::metrics::Metrics> {
        self.3.clone()
    }
    pub(crate) async fn sync_legacy(&self) -> Result<()> {
        let metrics = self.metrics();
        self.run(move |db| {
            let mut changed = false;
            while compact::import_chunk(db)? {
                changed = true;
            }
            if changed {
                metrics.pipeline(compact::progress(db)?);
            }
            Ok(())
        })
        .await
    }
    pub(crate) async fn read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let index = self
            .4
            .next
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            % self.4.connections.len();
        let reader = Self(
            self.4.connections[index].clone(),
            self.1.clone(),
            self.2.clone(),
            self.3.clone(),
            self.4.clone(),
        );
        reader
            .run(move |db| {
                let tx = db.transaction()?;
                f(&tx)
            })
            .await
    }
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let db = self.0.clone();
        let context = crate::metrics::context();
        let queued = std::time::Instant::now();
        tokio::task::spawn_blocking(move || {
            crate::metrics::stage(
                &context,
                "worker_queue",
                queued.elapsed().as_secs_f64() * 1000.,
            );
            let waiting = std::time::Instant::now();
            let mut db = db.lock().map_err(|_| {
                Error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Database lock failed".into(),
                )
            })?;
            crate::metrics::stage(&context, "db_wait", waiting.elapsed().as_secs_f64() * 1000.);
            let working = std::time::Instant::now();
            let result = f(&mut db);
            crate::metrics::stage(&context, "db_work", working.elapsed().as_secs_f64() * 1000.);
            result
        })
        .await
        .map_err(|_| {
            Error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Database task failed".into(),
            )
        })?
    }
    pub async fn add_session(&self, hash: String) -> Result<()> {
        self.auth()
            .run(move |db| {
                db.execute("DELETE FROM sessions WHERE expires<?", [now()])?;
                db.execute(
                    "INSERT INTO sessions VALUES(?,?)",
                    params![hash, now() + 604800000],
                )?;
                Ok(())
            })
            .await
    }
    pub async fn session_valid(&self, hash: String) -> Result<bool> {
        self.auth()
            .run(move |db| {
                Ok(db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sessions WHERE hash=? AND expires>?)",
                    params![hash, now()],
                    |r| r.get(0),
                )?)
            })
            .await
    }
    pub async fn remove_session(&self, hash: String) -> Result<()> {
        self.auth()
            .run(move |db| {
                db.execute("DELETE FROM sessions WHERE hash=?", [hash])?;
                Ok(())
            })
            .await
    }
    fn auth(&self) -> Self {
        Self(
            self.2.clone(),
            self.1.clone(),
            self.2.clone(),
            self.3.clone(),
            self.4.clone(),
        )
    }
    pub async fn create_device(
        &self,
        id: String,
        label: String,
        person: String,
        key: String,
    ) -> Result<()> {
        self.run(move |db| {
            let tx=db.transaction()?;
            let person_id=person_id(&tx,&person)?;
            tx.execute(
                "INSERT INTO devices(id,label,person,person_id,token_hash,created) VALUES(?,?,?,?,?,?)",
                params![id, label, person, person_id, key, now()],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }
    pub async fn revoke_device(&self, id: String) -> Result<()> {
        self.run(move |db| {
            db.execute("UPDATE devices SET revoked=1 WHERE id=?", [id])?;
            Ok(())
        })
        .await
    }
    pub async fn create_person(&self, name: String) -> Result<Value> {
        self.run(move |db| {
            let id = person_id(db, &name)?;
            Ok(json!({"id":id,"name":name}))
        })
        .await
    }
    pub async fn update_device(&self, id: String, label: String, person: String) -> Result<()> {
        self.run(move |db| {
            let tx = db.transaction()?;
            let person_id = person_id(&tx, &person)?;
            if tx.execute(
                "UPDATE devices SET label=?,person=?,person_id=? WHERE id=?",
                params![label, person, person_id, id],
            )? == 0
            {
                return Err(Error(StatusCode::NOT_FOUND, "Device not found".into()));
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }
    pub async fn rotate_device(&self, id: String, key: String) -> Result<()> {
        self.run(move |db| {
            if db.execute(
                "UPDATE devices SET token_hash=?,revoked=0 WHERE id=?",
                params![key, id],
            )? == 0
            {
                return Err(Error(StatusCode::NOT_FOUND, "Device not found".into()));
            }
            Ok(())
        })
        .await
    }
    pub async fn ingest(&self, key: String, batch: Batch) -> Result<Value> {
        self.sync_legacy().await?;
        let metrics = self.metrics();
        let context = crate::metrics::context();
        self.run(move |db| {
            let tx=db.transaction()?;
            let valid: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM devices WHERE id=? AND token_hash=? AND revoked=0)",params![batch.device_id,key],|r|r.get(0))?;
            if !valid { return Err(unauthorized()); }
            if batch.events.is_empty() || batch.events.len()>100 || batch.evidence.len()>100 { return Err(invalid("Batch must contain 1–100 events")); }
            for (key,serialized) in &batch.evidence {
                // Hash the exact UTF-8 encoding: no cross-language float serialization assumptions.
                let value:Value=serde_json::from_str(serialized).map_err(|_|invalid("Invalid evidence JSON"))?;
                if hash(serialized)!=*key || serialized.len()>64000 || !value.is_object() || !text(&value,"description",10000) || !text(&value,"title",500) {
                    return Err(invalid("Invalid evidence snapshot or digest"));
                }
                tx.execute("INSERT OR IGNORE INTO evidence VALUES(?,?)",params![key,serialized])?;
            }
            let mut accepted=Vec::new();
            let mut imported=Vec::new();
            for event in &batch.events {
                validate(event)?;
                let event_id=event["eventId"].as_str().unwrap();
                let payload=event.to_string();
                if event["kind"]=="viewing" {
                    if let Some(id)=event["evidenceId"].as_str() {
                        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM evidence WHERE id=?)",[id],|r|r.get(0))?;
                        if !exists{return Err(invalid("Missing evidence snapshot"));}
                    }
                    compact::accept(&tx,&batch.device_id,event)?;
                    accepted.push(event_id.to_owned());continue;
                }
                let collision:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM viewing_slices WHERE device=? AND id=?)",params![batch.device_id,event_id],|r|r.get(0))?;
                if collision {return Err(Error(StatusCode::CONFLICT,"Identity already belongs to a viewing".into()));}
                let previous: Option<String>=tx.query_row("SELECT payload FROM events WHERE device=? AND event_id=?",params![batch.device_id,event_id],|r|r.get(0)).optional()?;
                if let Some(previous)=previous {
                    if previous!=payload { return Err(Error(StatusCode::CONFLICT,"Event ID already contains different data".into())); }
                } else {
                    let evidence=event["evidenceId"].as_str();
                    if let Some(key)=evidence {
                        let exists: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM evidence WHERE id=?)",[key],|r|r.get(0))?;
                        if !exists { return Err(invalid("Missing evidence snapshot")); }
                    }
                    tx.execute("INSERT INTO events(device,event_id,t,kind,payload,evidence_id,received) VALUES(?,?,?,?,?,?,?)",params![batch.device_id,event_id,event["t"].as_f64(),event["kind"].as_str(),payload,evidence,now()])?;
                    imported.push((tx.last_insert_rowid(),batch.device_id.clone(),payload));
                }
                accepted.push(event_id.to_owned());
            }
            tx.execute("UPDATE devices SET last_seen=? WHERE id=?",params![now(),batch.device_id])?;
            compact::import_rows(&tx,&imported)?;
            tx.commit()?;
            metrics.pipeline(compact::progress(db)?);
            metrics.pipeline(json!({"lastAcceptedAt":now()}));
            crate::metrics::work(&context,"acknowledged_events",accepted.len() as u64);
            Ok(json!({"deviceId":batch.device_id,"accepted":accepted}))
        }).await
    }
    pub async fn export(&self, after: i64) -> Result<Value> {
        self.run(move |db| {
        let mut q=db.prepare("SELECT e.seq,e.device,e.received,e.payload,s.payload FROM events e LEFT JOIN evidence s ON s.id=e.evidence_id WHERE e.seq>? ORDER BY e.seq LIMIT 500")?;
        let rows=q.query_map([after],raw_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        let next=rows.last().and_then(|v|v["seq"].as_i64()).unwrap_or(after);
        Ok(json!({"events":rows,"next":next}))
    }).await
    }
    pub async fn device(&self, key: String) -> Result<Value> {
        self.run(move |db| {
        db.query_row("SELECT d.id,d.label,COALESCE(p.name,''),d.person_id FROM devices d LEFT JOIN people p ON p.id=d.person_id WHERE token_hash=? AND revoked=0",[key],|r|Ok(json!({"deviceId":r.get::<_,String>(0)?,"label":r.get::<_,String>(1)?,"person":r.get::<_,String>(2)?,"personId":r.get::<_,Option<String>>(3)?}))).optional()?.ok_or_else(unauthorized)
    }).await
    }
    pub async fn export_viewings(&self, after: i64) -> Result<Value> {
        self.read(move |db| {
            let mut q=db.prepare("SELECT s.id,s.device,s.viewing_id,s.bucket,s.revision,s.first,s.last,s.seconds,s.ranges,s.context,s.received,s.latest_order,m.payload,e.payload FROM viewing_slices s JOIN video_metadata m ON m.id=s.metadata_id LEFT JOIN evidence e ON e.id=json_extract(m.payload,'$.evidenceId') WHERE s.origin='viewing' AND s.latest_order>? ORDER BY s.latest_order LIMIT 500")?;
            let rows=q.query_map([after],viewing_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
            let next=rows.last().and_then(|v|v["change"].as_i64()).unwrap_or(after);
            Ok(json!({"viewings":rows,"nextViewing":next}))
        }).await
    }
    pub async fn viewing(&self, device: String, id: String) -> Result<Value> {
        self.read(move |db| {
            db.query_row("SELECT s.id,s.device,s.viewing_id,s.bucket,s.revision,s.first,s.last,s.seconds,s.ranges,s.context,s.received,s.latest_order,m.payload,e.payload FROM viewing_slices s JOIN video_metadata m ON m.id=s.metadata_id LEFT JOIN evidence e ON e.id=json_extract(m.payload,'$.evidenceId') WHERE s.origin='viewing' AND s.device=? AND s.id=?",params![device,id],viewing_row).optional()?.ok_or_else(||Error(StatusCode::NOT_FOUND,"Viewing not found".into()))
        }).await
    }
    pub async fn event(&self, seq: i64) -> Result<Value> {
        self.run(move |db| {
        db.query_row("SELECT e.seq,e.device,e.received,e.payload,s.payload FROM events e LEFT JOIN evidence s ON s.id=e.evidence_id WHERE seq=?",[seq],raw_row).optional()?.ok_or_else(||Error(StatusCode::NOT_FOUND,"Event not found".into()))
    }).await
    }
    pub async fn language_dashboard(
        &self,
        days: u32,
        device: String,
        person: String,
        tz: chrono_tz::Tz,
    ) -> Result<Value> {
        self.sync_legacy().await?;
        let context = crate::metrics::context();
        self.read(move |db| {
            let window = Window::new(days, now(), i64::MAX, tz);
            let started=std::time::Instant::now();
            let watches=Analytics::load_totals(db,&window)?;
            crate::metrics::stage(&context,"compact_read",started.elapsed().as_secs_f64()*1000.);
            let (devices, people) = dashboard_metadata(db)?;
            crate::metrics::work(&context,"compact_records_read",watches.row_count());
            let started=std::time::Instant::now();
            let languages = watches.languages(&devices, &device, &person);
            crate::metrics::stage(&context,"analytics_compute",started.elapsed().as_secs_f64()*1000.);
            let total: f64 = languages.values().sum();
            let daily: Vec<_> = window.dates.iter().map(|date| json!({"date":date})).collect();
            Ok(json!({"seconds":total,"languages":languages,"daily":daily,"timezone":tz.to_string(),"since":window.since,"until":window.until,"people":people,"devices":devices}))
        }).await
    }
    pub async fn language_videos(
        &self,
        days: u32,
        device: String,
        person: String,
        tz: chrono_tz::Tz,
        page: usize,
    ) -> Result<Value> {
        self.sync_legacy().await?;
        let context = crate::metrics::context();
        self.read(move |db| {
            let window = Window::new(days, now(), i64::MAX, tz);
            let watches = Analytics::load_totals(db, &window)?;
            crate::metrics::work(&context, "compact_records_read", watches.row_count());
            let (devices, _) = dashboard_metadata(db)?;
            Ok(watches.review(&devices, &device, &person, page))
        })
        .await
    }
    #[cfg(test)]
    pub async fn dashboard(
        &self,
        days: u32,
        device: String,
        person: String,
        tz: chrono_tz::Tz,
    ) -> Result<Value> {
        self.dashboard_page(days, device, person, tz, View::default())
            .await
    }
    pub async fn dashboard_page(
        &self,
        days: u32,
        device: String,
        person: String,
        tz: chrono_tz::Tz,
        view: View,
    ) -> Result<Value> {
        self.sync_legacy().await?;
        let snapshots = self.1.clone();
        let context = crate::metrics::context();
        self.read(move |db| {
        let until=view.until.unwrap_or_else(now);
        let latest=compact::generation(db)?;
        let before=view.before.unwrap_or(latest).min(latest);
        let cache_key=json!([days,device,person,tz.to_string(),before,until]).to_string();
        if view.before.is_some() {
            let cached=snapshots.lock().map_err(|_|invalid("Snapshot unavailable"))?.get(&cache_key);
            if let Some(cached)=cached {crate::metrics::work(&context,"snapshot_hits",1);return history_page(db,cached,&view);}
            if before!=latest{return Err(Error(StatusCode::GONE,"History snapshot expired. Refresh to load current data.".into()));}
        }
        let window=Window::new(days,until,before,tz);
        let since=window.since;
        let (devices,mut people)=dashboard_metadata(db)?;
        let started=std::time::Instant::now();
        let watches=Analytics::load(db,&window)?;
        crate::metrics::stage(&context,"compact_read",started.elapsed().as_secs_f64()*1000.);
        crate::metrics::work(&context,"compact_records_read",watches.row_count());
        let started=std::time::Instant::now();
        let summary=watches.summary(&window,&devices,&mut people,&device,&person,tz);
        crate::metrics::stage(&context,"analytics_compute",started.elapsed().as_secs_f64()*1000.);
        drop(watches);
        let total=summary.seconds;
        let short_seconds=summary.short_seconds;
        let context_seconds=summary.context;
        let languages=summary.languages;
        let daily=summary.daily;
        let videos=summary.videos;
        let scope="FROM events e JOIN devices d ON d.id=e.device LEFT JOIN people p ON p.id=d.person_id WHERE e.seq<=? AND e.t>=? AND e.t<? AND (?='' OR d.id=?) AND (?='' OR p.id=? OR (?<>'unassigned' AND p.name=?) OR (?='unassigned' AND p.id IS NULL))";
        // Bound the index walk per selected device, including devices with no activity.
        // A global time scan followed by an OR-based device/person filter can walk all ticks.
        let started=std::time::Instant::now();
        let selected=devices.iter().filter(|d| (device.is_empty()||d["id"]==device) && (person.is_empty()||d["personId"]==person||(person!="unassigned"&&d["person"]==person)||(person=="unassigned"&&d["personId"].is_null())));
        let mut recent=Vec::new();
        for selected_device in selected {
        let selected_id=selected_device["id"].as_str().unwrap();
        let mut q=db.prepare("SELECT e.seq,e.device,e.received,e.payload,NULL FROM events e WHERE e.device=? AND e.t>=? AND e.t<? AND e.seq<=? ORDER BY e.t DESC,e.seq DESC LIMIT 100")?;
        recent.extend(q.query_map(params![selected_id,since,until,before],|r| {
            let raw=raw_row(r)?;let e=&raw["event"];
            Ok(json!({"seq":raw["seq"],"kind":e["kind"],"t":e["t"],"videoId":e["videoId"],"deviceId":raw["deviceId"],"receivedAt":raw["receivedAt"],"endpoint":e["endpoint"],"seconds":e["seconds"],"title":e["title"],"query":e["query"]}))
        })?.collect::<rusqlite::Result<Vec<_>>>()?);
        let mut q=db.prepare("SELECT s.device,s.received,s.last,s.seconds,m.payload,s.id FROM viewing_slices s JOIN video_metadata m ON m.id=s.metadata_id WHERE s.device=? AND s.origin='viewing' AND s.last>=? AND s.last<? ORDER BY s.last DESC LIMIT 100")?;
        for row in q.query_map(params![selected_id,since,until],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,f64>(2)?,r.get::<_,f64>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?)))? {
            let (device,received,t,seconds,meta,id)=row?;let meta:Value=serde_json::from_str(&meta).map_err(|_|invalid("Invalid saved metadata"))?;
            recent.push(json!({"seq":null,"kind":"watch","detailUrl":format!("/api/viewings/{device}/{id}"),"t":t,"videoId":meta["videoId"],"deviceId":device,"receivedAt":received,"endpoint":null,"seconds":seconds,"title":meta["title"],"query":null}));
        }
        }
        crate::metrics::work(&context,"activity_candidates_read",recent.len() as u64);
        recent.sort_by(|a,b|b["t"].as_f64().unwrap().total_cmp(&a["t"].as_f64().unwrap()).then(b["seq"].as_i64().cmp(&a["seq"].as_i64())));recent.truncate(100);
        crate::metrics::stage(&context,"activity_read",started.elapsed().as_secs_f64()*1000.);
        let started=std::time::Instant::now();
        let search_count:i64=db.query_row(&format!("SELECT COUNT(*) {scope} AND e.kind='search'"),params![before,since,until,device,device,person,person,person,person,person],|r|r.get(0))?;
        let mut q=db.prepare(&format!("SELECT json_extract(e.payload,'$.query'),e.t,COALESCE(p.name,'Unassigned · '||d.label),d.label {scope} AND e.kind='search' ORDER BY e.t DESC,e.seq DESC LIMIT 20"))?;
        let searches=q.query_map(params![before,since,until,device,device,person,person,person,person,person],|r| {
            let t:f64=r.get(1)?;
            Ok(json!({"query":r.get::<_,String>(0)?,"t":t,"person":r.get::<_,String>(2)?,"device":r.get::<_,String>(3)?,"timeLabel":tz.timestamp_millis_opt(t as i64).unwrap().format("%d %b · %H:%M").to_string()}))
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        crate::metrics::stage(&context,"search_read",started.elapsed().as_secs_f64()*1000.);
        let video_count=videos.iter().filter_map(|v|v["videoId"].as_str()).collect::<std::collections::BTreeSet<_>>().len();
        let history_count=videos.len();
        let completed_count=videos.iter().filter(|v|v["completed"]==true).count();
        let active_days=daily.iter().filter(|day|day["seconds"].as_f64().unwrap_or(0.)>0.).count();
        let snapshot=json!({"seconds":total,"foregroundSeconds":context_seconds[0],"backgroundSeconds":context_seconds[1],"unspecifiedSeconds":context_seconds[2],"shortSeconds":short_seconds,"regularSeconds":total-short_seconds,"searchCount":search_count,"searches":searches,"activeDays":active_days,"timezone":tz.to_string(),"since":since,"until":until,"snapshotSeq":before,"devices":devices,"people":people,"videos":videos,"videoCount":video_count,"historyCount":history_count,"completedCount":completed_count,"daily":daily,"languages":languages,"recent":recent});
        snapshots.lock().map_err(|_|invalid("Snapshot unavailable"))?.put(cache_key,snapshot.clone());
        history_page(db,snapshot,&view)
    }).await
    }
}
fn viewing_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut event: Value = serde_json::from_str(&r.get::<_, String>(12)?)
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    for (key, index) in [("eventId", 0), ("viewingId", 2)] {
        event[key] = json!(r.get::<_, String>(index)?);
    }
    for (key, index) in [("bucket", 3), ("revision", 4)] {
        event[key] = json!(r.get::<_, i64>(index)?);
    }
    for (key, index) in [("t", 5), ("lastWatched", 6), ("seconds", 7)] {
        event[key] = json!(r.get::<_, f64>(index)?);
    }
    event["kind"] = json!("viewing");
    event["coverage"] =
        serde_json::from_str(&r.get::<_, String>(8)?).map_err(|_| rusqlite::Error::InvalidQuery)?;
    event["playbackContext"] =
        json!(["foreground", "background", "unspecified"][r.get::<_, usize>(9)?]);
    Ok(
        json!({"event":event,"deviceId":r.get::<_,String>(1)?,"receivedAt":r.get::<_,i64>(10)?,"change":r.get::<_,i64>(11)?,"evidence":r.get::<_,Option<String>>(13)?.and_then(|s|serde_json::from_str::<Value>(&s).ok())}),
    )
}
fn history_page(db: &Connection, mut snapshot: Value, view: &View) -> Result<Value> {
    let mut videos = snapshot["videos"].as_array().unwrap().clone();
    let query = view.query.trim().to_lowercase();
    videos.retain(|v| {
        (view.kind == "all" || (v["isShort"] == true) == (view.kind == "short"))
            && (query.is_empty()
                || ["title", "channel", "videoId"].iter().any(|key| {
                    v[key]
                        .as_str()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&query)
                }))
    });
    videos.sort_by(|a, b| {
        let order = match view.sort.as_str() {
            "watch" => b["seconds"]
                .as_f64()
                .unwrap()
                .total_cmp(&a["seconds"].as_f64().unwrap()),
            "title" => a["title"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .cmp(&b["title"].as_str().unwrap_or("").to_lowercase()),
            _ => b["lastWatched"]
                .as_f64()
                .unwrap()
                .total_cmp(&a["lastWatched"].as_f64().unwrap()),
        };
        order.then_with(|| a["historyId"].as_str().cmp(&b["historyId"].as_str()))
    });
    let count = videos.len();
    let pages = count.div_ceil(view.per_page).max(1);
    let page = view.page.min(pages).max(1);
    let mut videos: Vec<Value> = videos
        .into_iter()
        .skip((page - 1) * view.per_page)
        .take(view.per_page)
        .collect();
    for v in &mut videos {
        v["evidence"] = if let Some(id) = v["evidenceId"].as_str() {
            db.query_row("SELECT payload FROM evidence WHERE id=?", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
    }
    snapshot["videos"] = json!(videos);
    snapshot["filteredCount"] = json!(count);
    snapshot["pages"] = json!(pages);
    snapshot["page"] = json!(page);
    snapshot["perPage"] = json!(view.per_page);
    Ok(snapshot)
}
pub(crate) fn dashboard_metadata(db: &Connection) -> Result<(Vec<Value>, Vec<Value>)> {
    let mut q = db.prepare("SELECT d.id,d.label,COALESCE(p.name,''),d.revoked,d.last_seen,d.person_id FROM devices d LEFT JOIN people p ON p.id=d.person_id ORDER BY d.created")?;
    let devices = q.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"label":r.get::<_,String>(1)?,"person":r.get::<_,String>(2)?,"revoked":r.get::<_,bool>(3)?,"lastSeen":r.get::<_,Option<i64>>(4)?,"personId":r.get::<_,Option<String>>(5)?})))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut q = db.prepare("SELECT p.id,p.name,(SELECT COUNT(*) FROM devices d WHERE d.person_id=p.id) FROM people p ORDER BY p.name COLLATE NOCASE")?;
    let people = q.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"deviceCount":r.get::<_,i64>(2)?,"seconds":0.,"videoCount":0})))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((devices, people))
}
fn raw_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let parse = |s: String| {
        serde_json::from_str::<Value>(&s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })
    };
    Ok(
        json!({"seq":r.get::<_,i64>(0)?,"deviceId":r.get::<_,String>(1)?,"receivedAt":r.get::<_,i64>(2)?,"event":parse(r.get(3)?)?,"evidence":r.get::<_,Option<String>>(4)?.map(parse).transpose()?}),
    )
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;

    #[tokio::test]
    async fn session_operations_do_not_wait_for_the_analytics_connection() {
        let path =
            std::env::temp_dir().join(format!("observer-auth-{}.sqlite3", uuid::Uuid::new_v4()));
        let store = Store::open(path.clone()).unwrap();
        store.add_session("existing".into()).await.unwrap();
        let db = store.0.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let held = tokio::task::spawn_blocking(move || {
            let _guard = db.lock().unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        ready_rx.await.unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            assert!(store.session_valid("existing".into()).await.unwrap());
            store.add_session("new".into()).await.unwrap();
            store.remove_session("existing".into()).await.unwrap();
            assert!(!store.session_valid("existing".into()).await.unwrap());
        })
        .await;
        release_tx.send(()).unwrap();
        held.await.unwrap();
        assert!(
            result.is_ok(),
            "Authentication queued behind the history connection"
        );
        drop(store);
        std::fs::remove_file(path).unwrap();
    }
}

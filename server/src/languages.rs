//! Optional language interpretation. Recorded evidence and watch measurements are immutable.
//! Nothing in this module participates in ingestion or the global history read model.
use crate::{
    App, Error, Result,
    analytics::{Analytics, Window},
    compact::Metadata,
    invalid, now, owner,
    store::{Store, hash},
};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
mod inference;

pub fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS language_assessments(
          device TEXT NOT NULL REFERENCES devices(id),
          metadata_id TEXT NOT NULL REFERENCES video_metadata(id),
          revision INTEGER NOT NULL,action TEXT NOT NULL,assessment TEXT NOT NULL,
          note TEXT NOT NULL,created INTEGER NOT NULL,
          PRIMARY KEY(device,metadata_id,revision));
         CREATE INDEX IF NOT EXISTS language_observations ON viewing_slices(device,metadata_id);",
    )
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Assessment {
    lang: String,
    status: String,
    source: String,
    confidence: String,
    reason: String,
}
impl Assessment {
    fn review(&self) -> bool {
        self.status != "confirmed"
            && !(self.status == "estimated"
                && self.confidence == "high"
                && matches!(
                    self.source.as_str(),
                    "selected-audio-metadata" | "external-api:audio"
                ))
    }
}

// Accept a bounded BCP-47-shaped identifier, not a free-form display name.
fn language(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    let parts: Vec<_> = value.split('-').collect();
    let primary = parts[0];
    if value.len() > 35
        || primary == "other"
        || !(2..=3).contains(&primary.len())
        || !primary.bytes().all(|c| c.is_ascii_alphabetic())
        || parts[1..]
            .iter()
            .any(|p| p.is_empty() || p.len() > 8 || !p.bytes().all(|c| c.is_ascii_alphanumeric()))
        || (matches!(primary, "und" | "mul" | "zxx") && parts.len() != 1)
    {
        return None;
    }
    Some(value)
}

fn baseline(meta: &Metadata) -> Assessment {
    let lang = language(&meta.lang).unwrap_or_else(|| "und".into());
    let unknown = lang == "und";
    Assessment {
        lang, status: if unknown { "undetermined" } else { "estimated" }.into(),
        source: format!("collector:{}", meta.source),
        confidence: if unknown { "unavailable" } else if ["high","medium","low"].contains(&meta.conf.as_str()) { &meta.conf } else { "low" }.into(),
        reason: if unknown { "The collector did not determine the audio language." }
            else { "Original collector estimate; it may describe default audio, captions or text rather than the track actually played." }.into(),
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    days: Option<u32>,
    #[serde(default)]
    device: String,
    #[serde(default)]
    person: String,
    language: Option<String>,
    status: Option<String>,
    #[serde(default)]
    query: String,
    page: Option<usize>,
    group: Option<String>,
}
impl Filters {
    fn validate(&self) -> Result<()> {
        if ![7, 30, 90].contains(&self.days.unwrap_or(7))
            || self.group.as_deref().is_some_and(|g| g != "video")
            || self.page == Some(0)
            || self.query.chars().count() > 200
            || self.device.len() > 200
            || self.person.len() > 200
            || self
                .status
                .as_ref()
                .is_some_and(|s| !["all", "review", "confirmed", "estimated"].contains(&s.as_str()))
            || self
                .language
                .as_ref()
                .is_some_and(|l| l != "all" && language(l).is_none())
        {
            return Err(invalid("Invalid language module filters"));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    device: String,
    metadata: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    device_id: String,
    metadata_id: String,
    base_revision: i64,
    action: String,
    lang: Option<String>,
    #[serde(default)]
    note: String,
    provider: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkTarget {
    device_id: String,
    metadata_id: String,
    base_revision: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BulkChange {
    video_id: String,
    targets: Vec<BulkTarget>,
    action: String,
    lang: Option<String>,
    #[serde(default)]
    note: String,
}
impl Change {
    fn validate(&self) -> Result<()> {
        validate_target(&self.device_id, &self.metadata_id)?;
        if self.base_revision < 0
            || self.base_revision == i64::MAX
            || !["manual", "analyze", "reset"].contains(&self.action.as_str())
            || self.note.chars().count() > 2000
            || (self.action == "manual" && self.lang.as_ref().and_then(|l| language(l)).is_none())
            || (self.action != "manual" && self.lang.is_some())
            || (self.action != "analyze" && self.provider.is_some())
            || self
                .provider
                .as_ref()
                .is_some_and(|p| !["saved-evidence", "external"].contains(&p.as_str()))
        {
            return Err(invalid(
                "Invalid assessment action, language, revision or note",
            ));
        }
        Ok(())
    }
}
fn validate_target(device: &str, metadata: &str) -> Result<()> {
    if device.is_empty()
        || device.len() > 200
        || metadata.len() != 64
        || !metadata.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err(invalid("Invalid observation identity"));
    }
    Ok(())
}
fn conflict(message: &str) -> Error {
    Error(StatusCode::CONFLICT, message.into())
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(|_| {
        Error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid saved language data".into(),
        )
    })
}
fn metadata(db: &Connection, device: &str, id: &str) -> Result<Metadata> {
    let payload: Option<String> = db
        .query_row(
            "SELECT m.payload FROM video_metadata m WHERE m.id=? AND EXISTS(
            SELECT 1 FROM viewing_slices s WHERE s.device=? AND s.metadata_id=m.id)",
            params![id, device],
            |r| r.get(0),
        )
        .optional()?;
    decode(&payload.ok_or_else(|| {
        Error(
            StatusCode::NOT_FOUND,
            "Recorded observation not found".into(),
        )
    })?)
}
fn latest(
    db: &Connection,
    device: &str,
    id: &str,
    meta: &Metadata,
) -> Result<(i64, Assessment, String)> {
    let row: Option<(i64, String, String)> = db
        .query_row(
            "SELECT revision,assessment,action FROM language_assessments
         WHERE device=? AND metadata_id=? ORDER BY revision DESC LIMIT 1",
            params![device, id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    match row {
        Some((revision, payload, action)) => Ok((revision, decode(&payload)?, action)),
        None => {
            // Interpret existing and incoming saved audio without requiring a review
            // click. Explicit assessment revisions above always take precedence.
            if let Some(text) = evidence_text(db, meta)?
                && meta.evidence_id.as_deref() == Some(hash(&text).as_str())
                && let Ok(evidence) = serde_json::from_str::<Value>(&text)
            {
                let assessment = saved_audio(&evidence);
                if assessment.lang != "und"
                    || evidence["algorithmVersion"]
                        .as_str()
                        .is_some_and(|v| v.starts_with("language-"))
                    || evidence["collector"] == "owntube-source-v1"
                {
                    return Ok((0, assessment, "automatic".into()));
                }
            }
            Ok((0, baseline(meta), "collector".into()))
        }
    }
}
fn evidence_text(db: &Connection, meta: &Metadata) -> Result<Option<String>> {
    match &meta.evidence_id {
        Some(id) => Ok(db
            .query_row("SELECT payload FROM evidence WHERE id=?", [id], |r| {
                r.get(0)
            })
            .optional()?),
        None => Ok(None),
    }
}
fn recorded(meta: &Metadata) -> Value {
    json!({"lang":meta.lang,"source":meta.source,"conf":meta.conf})
}
fn providers() -> Value {
    let mut result = vec![json!({"id":"saved-evidence","label":"Saved audio metadata"})];
    if std::env::var("LANGUAGE_ANALYZER_URL").is_ok_and(|s| !s.trim().is_empty()) {
        result.push(json!({"id":"external","label":"Configured analysis API"}));
    }
    json!(result)
}

struct Row {
    meta: Metadata,
    device: String,
    label: String,
    metadata_id: String,
    context: [f64; 3],
    last: f64,
    revision: i64,
    assessment: Assessment,
}
impl Row {
    fn seconds(&self) -> f64 {
        self.context.iter().sum()
    }
    fn json(&self) -> Value {
        json!({"deviceId":self.device,"deviceLabel":self.label,"metadataId":self.metadata_id,
          "videoId":self.meta.video_id,"title":self.meta.title,"channel":self.meta.channel,
          "seconds":self.seconds(),"foregroundSeconds":self.context[0],"backgroundSeconds":self.context[1],
          "unspecifiedSeconds":self.context[2],"lastWatched":self.last,"evidenceId":self.meta.evidence_id,
          "recorded":recorded(&self.meta),"assessment":self.assessment,"revision":self.revision,
          "needsReview":self.assessment.review()})
    }
}

fn grouped_video(rows: &[Row], devices: &[Value], matched: usize) -> Value {
    let newest = &rows[0];
    let versions: Vec<_> = rows
        .iter()
        .map(|row| {
            let mut value = row.json();
            value["contextOverride"] = devices
                .iter()
                .find(|d| d["id"] == row.device)
                .map(|d| d["contextOverride"].clone())
                .unwrap_or(Value::Null);
            value
        })
        .collect();
    let device_ids: BTreeSet<_> = rows.iter().map(|r| r.device.as_str()).collect();
    let selected: Vec<_> = devices
        .iter()
        .filter(|d| device_ids.contains(d["id"].as_str().unwrap()))
        .map(|d| json!({"id":d["id"],"label":d["label"],"contextOverride":d["contextOverride"]}))
        .collect();
    let common = |key: &str, fallback: &str| {
        let first = &versions[0]["assessment"][key];
        if versions.iter().all(|v| &v["assessment"][key] == first) {
            first.clone()
        } else {
            json!(fallback)
        }
    };
    let common_recorded = |key: &str, fallback: &str| {
        let first = &versions[0]["recorded"][key];
        if versions.iter().all(|v| &v["recorded"][key] == first) {
            first.clone()
        } else {
            json!(fallback)
        }
    };
    json!({"id":newest.meta.video_id,"videoId":newest.meta.video_id,"title":newest.meta.title,
        "channel":newest.meta.channel,"seconds":rows.iter().map(Row::seconds).sum::<f64>(),
        "foregroundSeconds":rows.iter().map(|r| r.context[0]).sum::<f64>(),
        "backgroundSeconds":rows.iter().map(|r| r.context[1]).sum::<f64>(),
        "unspecifiedSeconds":rows.iter().map(|r| r.context[2]).sum::<f64>(),
        "lastWatched":newest.last,"devices":selected,
        "deviceLabel":selected.iter().filter_map(|d|d["label"].as_str()).collect::<Vec<_>>().join(" · "),
        "versionCount":rows.len(),"matchedVersionCount":matched,
        "assessment":{"lang":common("lang","mul"),"status":common("status","mixed"),
            "source":common("source","mixed"),"confidence":common("confidence","mixed"),
            "reason":"Summary of saved versions in this scope. Evidence remains specific to each version."},
        "recorded":{"lang":common_recorded("lang","mul"),"source":common_recorded("source","mixed"),
            "conf":common_recorded("conf","mixed")},
        "needsReview":rows.iter().any(|r|r.assessment.review()),"versions":versions})
}

impl Store {
    pub async fn language_bulk_change(&self, input: BulkChange) -> Result<Value> {
        if input.targets.is_empty()
            || input.targets.len() > 1000
            || !["manual", "reset"].contains(&input.action.as_str())
            || input.video_id.is_empty()
            || input.video_id.len() > 200
        {
            return Err(invalid(
                "Choose one video and 1–1000 saved versions to confirm or reset",
            ));
        }
        let mut identities = BTreeSet::new();
        for target in &input.targets {
            if !identities.insert((&target.device_id, &target.metadata_id)) {
                return Err(invalid("Repeated version in grouped assessment"));
            }
            Change {
                device_id: target.device_id.clone(),
                metadata_id: target.metadata_id.clone(),
                base_revision: target.base_revision,
                action: input.action.clone(),
                lang: input.lang.clone(),
                note: input.note.clone(),
                provider: None,
            }
            .validate()?;
        }
        self.run(move |db| {
            let tx = db.transaction()?;
            let mut versions = Vec::new();
            for target in &input.targets {
                let meta = metadata(&tx,&target.device_id,&target.metadata_id)?;
                if meta.video_id != input.video_id {
                    return Err(invalid("Every version must belong to the selected video"));
                }
                let (revision,_,_) = latest(&tx,&target.device_id,&target.metadata_id,&meta)?;
                if revision != target.base_revision {
                    return Err(conflict("A version changed. Refresh the video before saving; nothing was changed."));
                }
                let assessment = if input.action == "reset" { baseline(&meta) } else {
                    let lang = language(input.lang.as_deref().unwrap()).unwrap();
                    Assessment { status:if lang=="und" {"undetermined"} else {"confirmed"}.into(),
                        lang,source:"manual".into(),confidence:"human".into(),
                        reason:"Owner classification applied to this video's selected recorded versions together.".into() }
                };
                let next=revision+1;
                tx.execute("INSERT INTO language_assessments VALUES(?,?,?,?,?,?,?)",
                    params![target.device_id,target.metadata_id,next,input.action,
                        serde_json::to_string(&assessment).unwrap(),input.note.trim(),now()])?;
                versions.push(json!({"deviceId":target.device_id,"metadataId":target.metadata_id,
                    "revision":next,"assessment":assessment}));
            }
            tx.commit()?;
            Ok(json!({"ok":true,"updated":versions.len(),"versions":versions}))
        }).await
    }

    pub async fn module_languages(&self, filter: Filters, tz: chrono_tz::Tz) -> Result<Value> {
        filter.validate()?;
        self.sync_legacy().await?;
        self.read(move |db| {
            let days = filter.days.unwrap_or(7);
            let window = Window::new(days,now(),i64::MAX,tz);
            let mut devices: Vec<Value> = db.prepare(
                "SELECT d.id,d.label,d.person_id,COALESCE(p.name,'') FROM devices d LEFT JOIN people p ON p.id=d.person_id ORDER BY d.created,d.id")?
                .query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"label":r.get::<_,String>(1)?,
                    "personId":r.get::<_,Option<String>>(2)?,"person":r.get::<_,String>(3)?})))?
                .collect::<rusqlite::Result<_>>()?;
            crate::playback::annotate(db, &mut devices)?;
            let people: Vec<Value> = db.prepare("SELECT id,name FROM people ORDER BY name,id")?
                .query_map([],|r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?})))?
                .collect::<rusqlite::Result<_>>()?;
            let selected: BTreeMap<_,_> = devices.iter().filter(|d|
                (filter.device.is_empty() || d["id"] == filter.device)
                && (filter.person.is_empty() || d["personId"] == filter.person
                    || (filter.person == "unassigned" && d["personId"].is_null())))
                .map(|d| (d["id"].as_str().unwrap(),d["label"].as_str().unwrap())).collect();
            let watches = Analytics::load_totals(db,&window)?;
            let mut rows: BTreeMap<(String,String),Row> = BTreeMap::new();
            for f in watches.facts() {
                let Some(label) = selected.get(f.device.as_str()) else { continue };
                let mid = hash(&serde_json::to_string(&f.metadata).unwrap());
                let key = (f.device.clone(),mid.clone());
                if !rows.contains_key(&key) {
                    let (revision,assessment,_) = latest(db,&f.device,&mid,&f.metadata)?;
                    rows.insert(key.clone(), Row { meta:f.metadata.clone(),device:f.device.clone(),
                        label:(*label).into(),metadata_id:mid,context:[0.;3],last:0.,revision,assessment });
                }
                let row = rows.get_mut(&key).unwrap();
                row.context[f.context] += f.seconds;
                row.last = row.last.max(f.last);
            }
            let mut context = [0.;3];
            let mut langs: BTreeMap<String,(f64,BTreeSet<String>)> = BTreeMap::new();
            let mut videos = BTreeSet::new();
            let (mut review,mut confirmed,mut estimated) = (0.,0.,0.);
            for row in rows.values() {
                for (total,part) in context.iter_mut().zip(row.context) { *total += part; }
                videos.insert(row.meta.video_id.clone());
                let entry = langs.entry(row.assessment.lang.clone()).or_default();
                entry.0 += row.seconds(); entry.1.insert(row.meta.video_id.clone());
                if row.assessment.review() { review += row.seconds(); }
                match row.assessment.status.as_str() {
                    "confirmed" => confirmed += row.seconds(),
                    "estimated" => estimated += row.seconds(),
                    _ => {}
                }
            }
            let query = filter.query.trim().to_lowercase();
            let wanted = filter.language.as_deref().filter(|s| *s != "all").and_then(language);
            let matches = |r: &Row| {
                wanted.as_ref().is_none_or(|l| r.assessment.lang == *l)
                && match filter.status.as_deref().unwrap_or("all") {
                    "review" => r.assessment.review(),
                    "all" => true,
                    status => r.assessment.status == status,
                }
                && (query.is_empty() || format!("{} {} {}",r.meta.title,r.meta.channel.as_deref().unwrap_or(""),r.meta.video_id).to_lowercase().contains(&query))
            };
            let mut rows: Vec<_> = rows.into_values().collect();
            rows.sort_by(|a,b| b.last.total_cmp(&a.last).then(a.device.cmp(&b.device)).then(a.metadata_id.cmp(&b.metadata_id)));
            let mut items: Vec<Value> = if filter.group.as_deref() == Some("video") {
                let mut groups: BTreeMap<String,Vec<Row>> = BTreeMap::new();
                for row in rows { groups.entry(row.meta.video_id.clone()).or_default().push(row); }
                groups.into_values().filter_map(|versions| {
                    let matched = versions.iter().filter(|r| matches(r)).count();
                    (matched > 0).then(|| grouped_video(&versions,&devices,matched))
                }).collect()
            } else {
                rows.iter().filter(|r| matches(r)).map(|row| {
                    let mut value = row.json();
                    value["contextOverride"] = devices.iter().find(|d|d["id"]==row.device)
                        .map(|d|d["contextOverride"].clone()).unwrap_or(Value::Null);
                    value
                }).collect()
            };
            items.sort_by(|a,b|b["lastWatched"].as_f64().unwrap().total_cmp(&a["lastWatched"].as_f64().unwrap())
                .then(a["videoId"].as_str().cmp(&b["videoId"].as_str()))
                .then(a["deviceId"].as_str().cmp(&b["deviceId"].as_str()))
                .then(a["metadataId"].as_str().cmp(&b["metadataId"].as_str())));
            let count = items.len();
            let pages = count.div_ceil(20).max(1);
            let page = filter.page.unwrap_or(1).min(pages);
            Ok(json!({"seconds":context.iter().sum::<f64>(),"foregroundSeconds":context[0],
                "backgroundSeconds":context[1],"unspecifiedSeconds":context[2],"days":days,
                "timezone":tz.to_string(),"since":window.since,"until":window.until,
                "devices":devices,"people":people,"videoCount":videos.len(),
                "languages":langs.into_iter().map(|(lang,(seconds,videos))| json!({"lang":lang,"seconds":seconds,"videoCount":videos.len()})).collect::<Vec<_>>(),
                "reviewSeconds":review,"confirmedSeconds":confirmed,"estimatedSeconds":estimated,
                "count":count,"page":page,"pages":pages,
                "videos":items.into_iter().skip((page-1)*20).take(20).collect::<Vec<_>>(),
                "providers":providers()}))
        }).await
    }

    pub async fn language_evidence(&self, device: String, id: String) -> Result<Value> {
        validate_target(&device, &id)?;
        self.read(move |db| {
            let meta = metadata(db,&device,&id)?;
            let text = evidence_text(db,&meta)?;
            let evidence = text.as_deref().map(decode::<Value>).transpose()?;
            let (revision,assessment,_) = latest(db,&device,&id,&meta)?;
            let mut history = Vec::new();
            let mut stmt = db.prepare("SELECT revision,action,assessment,note,created FROM language_assessments WHERE device=? AND metadata_id=? ORDER BY revision DESC LIMIT 100")?;
            let records = stmt.query_map(params![device,id], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,
                r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?)))?;
            for item in records {
                let (rev,action,payload,note,created) = item?;
                let mut value: Value = decode(&payload)?;
                value["revision"] = json!(rev); value["action"] = json!(action);
                value["note"] = json!(note); value["createdAt"] = json!(created);
                history.push(value);
            }
            Ok(json!({"videoId":meta.video_id,"title":meta.title,"deviceId":device,"metadataId":id,
                "evidenceId":meta.evidence_id,"evidenceText":text,"evidence":evidence,
                "recorded":recorded(&meta),"revision":revision,"assessment":assessment,
                "history":history,"historyLimit":100,"historyHasMore":revision>100}))
        }).await
    }

    pub async fn language_change(
        &self,
        input: Change,
        analyzed: Option<Assessment>,
    ) -> Result<Value> {
        input.validate()?;
        self.run(move |db| {
            let tx = db.transaction()?;
            let meta = metadata(&tx,&input.device_id,&input.metadata_id)?;
            let (revision,_,action) = latest(&tx,&input.device_id,&input.metadata_id,&meta)?;
            if revision != input.base_revision {
                return Err(conflict("Assessment changed. Refresh before saving."));
            }
            let assessment = match input.action.as_str() {
                "manual" => {
                    let lang = language(input.lang.as_deref().unwrap()).unwrap();
                    Assessment { status:if lang=="und" { "undetermined" } else { "confirmed" }.into(),
                        lang,source:"manual".into(),confidence:"human".into(),
                        reason:"Owner classification of this recorded audio version on this device.".into() }
                },
                "reset" => baseline(&meta),
                "analyze" => {
                    if action == "manual" { return Err(conflict("Manual classification is protected. Reset it before automatic analysis.")); }
                    analyzed.ok_or_else(|| invalid("Missing analysis result"))?
                },
                _ => unreachable!(),
            };
            let next = revision+1;
            tx.execute("INSERT INTO language_assessments VALUES(?,?,?,?,?,?,?)",
                params![input.device_id,input.metadata_id,next,input.action,serde_json::to_string(&assessment).unwrap(),input.note.trim(),now()])?;
            tx.commit()?;
            Ok(json!({"ok":true,"revision":next,"assessment":assessment}))
        }).await
    }
}

// Providers return interpretations, never mutate recordings or declare observed truth.
fn saved_audio(evidence: &Value) -> Assessment {
    inference::assess(evidence)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderResponse {
    scope: String,
    lang: String,
    confidence: String,
    basis: String,
    reason: String,
}

async fn external_analysis(
    detail: &Value,
    endpoint: &str,
    token: Option<&str>,
) -> Result<Assessment> {
    let url =
        reqwest::Url::parse(endpoint).map_err(|_| invalid("Invalid configured analyzer URL"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid(
            "Analyzer requires HTTPS (HTTP is allowed only on loopback)",
        ));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| invalid("Cannot initialize analyzer"))?;
    let mut request = client.post(url).json(&json!({"schemaVersion":1,"scope":"played-audio",
        "videoId":detail["videoId"],"evidenceId":detail["evidenceId"],"evidence":detail["evidence"],"recorded":detail["recorded"]}));
    if let Some(key) = token.filter(|s| !s.is_empty()) {
        request = request.bearer_auth(key);
    }
    let mut response = request.send().await.map_err(|_| {
        Error(
            StatusCode::BAD_GATEWAY,
            "Language analyzer unavailable or timed out".into(),
        )
    })?;
    if !response.status().is_success() {
        return Err(Error(
            StatusCode::BAD_GATEWAY,
            "Language analyzer rejected the request".into(),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        Error(
            StatusCode::BAD_GATEWAY,
            "Language analyzer response interrupted".into(),
        )
    })? {
        if bytes.len() + chunk.len() > 64_000 {
            return Err(Error(
                StatusCode::BAD_GATEWAY,
                "Language analyzer response too large".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: ProviderResponse =
        serde_json::from_slice(&bytes).map_err(|_| invalid("Malformed analyzer result"))?;
    let lang =
        language(&value.lang).ok_or_else(|| invalid("Analyzer returned an invalid language"))?;
    if value.scope != "played-audio"
        || !["high", "medium", "low"].contains(&value.confidence.as_str())
        || !["audio", "transcript", "metadata", "text"].contains(&value.basis.as_str())
        || value.reason.trim().is_empty()
        || value.reason.chars().count() > 2000
    {
        return Err(invalid(
            "Analyzer returned an invalid scope, confidence, basis or reason",
        ));
    }
    Ok(Assessment {
        status: if lang == "und" {
            "undetermined"
        } else {
            "estimated"
        }
        .into(),
        lang,
        source: format!("external-api:{}", value.basis),
        confidence: value.confidence,
        reason: value.reason,
    })
}

pub async fn dashboard(
    State(app): State<App>,
    headers: HeaderMap,
    Query(filter): Query<Filters>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(
        app.store.module_languages(filter, app.timezone).await?,
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
            .language_evidence(target.device, target.metadata)
            .await?,
    ))
}
pub async fn assess(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Change>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    input.validate()?;
    let analyzed = if input.action == "analyze" {
        let detail = app
            .store
            .language_evidence(input.device_id.clone(), input.metadata_id.clone())
            .await?;
        if detail["revision"] != input.base_revision {
            return Err(conflict("Assessment changed. Refresh before analyzing."));
        }
        if detail["assessment"]["source"] == "manual" {
            return Err(conflict(
                "Manual classification is protected. Reset it before automatic analysis.",
            ));
        }
        Some(if input.provider.as_deref() == Some("external") {
            let endpoint = std::env::var("LANGUAGE_ANALYZER_URL")
                .map_err(|_| invalid("No external language analyzer is configured"))?;
            let key = std::env::var("LANGUAGE_ANALYZER_TOKEN").ok();
            external_analysis(&detail, &endpoint, key.as_deref()).await?
        } else {
            saved_audio(&detail["evidence"])
        })
    } else {
        None
    };
    // A second revision check inside the transaction protects edits made during API latency.
    Ok(Json(app.store.language_change(input, analyzed).await?))
}

pub async fn assess_bulk(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<BulkChange>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.language_bulk_change(input).await?))
}

#[cfg(test)]
mod tests;

//! Automatic Home overlay. The worker discovers evidence; this module owns policy
//! and atomically publishes only against the exact input generation/revision.
use super::*;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub target_percent: u8,
    pub creator_limit: usize,
    pub search_budget: usize,
    pub replacement_positions: Vec<usize>,
    pub row_positions: BTreeMap<String, Vec<usize>>,
    pub excluded_rows: Vec<String>,
    pub trusted_channels: Vec<String>,
    pub blocked_channels: Vec<String>,
    pub pinned_originals: Vec<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self { enabled:false, target_percent:30, creator_limit:3, search_budget:12, excluded_rows:vec![],
            replacement_positions:vec![2,6,9], row_positions:BTreeMap::new(),
            trusted_channels:vec![], blocked_channels:vec![], pinned_originals:vec![] }
    }
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub settings: Settings,
    matches: Vec<Match>,
    native_originals: Vec<String>,
    checked_at: Option<i64>,
    #[serde(default)]
    retry_at: i64,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    fill_pending: bool,
    error: Option<String>,
    pub(super) undo_version: Option<u64>,
    report: Option<Value>,
    #[serde(default)]
    pub(super) publication: Publication,
}
#[derive(Clone, Default, Deserialize, Serialize)]
pub(super) struct Publication {
    pub selected: Vec<Match>,
    pub total: usize,
    pub native: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Match {
    original: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    original_card: Option<Card>,
    replacement: Card,
    original_duration: f64,
    duration: f64,
    #[serde(default)]
    topic: u8,
    #[serde(default)]
    intent: u8,
    #[serde(default)]
    depth: u8,
    #[serde(default)]
    quality: u8,
    reason: String,
    evidence: Evidence,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    #[serde(default)]
    basis: String,
    #[serde(default)]
    audio_language: String,
    #[serde(default)]
    audio_checked_at: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    asr_language: String,
    #[serde(default)]
    original_production: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    transcript_excerpt: String,
    #[serde(default)]
    description_excerpt: String,
    #[serde(default)]
    chapters: Vec<String>,
    #[serde(default)]
    source_language: String,
    #[serde(default)]
    query: String,
    #[serde(default)]
    search_rank: usize,
    checked_at: i64,
}
impl Match {
    fn valid(&self) -> bool {
        self.original.len() == 11
            && self.replacement.video_id.as_ref().is_some_and(|v| v.len()==11 && v != &self.original)
            && self.replacement.channel_id.is_some()
            && !self.replacement.is_live && !self.replacement.is_upcoming
            && Rules {insertions:vec![self.replacement.clone()],..Default::default()}.validate().is_ok()
            && self.original_duration.is_finite() && self.original_duration >= 0.
            && self.duration.is_finite() && self.duration > 0.
            && (!self.replacement.is_shorts || self.duration <= 180.)
            && (self.original_duration==0. || (0.5..=2.).contains(&(self.duration/self.original_duration)))
            && self.reason.len() >= 10 && self.reason.len() <= 1000
            && self.evidence.basis == "title-search-audio" && self.evidence.source_language == "en"
            && self.evidence.audio_language == "de" && self.evidence.original_production
            && self.evidence.audio_checked_at <= now() + 60_000
            && self.evidence.audio_checked_at > now() - 30 * 86_400_000
            && (3..=800).contains(&self.evidence.query.len()) && (1..=5).contains(&self.evidence.search_rank)
            && self.evidence.transcript_excerpt.is_empty() && self.evidence.asr_language.is_empty()
            && self.evidence.checked_at <= now() + 60_000
            && self.evidence.checked_at > now() - 30 * 86_400_000
    }
}

pub(super) fn selection(doc: &Document, edits: &Edits) -> (Vec<Row>, Vec<Match>, usize, usize) {
    let mut rows = compose(&doc.source, edits);
    let total = rows.iter().flat_map(|r| &r.items).filter(|c| c.video_id.is_some()).count();
    let native = rows.iter().flat_map(|r| &r.items).filter(|c| c.video_id.as_ref()
        .is_some_and(|v| doc.german.native_originals.contains(v))).count();
    let s = &doc.german.settings;
    if doc.category != "home" || !s.enabled { return (rows, vec![], total, native); }
    let target = (total * usize::from(s.target_percent) + 50) / 100;
    let mut used: HashSet<_> = rows.iter().flat_map(|r| &r.items).filter_map(|c| c.video_id.clone()).collect();
    let mut creators = HashMap::<String, usize>::new();
    for c in rows.iter().flat_map(|r| &r.items) {
        if let Some(id) = &c.channel_id { *creators.entry(id.clone()).or_default() += 1; }
    }
    let candidates = doc.german.matches.iter().filter(|m| m.valid());
    let mut selected = Vec::new();
    let mut replaced = HashSet::new();
    let manual:HashSet<_>=edits.rows.values().flat_map(|r| &r.added).filter_map(|c|c.video_id.as_ref()).collect();
    let positions:HashMap<_,_>=rows.iter().map(|row| {
        let movable=|c:&Card|c.video_id.as_ref().is_some_and(|id|!manual.contains(id)
            && !s.pinned_originals.contains(id) && !doc.german.native_originals.contains(id))
            && c.playlist_id.is_none() && !c.is_live && !c.is_upcoming;
        let slots:Vec<_>=s.row_positions.get(&row.id).unwrap_or(&s.replacement_positions).iter()
            .filter_map(|p|p.checked_sub(1)).filter(|i|row.items.len()>=10.max(*i+2)
                && row.items.get(*i).is_some_and(movable)).collect();
        (row.id.clone(),slots)
    }).collect();
    let anchors:HashSet<_>=rows.iter().flat_map(|r|positions[&r.id].iter()
        .filter_map(|i|r.items[*i].video_id.clone())).collect();
    let mut retained=HashSet::<String>::new();
    for m in candidates {
        if native + selected.len() >= target { break; }
        let id = m.replacement.video_id.as_ref().unwrap();
        let channel = m.replacement.channel_id.as_ref().unwrap();
        if used.contains(id) || replaced.contains(&m.original) || manual.contains(&m.original) || s.pinned_originals.contains(&m.original)
            || doc.german.native_originals.contains(&m.original) || s.blocked_channels.contains(channel)
            || edits.blocked_channels.contains(channel) || edits.removed.contains(&card_key(&m.replacement))
            || creators.get(channel).copied().unwrap_or(0) >= s.creator_limit { continue; }
        let slot = rows.iter().enumerate().filter(|(_,r)| !s.excluded_rows.contains(&r.id))
            .find_map(|(ri,r)|positions[&r.id].iter().copied().find_map(|ci| {
                let c=&r.items[ci];
                if c.video_id.as_ref()!=Some(&m.original) || c.is_shorts!=m.replacement.is_shorts { return None; }
                let limit=edits.rows.get(&r.id).and_then(|e|e.limit).or(edits.card_limit).unwrap_or(CARD_LIMIT);
                let tail=if r.items.len()<limit {Some(r.items.len())} else {
                    r.items.iter().enumerate().rfind(|(i,c)|*i>=10.max(ci+2)
                        && !s.row_positions.get(&r.id).unwrap_or(&s.replacement_positions).contains(&(i+1))
                        && c.video_id.as_ref().is_some_and(|id|!manual.contains(id) && !s.pinned_originals.contains(id)
                            && !doc.german.native_originals.contains(id) && !retained.contains(id)
                            && !replaced.contains(id) && !anchors.contains(id))
                        && c.playlist_id.is_none() && !c.is_live && !c.is_upcoming).map(|(i,_)|i)
                };
                tail.map(|tail|(ri,ci,tail))
            }));
        if let Some((ri,ci,tail)) = slot {
            let row=&mut rows[ri];
            let card=&mut row.items[ci];
            let mut record=m.clone();
            record.original_card=Some(card.clone());
            *card = m.replacement.clone();
            if tail==row.items.len() {
                row.items.push(record.original_card.clone().unwrap());
            } else {
                if let Some(old)=&row.items[tail].channel_id { *creators.entry(old.clone()).or_default()-=1; }
                row.items[tail]=record.original_card.clone().unwrap();
            }
            retained.insert(id.clone());
            used.insert(id.clone());
            replaced.insert(m.original.clone());
            *creators.entry(channel.clone()).or_default() += 1;
            selected.push(record);
        }
    }
    let total=rows.iter().flat_map(|r|&r.items).filter(|c|c.video_id.is_some()).count();
    (rows, selected, total, native)
}

/// Hold a refreshed Home for the mix only when the mix can actually run now;
/// otherwise the refresh publishes immediately with existing matches.
pub(super) fn defer_to_mix(doc: &Document) -> bool {
    doc.category == "home" && doc.german.settings.enabled && configured() && doc.german.retry_at <= now()
}
pub(super) const MISSING_KEY: &str = "Add a DeepSeek API key above to start matching.";
fn missing_key_error(error: &str) -> bool { error == MISSING_KEY || error.starts_with("Set DEEPSEEK_API_KEY") }
/// Once a key exists (server config or saved), lift the stale missing-key pause.
fn clear_missing_key(doc: &mut Document, configured: bool) -> bool {
    if !configured || !doc.german.error.as_deref().is_some_and(missing_key_error) { return false; }
    doc.german.error = None;
    doc.german.retry_at = 0;
    true
}

/// Owner-saved key, kept beside the database and never returned to clients.
fn saved_key_path() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "data".into())).join("deepseek-api-key")
}
pub(super) fn configured() -> bool { server_configured() || saved_key_path().is_file() }
/// "server" (environment/config file, takes precedence), "saved" (owner UI) or none.
fn key_source() -> Option<&'static str> {
    if server_configured() { Some("server") } else if saved_key_path().is_file() { Some("saved") } else { None }
}
fn valid_key(key: &str) -> bool { (20..=200).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_graphic()) }
/// Atomically replace the key file with owner-only permissions.
fn write_key(path: &std::path::Path, key: &str) -> std::io::Result<()> {
    use std::io::Write;
    let temporary = path.with_extension(format!("tmp-{}", token()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let result = options.open(&temporary).and_then(|mut file| { file.write_all(key.as_bytes())?; file.sync_all() })
        .and_then(|_| std::fs::rename(&temporary, path));
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}
/// Ask DeepSeek whether it accepts the key (lists models; no tokens are used).
async fn verify_key(base: &str, key: &str) -> Result<()> {
    let response = reqwest::Client::builder().timeout(Duration::from_secs(15)).build()
        .map_err(|_| upstream_error("Could not check the key with DeepSeek"))?
        .get(format!("{base}/models")).bearer_auth(key).send().await
        .map_err(|_| upstream_error("Could not reach DeepSeek to check the key; it was not saved. Try again."))?;
    match response.status().as_u16() {
        200..=299 => Ok(()),
        401 | 403 => Err(invalid("DeepSeek rejected this key; it was not saved.")),
        _ => Err(upstream_error("DeepSeek could not check the key right now; it was not saved. Try again.")),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyInput { key: String }
pub async fn save_key(axum::extract::State(app): axum::extract::State<App>, headers: HeaderMap, Json(input): Json<KeyInput>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    let key = input.key.trim().to_owned();
    if !valid_key(&key) { return Err(invalid("Paste the whole DeepSeek API key (20–200 characters, no spaces).")); }
    let base = std::env::var("DEEPSEEK_API_BASE").unwrap_or_else(|_| "https://api.deepseek.com".into());
    verify_key(&base, &key).await?;
    let path = saved_key_path();
    tokio::task::spawn_blocking(move || write_key(&path, &key)).await
        .map_err(|_| upstream_error("Could not save the key"))?.map_err(|_| upstream_error("Could not save the key"))?;
    // Lift the missing-key pause so matching can start now rather than after its cooldown.
    let ids = app.store.run(|db| {
        let texts = db.prepare("SELECT payload FROM curated_feeds")?
            .query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let tx = db.transaction()?;
        let mut ids = Vec::new();
        for text in texts {
            let mut doc: Document = decode(&text)?;
            if clear_missing_key(&mut doc, true) {
                store(&tx, &doc)?;
                if doc.german.settings.enabled { ids.push(doc.id); }
            }
        }
        tx.commit()?;
        Ok(ids)
    }).await?;
    for id in ids { queue(app.clone(), id); }
    Ok(Json(json!({"ok":true,"keySource":key_source()})))
}
pub async fn remove_key(axum::extract::State(app): axum::extract::State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    match std::fs::remove_file(saved_key_path()) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(upstream_error("Could not remove the key")),
    }
    Ok(Json(json!({"ok":true,"keySource":key_source()})))
}

fn server_configured() -> bool {
    std::env::var("DEEPSEEK_API_KEY").is_ok_and(|v| !v.trim().is_empty())
        || std::env::var("DEEP_SEEK_API").is_ok_and(|v| !v.trim().is_empty())
        || std::env::var("DEEPSEEK_API_KEY_FILE").is_ok_and(|p| std::path::Path::new(&p).is_file())
        || std::fs::read_to_string(std::env::var("OWNTUBE_ENV_FILE").unwrap_or_else(|_| ".env".into()))
            .is_ok_and(|text| text.lines().any(|line| line.trim().trim_start_matches("export ").split_once('=')
                .is_some_and(|(key,value)| matches!(key.trim(),"DEEPSEEK_API_KEY"|"DEEP_SEEK_API") && !value.trim().is_empty())))
}
pub(super) fn view(doc: &Document, running: bool) -> Value {
    let Publication { selected, total, native } = &doc.german.publication;
    json!({"settings":doc.german.settings,"running":running,"fillPending":doc.german.fill_pending,"configured":configured(),"keySource":key_source(),"evidenceMode":"title-search-audio",
        "checkedAt":doc.german.checked_at,"retryAt":doc.german.retry_at,"error":doc.german.error,"undoAvailable":doc.german.undo_version.is_some(),
        "matches":doc.german.matches,"selected":selected,"nativeOriginals":doc.german.native_originals,
        "total":total,"native":native,"replacements":selected.len(),
        "achievedPercent":if *total==0 {0.} else {100. * (native+selected.len()) as f64 / *total as f64},
        "report":doc.german.report})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change { revision: u64, generation: u64, settings: Settings }
fn validate_settings(s: &Settings) -> Result<()> {
    let valid_positions=|positions:&Vec<usize>|positions.len()<=10
        && positions.iter().all(|p|(1..=48).contains(p)) && positions.windows(2).all(|p|p[0]<p[1]);
    let id = |s: &String| !s.is_empty() && s.len()<=128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b==b'_' || b==b'-');
    if !valid_positions(&s.replacement_positions) || s.row_positions.len()>64
        || s.row_positions.iter().any(|(row,p)|row.len()>200 || !valid_positions(p))
        || s.target_percent>100 || !(1..=20).contains(&s.creator_limit) || !(1..=50).contains(&s.search_budget) || s.excluded_rows.len()>64
        || s.excluded_rows.iter().any(|s| s.len()>200) || s.pinned_originals.len()>2000
        || s.pinned_originals.iter().any(|s| s.len()!=11 || !id(s))
        || s.trusted_channels.len()>1000 || s.blocked_channels.len()>1000
        || s.trusted_channels.iter().chain(&s.blocked_channels).any(|s| !id(s)) {
        return Err(invalid("Invalid German-mix settings"));
    }
    Ok(())
}
pub async fn settings(axum::extract::State(app): axum::extract::State<App>, headers: HeaderMap,
    Path(id): Path<String>, Json(change): Json<Change>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    validate_settings(&change.settings)?;
    let key = id.clone();
    let changed=app.store.run(move |db| {
        let tx = db.transaction()?;
        let mut doc = load(&tx, &key)?;
        if doc.category != "home" { return Err(invalid("German mixing applies to Home")); }
        if doc.version == 0 { return Err(invalid("Wait for the first cached Home feed")); }
        if doc.revision!=change.revision || doc.generation!=change.generation { return Err(conflict()); }
        if doc.german.settings==change.settings { return Ok(false); }
        doc.german.settings = change.settings;
        if !doc.german.settings.enabled { doc.german.fill_pending=false; }
        if doc.german.retry_at <= now() { doc.german.error = None; }
        doc.revision += 1;
        // Controls take effect immediately, using cached title-search matches.
        doc.german.undo_version = (doc.version>0).then_some(doc.version);
        publish_rows(&tx, &mut doc)?;
        tx.commit()?;
        Ok(true)
    }).await?;
    if changed { queue(app, id); }
    Ok(Json(json!({"ok":true,"changed":changed})))
}
pub async fn run(axum::extract::State(app): axum::extract::State<App>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    let key = id.clone();
    app.store.read(move |db| {
        let doc=load(db,&key)?;
        if doc.category!="home" || !doc.german.settings.enabled { return Err(invalid("Enable the Home German mix first")); }
        Ok(())
    }).await?;
    queue(app,id);
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Version { revision: u64, generation: u64 }
pub async fn fill(axum::extract::State(app): axum::extract::State<App>, headers: HeaderMap,
    Path(id): Path<String>, Json(input): Json<Version>) -> Result<Json<Value>> {
    owner(&app,&headers).await?;
    let key=id.clone();
    app.store.run(move |db| {
        let mut doc=load(db,&key)?;
        if doc.revision!=input.revision || doc.generation!=input.generation { return Err(conflict()); }
        if doc.category!="home" || !doc.german.settings.enabled || doc.version==0 {
            return Err(invalid("Enable the cached Home German mix first"));
        }
        if !doc.german.fill_pending {
            doc.german.fill_pending=true;
            doc.revision+=1;
            store(db,&doc)?;
        }
        Ok(())
    }).await?;
    queue(app,id);
    Ok(Json(json!({"ok":true})))
}
pub async fn undo(axum::extract::State(app): axum::extract::State<App>, headers: HeaderMap,
    Path(id): Path<String>, Json(input): Json<Version>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    app.store.run(move |db| {
        let tx=db.transaction()?;
        let mut doc=load(&tx,&id)?;
        if doc.revision!=input.revision || doc.generation!=input.generation { return Err(conflict()); }
        let version=doc.german.undo_version.ok_or_else(|| invalid("No German mix to undo"))?;
        let rows:String=tx.query_row("SELECT rows FROM curated_versions WHERE feed=? AND version=?",params![id,version],|r|r.get(0))
            .optional()?.ok_or_else(|| invalid("Undo version expired"))?;
        let projection:Option<String>=tx.query_row("SELECT payload FROM curated_german_versions WHERE feed=? AND version=?",params![id,version],|r|r.get(0)).optional()?;
        doc.german.publication=projection.map(|p|decode(&p)).transpose()?.unwrap_or_default();
        doc.german.settings.enabled=false;
        doc.german.fill_pending=false;
        doc.german.undo_version=None;
        doc.german.error=None;
        doc.revision+=1;
        doc.version+=1;
        doc.published_at=Some(now());
        tx.execute("INSERT INTO curated_versions VALUES(?,?,?,?)",params![id,doc.version,now(),rows])?;
        tx.execute("INSERT INTO curated_german_versions VALUES(?,?,?)",params![id,doc.version,encode(&doc.german.publication)?])?;
        store(&tx,&doc)?;
        tx.commit()?;
        Ok(())
    }).await?;
    Ok(Json(json!({"ok":true,"message":"Previous publication restored; automatic German mixing paused."})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Output { matches: Vec<Match>, native_originals: Vec<String>, report: Value }
async fn worker(doc: &Document, feed: &Feed) -> Result<Output> {
    if !configured() { return Err(invalid(MISSING_KEY)); }
    let script=std::env::var("OWNTUBE_GERMAN_WORKER").unwrap_or_else(|_| "scripts/german-matcher.py".into());
    let mut command=tokio::process::Command::new("python3");
    // Server configuration takes precedence; otherwise hand the worker the owner-saved key file.
    if !server_configured() { command.env("DEEPSEEK_API_KEY_FILE", saved_key_path()); }
    let mut child=command.arg(script)
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped()).kill_on_drop(true).spawn()
        .map_err(|_| upstream_error("Could not start the German matcher"))?;
    let mut settings=doc.german.settings.clone();
    settings.blocked_channels.extend(doc.published.blocked_channels.clone());
    settings.pinned_originals.extend(doc.published.rows.values().flat_map(|r| &r.added).filter_map(|c|c.video_id.clone()));
    let removed:Vec<_>=doc.published.removed.iter().filter_map(|v|v.strip_prefix("video:")).collect();
    let rows=compose(&doc.source,&doc.published);
    let limits:BTreeMap<_,_>=rows.iter().map(|r|(&r.id,doc.published.rows.get(&r.id)
        .and_then(|e|e.limit).or(doc.published.card_limit).unwrap_or(CARD_LIMIT))).collect();
    let input=json!({"rows":rows,"rowLimits":limits,"settings":settings,"removedVideos":removed,
        "fillTarget":doc.german.fill_pending});
    let mut stdin=child.stdin.take().unwrap();
    let output=child.stdout.take().unwrap();
    let mut progress=BufReader::new(child.stderr.take().unwrap().take(1_000_000)).lines();
    let operation=async {
        stdin.write_all(input.to_string().as_bytes()).await.map_err(|_| upstream_error("Matcher input failed"))?;
        drop(stdin);
        let mut bytes=Vec::new();
        let read_output=async {
            output.take(8_000_001).read_to_end(&mut bytes).await.map_err(|_| upstream_error("Matcher output failed"))?;
            if bytes.len()>8_000_000 { return Err(upstream_error("Matcher output exceeded its limit")); }
            Ok::<_,Error>(())
        };
        let read_progress=async {
            while let Ok(Some(line))=progress.next_line().await {
                if line.len()>4000 { continue; }
                if let Ok(value)=serde_json::from_str::<Value>(&line)
                    && value["type"]=="progress"
                    && value["total"].as_u64().is_some_and(|n|n<=2000)
                    && value["completed"].as_u64().is_some_and(|n|n<=2000)
                    && value["candidates"].as_u64().is_some_and(|n|n<=2000)
                    && value["title"].as_str().is_some_and(|s|s.len()<=1000) {
                    feed.mix_progress.lock().unwrap().insert(doc.id.clone(),value);
                }
            }
            Ok::<_,Error>(())
        };
        tokio::try_join!(read_output,read_progress)?;
        let status=child.wait().await.map_err(|_| upstream_error("Matcher process failed"))?;
        if !status.success() {
            let response:Value=serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            return Err(match response["errorCode"].as_str() {
                Some("youtube_search_rate_limited") => Error(StatusCode::TOO_MANY_REQUESTS,"YouTube is rate-limiting search. Matching is cooling down for one hour; previous publication kept.".into()),
                Some("deepseek_rate_limited") => Error(StatusCode::TOO_MANY_REQUESTS,"DeepSeek is rate-limiting requests. Matching is cooling down for one hour; previous publication kept.".into()),
                _ => upstream_error("German matcher failed. Check the DeepSeek key, quota and YouTube access; previous publication kept."),
            });
        }
        let output:Output=serde_json::from_slice(&bytes).map_err(|_| upstream_error("Invalid matcher result; previous publication kept"))?;
        if output.matches.len()>2000 || output.matches.iter().any(|m| !m.valid()) || output.native_originals.len()>2000 {
            return Err(upstream_error("Matcher returned invalid evidence; previous publication kept"));
        }
        Ok(output)
    };
    tokio::time::timeout(Duration::from_secs(2400),operation).await
        .unwrap_or_else(|_| Err(upstream_error("German matching timed out; previous publication kept")))
}

pub(super) fn queue(app: App, id: String) {
    if !app.feed.mixing.lock().unwrap().insert(id.clone()) { return; }
    tokio::spawn(async move {
      loop {
        let key=id.clone();
        let snapshot=app.store.read(move |db| load(db,&key)).await;
        if let Ok(doc)=snapshot
            && doc.category=="home" && doc.german.settings.enabled && doc.german.retry_at <= now() {
            app.feed.mix_progress.lock().unwrap().remove(&id);
            let output=worker(&doc,&app.feed).await;
            let more=output.as_ref().is_ok_and(|o|
                o.report["remaining"].as_u64().unwrap_or(0)>0 && o.report["checked"].as_u64().unwrap_or(0)>0);
            let key=id.clone();
            let saved=app.store.run(move |db| complete(db,&key,&doc,output)).await;
            if saved.is_err() { eprintln!("Could not persist German matching result"); }
            if matches!(saved,Ok(true)) || saved.is_ok() && more { continue; }
        }
        break;
      }
        app.feed.mixing.lock().unwrap().remove(&id);
        app.feed.mix_progress.lock().unwrap().remove(&id);
    });
}

fn complete(db: &mut Connection, key: &str, doc: &Document, output: Result<Output>) -> Result<bool> {
    let tx=db.transaction()?;
    let mut current=load(&tx,key)?;
    if current.revision!=doc.revision || current.generation!=doc.generation || current.version!=doc.version {
        // A newer owner decision wins. Re-run against it while holding single-flight.
        return Ok(true);
    }
    current.german.checked_at=Some(now());
    match output {
        Ok(output) => {
            if output.report["remaining"].as_u64().unwrap_or(0)==0 {
                current.german.fill_pending=false;
            }
            current.german.matches=output.matches;
            current.german.native_originals=output.native_originals;
            current.german.report=Some(output.report);
            current.german.error=None;
            current.german.retry_at=0;
            if current.german.undo_version.is_none() {
                current.german.undo_version=(current.version>0).then_some(current.version);
            }
            publish_rows(&tx,&mut current)?;
        }
        Err(error) => {
            current.german.retry_at=now()+if error.0==StatusCode::TOO_MANY_REQUESTS {3_600_000} else {WINDOW};
            current.german.error=Some(error.1);
            // Never let a failed mix freeze the feed: publish a newer source with existing matches.
            if current.cached_at.unwrap_or(0) > current.published_at.unwrap_or(0) { publish_rows(&tx,&mut current)?; }
            else { store(&tx,&current)?; }
        }
    }
    tx.commit()?;
    Ok(false)
}

/// Cached Home matching does not need the TV's YouTube credentials. Resume
/// unfinished jobs after restart and retry provider cooldowns autonomously.
fn title_mode(doc: &mut Document) -> bool {
    if doc.german.mode == "title-search-audio" { return false; }
    doc.german.mode="title-search-audio".into();
    doc.german.checked_at=None;
    doc.german.matches.retain(|m|m.valid());
    // Use the clean migration publication as the next undo baseline instead of
    // resurrecting legacy title-only alternatives.
    doc.german.undo_version=None;
    doc.german.native_originals.clear();
    doc.german.report=None;
    // Retire the old analysis job's status; retain a provider rate limit.
    if !doc.german.error.as_ref().is_some_and(|s|s.starts_with("DeepSeek")) {
        doc.german.retry_at=0;
        doc.german.error=None;
    }
    doc.revision+=1;
    true
}
pub fn resume(app: App) {
    tokio::spawn(async move {
        let mut interval=tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            let due=app.store.run(|db| {
                let texts=db.prepare("SELECT payload FROM curated_feeds")?
                    .query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                let mut ids=Vec::new();
                for text in texts {
                    let mut doc:Document=decode(&text)?;
                    if doc.category!="home" { continue; }
                    if clear_missing_key(&mut doc, configured()) {
                        let tx=db.transaction()?;store(&tx,&doc)?;tx.commit()?;
                    }
                    if title_mode(&mut doc) {
                        // Retire title-only selections immediately, even if the
                        // provider is unavailable. Existing pagination is immutable.
                        let tx=db.transaction()?;
                        if doc.version>0 { publish_rows(&tx,&mut doc)?; } else { store(&tx,&doc)?; }
                        tx.commit()?;
                    }
                    if doc.german.settings.enabled && doc.cached_at.is_some()
                        && doc.german.retry_at <= now()
                        && (doc.german.fill_pending || doc.german.checked_at.is_none() || doc.cached_at>doc.german.checked_at || doc.german.retry_at>0
                            || doc.german.report.as_ref().is_some_and(|r| r["targetRemaining"].as_u64().unwrap_or(0)>0
                                && r["nextCycleAt"].as_i64().is_some_and(|t|t<=now()))) {
                        ids.push(doc.id);
                    }
                }
                Ok(ids)
            }).await;
            if let Ok(ids)=due {
                for id in ids { queue(app.clone(),id); }
            }
        }
    });
}

#[cfg(test)]
mod tests;

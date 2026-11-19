//! Durable source snapshots + editorial overlays + immutable TV publications.
//! No access tokens are persisted. Refreshes use the active TV request's credentials.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::{BTreeMap, HashSet};

const WINDOW: i64 = 6 * 60 * 60 * 1000;
const ROW_LIMIT: usize = 32;
const CARD_LIMIT: usize = 48;
const PAGE_ROWS: usize = 8;
const PAGE_CARDS: usize = 12;
pub const CATEGORIES: &[&str] = &["home", "music", "news", "gaming", "sports", "live", "trending"];
pub mod german;

pub fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS curated_feeds(
            id TEXT PRIMARY KEY, device TEXT NOT NULL REFERENCES devices(id), payload TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS curated_versions(
             feed TEXT NOT NULL REFERENCES curated_feeds(id), version INTEGER NOT NULL,
             created INTEGER NOT NULL, rows TEXT NOT NULL, PRIMARY KEY(feed,version));
         CREATE TABLE IF NOT EXISTS curated_german_versions(
             feed TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
             PRIMARY KEY(feed,version),
             FOREIGN KEY(feed,version) REFERENCES curated_versions(feed,version) ON DELETE CASCADE);"
    )
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    card_limit: Option<usize>,
    #[serde(default)]
    removed: Vec<String>,
    #[serde(default)]
    blocked_channels: Vec<String>,
    #[serde(default)]
    rows: BTreeMap<String, RowEdit>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RowEdit {
    title: String,
    #[serde(default)]
    added: Vec<Card>,
    #[serde(default)]
    order: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    limit: Option<usize>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    id: String,
    #[serde(default)]
    audience: String,
    device: String,
    label: String,
    category: String,
    revision: u64,
    generation: u64,
    version: u64,
    served_version: Option<u64>,
    served_at: Option<i64>,
    cached_at: Option<i64>,
    published_at: Option<i64>,
    next_refresh_at: i64,
    retry_at: i64,
    error: Option<String>,
    limited: bool,
    source: Vec<Row>,
    draft: Edits,
    published: Edits,
    #[serde(default)]
    german: german::State,
}

fn broken() -> Error { Error(StatusCode::INTERNAL_SERVER_ERROR, "Cannot read saved feed".into()) }
fn missing() -> Error { Error(StatusCode::NOT_FOUND, "Feed not found. Open this category on the TV first.".into()) }
fn conflict() -> Error { Error(StatusCode::CONFLICT, "The feed changed. Reload before saving or publishing.".into()) }
fn decode<T: serde::de::DeserializeOwned>(text: &str) -> Result<T> {
    serde_json::from_str(text).map_err(|_| broken())
}
fn encode<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|_| broken())
}
fn load(db: &Connection, id: &str) -> Result<Document> {
    let text: Option<String> = db.query_row("SELECT payload FROM curated_feeds WHERE id=?", [id], |r| r.get(0)).optional()?;
    decode(&text.ok_or_else(missing)?)
}
fn store(db: &Connection, doc: &Document) -> Result<()> {
    db.execute("INSERT INTO curated_feeds(id,device,payload) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
        params![doc.id, doc.device, encode(doc)?])?;
    Ok(())
}

pub fn card_key(card: &Card) -> String {
    if let Some(id) = &card.video_id { format!("video:{id}") }
    else if let Some(id) = &card.playlist_id { format!("playlist:{id}") }
    else { format!("channel:{}", card.channel_id.as_deref().unwrap_or("")) }
}

fn compose(source: &[Row], edits: &Edits) -> Vec<Row> {
    let allowed = |c: &Card| !edits.removed.contains(&card_key(c))
        && !c.channel_id.as_ref().is_some_and(|id| edits.blocked_channels.contains(id));
    let mut rows = source.to_vec();
    // Keep explicitly added cards if YouTube later removes their destination shelf.
    for (id, edit) in &edits.rows {
        if !edit.added.is_empty() && !rows.iter().any(|r| &r.id == id) {
            rows.push(Row { id: id.clone(), title: edit.title.clone(), items: vec![], next: None });
        }
    }
    for row in &mut rows {
        row.next = None;
        if let Some(edit) = edits.rows.get(&row.id) {
            let additions: HashSet<_> = edit.added.iter().map(card_key).collect();
            row.items.retain(|c| !additions.contains(&card_key(c)));
            row.items.extend(edit.added.clone());
            let ranks: BTreeMap<_, _> = edit.order.iter().enumerate().map(|(i,k)| (k, i)).collect();
            row.items.sort_by_key(|c| ranks.get(&card_key(c)).copied().unwrap_or(usize::MAX));
        }
        let mut seen = HashSet::new();
        row.items.retain(|c| allowed(c) && seen.insert(card_key(c)));
        let limit = edits.rows.get(&row.id).and_then(|edit| edit.limit)
            .or(edits.card_limit).unwrap_or(CARD_LIMIT);
        row.items.truncate(limit);
    }
    rows
}

fn validate(edits: &Edits, doc: &Document) -> Result<()> {
    if edits.card_limit.is_some_and(|limit| !(1..=CARD_LIMIT).contains(&limit)) {
        return Err(invalid("Category card limit must be between 1 and 48"));
    }
    let valid_key = |s: &str| s.len() <= 150 && s.split_once(':').is_some_and(|(kind,id)|
        matches!(kind, "video" | "channel" | "playlist") && !id.is_empty()
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
    if edits.removed.len() > 2000 || edits.blocked_channels.len() > 1000 || edits.rows.len() > 64
        || edits.removed.iter().any(|s| !valid_key(s))
        || edits.blocked_channels.iter().any(|s| s.is_empty() || s.len() > 128 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')) {
        return Err(invalid("Invalid curation rules"));
    }
    for (id, row) in &edits.rows {
        if row.limit.is_some_and(|limit| !(1..=CARD_LIMIT).contains(&limit)) {
            return Err(invalid("Row card limit must be between 1 and 48, or null to use the category default"));
        }
        if !doc.source.iter().any(|r| &r.id == id) && !doc.draft.rows.contains_key(id) && !doc.published.rows.contains_key(id) {
            return Err(invalid("Choose an existing cached row"));
        }
        if row.title.len() > 1000 || row.order.len() > 250 || row.order.iter().any(|s| !valid_key(s))
            || row.order.iter().collect::<HashSet<_>>().len() != row.order.len() {
            return Err(invalid("Invalid row order"));
        }
        Rules { insertions: row.added.clone(), ..Default::default() }.validate()?;
        if row.added.iter().any(|c| c.video_id.as_ref().is_none_or(|id| id.len() != 11) || c.badge.as_ref().is_some_and(|s| s.len() > 100)) {
            return Err(invalid("Add a valid YouTube video"));
        }
    }
    Ok(())
}

fn publish_rows(db: &Connection, doc: &mut Document) -> Result<()> {
    doc.version += 1;
    doc.published_at = Some(now());
    let (rows, selected, total, native) = german::selection(doc, &doc.published);
    doc.german.publication = german::Publication { selected, total, native };
    db.execute("INSERT INTO curated_versions(feed,version,created,rows) VALUES(?,?,?,?)",
        params![doc.id, doc.version, now(), encode(&rows)?])?;
    db.execute("INSERT INTO curated_german_versions VALUES(?,?,?)",
        params![doc.id,doc.version,encode(&doc.german.publication)?])?;
    // Retain at least sixteen generations AND every generation from the last day.
    db.execute("DELETE FROM curated_versions WHERE feed=? AND version<? AND created<?",
        params![doc.id, doc.version.saturating_sub(15), now() - 86_400_000])?;
    store(db, doc)
}

async fn snapshot(feed: &Feed, scope: &str, request: &Request, headers: &HeaderMap) -> Result<(Vec<Row>, bool)> {
    let mut rows = Vec::new();
    let mut query = request.clone();
    query.cursor = None;
    let mut calls = 0;
    let mut limited = false;
    loop {
        let page = feed.upstream(scope.into(), query.clone(), headers, false).await?;
        calls += 1;
        rows.extend(page.rows);
        if page.next.is_none() { break; }
        if rows.len() >= ROW_LIMIT || calls >= 20 { limited = true; break; }
        query.cursor = page.next;
    }
    rows.truncate(ROW_LIMIT);
    let mut titles = BTreeMap::<String, usize>::new();
    for row in &mut rows {
        let mut seen: HashSet<String> = row.items.iter().map(card_key).collect();
        while let Some(cursor) = row.next.take() {
            if row.items.len() >= CARD_LIMIT || calls >= 100 { limited = true; break; }
            query.cursor = Some(cursor);
            let page = feed.upstream(scope.into(), query.clone(), headers, false).await?;
            calls += 1;
            let more = page.rows.into_iter().next().ok_or_else(|| upstream_error("Missing cached row continuation"))?;
            row.items.extend(more.items.into_iter().filter(|c| seen.insert(card_key(c))));
            row.next = more.next;
        }
        row.items.truncate(CARD_LIMIT);
        let count = titles.entry(row.title.clone()).or_default();
        row.id = format!("{}:{}:{}", request.category, &store::hash(&row.title)[..16], count);
        *count += 1;
    }
    if rows.iter().all(|r| r.items.is_empty()) {
        return Err(upstream_error("YouTube returned no supported cards; the previous cached feed was kept"));
    }
    Ok((rows, limited))
}

fn queue_refresh(app: App, id: String, request: Request, headers: HeaderMap) {
    if !app.feed.refreshing.lock().unwrap().insert(id.clone()) { return; }
    tokio::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(120), snapshot(&app.feed, &id, &request, &headers)).await
            .unwrap_or_else(|_| Err(upstream_error("Feed refresh timed out; the previous cache was kept")));
        let key = id.clone();
        let saved = app.store.run(move |db| {
            let tx = db.transaction()?;
            let mut doc = load(&tx, &key)?;
            let refreshed = result.is_ok();
            match result {
                Ok((rows, limited)) => {
                    doc.source = rows;
                    doc.limited = limited;
                    doc.cached_at = Some(now());
                    doc.generation += 1;
                    doc.error = None;
                    doc.retry_at = 0;
                    doc.next_refresh_at = (now().div_euclid(WINDOW) + 1) * WINDOW;
                    if doc.category == "home" && doc.german.settings.enabled {
                        doc.german.undo_version = (doc.version>0).then_some(doc.version);
                        store(&tx, &doc)?;
                    } else {
                        publish_rows(&tx, &mut doc)?;
                    }
                }
                Err(error) => {
                    doc.error = Some(error.1);
                    doc.retry_at = now() + 5 * 60 * 1000;
                    store(&tx, &doc)?;
                }
            }
            tx.commit()?;
            Ok(refreshed)
        }).await;
        if saved.is_err() { eprintln!("Could not persist feed refresh"); }
        app.feed.refreshing.lock().unwrap().remove(&id);
        if matches!(saved,Ok(true)) { german::queue(app.clone(), id); }
    });
}

#[derive(Deserialize, Serialize)]
struct CachedCursor { feed: String, version: u64, row: Option<usize>, offset: usize }
fn cursor(feed: &str, version: u64, row: Option<usize>, offset: usize) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(&CachedCursor { feed:feed.into(), version,row,offset }).unwrap())
}
fn expired() -> Error { Error(StatusCode::GONE, "Cached feed version expired. Reopen the category.".into()) }
fn page(rows: &[Row], id: &str, version: u64, request: Option<CachedCursor>) -> Result<Value> {
    let (row, offset) = request.map(|c| (c.row, c.offset)).unwrap_or((None, 0));
    let mut result = Vec::new();
    if let Some(index) = row {
        let source = rows.get(index).ok_or_else(expired)?;
        if offset > source.items.len() { return Err(expired()); }
        let mut r = source.clone();
        r.items = source.items.iter().skip(offset).take(PAGE_CARDS).cloned().collect();
        r.next = (offset + PAGE_CARDS < source.items.len()).then(|| cursor(id,version,Some(index),offset+PAGE_CARDS));
        result.push(r);
    } else {
        if offset > rows.len() { return Err(expired()); }
        for (i, source) in rows.iter().enumerate().skip(offset).take(PAGE_ROWS) {
            let mut r = source.clone();
            r.items.truncate(PAGE_CARDS);
            r.next = (source.items.len() > PAGE_CARDS).then(|| cursor(id,version,Some(i),PAGE_CARDS));
            result.push(r);
        }
    }
    let next = (row.is_none() && offset + PAGE_ROWS < rows.len()).then(|| cursor(id,version,None,offset+PAGE_ROWS));
    Ok(json!({"version":1,"source":"owntube","feedId":id,"snapshotVersion":version,"rows":result,"next":next}))
}

pub async fn serve(State(app): State<App>, headers: HeaderMap, Json(request): Json<Request>) -> Result<Response> {
    let key = bearer(&headers).ok_or_else(unauthorized)?;
    let device = app.store.device(store::hash(key)).await?;
    if app.feed.rules.is_none() {
        return Err(Error(StatusCode::SERVICE_UNAVAILABLE, "Server feeds are disabled".into()));
    }
    if !CATEGORIES.contains(&request.category.as_str()) || request.account_key.len() > 128
        || request.language.is_empty() || request.language.len() > 20
        || !request.language.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-')
        || request.country.len() != 2 || !request.country.bytes().all(|b| b.is_ascii_alphabetic())
        || request.visitor_data.len() > 4096 || request.utc_offset_minutes.unsigned_abs() > 840 {
        return Err(invalid("Invalid feed account, category or locale"));
    }
    let auth = headers.get("x-youtube-authorization").map(|v| v.to_str()).transpose().map_err(|_| invalid("Invalid account header"))?.unwrap_or("");
    let profile = headers.get("x-youtube-page-id").map(|v| v.to_str()).transpose().map_err(|_| invalid("Invalid profile header"))?.unwrap_or("");
    if (!auth.is_empty() && (!auth.starts_with("Bearer ") || auth.len() > 4096)) || profile.len() > 256 {
        return Err(invalid("Invalid YouTube account context"));
    }
    // New clients send a stable, hashed selected-account identity. Old clients are
    // isolated by access-token hash rather than risking account mixing.
    let account = if request.account_key.is_empty() { store::hash(auth) } else { request.account_key.clone() };
    let audience = store::hash(&encode(&(device["deviceId"].as_str(), &account, profile, &request.language, &request.country))?);
    let id = store::hash(&encode(&(device["deviceId"].as_str(), account, profile, &request.category, &request.language, &request.country))?);
    let decoded: Option<CachedCursor> = request.cursor.as_ref().map(|c| {
        if c.len() > 2048 { return Err(expired()); }
        let bytes = URL_SAFE_NO_PAD.decode(c).map_err(|_| expired())?;
        let cursor: CachedCursor = serde_json::from_slice(&bytes).map_err(|_| expired())?;
        if cursor.feed != id { return Err(expired()); }
        Ok(cursor)
    }).transpose()?;
    let lookup = id.clone();
    let category = request.category.clone();
    let doc = app.store.run(move |db| {
        match load(db, &lookup) {
            Ok(mut doc) => {
                if doc.audience.is_empty() { doc.audience = audience; store(db, &doc)?; }
                return Ok(doc);
            },
            Err(error) if error.0 == StatusCode::NOT_FOUND => {},
            Err(error) => return Err(error),
        }
        let doc = Document {
            id:lookup, audience, device:device["deviceId"].as_str().unwrap().into(), label:device["label"].as_str().unwrap_or("TV").into(),
            category,revision:0,generation:0,version:0,served_version:None,served_at:None,cached_at:None,
            published_at:None,next_refresh_at:0,retry_at:0,error:None,limited:false,source:vec![],draft:Edits::default(),published:Edits::default(),german:Default::default(),
        };
        store(db, &doc)?;
        Ok(doc)
    }).await?;
    // Pagination always reads its immutable version, including after a publish.
    if decoded.is_none() && now() >= doc.next_refresh_at && now() >= doc.retry_at {
        queue_refresh(app.clone(), id.clone(), request, headers);
    }
    if doc.version == 0 {
        if let Some(error) = doc.error { return Err(upstream_error(&error)); }
        return Ok((StatusCode::ACCEPTED, Json(json!({"status":"building","message":"Preparing the cached feed"}))).into_response());
    }
    let version = decoded.as_ref().map(|c| c.version).unwrap_or(doc.version);
    let result = app.store.run(move |db| {
        let text: Option<String> = db.query_row("SELECT rows FROM curated_versions WHERE feed=? AND version=?", params![id,version], |r| r.get(0)).optional()?;
        let rows: Vec<Row> = decode(&text.ok_or_else(expired)?)?;
        let response = page(&rows, &id, version, decoded)?;
        let mut doc = load(db, &id)?;
        doc.served_version = Some(version);
        doc.served_at = Some(now());
        store(db, &doc)?;
        Ok(response)
    }).await?;
    Ok(Json(result).into_response())
}

fn summary(doc: &Document, refreshing: bool) -> Value {
    json!({"id":doc.id,"audience":doc.audience,"device":doc.device,"label":doc.label,"category":doc.category,
        "revision":doc.revision,"generation":doc.generation,"publishedVersion":doc.version,
        "servedVersion":doc.served_version,"servedAt":doc.served_at,"cachedAt":doc.cached_at,
        "publishedAt":doc.published_at,"nextRefreshAt":doc.next_refresh_at,"retryAt":doc.retry_at,
        "error":doc.error,"refreshing":refreshing,"limited":doc.limited,"dirty":doc.draft!=doc.published,
        "rowCount":doc.source.len(),"cardCount":doc.source.iter().map(|r|r.items.len()).sum::<usize>()})
}
pub async fn list(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    owner(&app,&headers).await?;
    let refreshing = app.feed.refreshing.lock().unwrap().clone();
    let feeds = app.store.read(move |db| {
        let texts = db.prepare("SELECT payload FROM curated_feeds ORDER BY rowid")?
            .query_map([], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        texts.iter().map(|text| { let doc: Document = decode(text)?; Ok(summary(&doc,refreshing.contains(&doc.id))) }).collect::<Result<Vec<_>>>()
    }).await?;
    Ok(Json(json!({"feeds":feeds,"categories":CATEGORIES,"refreshHours":6,"cacheLimits":{"rows":ROW_LIMIT,"cardsPerRow":CARD_LIMIT}})))
}
pub async fn get(State(app): State<App>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>> {
    owner(&app,&headers).await?;
    let refreshing = app.feed.refreshing.lock().unwrap().contains(&id);
    let mixing = app.feed.mixing.lock().unwrap().contains(&id);
    let progress = app.feed.mix_progress.lock().unwrap().get(&id).cloned();
    let result = app.store.read(move |db| {
        let doc = load(db,&id)?;
        let mut value = summary(&doc,refreshing);
        value["rows"] = json!(compose(&doc.source,&doc.draft));
        value["sourceRows"] = json!(doc.source);
        value["edits"] = json!(doc.draft);
        value["publishedEdits"] = json!(doc.published);
        value["german"] = german::view(&doc, mixing);
        value["german"]["progress"] = json!(progress);
        let published: Option<String> = db.query_row("SELECT rows FROM curated_versions WHERE feed=? AND version=?",params![id,doc.version],|r|r.get(0)).optional()?;
        value["publishedRows"] = published.map(|text| decode::<Value>(&text)).transpose()?.unwrap_or(json!([]));
        Ok(value)
    }).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change { revision: u64, generation: u64, edits: Edits }

async fn edit(app: &App, id: String, change: Change, publish: bool) -> Result<Value> {
    app.store.run(move |db| {
        let tx = db.transaction()?;
        let mut doc = load(&tx,&id)?;
        if doc.revision != change.revision || doc.generation != change.generation { return Err(conflict()); }
        if doc.version == 0 { return Err(invalid("Wait for the first cached feed")); }
        validate(&change.edits,&doc)?;
        doc.draft = change.edits;
        doc.revision += 1;
        if publish {
            doc.published = doc.draft.clone();
            doc.german.undo_version = None;
            publish_rows(&tx,&mut doc)?;
        } else { store(&tx,&doc)?; }
        tx.commit()?;
        Ok(summary(&doc,false))
    }).await
}
pub async fn save(State(app): State<App>, headers: HeaderMap, Path(id): Path<String>, Json(change): Json<Change>) -> Result<Json<Value>> {
    owner(&app,&headers).await?;
    Ok(Json(edit(&app,id,change,false).await?))
}
pub async fn publish(State(app): State<App>, headers: HeaderMap, Path(id): Path<String>, Json(change): Json<Change>) -> Result<Json<Value>> {
    owner(&app,&headers).await?;
    let result=edit(&app,id.clone(),change,true).await?;
    german::queue(app,id);
    Ok(Json(result))
}
pub async fn refresh(State(app): State<App>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>> {
    owner(&app,&headers).await?;
    app.store.run(move |db| {
        let mut doc = load(db,&id)?;
        doc.next_refresh_at = 0;
        doc.retry_at = 0;
        store(db,&doc)
    }).await?;
    Ok(Json(json!({"ok":true,"message":"Refresh queued. Reopen this category on the TV to supply its current account connection."})))
}

#[derive(Deserialize)]
pub struct Resolve { video: String }
fn video_id(value: &str) -> Result<String> {
    let value = value.trim();
    let valid = |s: &str| s.len() == 11 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid(value) { return Ok(value.into()); }
    let url = reqwest::Url::parse(value).map_err(|_| invalid("Paste a YouTube video URL or ID"))?;
    let id = match url.host_str().unwrap_or("") {
        "youtu.be" => url.path().trim_start_matches('/').to_string(),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            url.query_pairs().find(|(k,_)| k=="v").map(|(_,v)|v.into_owned())
                .or_else(|| url.path().strip_prefix("/shorts/").map(str::to_owned)).unwrap_or_default()
        }
        _ => String::new(),
    };
    if !valid(&id) { return Err(invalid("Paste a YouTube video URL or ID")); }
    Ok(id)
}
pub async fn resolve(State(app): State<App>, headers: HeaderMap, Json(input): Json<Resolve>) -> Result<Json<Card>> {
    owner(&app,&headers).await?;
    let id = video_id(&input.video)?;
    let mut response = app.feed.client.get("https://www.youtube.com/oembed")
        .query(&[("format","json"),("url",&format!("https://www.youtube.com/watch?v={id}"))])
        .send().await.map_err(|_| upstream_error("Could not look up this video"))?;
    if !response.status().is_success() { return Err(invalid("YouTube could not resolve this video. Check that it is public.")); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| upstream_error("Video lookup interrupted"))? {
        if bytes.len() + chunk.len() > 1_000_000 { return Err(upstream_error("Video metadata too large")); }
        bytes.extend_from_slice(&chunk);
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| upstream_error("Invalid video metadata"))?;
    Ok(Json(Card { video_id:Some(id.clone()),title:v["title"].as_str().unwrap_or(&id).into(),
        subtitle:v["author_name"].as_str().unwrap_or("").into(),
        thumbnail:Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")),..Default::default() }))
}

#[cfg(test)]
mod tests;

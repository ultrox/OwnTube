//! First feed slice: fetch YouTube Home on the server, then compose OwnTube rows.
//! Authentication is request-local. Continuations are opaque, device/account-bound
//! and expire; neither YouTube credentials nor upstream cursors are returned.
use crate::*;
use serde::Serialize;
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};

mod youtube;
pub mod cache;
#[cfg(test)]
mod tests;

const UPSTREAM: &str = "https://www.youtube.com/youtubei/v1/browse";
const MAX_BODY: usize = 8 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Card {
    pub video_id: Option<String>,
    pub channel_id: Option<String>,
    pub playlist_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub subtitle: String,
    pub thumbnail: Option<String>,
    pub badge: Option<String>,
    #[serde(default)]
    pub is_live: bool,
    #[serde(default)]
    pub is_upcoming: bool,
    #[serde(default)]
    pub is_shorts: bool,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rules {
    #[serde(default)]
    pub insertions: Vec<Card>,
    #[serde(default)]
    pub blocked_videos: Vec<String>,
    #[serde(default)]
    pub blocked_channels: Vec<String>,
}

impl Rules {
    fn validate(&self) -> Result<()> {
        if self.insertions.len() > 50 || self.blocked_videos.len() > 1000 || self.blocked_channels.len() > 1000 {
            return Err(invalid("Too many Home feed rules"));
        }
        let id = |s: &str| !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if self.blocked_videos.iter().chain(&self.blocked_channels).any(|s| !id(s))
            || self.insertions.iter().any(|c| c.video_id.as_ref().is_none_or(|s| !id(s))
                || c.channel_id.as_ref().is_some_and(|s| !id(s))
                || c.title.trim().is_empty() || c.title.len() > 1000 || c.subtitle.len() > 1000
                || c.playlist_id.is_some()
                || c.thumbnail.as_ref().is_some_and(|s| !s.starts_with("https://") || s.len() > 2048)) {
            return Err(invalid("Invalid Home feed rule"));
        }
        Ok(())
    }

    fn allowed(&self, card: &Card) -> bool {
        !card.video_id.as_ref().is_some_and(|id| self.blocked_videos.contains(id))
            && !card.channel_id.as_ref().is_some_and(|id| self.blocked_channels.contains(id))
    }

    fn filter(&self, cards: &mut Vec<Card>) {
        cards.retain(|c| self.allowed(c) && !self.insertions.iter().any(|i| i.video_id.is_some() && i.video_id == c.video_id));
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    #[serde(default)]
    account_key: String,
    #[serde(default = "default_category")]
    category: String,
    #[serde(default = "default_language")]
    language: String,
    #[serde(default = "default_country")]
    country: String,
    #[serde(default)]
    utc_offset_minutes: i32,
    #[serde(default)]
    visitor_data: String,
    cursor: Option<String>,
}
fn default_language() -> String { "en".into() }
fn default_country() -> String { "CH".into() }
fn default_category() -> String { "home".into() }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    version: u8,
    source: &'static str,
    rows: Vec<Row>,
    next: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    id: String,
    title: String,
    items: Vec<Card>,
    next: Option<String>,
}

#[derive(Clone)]
struct Cursor {
    scope: String,
    upstream: String,
    request: Request,
    row: Option<(String, String)>,
    created: Instant,
    trail: Vec<String>,
}

pub struct Feed {
    client: reqwest::Client,
    endpoint: String,
    rules: Option<Rules>,
    cursors: Mutex<HashMap<String, Cursor>>,
    refreshing: Mutex<std::collections::HashSet<String>>,
    mixing: Mutex<std::collections::HashSet<String>>,
    mix_progress: Mutex<HashMap<String, Value>>,
}

impl Feed {
    pub fn disabled() -> Self { Self::new(None, UPSTREAM.into()) }

    fn new(rules: Option<Rules>, endpoint: String) -> Self {
        Self {
            client: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(25)).build().expect("HTTP client"),
            endpoint, rules, cursors: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(std::collections::HashSet::new()),
            mixing: Mutex::new(std::collections::HashSet::new()),
            mix_progress: Mutex::new(HashMap::new()),
        }
    }

    pub fn from_env() -> std::result::Result<Self, Box<dyn std::error::Error>> {
        let Ok(file) = std::env::var("OWNTUBE_HOME_RULES") else { return Ok(Self::disabled()); };
        let bytes = std::fs::read(file)?;
        if bytes.len() > 256_000 { return Err("Home rules file too large".into()); }
        let rules: Rules = serde_json::from_slice(&bytes)?;
        rules.validate().map_err(|e| e.1)?;
        Ok(Self::new(Some(rules), UPSTREAM.into()))
    }

    fn cursor(&self, upstream: Option<String>, scope: &str, request: &Request, row: Option<(String, String)>, trail: &[String]) -> Result<Option<String>> {
        upstream.map(|upstream| {
            if upstream.len() > 32_768 || trail.len() >= 100 || trail.contains(&store::hash(&upstream)) {
                return Err(upstream_error("YouTube repeated or exceeded Home pagination. Refresh Home."));
            }
            let mut cursors = self.cursors.lock().unwrap();
            cursors.retain(|_, c| c.created.elapsed() < TTL);
            // Bound retained pagination state even when clients abandon pages.
            if cursors.len() >= 512 {
                if let Some(oldest) = cursors.iter().min_by_key(|(_, c)| c.created).map(|(k, _)| k.clone()) {
                    cursors.remove(&oldest);
                }
            }
            let key = token();
            cursors.insert(key.clone(), Cursor { scope: scope.into(), upstream, request: request.clone(), row, created: Instant::now(), trail: trail.into() });
            Ok(key)
        }).transpose()
    }

    #[cfg(test)]
    async fn home(&self, scope: String, request: Request, headers: &HeaderMap) -> Result<Page> {
        self.upstream(scope, request, headers, true).await
    }

    async fn upstream(&self, scope: String, request: Request, headers: &HeaderMap, apply_rules: bool) -> Result<Page> {
        let rules = self.rules.as_ref().ok_or_else(|| Error(StatusCode::SERVICE_UNAVAILABLE, "OwnTube Home is not enabled on this server".into()))?;
        let continuation = if let Some(key) = &request.cursor {
            let cursors = self.cursors.lock().unwrap();
            Some(cursors.get(key).filter(|c| c.scope == scope && c.created.elapsed() < TTL)
                .cloned().ok_or_else(|| Error(StatusCode::GONE, "Home page expired. Refresh Home.".into()))?)
        } else { None };
        let context = continuation.as_ref().map(|c| &c.request).unwrap_or(&request);
        if context.language.is_empty() || context.language.len() > 20 || context.country.len() != 2
            || !context.language.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-')
            || !context.country.bytes().all(|b| b.is_ascii_alphabetic())
            || context.utc_offset_minutes.unsigned_abs() > 840 || context.visitor_data.len() > 4096 {
            return Err(invalid("Invalid YouTube locale or visitor context"));
        }
        let body = youtube::query(context, continuation.as_ref().map(|c| c.upstream.as_str()));
        let mut call = self.client.post(&self.endpoint).header("User-Agent", youtube::USER_AGENT)
            .header("Referer", "https://www.youtube.com/tv")
            .query(&[("prettyPrint", "false"), ("t", &token()[..12])]).json(&body);
        if !headers.contains_key("x-youtube-authorization") {
            // Public TV client key used by the pinned MediaServiceCore, not an owner credential.
            call = call.query(&[("key", "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8")]);
        }
        if !context.visitor_data.is_empty() {
            call = call.header("X-Goog-Visitor-Id", &context.visitor_data);
        }
        // These are separate from the OwnTube device credential. Never forward
        // the device Authorization, cookies or arbitrary client headers to YouTube.
        for (source, target) in [("x-youtube-authorization", "Authorization"), ("x-youtube-page-id", "X-Goog-Pageid")] {
            if let Some(value) = headers.get(source) { call = call.header(target, value); }
        }
        let mut response = call.send().await.map_err(|_| upstream_error("YouTube Home request failed"))?;
        if !response.status().is_success() {
            return Err(upstream_error(if response.status().as_u16() == 401 { "YouTube sign-in expired. Sign in again on the TV." } else { "YouTube Home is unavailable" }));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| upstream_error("Incomplete YouTube Home response"))? {
            if bytes.len() + chunk.len() > MAX_BODY { return Err(upstream_error("YouTube Home response too large")); }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| upstream_error("Invalid YouTube Home response"))?;
        let parsed = youtube::parse(&value, continuation.as_ref().and_then(|c| c.row.as_ref()).is_some())?;
        let mut context = context.clone();
        context.cursor = None;
        if let Some(visitor) = value.pointer("/responseContext/visitorData").and_then(Value::as_str) {
            context.visitor_data = visitor.into();
        }
        let row_context = continuation.as_ref().and_then(|c| c.row.as_ref());
        let mut trail = continuation.as_ref().map(|c| c.trail.clone()).unwrap_or_default();
        if let Some(c) = &continuation { trail.push(store::hash(&c.upstream)); }
        let mut rows = Vec::new();
        if apply_rules && continuation.is_none() {
            let mut seen = std::collections::HashSet::new();
            let items = rules.insertions.iter().filter(|c| rules.allowed(c) && seen.insert(c.video_id.clone())).cloned().collect::<Vec<_>>();
            if !items.is_empty() { rows.push(Row { id: "owntube:added".into(), title: "Added in OwnTube".into(), items, next: None }); }
        }
        for (index, mut row) in parsed.rows.into_iter().enumerate() {
            if apply_rules { rules.filter(&mut row.items); }
            let (id, title) = row_context.cloned().unwrap_or_else(|| (
                format!("youtube:{}:{index}", request.cursor.as_deref().unwrap_or("home")), row.title
            ));
            let next = self.cursor(row.next, &scope, &context, Some((id.clone(), title.clone())), &trail)?;
            // Empty filtered pages retain continuation so scrolling can reach allowed cards.
            rows.push(Row { id, title, items: row.items, next });
        }
        let next = self.cursor(parsed.next, &scope, &context, None, &trail)?;
        Ok(Page { version: 1, source: "owntube", rows, next })
    }
}

fn upstream_error(message: &str) -> Error { Error(StatusCode::BAD_GATEWAY, message.into()) }

#[cfg(test)]
pub async fn upstream_home(State(app): State<App>, headers: HeaderMap, Json(request): Json<Request>) -> Result<Json<Page>> {
    let key = bearer(&headers).ok_or_else(unauthorized)?;
    app.store.device(store::hash(key)).await?;
    let authorization = headers.get("x-youtube-authorization").map(|v| v.to_str().unwrap_or("")).unwrap_or("");
    let page = headers.get("x-youtube-page-id").map(|v| v.to_str().unwrap_or("")).unwrap_or("");
    if (!authorization.is_empty() && (!authorization.starts_with("Bearer ") || authorization.len() > 4096))
        || page.len() > 256 {
        return Err(invalid("Invalid YouTube account context"));
    }
    let scope = store::hash(&format!("{key}\n{authorization}\n{page}"));
    Ok(Json(app.feed.home(scope, request, &headers).await?))
}

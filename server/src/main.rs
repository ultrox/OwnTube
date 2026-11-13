mod store;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tower_http::services::ServeDir;

mod analytics;
mod compact;
mod history;
mod languages;
#[cfg(test)]
mod legacy_analytics;
mod metrics;
mod snapshots;

#[derive(Clone)]
pub struct App {
    store: store::Store,
    admin_hash: Arc<String>,
    secure_cookie: bool,
    timezone: chrono_tz::Tz,
}

#[derive(Debug)]
pub struct Error(StatusCode, String);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        eprintln!("database error: {error}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Database operation failed".into(),
        )
    }
}
type Result<T> = std::result::Result<T, Error>;
fn invalid(message: &str) -> Error {
    Error(StatusCode::UNPROCESSABLE_ENTITY, message.into())
}
fn unauthorized() -> Error {
    Error(StatusCode::UNAUTHORIZED, "Authentication required".into())
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
fn session(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("observer_session="))
}
fn cookie(value: &str, secure: bool, age: u32) -> String {
    format!(
        "observer_session={value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age={age}{}",
        if secure { "; Secure" } else { "" }
    )
}

async fn owner(app: &App, headers: &HeaderMap) -> Result<()> {
    let hash = session(headers).map(store::hash).ok_or_else(unauthorized)?;
    if app.store.session_valid(hash).await? {
        Ok(())
    } else {
        Err(unauthorized())
    }
}

#[derive(Deserialize)]
struct Login {
    token: String,
}
async fn login(State(app): State<App>, Json(input): Json<Login>) -> Result<Response> {
    let hash = store::hash(&input.token);
    let equal = hash
        .bytes()
        .zip(app.admin_hash.bytes())
        .fold(0u8, |a, (b, c)| a | (b ^ c))
        == 0;
    if !equal {
        return Err(unauthorized());
    }
    let session_token = token();
    app.store.add_session(store::hash(&session_token)).await?;
    Ok((
        [(
            header::SET_COOKIE,
            cookie(&session_token, app.secure_cookie, 604800),
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}
async fn logout(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    if let Some(value) = session(&headers) {
        app.store.remove_session(store::hash(value)).await?;
    }
    Ok((
        [(header::SET_COOKIE, cookie("", app.secure_cookie, 0))],
        Json(json!({"ok":true})),
    )
        .into_response())
}

async fn session_status(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInput {
    label: String,
    #[serde(default)]
    person: String,
}
async fn create_device(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<DeviceInput>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    if input.label.trim().is_empty() || input.label.len() > 200 || input.person.len() > 200 {
        return Err(invalid("Enter a device label (up to 200 bytes)"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let key = token();
    app.store
        .create_device(
            id.clone(),
            input.label.trim().into(),
            input.person.trim().into(),
            store::hash(&key),
        )
        .await?;
    Ok(Json(json!({"deviceId":id,"token":key})))
}
async fn revoke_device(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    app.store.revoke_device(id).await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct PersonInput {
    name: String,
}
async fn create_person(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<PersonInput>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    if input.name.trim().is_empty() || input.name.len() > 200 {
        return Err(invalid("Enter a person name (up to 200 bytes)"));
    }
    Ok(Json(
        app.store.create_person(input.name.trim().into()).await?,
    ))
}
async fn update_device(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<DeviceInput>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    if input.label.trim().is_empty() || input.label.len() > 200 || input.person.len() > 200 {
        return Err(invalid("Enter a device label and person"));
    }
    app.store
        .update_device(id, input.label.trim().into(), input.person.trim().into())
        .await?;
    Ok(Json(json!({"ok":true})))
}
async fn rotate_device(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    let key = token();
    app.store
        .rotate_device(id.clone(), store::hash(&key))
        .await?;
    Ok(Json(json!({"deviceId":id,"token":key})))
}

async fn ingest(
    State(app): State<App>,
    headers: HeaderMap,
    Json(batch): Json<store::Batch>,
) -> Result<Json<Value>> {
    let key = bearer(&headers).ok_or_else(unauthorized)?;
    Ok(Json(app.store.ingest(store::hash(key), batch).await?))
}
async fn device_identity(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    Ok(Json(
        app.store
            .device(store::hash(bearer(&headers).ok_or_else(unauthorized)?))
            .await?,
    ))
}
#[derive(Default, Deserialize)]
struct Filter {
    days: Option<u32>,
    #[serde(default)]
    device: String,
    #[serde(default)]
    person: String,
    page: Option<usize>,
    #[serde(rename = "perPage")]
    per_page: Option<usize>,
    before: Option<i64>,
    until: Option<i64>,
    #[serde(default)]
    query: String,
    kind: Option<String>,
    sort: Option<String>,
}
async fn dashboard(
    State(app): State<App>,
    headers: HeaderMap,
    Query(filter): Query<Filter>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    let days = filter.days.unwrap_or(7);
    if ![7, 30, 90].contains(&days) {
        return Err(invalid("Range must be 7, 30 or 90 days"));
    }
    let page = filter.page.unwrap_or(1);
    let per_page = filter.per_page.unwrap_or(20);
    let kind = filter.kind.unwrap_or_else(|| "all".into());
    let sort = filter.sort.unwrap_or_else(|| "recent".into());
    if filter.query.chars().count() > 200
        || !["all", "video", "short"].contains(&kind.as_str())
        || !["recent", "watch", "title"].contains(&sort.as_str())
    {
        return Err(invalid("Invalid history filter"));
    }
    if page == 0
        || ![10, 20, 50].contains(&per_page)
        || filter.before.is_some() != filter.until.is_some()
        || filter.before.is_some_and(|n| n < 0)
        || filter.until.is_some_and(|n| n < 0 || n > now())
    {
        return Err(invalid("Invalid page or snapshot parameters"));
    }
    Ok(Json(
        app.store
            .dashboard_page(
                days,
                filter.device,
                filter.person,
                app.timezone,
                store::View {
                    page,
                    per_page,
                    before: filter.before,
                    until: filter.until,
                    query: filter.query,
                    kind,
                    sort,
                },
            )
            .await?,
    ))
}

async fn languages(
    State(app): State<App>,
    headers: HeaderMap,
    Query(filter): Query<Filter>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    let days = filter.days.unwrap_or(7);
    if ![7, 30, 90].contains(&days) {
        return Err(invalid("Range must be 7, 30 or 90 days"));
    }
    Ok(Json(
        app.store
            .language_dashboard(days, filter.device, filter.person, app.timezone)
            .await?,
    ))
}
async fn language_videos(
    State(app): State<App>,
    headers: HeaderMap,
    Query(filter): Query<Filter>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    let days = filter.days.unwrap_or(7);
    let page = filter.page.unwrap_or(1);
    if ![7, 30, 90].contains(&days) || page == 0 {
        return Err(invalid("Invalid range or page"));
    }
    Ok(Json(
        app.store
            .language_videos(days, filter.device, filter.person, app.timezone, page)
            .await?,
    ))
}

async fn diagnostics(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.metrics().snapshot()))
}

async fn browser_metric(
    State(app): State<App>,
    headers: HeaderMap,
    Json(sample): Json<metrics::BrowserSample>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    if !sample.duration_ms.is_finite() || !(0.0..=120000.0).contains(&sample.duration_ms) {
        return Err(invalid("Invalid duration"));
    }
    app.store.metrics().browser(sample);
    Ok(Json(json!({"ok":true})))
}
async fn event(
    State(app): State<App>,
    headers: HeaderMap,
    Path(seq): Path<i64>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.event(seq).await?))
}
#[derive(Deserialize)]
struct Export {
    #[serde(default)]
    after: i64,
    #[serde(default, rename = "viewingAfter")]
    viewing_after: i64,
}
async fn export(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<Export>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    let mut result = app.store.export(query.after).await?;
    let viewings = app.store.export_viewings(query.viewing_after).await?;
    result["viewings"] = viewings["viewings"].clone();
    result["nextViewing"] = viewings["nextViewing"].clone();
    Ok(Json(result))
}
async fn viewing(
    State(app): State<App>,
    headers: HeaderMap,
    Path((device, id)): Path<(String, String)>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.viewing(device, id).await?))
}

fn router(app: App, public: PathBuf) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"ok":true,"version":env!("CARGO_PKG_VERSION")})) }),
        )
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/session", get(session_status))
        .route("/api/devices", post(create_device))
        .route("/api/people", post(create_person))
        .route("/api/devices/{id}", post(update_device))
        .route("/api/devices/{id}/rotate", post(rotate_device))
        .route("/api/devices/{id}/revoke", post(revoke_device))
        .route("/api/ingest", post(ingest))
        .route("/api/dashboard", get(dashboard))
        .route("/api/history", get(history::watched))
        .route("/api/history/searches", get(history::searches))
        .route("/api/history/evidence", get(history::evidence))
        .route("/api/languages", get(languages))
        .route("/api/language-videos", get(language_videos))
        .route("/api/modules/languages", get(languages::dashboard))
        .route("/api/modules/languages/evidence", get(languages::evidence))
        .route("/api/modules/languages/assessment", post(languages::assess))
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/metrics/client", post(browser_metric))
        .route("/api/device", get(device_identity))
        .route("/api/events/{seq}", get(event))
        .route("/api/export", get(export))
        .route("/api/viewings/{device}/{id}", get(viewing))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
        .fallback_service(ServeDir::new(public))
        .layer(axum::middleware::from_fn_with_state(
            app.clone(),
            metrics::measure,
        ))
        .with_state(app)
}

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let data = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "data".into()));
    std::fs::create_dir_all(&data)?;
    let token_file = data.join("admin-token");
    let admin_token = match std::env::var("ADMIN_TOKEN") {
        Ok(value) => value,
        Err(_) => match std::fs::read_to_string(&token_file) {
            Ok(value) => value.trim().to_owned(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                use std::io::Write;
                let value = token();
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                options.open(&token_file)?.write_all(value.as_bytes())?;
                value
            }
            Err(error) => return Err(error.into()),
        },
    };
    if admin_token.len() < 24 {
        return Err("ADMIN_TOKEN must contain at least 24 characters".into());
    }
    let timezone = std::env::var("TIMEZONE")
        .unwrap_or_else(|_| "Europe/Zurich".into())
        .parse()?;
    let app = App {
        store: store::Store::open(data.join("observer.sqlite3"))?,
        admin_hash: Arc::new(store::hash(&admin_token)),
        secure_cookie: std::env::var("COOKIE_SECURE").is_ok_and(|v| v == "true"),
        timezone,
    };
    let address = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:3210".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("YouTube Observer listening on http://{address}");
    if std::env::var("ADMIN_TOKEN").is_err() {
        println!("Owner login key: {}", token_file.display());
    }
    axum::serve(
        listener,
        router(
            app,
            PathBuf::from(
                std::env::var("PUBLIC_DIR").unwrap_or_else(|_| "../apps/backoffice/dist".into()),
            ),
        ),
    )
    .with_graceful_shutdown(async {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("install SIGTERM handler");
            tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=terminate.recv()=>{} }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
    })
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests;

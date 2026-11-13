//! Bounded, owner-visible operational measurements. Never record credentials, URLs,
//! search terms, video titles, or user/device identifiers.
use axum::{
    extract::{MatchedPath, Request, State},
    http::HeaderValue,
    middleware::Next,
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::Instant,
};

const WINDOW_MS: i64 = 15 * 60 * 1000;
const SAMPLES: usize = 512;

#[derive(Default)]
struct Distribution {
    total: u64,
    failures: u64,
    samples: VecDeque<(i64, f64)>,
}
impl Distribution {
    fn record(&mut self, ms: f64, failed: bool) {
        self.total += 1;
        self.failures += u64::from(failed);
        self.samples.push_back((crate::now(), ms));
        while self.samples.len() > SAMPLES {
            self.samples.pop_front();
        }
    }
    fn value(&self, now: i64) -> Value {
        let mut values: Vec<_> = self
            .samples
            .iter()
            .filter(|(t, _)| *t >= now - WINDOW_MS)
            .map(|(_, ms)| *ms)
            .collect();
        values.sort_by(f64::total_cmp);
        let percentile = |p: f64| -> Option<f64> {
            if values.is_empty() {
                None
            } else {
                Some(values[((values.len() as f64 * p).ceil() as usize).saturating_sub(1)])
            }
        };
        json!({"totalSinceStart":self.total,"failuresSinceStart":self.failures,"samples":values.len(),"p50Ms":percentile(0.5),"p95Ms":percentile(0.95),"p99Ms":percentile(0.99),"maxMs":values.last()})
    }
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakdown {
    pub stages_ms: BTreeMap<&'static str, f64>,
    pub work: BTreeMap<&'static str, u64>,
}

tokio::task_local! { static REQUEST: Arc<Mutex<Breakdown>>; }

pub fn context() -> Option<Arc<Mutex<Breakdown>>> {
    REQUEST.try_with(Clone::clone).ok()
}
pub fn stage(context: &Option<Arc<Mutex<Breakdown>>>, name: &'static str, ms: f64) {
    if let Some(context) = context
        && let Ok(mut data) = context.lock()
    {
        *data.stages_ms.entry(name).or_default() += ms;
    }
}
pub fn work(context: &Option<Arc<Mutex<Breakdown>>>, name: &'static str, count: u64) {
    if let Some(context) = context
        && let Ok(mut data) = context.lock()
    {
        *data.work.entry(name).or_default() += count;
    }
}

#[derive(Default)]
struct Data {
    requests: BTreeMap<String, Distribution>,
    stages: BTreeMap<String, Distribution>,
    browser: BTreeMap<String, Distribution>,
    recent: VecDeque<Value>,
    pipeline: Value,
}

pub struct Metrics {
    started: Instant,
    data: Mutex<Data>,
}
impl Default for Metrics {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            data: Mutex::new(Data::default()),
        }
    }
}
impl Metrics {
    pub fn pipeline(&self, value: Value) {
        if let Ok(mut data) = self.data.lock() {
            if !data.pipeline.is_object() {
                data.pipeline = json!({});
            }
            if let Some(fields) = value.as_object() {
                for (name, value) in fields {
                    data.pipeline[name] = value.clone();
                }
            }
        }
    }
    fn request(&self, id: &str, route: &str, status: u16, ms: f64, breakdown: &Breakdown) {
        if let Ok(mut data) = self.data.lock() {
            data.requests
                .entry(route.to_owned())
                .or_default()
                .record(ms, status >= 500);
            for (stage, duration) in &breakdown.stages_ms {
                data.stages
                    .entry(format!("{route} · {stage}"))
                    .or_default()
                    .record(*duration, false);
            }
            data.recent.push_front(json!({"requestId":id,"at":crate::now(),"route":route,"status":status,"serverMs":ms,"stagesMs":breakdown.stages_ms,"work":breakdown.work}));
            data.recent.truncate(40);
        }
    }
    pub fn browser(&self, sample: BrowserSample) {
        if let Ok(mut data) = self.data.lock() {
            data.browser
                .entry(sample.name.key().into())
                .or_default()
                .record(sample.duration_ms, !sample.ok);
        }
    }
    pub fn snapshot(&self) -> Value {
        let now = crate::now();
        let data = self
            .data
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let values = |entries: &BTreeMap<String, Distribution>| -> BTreeMap<String, Value> {
            entries
                .iter()
                .map(|(name, d)| (name.clone(), d.value(now)))
                .collect()
        };
        json!({"measuredAt":now,"release":std::env::var("KAMAL_VERSION").unwrap_or_else(|_|"local".into()),"uptimeSeconds":self.started.elapsed().as_secs(),"windowSeconds":WINDOW_MS/1000,"maxSamplesPerSeries":SAMPLES,"requests":values(&data.requests),"stages":values(&data.stages),"browser":values(&data.browser),"recent":data.recent,"pipeline":data.pipeline,"budgetsMs":{"/api/session":10,"/api/dashboard":100,"/api/languages":100,"/api/language-videos":100},"notes":["Percentiles use the latest 512 samples within 15 minutes; counters reset at process restart.","Server timing ends when response headers are ready. Browser timing includes transfer or DOM rendering as labelled.","Stage timings can be nested; do not add them together."]})
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSample {
    pub name: BrowserMetric,
    pub duration_ms: f64,
    pub ok: bool,
}
#[derive(Deserialize)]
pub enum BrowserMetric {
    #[serde(rename = "session.network")]
    SessionNetwork,
    #[serde(rename = "dashboard.network")]
    DashboardNetwork,
    #[serde(rename = "languages.network")]
    LanguagesNetwork,
    #[serde(rename = "review.network")]
    ReviewNetwork,
    #[serde(rename = "dashboard.ready")]
    DashboardReady,
    #[serde(rename = "languages.ready")]
    LanguagesReady,
    #[serde(rename = "review.ready")]
    ReviewReady,
}
impl BrowserMetric {
    fn key(&self) -> &'static str {
        match self {
            Self::SessionNetwork => "session.network",
            Self::DashboardNetwork => "dashboard.network",
            Self::LanguagesNetwork => "languages.network",
            Self::ReviewNetwork => "review.network",
            Self::DashboardReady => "dashboard.ready",
            Self::LanguagesReady => "languages.ready",
            Self::ReviewReady => "review.ready",
        }
    }
}

pub async fn measure(State(app): State<crate::App>, request: Request, next: Next) -> Response {
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .unwrap_or("/static")
        .to_owned();
    // Diagnostic polling and telemetry must not dominate the workload they measure.
    let measured =
        route.starts_with("/api/") && route != "/api/diagnostics" && route != "/api/metrics/client";
    if !measured {
        let mut response = next.run(request).await;
        if route.starts_with("/api/") {
            response
                .headers_mut()
                .insert("cache-control", HeaderValue::from_static("no-store"));
        }
        return response;
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let start = Instant::now();
    let context = Arc::new(Mutex::new(Breakdown::default()));
    let mut response = REQUEST.scope(context.clone(), next.run(request)).await;
    let ms = start.elapsed().as_secs_f64() * 1000.;
    let breakdown = context.lock().unwrap_or_else(|p| p.into_inner()).clone();
    app.store
        .metrics()
        .request(&id, &route, response.status().as_u16(), ms, &breakdown);
    let mut timing = format!("app;dur={ms:.2}");
    for (stage, duration) in &breakdown.stages_ms {
        timing.push_str(&format!(", {stage};dur={duration:.2}"));
    }
    if let Ok(value) = HeaderValue::from_str(&timing) {
        response.headers_mut().insert("server-timing", value);
    }
    response
        .headers_mut()
        .insert("x-request-id", HeaderValue::from_str(&id).unwrap());
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    // Only operational fields: no cookies, request bodies, query strings, or video metadata.
    println!(
        "{}",
        json!({"event":"request.completed","requestId":id,"route":route,"status":response.status().as_u16(),"serverMs":ms,"stagesMs":breakdown.stages_ms,"work":breakdown.work})
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distributions_are_bounded_and_empty_is_not_zero_latency() {
        let mut d = Distribution::default();
        assert_eq!(d.value(crate::now())["p95Ms"], Value::Null);
        for i in 1..=600 {
            d.record(i as f64, i % 100 == 0);
        }
        let value = d.value(crate::now());
        assert_eq!(value["samples"], 512);
        assert_eq!(value["totalSinceStart"], 600);
        assert_eq!(value["failuresSinceStart"], 6);
        assert_eq!(value["p95Ms"], 575.);
        assert_eq!(d.value(crate::now() + WINDOW_MS + 1)["p95Ms"], Value::Null);
    }
}

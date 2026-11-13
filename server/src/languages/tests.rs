use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

fn filters(value: Value) -> Filters {
    serde_json::from_value(value).unwrap()
}
fn change(row: &Value, revision: i64, action: &str, lang: Option<&str>) -> Change {
    serde_json::from_value(
        json!({"deviceId":row["deviceId"],"metadataId":row["metadataId"],
        "baseRevision":revision,"action":action,"lang":lang,"note":"Reviewed the recorded audio"}),
    )
    .unwrap()
}
fn observation(id: &str, lang: &str, context: Option<&str>, seconds: f64) -> Value {
    let mut event = json!({"eventId":id,"kind":"watch","t":now()-100_000,"seconds":seconds,
        "videoId":"abcdefghijk","title":"One video, different audio","channel":"Examples",
        "lang":lang,"source":"unknown","conf":"low"});
    if let Some(ctx) = context {
        event["playbackContext"] = json!(ctx);
    }
    event
}
async fn seed(s: &Store) -> (String, String) {
    s.create_device("tv".into(), "TV".into(), "Marko".into(), hash("tv-key"))
        .await
        .unwrap();
    s.create_device(
        "browser".into(),
        "Laptop".into(),
        "Marko".into(),
        hash("browser-key"),
    )
    .await
    .unwrap();
    let german = r#"{ "title":"English title", "description":"<script>unsafe()</script>", "selectedAudioLanguage":"de", "defaultAudioLanguage":"en", "captions":[{"language":"en","kind":"manual"}] }"#;
    let english = r#"{"title":"Same video","description":"","selectedAudioLanguage":"en"}"#;
    let mut first = observation("de", "other", Some("background"), 8.);
    first["evidenceId"] = json!(hash(german));
    let mut second = observation("en", "en", Some("foreground"), 4.);
    second["evidenceId"] = json!(hash(english));
    s.ingest(
        hash("browser-key"),
        crate::store::Batch {
            device_id: "browser".into(),
            events: vec![first, second],
            evidence: BTreeMap::from([
                (hash(german), german.into()),
                (hash(english), english.into()),
            ]),
        },
    )
    .await
    .unwrap();
    s.ingest(
        hash("tv-key"),
        crate::store::Batch {
            device_id: "tv".into(),
            events: vec![observation("unknown", "other", None, 3.)],
            evidence: Default::default(),
        },
    )
    .await
    .unwrap();
    (german.into(), english.into())
}
async fn dashboard(s: &Store, args: Value) -> Value {
    s.module_languages(filters(args), chrono_tz::Europe::Zurich)
        .await
        .unwrap()
}
fn unknown_browser(value: &Value) -> Value {
    value["videos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["deviceId"] == "browser" && v["recorded"]["lang"] == "other")
        .unwrap()
        .clone()
}
fn total(value: &Value, language: &str) -> f64 {
    value["languages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["lang"] == language)
        .map_or(0., |v| v["seconds"].as_f64().unwrap())
}

#[tokio::test]
async fn manual_corrections_are_scoped_audited_and_leave_global_history_untouched() {
    let s = Store::open(":memory:".into()).unwrap();
    let (raw, _) = seed(&s).await;
    let before = dashboard(&s, json!({})).await;
    assert_eq!(before["seconds"], 15.);
    assert_eq!(before["foregroundSeconds"], 4.);
    assert_eq!(before["backgroundSeconds"], 8.);
    assert_eq!(before["unspecifiedSeconds"], 3.);
    assert_eq!(before["videoCount"], 1);
    assert_eq!(before["count"], 3); // separate evidence/audio versions, not three distinct videos
    let original = s
        .dashboard(7, "".into(), "".into(), chrono_tz::Europe::Zurich)
        .await
        .unwrap();
    let row = unknown_browser(&before);
    let result = s
        .language_change(change(&row, 0, "manual", Some("de")), None)
        .await
        .unwrap();
    assert_eq!(result["revision"], 1);
    let after = dashboard(&s, json!({})).await;
    assert_eq!(after["seconds"], 15.);
    assert_eq!(total(&after, "de"), 8.);
    assert_eq!(total(&after, "en"), 4.);
    assert_eq!(total(&after, "und"), 3.);
    assert_eq!(after["confirmedSeconds"], 8.);
    // Language filters/query affect rows, never the scope's watch-time figures.
    let filtered = dashboard(&s, json!({"language":"de","query":"same title absent"})).await;
    assert_eq!(filtered["count"], 0);
    assert_eq!(filtered["seconds"], 15.);
    assert_eq!(filtered["languages"], after["languages"]);
    let tv = dashboard(&s, json!({"device":"tv"})).await;
    assert_eq!(total(&tv, "und"), 3.);
    assert_eq!(tv["confirmedSeconds"], 0.);
    let legacy = s
        .dashboard(7, "".into(), "".into(), chrono_tz::Europe::Zurich)
        .await
        .unwrap();
    for field in [
        "seconds",
        "languages",
        "foregroundSeconds",
        "backgroundSeconds",
        "unspecifiedSeconds",
        "videoCount",
    ] {
        assert_eq!(
            original[field], legacy[field],
            "{field} is independent of the optional module"
        );
    }
    let detail = s
        .language_evidence(
            row["deviceId"].as_str().unwrap().into(),
            row["metadataId"].as_str().unwrap().into(),
        )
        .await
        .unwrap();
    assert_eq!(detail["evidenceText"], raw);
    assert_eq!(detail["evidenceId"], hash(&raw));
    assert_eq!(detail["recorded"]["lang"], "other");
    assert_eq!(detail["history"][0]["action"], "manual");
    assert_eq!(detail["history"][0]["note"], "Reviewed the recorded audio");
    let stale = s
        .language_change(change(&row, 0, "manual", Some("fr")), None)
        .await
        .unwrap_err();
    assert_eq!(stale.0, StatusCode::CONFLICT);
    let protected = s
        .language_change(
            change(&row, 1, "analyze", None),
            Some(saved_audio(&json!({"selectedAudioLanguage":"en"}))),
        )
        .await
        .unwrap_err();
    assert_eq!(protected.0, StatusCode::CONFLICT);
    s.language_change(change(&row, 1, "reset", None), None)
        .await
        .unwrap();
    let reset = dashboard(&s, json!({})).await;
    assert_eq!(reset["languages"], before["languages"]);
    let detail = s
        .language_evidence(
            row["deviceId"].as_str().unwrap().into(),
            row["metadataId"].as_str().unwrap().into(),
        )
        .await
        .unwrap();
    assert_eq!(detail["history"].as_array().unwrap().len(), 2);
    assert_eq!(detail["history"][0]["action"], "reset");
}

#[test]
fn inference_requires_selected_audio_and_never_confuses_titles_or_translation_with_speech() {
    for evidence in [
        json!(null),
        json!({"title":"English title","description":"English description"}),
        json!({"defaultAudioLanguage":"de","captions":[{"kind":"asr","language":"de"}]}),
        json!({"selectedAudioLanguage":"und"}),
        json!({"selectedAudioLanguage":"English (original)"}),
    ] {
        let result = saved_audio(&evidence);
        assert_eq!(result.lang, "und");
        assert!(result.review());
    }
    let selected = saved_audio(
        &json!({"selectedAudioLanguage":"sr-Latn","defaultAudioLanguage":"en",
        "captions":[{"kind":"manual","language":"fr"}]}),
    );
    assert_eq!(selected.lang, "sr-latn");
    assert_eq!(selected.status, "estimated");
    assert!(!selected.review());
    for value in [
        "",
        "other",
        "English",
        "und-US",
        "en-<script>",
        "x",
        "de--DE",
    ] {
        assert!(language(value).is_none(), "{value}");
    }
    for value in ["de", "bcs", "sr-Cyrl", "en-US", "und", "mul", "zxx"] {
        assert!(language(value).is_some(), "{value}");
    }
}

#[tokio::test]
async fn competing_corrections_and_late_api_results_cannot_overwrite_manual_review() {
    let s = Store::open(":memory:".into()).unwrap();
    seed(&s).await;
    let row = unknown_browser(&dashboard(&s, json!({})).await);
    let (a, b) = tokio::join!(
        s.language_change(change(&row, 0, "manual", Some("de")), None),
        s.language_change(change(&row, 0, "manual", Some("fr")), None)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let late = s
        .language_change(
            change(&row, 0, "analyze", None),
            Some(saved_audio(&json!({"selectedAudioLanguage":"en"}))),
        )
        .await
        .unwrap_err();
    assert_eq!(late.0, StatusCode::CONFLICT);
    // Even explicitly marking unknown is an owner decision that automation cannot erase.
    s.language_change(change(&row, 1, "manual", Some("und")), None)
        .await
        .unwrap();
    assert_eq!(
        s.language_change(
            change(&row, 2, "analyze", None),
            Some(saved_audio(&json!({"selectedAudioLanguage":"en"})))
        )
        .await
        .unwrap_err()
        .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn persistence_person_scopes_and_pagination_preserve_all_time() {
    let folder = std::env::temp_dir().join(format!("owntube-languages-{}", crate::token()));
    std::fs::create_dir(&folder).unwrap();
    let path = folder.join("test.sqlite3");
    let s = Store::open(path.clone()).unwrap();
    seed(&s).await;
    s.create_device(
        "other".into(),
        "Other".into(),
        "Other person".into(),
        hash("other-key"),
    )
    .await
    .unwrap();
    let events: Vec<_> = (0..25)
        .map(|i| {
            let mut e = observation(&format!("search-{i}"), "fr", Some("background"), 2.);
            e["title"] = json!(format!("French video {i}"));
            e
        })
        .collect();
    s.ingest(
        hash("other-key"),
        crate::store::Batch {
            device_id: "other".into(),
            events,
            evidence: Default::default(),
        },
    )
    .await
    .unwrap();
    let row = unknown_browser(&dashboard(&s, json!({})).await);
    s.language_change(change(&row, 0, "manual", Some("mul")), None)
        .await
        .unwrap();
    drop(s);
    let s = Store::open(path).unwrap();
    let all = dashboard(&s, json!({})).await;
    assert_eq!(all["count"], 28);
    assert_eq!(all["videos"].as_array().unwrap().len(), 20);
    let page2 = dashboard(&s, json!({"page":2})).await;
    assert_eq!(page2["videos"].as_array().unwrap().len(), 8);
    assert_eq!(page2["seconds"], all["seconds"]);
    assert_eq!(total(&all, "mul"), 8.);
    let marko = all["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "Marko")
        .unwrap()["id"]
        .clone();
    let scoped = dashboard(&s, json!({"person":marko})).await;
    assert_eq!(scoped["seconds"], 15.);
    assert_eq!(total(&scoped, "fr"), 0.);
    assert_eq!(scoped["timezone"], "Europe/Zurich");
    assert_eq!(scoped["days"], 7);
    assert_eq!(
        dashboard(&s, json!({"status":"confirmed"})).await["count"],
        1
    );
    drop(s);
    std::fs::remove_dir_all(folder).unwrap();
}

async fn request(
    app: &axum::Router,
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("Content-Type", "application/json");
    if let Some(cookie) = cookie {
        req = req.header("Cookie", cookie);
    }
    let response = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn routes_require_owner_and_run_real_saved_evidence_analysis() {
    let s = Store::open(":memory:".into()).unwrap();
    seed(&s).await;
    s.add_session(hash("owner-session")).await.unwrap();
    let row = unknown_browser(&dashboard(&s, json!({})).await);
    let app = crate::router(
        App {
            store: s,
            admin_hash: Arc::new(hash("owner-key")),
            secure_cookie: false,
            timezone: chrono_tz::UTC,
        },
        ".".into(),
    );
    let url = "/api/modules/languages";
    assert_eq!(
        request(&app, "GET", url, None, Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "GET",
            url,
            Some("observer_session=tv-key"),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let cookie = Some("observer_session=owner-session");
    for query in ["?days=1", "?page=0", "?language=English", "?status=bogus"] {
        assert_eq!(
            request(&app, "GET", &format!("{url}{query}"), cookie, Value::Null)
                .await
                .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let body = json!({"deviceId":row["deviceId"],"metadataId":row["metadataId"],"baseRevision":0,"action":"analyze"});
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("{url}/assessment"),
            None,
            body.clone()
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, saved) = request(&app, "POST", &format!("{url}/assessment"), cookie, body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["assessment"]["lang"], "de");
    assert_eq!(saved["assessment"]["status"], "estimated");
    let (status, detail) = request(
        &app,
        "GET",
        &format!(
            "{url}/evidence?device=browser&metadata={}",
            row["metadataId"].as_str().unwrap()
        ),
        cookie,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["history"][0]["action"], "analyze");
    let (_, next) = request(&app, "GET", url, cookie, Value::Null).await;
    assert_eq!(total(&next, "de"), 8.);
    assert_eq!(next["reviewSeconds"], 7.);
}

#[tokio::test]
async fn external_provider_is_bounded_structured_and_remains_an_estimate() {
    async fn provider(headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
        assert_eq!(headers["authorization"], "Bearer only-test");
        assert_eq!(body["scope"], "played-audio");
        assert_eq!(body["videoId"], "abcdefghijk");
        assert!(body.get("deviceId").is_none());
        Json(
            json!({"scope":"played-audio","lang":"de","confidence":"high","basis":"text","reason":"Description is German, but speech is unverified."}),
        )
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route("/", axum::routing::post(provider)),
        )
        .await
        .unwrap()
    });
    let detail = json!({"videoId":"abcdefghijk","evidence":{"description":"Deutsch"},"evidenceId":null,"recorded":{}});
    let result = external_analysis(
        &detail,
        &format!("http://127.0.0.1:{port}/"),
        Some("only-test"),
    )
    .await
    .unwrap();
    assert_eq!(result.lang, "de");
    assert_eq!(result.status, "estimated");
    assert!(
        result.review(),
        "Even a confident text result is not proof of audio language"
    );
    assert!(
        external_analysis(&detail, "http://example.com", None)
            .await
            .is_err()
    );
    task.abort();
}

#[tokio::test]
async fn failed_external_results_are_rejected_without_following_redirects() {
    use axum::{response::IntoResponse, routing::post};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let api = axum::Router::new()
        .route("/large", post(|| async { "x".repeat(64_001) }))
        .route("/wrong-scope", post(|| async { Json(json!({
            "scope":"title-language","lang":"en","confidence":"high","basis":"text","reason":"Title"
        })) }))
        .route("/invalid", post(|| async { Json(json!({
            "scope":"played-audio","lang":"English","confidence":"high","basis":"audio","reason":"Guess"
        })) }))
        .route("/redirect", post(|| async {
            (StatusCode::TEMPORARY_REDIRECT, [("Location","/target")]).into_response()
        }))
        .route("/target", post(|| async { panic!("Redirect must not be followed"); #[allow(unreachable_code)] "bad" }));
    let task = tokio::spawn(async move { axum::serve(listener, api).await.unwrap() });
    let detail = json!({"videoId":"abcdefghijk","evidence":null,"evidenceId":null,"recorded":{}});
    for route in ["large", "wrong-scope", "invalid", "redirect"] {
        assert!(
            external_analysis(&detail, &format!("http://127.0.0.1:{port}/{route}"), None)
                .await
                .is_err(),
            "{route}"
        );
    }
    task.abort();
}

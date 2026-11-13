use super::*;
use http_body_util::BodyExt;
use tower::ServiceExt;

fn watch(id: &str) -> Value {
    json!({"eventId":id,"kind":"watch","t":now()-10000,"seconds":5.,"videoId":"abcdefghijk","title":"Example","lang":"en","source":"audio-track","conf":"high","durationSeconds":10.,"coverage":[0.,5.]})
}
fn batch(events: Vec<Value>) -> store::Batch {
    store::Batch {
        device_id: "device".into(),
        events,
        evidence: Default::default(),
    }
}
fn viewing(id: &str, revision: i64, seconds: f64) -> Value {
    let bucket = (now() - 1_800_000).div_euclid(compact::BUCKET_MS) * compact::BUCKET_MS;
    json!({"eventId":id,"kind":"viewing","viewingId":"visit","bucket":bucket,"revision":revision,"t":bucket+1000,"lastWatched":bucket+1000+(seconds*1000.) as i64,"seconds":seconds,"videoId":"abcdefghijk","title":"Example","lang":"en","source":"audio-track","conf":"high","playbackContext":"foreground","durationSeconds":900.,"coverage":[[0.,seconds]]})
}
#[tokio::test]
async fn cumulative_revisions_are_atomic_idempotent_and_exportable() {
    let s = setup().await;
    let a = viewing("slice", 1, 2.);
    let b = viewing("slice", 2, 5.);
    for event in [&a, &b, &a, &b] {
        s.ingest(store::hash("key"), batch(vec![event.clone()]))
            .await
            .unwrap();
    }
    assert_eq!(s.export(0).await.unwrap()["events"], json!([]));
    let exported = s.export_viewings(0).await.unwrap();
    assert_eq!(exported["viewings"].as_array().unwrap().len(), 1);
    assert_eq!(exported["viewings"][0]["event"]["seconds"], 5.);
    let first = s
        .dashboard(7, "".into(), "".into(), chrono_tz::UTC)
        .await
        .unwrap();
    assert_eq!(first["seconds"], 5.);
    for mut bad in [
        viewing("slice", 2, 6.),
        viewing("slice", 3, 4.),
        viewing("legacy-collision", 1, 1.),
    ] {
        assert!(
            s.ingest(
                store::hash("key"),
                batch(vec![viewing("rollback", 1, 3.), bad.clone()])
            )
            .await
            .is_err()
        );
        bad["title"] = json!("Changed");
        bad["revision"] = json!(3);
        assert!(
            s.ingest(store::hash("key"), batch(vec![bad]))
                .await
                .is_err()
        );
    }
    s.ingest(store::hash("key"), batch(vec![watch("old-client")]))
        .await
        .unwrap();
    let second = s
        .dashboard(7, "".into(), "".into(), chrono_tz::UTC)
        .await
        .unwrap();
    assert_eq!(second["seconds"], 10.);
    assert!(second["snapshotSeq"].as_i64() > first["snapshotSeq"].as_i64());
    let cutoff = store::View {
        until: Some(b["bucket"].as_i64().unwrap() + 4000),
        ..Default::default()
    };
    assert!(
        s.dashboard_page(7, "".into(), "".into(), chrono_tz::UTC, cutoff)
            .await
            .is_err(),
        "Partial cumulative records cannot be interpolated across pauses"
    );
    s.ingest(store::hash("key"), batch(vec![viewing("slice", 4, 7.)]))
        .await
        .unwrap();
    let next = s
        .export_viewings(exported["nextViewing"].as_i64().unwrap())
        .await
        .unwrap();
    assert_eq!(next["viewings"][0]["event"]["revision"], 4);
    let mut collision = watch("slice");
    collision["t"] = a["t"].clone();
    assert!(
        s.ingest(store::hash("key"), batch(vec![collision]))
            .await
            .is_err()
    );
}

fn assert_parity(a: &Value, b: &Value, path: &str) {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!(
                (a - b).abs() <= 1e-7_f64.max(a.abs() * 1e-10),
                "{path}: {a} != {b}"
            );
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_parity(a, b, &format!("{path}/{i}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (key, a) in a {
                assert_parity(a, &b[key], &format!("{path}/{key}"));
            }
        }
        _ => assert_eq!(a, b, "{path}"),
    }
}
fn migration_parity(db: &rusqlite::Connection, until: i64) {
    let devices:Vec<Value>=db.prepare("SELECT d.id,d.label,d.person_id,COALESCE(p.name,'') FROM devices d LEFT JOIN people p ON p.id=d.person_id").unwrap().query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"label":r.get::<_,String>(1)?,"personId":r.get::<_,Option<String>>(2)?,"person":r.get::<_,String>(3)?}))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    let people:Vec<Value>=db.prepare("SELECT id,name FROM people").unwrap().query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"seconds":0,"videoCount":0}))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    let mut oracle = legacy_analytics::WatchCache::default();
    oracle.sync(db).unwrap();
    let scopes = std::iter::once((String::new(), String::new()))
        .chain(
            devices
                .iter()
                .map(|d| (d["id"].as_str().unwrap().to_owned(), String::new())),
        )
        .chain(
            people
                .iter()
                .map(|p| (String::new(), p["id"].as_str().unwrap().to_owned())),
        );
    for (device, person) in scopes {
        for days in [1, 7, 30, 90] {
            for cutoff in [until, until - 12345] {
                let tz = chrono_tz::Europe::Zurich;
                let w = analytics::Window::new(days, cutoff, i64::MAX, tz);
                let old = legacy_analytics::Window::new(days, cutoff, i64::MAX, tz);
                let mut pa = people.clone();
                let mut pb = people.clone();
                let a = analytics::Analytics::load(db, &w)
                    .unwrap()
                    .summary(&w, &devices, &mut pa, &device, &person, tz);
                let b = oracle
                    .summary(&old, &devices, &mut pb, &device, &person, tz)
                    .unwrap();
                assert_parity(
                    &json!([
                        a.seconds,
                        a.short_seconds,
                        a.context,
                        a.languages,
                        a.daily,
                        a.videos,
                        pa
                    ]),
                    &json!([
                        b.seconds,
                        b.short_seconds,
                        b.context,
                        b.languages,
                        b.daily,
                        b.videos,
                        pb
                    ]),
                    &format!("{days}/{device}/{person}/{cutoff}"),
                );
            }
        }
    }
}
#[test]
#[ignore = "Requires a disposable production database copy via OBSERVER_PARITY_DB"]
fn production_copy_migration_parity() {
    let path = std::env::var("OBSERVER_PARITY_DB").unwrap();
    let _store = store::Store::open(path.clone().into()).unwrap();
    let db = rusqlite::Connection::open(path).unwrap();
    let until = db
        .query_row(
            "SELECT CAST(MAX(t)+30000 AS INTEGER) FROM events",
            [],
            |r| r.get(0),
        )
        .unwrap();
    migration_parity(&db, until);
}
#[tokio::test]
async fn compact_import_matches_legacy_overlaps_edges_metadata_and_scopes() {
    let s = setup().await;
    let bucket = (now() - 86400000).div_euclid(compact::BUCKET_MS) * compact::BUCKET_MS;
    let mut events = Vec::new();
    for i in 0..90 {
        let mut e = watch(&format!("overlap-{i}"));
        e["t"] = json!(bucket - 12345 + i * 300);
        e["seconds"] = json!(if i % 2 == 0 { 18. } else { 1. });
        e["coverage"] = json!([0., 1.]);
        e["title"] = json!(format!("Metadata {}", i % 3));
        events.push(e);
    }
    s.ingest(store::hash("key"), batch(events)).await.unwrap();
    // Export/import through SQLite exercises resumable migration on the same source events.
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE people(id TEXT PRIMARY KEY,name TEXT);CREATE TABLE devices(id TEXT PRIMARY KEY,label TEXT,person_id TEXT);CREATE TABLE events(seq INTEGER PRIMARY KEY,device TEXT,payload TEXT,t REAL,kind TEXT);INSERT INTO people VALUES('me','Me');INSERT INTO devices VALUES('device','Laptop','me');").unwrap();
    for e in s.export(0).await.unwrap()["events"].as_array().unwrap() {
        db.execute(
            "INSERT INTO events VALUES(?,?,?,?,?)",
            rusqlite::params![
                e["seq"].as_i64(),
                "device",
                e["event"].to_string(),
                e["event"]["t"].as_f64(),
                "watch"
            ],
        )
        .unwrap();
    }
    let mut db = db;
    compact::initialize(&db).unwrap();
    while compact::import_chunk(&mut db).unwrap() {}
    let generation = compact::generation(&db).unwrap();
    assert!(!compact::import_chunk(&mut db).unwrap());
    assert_eq!(compact::generation(&db).unwrap(), generation);
    migration_parity(&db, bucket + 20000);
}
async fn setup() -> store::Store {
    let s = store::Store::open(":memory:".into()).unwrap();
    s.create_device(
        "device".into(),
        "Laptop".into(),
        "Me".into(),
        store::hash("key"),
    )
    .await
    .unwrap();
    s
}
#[tokio::test]
async fn retries_are_atomic_and_network_reports_never_count() {
    let s = setup().await;
    let event = watch("one");
    let ack = s
        .ingest(store::hash("key"), batch(vec![event.clone()]))
        .await
        .unwrap();
    assert_eq!(ack["accepted"], json!(["one"]));
    s.ingest(store::hash("key"), batch(vec![event.clone()]))
        .await
        .unwrap();
    let mut changed = event.clone();
    changed["seconds"] = json!(6.);
    assert_eq!(
        s.ingest(store::hash("key"), batch(vec![watch("rollback"), changed]))
            .await
            .err()
            .unwrap()
            .0,
        StatusCode::CONFLICT
    );
    s.ingest(store::hash("key"),batch(vec![json!({"eventId":"report","kind":"network","t":now()-1000,"endpoint":"watchtime","fields":{"st":"0","et":"900"}})])).await.unwrap();
    let d = s
        .dashboard(7, "".into(), "".into(), chrono_tz::Europe::Zurich)
        .await
        .unwrap();
    assert_eq!(d["seconds"], 5.);
    assert_eq!(d["daily"].as_array().unwrap().len(), 7);
    assert_eq!(
        s.export(0).await.unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        s.dashboard(7, "".into(), "Someone else".into(), chrono_tz::UTC)
            .await
            .unwrap()["seconds"],
        0.
    );
    s.revoke_device("device".into()).await.unwrap();
    assert_eq!(
        s.ingest(store::hash("key"), batch(vec![event]))
            .await
            .err()
            .unwrap()
            .0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn evidence_revisions_and_restart_persist() {
    let path = std::env::temp_dir().join(format!("observer-test-{}.sqlite", uuid::Uuid::new_v4()));
    {
        let s = store::Store::open(path.clone()).unwrap();
        s.create_device(
            "device".into(),
            "Laptop".into(),
            "".into(),
            store::hash("key"),
        )
        .await
        .unwrap();
        for (id, description) in [("one", "Original"), ("two", "Revised")] {
            let evidence = json!({"title":"Example","description":description,"algorithmVersion":"language-v2"});
            let key = store::hash(&evidence.to_string());
            let mut event = watch(id);
            event["evidenceId"] = json!(key);
            let mut b = batch(vec![event]);
            b.evidence.insert(key, evidence.to_string());
            s.ingest(store::hash("key"), b).await.unwrap();
        }
    }
    {
        let s = store::Store::open(path.clone()).unwrap();
        let export = s.export(0).await.unwrap();
        assert_eq!(export["events"][0]["evidence"]["description"], "Original");
        assert_eq!(export["events"][1]["evidence"]["description"], "Revised");
        let mut e = watch("bad");
        e["evidenceId"] = json!("a".repeat(64));
        assert!(s.ingest(store::hash("key"), batch(vec![e])).await.is_err());
    }
    std::fs::remove_file(path).unwrap();
}
#[tokio::test]
async fn api_owner_and_device_credentials_are_separate() {
    let s = setup().await;
    let app = router(
        App {
            store: s,
            admin_hash: Arc::new(store::hash("owner")),
            secure_cookie: false,
            timezone: chrono_tz::UTC,
        },
        "public".into(),
    );
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/dashboard")
                .header("authorization", "Bearer key")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/login")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(r#"{"token":"owner"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/dashboard")
                .header("cookie", &cookie)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["devices"][0]["label"],
        "Laptop"
    );
    for path in [
        "/api/session",
        "/api/languages",
        "/api/language-videos",
        "/api/diagnostics",
    ] {
        for signed_in in [false, true] {
            let request = axum::http::Request::builder()
                .uri(path)
                .header("cookie", if signed_in { cookie.as_str() } else { "" })
                .header("authorization", "Bearer key")
                .body(axum::body::Body::empty())
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                if signed_in {
                    StatusCode::OK
                } else {
                    StatusCode::UNAUTHORIZED
                }
            );
        }
    }
    for signed_in in [false, true] {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/metrics/client")
                    .header("content-type", "application/json")
                    .header("cookie", if signed_in { cookie.as_str() } else { "" })
                    .body(axum::body::Body::from(
                        r#"{"name":"dashboard.ready","durationMs":123,"ok":true}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if signed_in {
                StatusCode::OK
            } else {
                StatusCode::UNAUTHORIZED
            }
        );
    }
    let measured = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/dashboard?query=private-search")
                .header("cookie", &cookie)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        measured.headers()["server-timing"]
            .to_str()
            .unwrap()
            .contains("db_wait;dur=")
    );
    assert!(
        measured.headers()["server-timing"]
            .to_str()
            .unwrap()
            .contains("analytics_compute;dur=")
    );
    let request_id = measured.headers()["x-request-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/diagnostics")
                .header("cookie", &cookie)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let metrics: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(metrics["browser"]["dashboard.ready"]["p95Ms"], 123.);
    assert_eq!(metrics["recent"][0]["requestId"], request_id);
    assert!(
        metrics["requests"]["/api/dashboard"]["samples"]
            .as_u64()
            .unwrap()
            >= 2
    );
    assert!(!String::from_utf8_lossy(&body).contains("private-search"));
    assert!(!String::from_utf8_lossy(&body).contains("Laptop"));
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/api/languages?days=8")
                .header("cookie", cookie)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn undetermined_review_keeps_mixed_segments_scopes_and_every_page() {
    let s = setup().await;
    let mut events = Vec::new();
    for i in 0..25 {
        let mut event = watch(&format!("review-{i}"));
        event["videoId"] = json!(format!("v{i:010}"));
        event["lang"] = json!(if i % 2 == 0 { "und" } else { "other" });
        event["seconds"] = json!(1. + i as f64 / 10.);
        event.as_object_mut().unwrap().remove("coverage");
        events.push(event);
    }
    s.ingest(store::hash("key"), batch(events)).await.unwrap();
    let first = s
        .language_videos(7, "".into(), "".into(), chrono_tz::UTC, 1)
        .await
        .unwrap();
    assert_eq!(first["count"], 25);
    assert_eq!(first["pages"], 2);
    assert_eq!(first["videos"].as_array().unwrap().len(), 20);
    assert_eq!(first["videos"][0]["videoId"], "v0000000024");
    let second = s
        .language_videos(7, "device".into(), "Me".into(), chrono_tz::UTC, 2)
        .await
        .unwrap();
    assert_eq!(second["videos"].as_array().unwrap().len(), 5);
    let empty = s
        .language_videos(7, "".into(), "unassigned".into(), chrono_tz::UTC, 1)
        .await
        .unwrap();
    assert_eq!(empty["count"], 0);
    // A later identified segment must neither hide nor inflate this video's uncertain time.
    let mut identified = watch("identified-later");
    identified["videoId"] = json!("v0000000024");
    identified["t"] = json!(now() - 6000);
    s.ingest(store::hash("key"), batch(vec![identified]))
        .await
        .unwrap();
    let mixed = s
        .language_videos(7, "".into(), "".into(), chrono_tz::UTC, 1)
        .await
        .unwrap();
    assert_eq!(mixed["videos"][0]["seconds"], 3.4);
    // Late uploads must be inserted by event time, not ingestion order; assignments stay live.
    let mut late = watch("late-undetermined");
    late["videoId"] = json!("v0000000024");
    late["lang"] = json!("und");
    late["t"] = json!(now() - 20000);
    s.ingest(store::hash("key"), batch(vec![late]))
        .await
        .unwrap();
    s.update_device("device".into(), "Renamed".into(), "New person".into())
        .await
        .unwrap();
    let moved = s
        .language_videos(7, "".into(), "New person".into(), chrono_tz::UTC, 1)
        .await
        .unwrap();
    assert_eq!(moved["videos"][0]["seconds"], 8.4);
    let old = s
        .language_videos(7, "".into(), "Me".into(), chrono_tz::UTC, 1)
        .await
        .unwrap();
    assert_eq!(old["count"], 0);
    let dashboard = s
        .dashboard(7, "".into(), "".into(), chrono_tz::UTC)
        .await
        .unwrap();
    let video = dashboard["videos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["videoId"] == "v0000000024")
        .unwrap();
    assert_eq!(video["lang"], "en");
}

#[tokio::test]
async fn language_breakdown_matches_watch_segments_scopes_and_fractional_boundaries() {
    use chrono::{Days, TimeZone};
    let s = setup().await;
    let tz = chrono_tz::Europe::Zurich;
    let first = tz
        .timestamp_millis_opt(now())
        .unwrap()
        .date_naive()
        .checked_sub_days(Days::new(6))
        .unwrap();
    let since = tz
        .from_local_datetime(&first.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .unwrap()
        .timestamp_millis();
    let mut events = Vec::new();
    // One video can have multiple estimates. Keep each segment's attribution, not the last label.
    for (i, lang) in ["de", "en", "es", "other"].iter().enumerate() {
        let mut event = watch(&format!("language-{i}"));
        event["lang"] = json!(lang);
        event["playbackContext"] = json!(if i % 2 == 0 {
            "foreground"
        } else {
            "background"
        });
        event["isShort"] = json!(i == 2);
        events.push(event);
    }
    let mut boundary = watch("boundary");
    boundary["lang"] = json!("de");
    boundary["t"] = json!(since - 1250);
    events.push(boundary);
    let mut before = watch("before");
    before["t"] = json!(since - 5000);
    events.push(before);
    events.push(json!({"eventId":"report","kind":"network","t":now()-10000,"endpoint":"watchtime","fields":{"st":"0","et":"900"}}));
    events
        .push(json!({"eventId":"search","kind":"search","t":now()-10000,"query":"German lessons"}));
    for _ in 0..2 {
        s.ingest(store::hash("key"), batch(events.clone()))
            .await
            .unwrap();
    }
    for (id, person, lang) in [
        ("tablet", "Me", "de"),
        ("wife", "Wife", "fr"),
        ("unassigned", "", "bcs"),
    ] {
        s.create_device(id.into(), id.into(), person.into(), store::hash(id))
            .await
            .unwrap();
        let mut event = watch(id);
        event["lang"] = json!(lang);
        let mut b = batch(vec![event]);
        b.device_id = id.into();
        s.ingest(store::hash(id), b).await.unwrap();
    }
    let all = s
        .language_dashboard(7, "".into(), "".into(), tz)
        .await
        .unwrap();
    assert_eq!(all["seconds"], 38.75);
    assert_eq!(
        all["languages"],
        json!({"de":13.75,"en":5.,"es":5.,"other":5.,"fr":5.,"bcs":5.})
    );
    assert_eq!(all["daily"].as_array().unwrap().len(), 7);
    assert!(
        all.get("videos").is_none(),
        "Language responses do not build or transfer video history"
    );
    let me = all["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "Me")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    for days in [7, 30, 90] {
        for (device, person) in [
            ("", ""),
            ("", "Me"),
            ("", me),
            ("device", "Me"),
            ("", "unassigned"),
            ("wife", "Me"),
        ] {
            let language = s
                .language_dashboard(days, device.into(), person.into(), tz)
                .await
                .unwrap();
            let observer = s
                .dashboard(days, device.into(), person.into(), tz)
                .await
                .unwrap();
            assert_eq!(
                language["seconds"], observer["seconds"],
                "days={days} device={device} person={person}"
            );
            assert_eq!(language["languages"], observer["languages"]);
            assert_eq!(language["daily"].as_array().unwrap().len(), days as usize);
        }
    }
}

#[tokio::test]
async fn calendar_boundaries_and_replays_keep_time_separate_from_coverage() {
    use chrono::TimeZone;
    let s = setup().await;
    let today = chrono::Utc::now().date_naive();
    let midnight = chrono::Utc
        .from_utc_datetime(&today.and_hms_opt(0, 0, 0).unwrap())
        .timestamp_millis();
    // Use yesterday's boundary so the test works even immediately after midnight.
    let boundary = midnight - 86400000;
    let mut first = watch("cross-midnight");
    first["t"] = json!(boundary - 2000);
    first["coverage"] = json!([0., 5.]);
    let mut replay = watch("replay");
    replay["t"] = json!(boundary + 10000);
    s.ingest(store::hash("key"), batch(vec![first, replay]))
        .await
        .unwrap();
    let d = s
        .dashboard(7, "".into(), "".into(), chrono_tz::UTC)
        .await
        .unwrap();
    assert_eq!(d["seconds"], 10.);
    assert_eq!(d["videos"][0]["coveredSeconds"], 5.);
    assert_eq!(d["videos"][0]["completed"], false);
    let days = d["daily"].as_array().unwrap();
    assert_eq!(days[4]["seconds"], 2.);
    assert_eq!(days[5]["seconds"], 8.);
    let mut bad = watch("bad");
    bad["seconds"] = json!(-5);
    assert!(
        s.ingest(
            store::hash("key"),
            batch(vec![watch("rollback-valid"), bad])
        )
        .await
        .is_err()
    );
    assert_eq!(
        s.export(0).await.unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn high_resolution_capture_timestamps_preserve_fractional_elapsed_seconds() {
    let s = setup().await;
    let mut event = watch("fractional");
    event["t"] = json!((now() - 10000) as f64 + 0.375);
    event["seconds"] = json!(0.1234567);
    event.as_object_mut().unwrap().remove("coverage");
    s.ingest(store::hash("key"), batch(vec![event.clone()]))
        .await
        .unwrap();
    s.ingest(store::hash("key"), batch(vec![event]))
        .await
        .unwrap();
    let snapshot = s
        .dashboard(7, "".into(), "".into(), chrono_tz::UTC)
        .await
        .unwrap();
    assert_eq!(snapshot["seconds"], 0.1234567);
    assert_eq!(snapshot["people"][0]["seconds"], snapshot["seconds"]);
    assert_eq!(
        snapshot["daily"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["seconds"].as_f64().unwrap())
            .sum::<f64>(),
        0.1234567
    );
}

#[tokio::test]
async fn people_combine_devices_and_paginated_snapshots_stay_stable() {
    let s = setup().await;
    let me = s.create_person("Me".into()).await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let wife = s.create_person("Wife".into()).await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.create_device(
        "tablet".into(),
        "Tablet".into(),
        me.clone(),
        store::hash("tablet-key"),
    )
    .await
    .unwrap();
    s.create_device(
        "wife".into(),
        "Wife laptop".into(),
        wife.clone(),
        store::hash("wife-key"),
    )
    .await
    .unwrap();
    let at = now() - 20000;
    let events: Vec<Value> = (0..25)
        .map(|i| {
            let mut v = watch(&format!("event-{i}"));
            v["videoId"] = json!(format!("v{i:010}"));
            v["t"] = json!(at);
            v
        })
        .collect();
    s.ingest(store::hash("key"), batch(events)).await.unwrap();
    let mut tablet = batch(vec![watch("tablet-watch")]);
    tablet.device_id = "tablet".into();
    s.ingest(store::hash("tablet-key"), tablet).await.unwrap();
    let mut w = batch(vec![watch("wife-watch")]);
    w.device_id = "wife".into();
    s.ingest(store::hash("wife-key"), w).await.unwrap();
    let first = s
        .dashboard_page(
            7,
            "".into(),
            me.clone(),
            chrono_tz::UTC,
            store::View {
                per_page: 10,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(first["seconds"], 130.);
    assert_eq!(first["videoCount"], 26);
    assert_eq!(first["videos"].as_array().unwrap().len(), 10);
    let me_stats = first["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == me)
        .unwrap();
    assert_eq!(me_stats["deviceCount"], 2);
    assert_eq!(me_stats["videoCount"], 26);
    assert_eq!(
        s.dashboard(7, "".into(), wife, chrono_tz::UTC)
            .await
            .unwrap()["seconds"],
        5.
    );
    s.ingest(store::hash("key"), batch(vec![watch("new-arrival")]))
        .await
        .unwrap();
    let view = store::View {
        page: 2,
        per_page: 10,
        before: first["snapshotSeq"].as_i64(),
        until: first["until"].as_i64(),
        ..Default::default()
    };
    let second = s
        .dashboard_page(7, "".into(), me.clone(), chrono_tz::UTC, view)
        .await
        .unwrap();
    assert_eq!(second["seconds"], 130.);
    assert_eq!(second["pages"], 3);
    let a = first["videos"].as_array().unwrap();
    let b = second["videos"].as_array().unwrap();
    assert!(
        a.iter()
            .all(|x| b.iter().all(|y| x["videoId"] != y["videoId"]))
    );
    assert_eq!(
        s.dashboard(7, "".into(), me, chrono_tz::UTC).await.unwrap()["seconds"],
        135.
    );
    s.rotate_device("device".into(), store::hash("replacement"))
        .await
        .unwrap();
    assert!(s.device(store::hash("key")).await.is_err());
    assert_eq!(
        s.device(store::hash("replacement")).await.unwrap()["deviceId"],
        "device"
    );
}

#[tokio::test]
async fn legacy_people_labels_migrate_without_changing_device_keys_or_events() {
    let path = std::env::temp_dir().join(format!(
        "observer-migration-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    {
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE devices(id TEXT PRIMARY KEY,label TEXT NOT NULL,person TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,last_seen INTEGER);").unwrap();
        db.execute(
            "INSERT INTO devices VALUES('legacy','Laptop','Me',?,0,0,NULL)",
            [store::hash("legacy-key")],
        )
        .unwrap();
    }
    {
        let s = store::Store::open(path.clone()).unwrap();
        let identity = s.device(store::hash("legacy-key")).await.unwrap();
        assert_eq!(identity["person"], "Me");
        assert!(identity["personId"].is_string());
        let p = s.create_person("Sister".into()).await.unwrap();
        s.update_device(
            "legacy".into(),
            "Renamed laptop".into(),
            p["id"].as_str().unwrap().into(),
        )
        .await
        .unwrap();
        assert_eq!(
            s.device(store::hash("legacy-key")).await.unwrap()["person"],
            "Sister"
        );
    }
    {
        let s = store::Store::open(path.clone()).unwrap();
        assert_eq!(
            s.device(store::hash("legacy-key")).await.unwrap()["person"],
            "Sister"
        );
    }
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn generic_dashboard_keeps_people_coverage_separate_and_filters_only_history() {
    let s = setup().await;
    let searches=(0..22).map(|i|json!({"eventId":format!("query-{i}"),"kind":"search","t":now()-5000+i,"query":format!("Search {i}")})).collect();
    s.ingest(store::hash("key"), batch(searches)).await.unwrap();
    s.create_device(
        "wife".into(),
        "Phone".into(),
        "Wife".into(),
        store::hash("wife-key"),
    )
    .await
    .unwrap();
    s.create_device(
        "tablet".into(),
        "Tablet".into(),
        "Me".into(),
        store::hash("tablet-key"),
    )
    .await
    .unwrap();
    let mut first = watch("first");
    first["isShort"] = json!(true);
    first["channel"] = json!("Example channel");
    s.ingest(store::hash("key"), batch(vec![first]))
        .await
        .unwrap();
    let mut second = watch("second");
    second["coverage"] = json!([5., 10.]);
    second["isShort"] = json!(true);
    let mut wife = batch(vec![second.clone()]);
    wife.device_id = "wife".into();
    s.ingest(store::hash("wife-key"), wife).await.unwrap();
    let household = s
        .dashboard(7, "".into(), "".into(), chrono_tz::UTC)
        .await
        .unwrap();
    assert_eq!(household["videoCount"], 1);
    assert_eq!(household["historyCount"], 2);
    assert_eq!(
        household["completedCount"], 0,
        "Different people cannot complete each other's videos"
    );
    assert!(
        household["videos"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["coveredSeconds"] == 5.)
    );
    second["eventId"] = json!("tablet-second");
    second["channel"] = json!("Example channel");
    let mut tablet = batch(vec![second]);
    tablet.device_id = "tablet".into();
    s.ingest(store::hash("tablet-key"), tablet).await.unwrap();
    let me = s
        .dashboard(7, "".into(), "Me".into(), chrono_tz::UTC)
        .await
        .unwrap();
    assert_eq!(me["searchCount"], 22);
    assert_eq!(me["searches"].as_array().unwrap().len(), 20);
    assert_eq!(me["searches"][0]["query"], "Search 21");
    assert_eq!(me["historyCount"], 1);
    assert_eq!(me["completedCount"], 1);
    assert_eq!(me["shortSeconds"], 10.);
    assert_eq!(me["videos"][0]["coveredSeconds"], 10.);
    let phone = s
        .dashboard(7, "device".into(), "Me".into(), chrono_tz::UTC)
        .await
        .unwrap();
    assert_eq!(phone["seconds"], 5.);
    assert_eq!(phone["completedCount"], 0);
    assert_eq!(
        phone["people"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == "Me")
            .unwrap()["seconds"],
        10.
    );
    let filtered = s
        .dashboard_page(
            7,
            "".into(),
            "Me".into(),
            chrono_tz::UTC,
            store::View {
                query: "not found".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(filtered["filteredCount"], 0);
    assert_eq!(filtered["seconds"], 10.);
    assert_eq!(filtered["videoCount"], 1);
    assert_eq!(filtered["completedCount"], 1);
    let matched = s
        .dashboard_page(
            7,
            "".into(),
            "Me".into(),
            chrono_tz::UTC,
            store::View {
                query: "EXAMPLE CHANNEL".into(),
                kind: "short".into(),
                sort: "watch".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(matched["filteredCount"], 1);
    let regular = s
        .dashboard_page(
            7,
            "".into(),
            "Me".into(),
            chrono_tz::UTC,
            store::View {
                kind: "video".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(regular["filteredCount"], 0);
    assert_eq!(regular["shortSeconds"], 10.);
}

#[tokio::test]
async fn playback_context_survives_retries_scopes_filters_and_legacy_records() {
    let s = setup().await;
    let mut foreground = watch("foreground");
    foreground["playbackContext"] = json!("foreground");
    let mut background = watch("background");
    background["playbackContext"] = json!("background");
    let events = vec![foreground, background, watch("legacy")];
    for _ in 0..2 {
        s.ingest(store::hash("key"), batch(events.clone()))
            .await
            .unwrap();
    }
    let d = s
        .dashboard(7, "device".into(), "Me".into(), chrono_tz::UTC)
        .await
        .unwrap();
    assert_eq!(d["seconds"], 15.);
    for key in [
        "foregroundSeconds",
        "backgroundSeconds",
        "unspecifiedSeconds",
    ] {
        assert_eq!(d[key], 5.);
        assert_eq!(d["videos"][0][key], 5.);
        assert_eq!(
            d["daily"]
                .as_array()
                .unwrap()
                .iter()
                .map(|day| day[key].as_f64().unwrap())
                .sum::<f64>(),
            5.
        );
    }
    let filtered = s
        .dashboard_page(
            7,
            "device".into(),
            "Me".into(),
            chrono_tz::UTC,
            store::View {
                query: "no-such-video".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(filtered["foregroundSeconds"], 5.);
    assert_eq!(filtered["backgroundSeconds"], 5.);
    assert_eq!(filtered["unspecifiedSeconds"], 5.);
    let mut invalid = watch("bad-context");
    invalid["playbackContext"] = json!("maybe");
    assert!(
        s.ingest(store::hash("key"), batch(vec![invalid]))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn bounded_activity_queries_keep_order_counts_and_paging_snapshot() {
    let s = setup().await;
    let t = now() - 10000;
    let mut events: Vec<Value> = (0..125).map(|i| {
        if i % 5 == 0 {
            json!({"eventId":format!("query-{i}"),"kind":"search","t":t,"query":format!("Search {i}")})
        } else {
            json!({"eventId":format!("report-{i}"),"kind":"network","t":t,"endpoint":"qoe","fields":{"cmt":i.to_string()}})
        }
    }).collect();
    events.push(watch("watch"));
    for chunk in events.chunks(100) {
        s.ingest(store::hash("key"), batch(chunk.to_vec()))
            .await
            .unwrap();
    }
    let original = s
        .dashboard(7, "".into(), "".into(), chrono_tz::UTC)
        .await
        .unwrap();
    assert_eq!(original["seconds"], 5.);
    assert_eq!(original["searchCount"], 25);
    assert_eq!(original["searches"].as_array().unwrap().len(), 20);
    assert_eq!(original["searches"][0]["query"], "Search 120");
    let recent = original["recent"].as_array().unwrap();
    assert_eq!(recent.len(), 100);
    assert!(
        recent
            .windows(2)
            .all(|pair| pair[0]["seq"].as_i64() > pair[1]["seq"].as_i64())
    );
    s.ingest(
        store::hash("key"),
        batch(vec![
            json!({"eventId":"later","kind":"search","t":t+1000,"query":"Later search"}),
        ]),
    )
    .await
    .unwrap();
    let frozen = s
        .dashboard_page(
            7,
            "".into(),
            "".into(),
            chrono_tz::UTC,
            store::View {
                before: original["snapshotSeq"].as_i64(),
                until: original["until"].as_i64(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(frozen["recent"], original["recent"]);
    assert_eq!(frozen["searches"], original["searches"]);
    assert_eq!(frozen["searchCount"], 25);
    let fresh = s
        .dashboard(7, "".into(), "".into(), chrono_tz::UTC)
        .await
        .unwrap();
    assert_eq!(fresh["searchCount"], 26);
    assert_eq!(fresh["searches"][0]["query"], "Later search");
    let empty = s
        .dashboard(7, "".into(), "unassigned".into(), chrono_tz::UTC)
        .await
        .unwrap();
    assert_eq!(empty["searchCount"], 0);
    assert_eq!(empty["recent"], json!([]));
}

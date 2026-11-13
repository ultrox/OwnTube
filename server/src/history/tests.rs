use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

fn filters(v: Value) -> Filters {
    serde_json::from_value(v).unwrap()
}
async fn seed() -> Store {
    let s = Store::open(":memory:".into()).unwrap();
    s.create_device(
        "browser".into(),
        "Misleading TV label".into(),
        "Owner".into(),
        hash("browser-key"),
    )
    .await
    .unwrap();
    s.create_device(
        "tv".into(),
        "Laptop label".into(),
        "Guest".into(),
        hash("tv-key"),
    )
    .await
    .unwrap();
    s.create_device(
        "unknown".into(),
        "TV with no records".into(),
        "Owner".into(),
        hash("unknown-key"),
    )
    .await
    .unwrap();
    s
}
fn bucket() -> i64 {
    (now() - 86_400_000).div_euclid(compact::BUCKET_MS) * compact::BUCKET_MS
}
fn viewing(id: &str, visit: &str, seconds: f64, context: &str) -> Value {
    json!({"eventId":id,"kind":"viewing","viewingId":visit,"bucket":bucket(),"revision":1,
        "t":bucket()+1000,"lastWatched":bucket()+1000+(seconds*1000.) as i64,
        "seconds":seconds,"videoId":"abcdefghijk","title":"<script>Title</script>",
        "channel":"A long channel","lang":"en","source":"audio-track","conf":"high",
        "playbackContext":context,"durationSeconds":100.,"coverage":[[0.,seconds]]})
}
async fn ingest(s: &Store, device: &str, events: Vec<Value>, evidence: BTreeMap<String, String>) {
    s.ingest(
        hash(&format!("{device}-key")),
        crate::store::Batch {
            device_id: device.into(),
            events,
            evidence,
        },
    )
    .await
    .unwrap();
}
async fn watched(s: &Store, args: Value) -> Value {
    s.history(filters(args), chrono_tz::Europe::Zurich)
        .await
        .unwrap()
}
async fn searched(s: &Store, args: Value) -> Value {
    s.history_searches(filters(args), chrono_tz::Europe::Zurich)
        .await
        .unwrap()
}
fn search(id: &str, query: &str, t: i64) -> Value {
    json!({"eventId":id,"kind":"search","query":query,"t":t,"lang":"en","source":"text","conf":"low"})
}

#[tokio::test]
async fn metadata_versions_combine_within_visits_and_legacy_days_without_merging_visits() {
    let s = seed().await;
    let raw = r#"{ "title":"Saved", "description":"<img onerror=bad()>", "algorithmVersion":"language-v2", "selectedAudioLanguage":"en" }"#;
    let mut first = viewing("first", "visit1", 30., "foreground");
    first["evidenceId"] = json!(hash(raw));
    let mut background = first.clone();
    background["eventId"] = json!("background");
    background["playbackContext"] = json!("background");
    background["t"] = json!(bucket() + 40_000);
    background["lastWatched"] = json!(bucket() + 70_000);
    let mut replay = first.clone();
    replay["eventId"] = json!("replay");
    replay["viewingId"] = json!("visit2");
    let mut version = first.clone();
    version["eventId"] = json!("new-version");
    version["title"] = json!("Changed title");
    let legacy = json!({"eventId":"legacy1","kind":"watch","t":bucket()+2000,"seconds":5.,
        "videoId":"abcdefghijk","title":"Legacy version","lang":"other","source":"unknown","conf":"low"});
    let mut legacy2 = legacy.clone();
    legacy2["eventId"] = json!("legacy2");
    legacy2["title"] = json!("Updated legacy title");
    legacy2["t"] = json!(bucket() + 80_000);
    ingest(
        &s,
        "browser",
        vec![first, background, replay, version, legacy, legacy2],
        BTreeMap::from([(hash(raw), raw.into())]),
    )
    .await;
    let value = watched(&s, json!({})).await;
    assert_eq!(value["count"], 3);
    assert_eq!(value["videoCount"], 1);
    assert_eq!(value["seconds"], 130.);
    assert_eq!(value["foregroundSeconds"], 90.);
    assert_eq!(value["backgroundSeconds"], 30.);
    assert_eq!(value["unspecifiedSeconds"], 10.);
    assert_eq!(value["perCalendarDaySeconds"], 130. / 7.);
    let rows = value["rows"].as_array().unwrap();
    let visit = rows
        .iter()
        .find(|v| v["viewingId"] == "visit1" && v["title"] == "<script>Title</script>")
        .unwrap();
    assert_eq!(visit["seconds"], 90.);
    assert_eq!(visit["coveredSeconds"], 30.);
    assert_eq!(visit["coveragePercent"], 30.);
    assert_eq!(visit["coverageComplete"], true);
    assert_eq!(visit["rowKind"], "viewing");
    assert_eq!(visit["versionCount"], 2);
    assert_eq!(visit["versions"][0]["seconds"], 60.);
    assert_eq!(visit["versions"][1]["seconds"], 30.);
    assert_eq!(visit["foregroundSeconds"], 60.);
    assert_eq!(visit["backgroundSeconds"], 30.);
    assert_eq!(visit["deviceKind"], "browser"); // not inferred from the misleading label
    let old = rows.iter().find(|v| v["rowKind"] == "legacy-day").unwrap();
    assert!(old["viewingId"].is_null());
    assert!(old["coveredSeconds"].is_null());
    assert!(old["coveragePercent"].is_null());
    assert_eq!(old["seconds"], 10.);
    assert_eq!(old["versionCount"], 2);
    let detail = s
        .history_evidence(
            "browser".into(),
            visit["metadataId"].as_str().unwrap().into(),
        )
        .await
        .unwrap();
    assert_eq!(detail["evidenceText"], raw);
    assert_eq!(
        hash(detail["evidenceText"].as_str().unwrap()),
        detail["evidenceId"]
    );
    assert!(
        s.history_evidence("tv".into(), visit["metadataId"].as_str().unwrap().into())
            .await
            .is_err()
    );
    let global = s
        .dashboard(7, "".into(), "".into(), chrono_tz::Europe::Zurich)
        .await
        .unwrap();
    for f in [
        "seconds",
        "foregroundSeconds",
        "backgroundSeconds",
        "unspecifiedSeconds",
        "videoCount",
    ] {
        assert_eq!(value[f], global[f], "{f}");
    }
    let filtered = watched(&s, json!({"query":"CHANGED"})).await;
    assert_eq!(filtered["filteredCount"], 1);
    assert_eq!(filtered["rows"][0]["id"], visit["id"]);
    assert_eq!(filtered["rows"][0]["seconds"], 90.);
    assert_eq!(filtered["rows"][0]["versionCount"], 2);
    assert_eq!(filtered["seconds"], value["seconds"]);
    for (a, b) in filtered["daily"]
        .as_array()
        .unwrap()
        .iter()
        .zip(value["daily"].as_array().unwrap())
    {
        assert_eq!(a["seconds"], b["seconds"]);
        assert_eq!(a["rowCount"], b["rowCount"]);
    }
}

#[tokio::test]
async fn history_groups_before_paging_and_keeps_identity_and_union_coverage_across_updates() {
    let s = seed().await;
    let mut events = Vec::new();
    for visit in 0..25 {
        for version in 0..2 {
            let mut e = viewing(
                &format!("v{visit}-{version}"),
                &format!("visit{visit}"),
                2.,
                "foreground",
            );
            e["title"] = json!(if version == 0 {
                "Original title"
            } else {
                "Updated title"
            });
            e["t"] = json!(bucket() + 1000 + version * 3000);
            e["lastWatched"] = json!(bucket() + 3000 + version * 3000);
            e["coverage"] = json!([[version as f64, version as f64 + 2.]]);
            events.push(e);
        }
    }
    ingest(&s, "browser", events, Default::default()).await;
    let first = watched(&s, json!({"query":"Original"})).await;
    let second = watched(&s, json!({"query":"Original","page":2,"generation":first["generation"],"until":first["until"]})).await;
    assert_eq!(first["count"], 25);
    assert_eq!(first["filteredCount"], 25);
    assert_eq!(first["pages"], 2);
    assert_eq!(first["rows"].as_array().unwrap().len(), 20);
    assert_eq!(second["rows"].as_array().unwrap().len(), 5);
    let rows: Vec<_> = first["rows"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["rows"].as_array().unwrap())
        .collect();
    assert_eq!(
        rows.iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect::<BTreeSet<_>>()
            .len(),
        25
    );
    for row in &rows {
        assert_eq!(row["title"], "Updated title");
        assert_eq!(row["seconds"], 4.);
        assert_eq!(row["coveredSeconds"], 3.); // overlapping ranges across versions, not a sum of 4
        assert_eq!(row["versionCount"], 2);
        assert_eq!(row["versions"][0]["title"], "Updated title");
        assert_eq!(row["versions"][1]["title"], "Original title");
    }
    let prior = rows.iter().find(|r| r["viewingId"] == "visit0").unwrap();
    let mut updates = Vec::new();
    for version in 2..17 {
        let mut e = viewing(&format!("update-{version}"), "visit0", 1., "background");
        e["title"] = json!(format!("Metadata {version}"));
        e["t"] = json!(bucket() + 10_000 + version * 1000);
        e["lastWatched"] = json!(bucket() + 11_000 + version * 1000);
        e["coverage"] = json!([]);
        updates.push(e);
    }
    ingest(&s, "browser", updates, Default::default()).await;
    let updated = watched(&s, json!({})).await;
    assert_eq!(updated["count"], 25);
    let entry = &updated["rows"][0];
    assert_eq!(entry["id"], prior["id"]);
    assert_eq!(entry["versionCount"], 17);
    assert_eq!(entry["title"], "Metadata 16");
    assert_eq!(entry["seconds"], 19.);
    assert_eq!(entry["foregroundSeconds"], 4.);
    assert_eq!(entry["backgroundSeconds"], 15.);
    assert_eq!(entry["coveredSeconds"], 3.);
    assert_eq!(entry["coverageComplete"], false);
}

#[tokio::test]
async fn history_keeps_devices_and_videos_separate_even_when_viewing_ids_are_reused() {
    let s = seed().await;
    ingest(
        &s,
        "browser",
        vec![viewing("a", "reused-id", 2., "foreground")],
        Default::default(),
    )
    .await;
    ingest(
        &s,
        "tv",
        vec![viewing("b", "reused-id", 3., "background")],
        Default::default(),
    )
    .await;
    let mut other = viewing("c", "reused-id", 4., "foreground");
    other["videoId"] = json!("lmnopqrstuv");
    ingest(&s, "browser", vec![other], Default::default()).await;
    let data = watched(&s, json!({})).await;
    assert_eq!(data["count"], 3);
    assert_eq!(data["videoCount"], 2);
    assert_eq!(data["seconds"], 9.);
}

#[tokio::test]
async fn local_dates_split_midnight_and_retain_zero_days() {
    let s = seed().await;
    let tz = chrono_tz::Europe::Zurich;
    let midnight = tz
        .from_local_datetime(
            &tz.timestamp_millis_opt(now())
                .unwrap()
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
        )
        .earliest()
        .unwrap()
        .timestamp_millis();
    let mut a = viewing("before-midnight", "cross-midnight", 20., "foreground");
    a["bucket"] = json!(midnight - 900_000);
    a["t"] = json!(midnight - 30_000);
    a["lastWatched"] = json!(midnight - 10_000);
    let mut b = a.clone();
    b["eventId"] = json!("after-midnight");
    b["bucket"] = json!(midnight);
    b["t"] = json!(midnight + 1000);
    b["lastWatched"] = json!(midnight + 21_000);
    ingest(&s, "browser", vec![a, b], Default::default()).await;
    let v = watched(&s, json!({})).await;
    assert_eq!(v["count"], 2);
    assert_eq!(v["seconds"], 40.);
    assert_eq!(v["videoCount"], 1);
    assert_eq!(v["daily"].as_array().unwrap().len(), 7);
    assert_eq!(
        v["daily"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["seconds"] == 0.)
            .count(),
        5
    );
    assert_ne!(v["rows"][0]["date"], v["rows"][1]["date"]);
    assert_eq!(v["rows"][0]["viewingId"], v["rows"][1]["viewingId"]);
    assert_eq!(
        v["rows"][0]["date"],
        tz.timestamp_millis_opt(midnight)
            .unwrap()
            .date_naive()
            .to_string()
    );
}

#[tokio::test]
async fn watch_paging_preserves_scope_and_rejects_an_outdated_generation() {
    let s = seed().await;
    let events = (0..25)
        .map(|i| {
            viewing(
                &format!("record{i}"),
                &format!("visit{i}"),
                2.,
                "background",
            )
        })
        .collect();
    ingest(&s, "browser", events, Default::default()).await;
    let first = watched(&s, json!({})).await;
    assert_eq!(first["count"], 25);
    assert_eq!(first["rows"].as_array().unwrap().len(), 20);
    let second = watched(
        &s,
        json!({"page":2,"generation":first["generation"],"until":first["until"]}),
    )
    .await;
    assert_eq!(second["rows"].as_array().unwrap().len(), 5);
    let ids: BTreeSet<_> = first["rows"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["rows"].as_array().unwrap())
        .map(|v| v["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 25);
    assert_eq!(first["seconds"], second["seconds"]);
    let owner = first["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "Owner")
        .unwrap()["id"]
        .clone();
    assert_eq!(watched(&s, json!({"person":owner})).await["seconds"], 50.);
    assert_eq!(watched(&s, json!({"device":"tv"})).await["seconds"], 0.);
    ingest(
        &s,
        "browser",
        vec![viewing("new", "new", 2., "background")],
        Default::default(),
    )
    .await;
    let err = s
        .history(
            filters(json!({"page":2,"generation":first["generation"],"until":first["until"]})),
            chrono_tz::UTC,
        )
        .await
        .unwrap_err();
    assert_eq!(err.0, StatusCode::GONE);
}

#[tokio::test]
async fn searches_page_every_match_freeze_inserts_and_name_actual_collectors() {
    let s = seed().await;
    // Several searches at exactly the same millisecond remain distinct.
    let events = (0..27)
        .map(|i| {
            search(
                &format!("search{i}"),
                if i % 2 == 0 {
                    "Čokolada <script>"
                } else {
                    "Other"
                },
                bucket() + 1000,
            )
        })
        .collect();
    ingest(&s, "browser", events, Default::default()).await;
    let mut tv = viewing("tv-watch", "tv-visit", 2., "foreground");
    tv["source"] = json!("android-player");
    ingest(&s, "tv", vec![tv], Default::default()).await;
    let first = searched(&s, json!({})).await;
    assert_eq!(first["count"], 27);
    assert_eq!(first["rows"].as_array().unwrap().len(), 20);
    assert_eq!(first["searchCapability"], "recorded");
    let filtered = searched(&s, json!({"query":"čOKOLADA"})).await;
    assert_eq!(filtered["count"], 27);
    assert_eq!(filtered["filteredCount"], 14);
    assert_eq!(filtered["rows"][0]["query"], "Čokolada <script>");
    let second = searched(
        &s,
        json!({"page":2,"before":first["before"],"until":first["until"]}),
    )
    .await;
    assert_eq!(second["rows"].as_array().unwrap().len(), 7);
    let ids: BTreeSet<_> = first["rows"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["rows"].as_array().unwrap())
        .map(|v| v["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids.len(), 27);
    ingest(
        &s,
        "browser",
        vec![search("late", "Late upload", bucket() + 500)],
        Default::default(),
    )
    .await;
    let frozen = searched(
        &s,
        json!({"page":2,"before":first["before"],"until":first["until"]}),
    )
    .await;
    // Device lastSeen is live metadata; the saved search snapshot stays fixed.
    for field in [
        "rows",
        "count",
        "filteredCount",
        "daily",
        "before",
        "until",
        "since",
        "page",
        "pages",
        "pageSize",
    ] {
        assert_eq!(frozen[field], second[field], "{field}");
    }
    assert_eq!(searched(&s, json!({})).await["count"], 28);
    let tv = searched(&s, json!({"device":"tv"})).await;
    assert_eq!(tv["count"], 0);
    assert_eq!(tv["searchCapability"], "not-recorded");
    assert_eq!(
        searched(&s, json!({"device":"unknown"})).await["searchCapability"],
        "unknown"
    );
    // A device observed sending both TV playback and search events is mixed.
    ingest(
        &s,
        "tv",
        vec![search("tv-search", "A changed collector", bucket() + 700)],
        Default::default(),
    )
    .await;
    let mixed = searched(&s, json!({"device":"tv"})).await;
    assert_eq!(mixed["searchCapability"], "recorded");
    assert_eq!(mixed["rows"][0]["deviceKind"], "mixed");
}

#[tokio::test]
async fn history_routes_require_owner_and_validate_snapshot_pairs() {
    let s = seed().await;
    s.add_session(hash("owner")).await.unwrap();
    let app = crate::router(
        App {
            store: s,
            admin_hash: Arc::new(hash("admin-key")),
            secure_cookie: false,
            timezone: chrono_tz::UTC,
        },
        ".".into(),
    );
    for path in [
        "/api/history",
        "/api/history/searches",
        "/api/history/evidence?device=browser&metadata=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ] {
        let r = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("Authorization", "Bearer browser-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    }
    for path in [
        "/api/history?days=1",
        "/api/history?page=0",
        "/api/history?generation=1",
        "/api/history?before=1&until=100",
        "/api/history/searches?until=100",
        "/api/history/searches?generation=1&until=100",
    ] {
        let r = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("Cookie", "observer_session=owner")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::UNPROCESSABLE_ENTITY, "{path}");
    }
    let r = app
        .oneshot(
            Request::builder()
                .uri("/api/history")
                .header("Cookie", "observer_session=owner")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["count"], 0);
    assert_eq!(body["daily"].as_array().unwrap().len(), 7);
}

#[tokio::test]
async fn device_foreground_correction_preserves_evidence_time_and_other_devices() {
    let s = seed().await;
    ingest(
        &s,
        "tv",
        vec![viewing("tv-background", "tv-view", 20., "background")],
        Default::default(),
    )
    .await;
    ingest(
        &s,
        "browser",
        vec![viewing(
            "browser-background",
            "browser-view",
            10.,
            "background",
        )],
        Default::default(),
    )
    .await;
    let original = s.export_viewings(0).await.unwrap();
    let before = watched(&s, json!({})).await;
    let set = |context: Value| {
        serde_json::from_value(json!({
            "context":context,"reason":"Owner confirmed this TV is foreground"
        }))
        .unwrap()
    };
    s.correct_playback_context("tv".into(), set(json!("foreground")))
        .await
        .unwrap();
    let corrected = watched(&s, json!({})).await;
    assert_eq!(corrected["seconds"], before["seconds"]);
    assert_eq!(corrected["foregroundSeconds"], 20.);
    assert_eq!(corrected["backgroundSeconds"], 10.);
    assert_eq!(s.export_viewings(0).await.unwrap(), original);
    let tv = corrected["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["deviceId"] == "tv")
        .unwrap();
    assert_eq!(tv["contextOverride"]["context"], "foreground");
    let stale = s
        .history(
            filters(json!({"generation":before["generation"],"until":before["until"]})),
            chrono_tz::UTC,
        )
        .await
        .unwrap_err();
    assert_eq!(stale.0, StatusCode::GONE);
    let languages = s
        .module_languages(
            serde_json::from_value(json!({})).unwrap(),
            chrono_tz::Europe::Zurich,
        )
        .await
        .unwrap();
    let dashboard = s
        .dashboard(7, "".into(), "".into(), chrono_tz::Europe::Zurich)
        .await
        .unwrap();
    for field in [
        "seconds",
        "foregroundSeconds",
        "backgroundSeconds",
        "unspecifiedSeconds",
    ] {
        assert_eq!(corrected[field], languages[field]);
        assert_eq!(corrected[field], dashboard[field]);
    }
    // Later uploads from the installed collector obey the same owner correction.
    ingest(
        &s,
        "tv",
        vec![viewing("next-tv", "next-tv", 5., "background")],
        Default::default(),
    )
    .await;
    assert_eq!(watched(&s, json!({})).await["foregroundSeconds"], 25.);
    // Reset is appended, returning all original context without touching collector records.
    s.correct_playback_context("tv".into(), set(Value::Null))
        .await
        .unwrap();
    let reset = watched(&s, json!({})).await;
    assert_eq!(reset["foregroundSeconds"], 0.);
    assert_eq!(reset["backgroundSeconds"], 35.);
    let audit = s
        .read(|db| {
            Ok(
                db.query_row("SELECT COUNT(*) FROM device_context_overrides", [], |r| {
                    r.get::<_, i64>(0)
                })?,
            )
        })
        .await
        .unwrap();
    assert_eq!(audit, 2);

    let app = crate::router(
        App {
            store: s,
            admin_hash: Arc::new(hash("admin-key")),
            secure_cookie: false,
            timezone: chrono_tz::UTC,
        },
        ".".into(),
    );
    let result = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/devices/tv/playback-context")
                .header("Authorization", "Bearer tv-key")
                .header("Content-Type", "application/json")
                .body(Body::from(
                    r#"{"context":"foreground","reason":"not owner"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result.status(), StatusCode::UNAUTHORIZED);
}

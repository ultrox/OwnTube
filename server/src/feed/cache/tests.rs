use super::*;
use axum::body::Body;
use http_body_util::BodyExt;
use tower::ServiceExt;

pub(super) fn card(id: &str) -> Card {
    Card { video_id:Some(id.into()),title:id.into(),..Default::default() }
}
fn row() -> Row {
    Row { id:"home:recommended:0".into(), title:"Recommended".into(),
        items:vec![card("aaaaaaaaaaa"),card("bbbbbbbbbbb"),card("ccccccccccc")],next:None }
}
pub(super) fn document() -> Document {
    Document { id:"test".into(),audience:"account".into(),device:"tv".into(),label:"TV".into(),category:"home".into(),
        revision:0,generation:1,version:0,served_version:None,served_at:None,cached_at:Some(now()),published_at:None,
        next_refresh_at:now()+WINDOW,retry_at:0,error:None,limited:false,source:vec![row()],draft:Edits::default(),published:Edits::default(),german:Default::default() }
}
fn edits() -> Edits {
    Edits { removed:vec!["video:bbbbbbbbbbb".into()], rows:BTreeMap::from([("home:recommended:0".into(), RowEdit {
        title:"Recommended".into(),added:vec![card("ddddddddddd")],
        order:vec!["video:ccccccccccc".into(),"video:ddddddddddd".into(),"video:aaaaaaaaaaa".into()],
        limit:None,
    })]),..Default::default() }
}

#[test]
fn row_limits_apply_after_edits_survive_refresh_and_bound_tv_pagination() {
    let mut source = row();
    source.items = (0..48).map(|i| card(&format!("{i:011}"))).collect();
    let mut edits = Edits::default();
    edits.removed.push("video:00000000000".into());
    edits.rows.insert(source.id.clone(), RowEdit {
        title:source.title.clone(), limit:Some(6), added:vec![card("aaaaaaaaaaa")],
        order:vec!["video:00000000000".into(),"video:aaaaaaaaaaa".into(),"video:00000000047".into()],
    });
    edits.card_limit = Some(12);
    let mut other = source.clone();
    other.id = "other-row".into();
    let rows = compose(&[source.clone(), other], &edits);
    assert_eq!(rows[0].items.len(), 6);
    assert_eq!(rows[1].items.len(), 12);
    assert_eq!(rows[0].items[0].video_id.as_deref(), Some("aaaaaaaaaaa"));
    assert_eq!(rows[0].items[1].video_id.as_deref(), Some("00000000047"));
    let response = page(&rows, "test", 1, None).unwrap();
    assert_eq!(response["rows"][0]["items"].as_array().unwrap().len(), 6);
    assert!(response["rows"][0]["next"].is_null());
    source.items.reverse();
    assert_eq!(compose(&[source.clone()], &edits)[0].items.len(), 6);
    assert_eq!(source.items.len(), 48);
    edits.rows.get_mut(&source.id).unwrap().limit = None;
    assert_eq!(compose(&[source.clone()], &edits)[0].items.len(), 12);
    edits.card_limit = Some(48);
    assert_eq!(compose(&[source], &edits)[0].items.len(), 48);
    for limit in [0, 49] {
        edits.rows.get_mut(&row().id).unwrap().limit = Some(limit);
        assert!(validate(&edits, &document()).is_err());
    }
    // Existing saved edits do not need a migration.
    let old: RowEdit = serde_json::from_value(json!({"title":"Shorts","added":[],"order":[]})).unwrap();
    assert_eq!(old.limit, None);
    edits.rows.get_mut(&row().id).unwrap().limit = None;
    for limit in [0, 49] {
        edits.card_limit = Some(limit);
        assert!(validate(&edits, &document()).is_err());
    }
}
#[test]
fn refresh_keeps_insertions_blocks_and_order_inside_existing_rows() {
    let first = compose(&[row()],&edits());
    assert_eq!(first.len(),1);
    assert_eq!(first[0].items.iter().map(card_key).collect::<Vec<_>>(),
        vec!["video:ccccccccccc","video:ddddddddddd","video:aaaaaaaaaaa"]);
    let mut refreshed = row();
    refreshed.items = vec![card("eeeeeeeeeee"),card("bbbbbbbbbbb"),card("aaaaaaaaaaa"),card("ccccccccccc")];
    let refreshed = compose(&[refreshed],&edits());
    assert_eq!(refreshed[0].items.iter().map(card_key).collect::<Vec<_>>(),
        vec!["video:ccccccccccc","video:ddddddddddd","video:aaaaaaaaaaa","video:eeeeeeeeeee"]);
}

#[tokio::test]
async fn draft_publish_conflicts_and_persistence_leave_old_pagination_immutable() {
    let path = std::env::temp_dir().join(format!("curation-{}.sqlite3",token()));
    let s = store::Store::open(path.clone()).unwrap();
    s.create_device("tv".into(),"TV".into(),"".into(),store::hash("device")).await.unwrap();
    s.run(|db| { let mut d=document();store(db,&d)?;publish_rows(db,&mut d) }).await.unwrap();
    let app=App {store:s.clone(),feed:Arc::new(Feed::disabled()),admin_hash:Arc::new(store::hash("owner")),secure_cookie:false,timezone:chrono_tz::UTC};
    edit(&app,"test".into(),Change {revision:0,generation:1,edits:edits()},false).await.unwrap();
    s.read(|db| {
        let d=load(db,"test")?;
        assert_ne!(d.draft,d.published);
        let rows:String=db.query_row("SELECT rows FROM curated_versions WHERE feed='test' AND version=1",[],|r|r.get(0))?;
        assert_eq!(decode::<Vec<Row>>(&rows)?[0].items[1].video_id.as_deref(),Some("bbbbbbbbbbb"));
        Ok(())
    }).await.unwrap();
    assert_eq!(edit(&app,"test".into(),Change {revision:0,generation:1,edits:edits()},true).await.err().unwrap().0,StatusCode::CONFLICT);
    edit(&app,"test".into(),Change {revision:1,generation:1,edits:edits()},true).await.unwrap();
    let reopened=store::Store::open(path.clone()).unwrap();
    reopened.read(|db| {
        let d=load(db,"test")?;
        assert_eq!(d.version,2);
        assert_eq!(d.draft,d.published);
        let count:i64=db.query_row("SELECT count(*) FROM curated_versions",[],|r|r.get(0))?;
        assert_eq!(count,2);
        Ok(())
    }).await.unwrap();
    let rows:Vec<_>=(0..10).map(|i| Row {id:i.to_string(),title:i.to_string(),items:(0..30).map(|j|card(&format!("{j:011}"))).collect(),next:None}).collect();
    let first=page(&rows,"test",1,None).unwrap();
    assert_eq!(first["rows"].as_array().unwrap().len(),8);
    let c:CachedCursor=serde_json::from_slice(&URL_SAFE_NO_PAD.decode(first["rows"][0]["next"].as_str().unwrap()).unwrap()).unwrap();
    let second=page(&rows,"test",1,Some(c)).unwrap();
    assert_eq!(second["rows"][0]["items"][0]["videoId"],"00000000012");
    assert_eq!(second["snapshotVersion"],1);
    drop(app);drop(s);drop(reopened);
    let _=std::fs::remove_file(path);
}

#[tokio::test]
async fn device_cache_hits_need_no_upstream_and_owner_routes_reject_device_keys() {
    let path=std::env::temp_dir().join(format!("curation-api-{}.sqlite3",token()));
    let s=store::Store::open(path.clone()).unwrap();
    s.create_device("tv".into(),"TV".into(),"".into(),store::hash("device")).await.unwrap();
    let id=store::hash(&encode(&(Some("tv"),"account","","home","en","CH")).unwrap());
    let expected=id.clone();
    s.run(move |db| {let mut d=document();d.id=id;store(db,&d)?;publish_rows(db,&mut d)}).await.unwrap();
    let app=crate::router(App {store:s.clone(),feed:Arc::new(Feed::new(Some(Rules::default()),"http://127.0.0.1:1".into())),
        admin_hash:Arc::new(store::hash("owner")),secure_cookie:false,timezone:chrono_tz::UTC},".".into());
    let response=app.clone().oneshot(axum::http::Request::builder().method("POST").uri("/api/device/home")
        .header("Authorization","Bearer device").header("Content-Type","application/json")
        .body(Body::from(r#"{"accountKey":"account"}"#)).unwrap()).await.unwrap();
    assert_eq!(response.status(),StatusCode::OK);
    let value:Value=serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value["feedId"],expected);
    assert_eq!(value["rows"][0]["items"][0]["videoId"],"aaaaaaaaaaa");
    for path in ["/api/curation".to_string(),format!("/api/curation/{expected}")] {
        let response=app.clone().oneshot(axum::http::Request::builder().uri(path).header("Authorization","Bearer device").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(),StatusCode::UNAUTHORIZED);
    }
    let foreign=cursor("foreign-account",1,None,0);
    let response=app.oneshot(axum::http::Request::builder().method("POST").uri("/api/device/home")
        .header("Authorization","Bearer device").header("Content-Type","application/json")
        .body(Body::from(json!({"accountKey":"account","cursor":foreign}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(),StatusCode::GONE);
    drop(s);let _=std::fs::remove_file(path);
}

#[tokio::test]
async fn refresh_is_single_flight_token_rotation_keeps_cache_and_failure_keeps_publication() {
    use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
    let calls=Arc::new(AtomicUsize::new(0));
    let fail=Arc::new(AtomicBool::new(false));
    let gate=Arc::new(tokio::sync::Notify::new());
    let entered=Arc::new(tokio::sync::Notify::new());
    let upstream=Router::new().route("/browse",post({
        let calls=calls.clone();let fail=fail.clone();let gate=gate.clone();let entered=entered.clone();
        move |Json(body):Json<Value>| {
            let calls=calls.clone();let fail=fail.clone();let gate=gate.clone();let entered=entered.clone();
            async move {
                assert_eq!(body["browseId"],"FEtopics_music");
                calls.fetch_add(1,Ordering::SeqCst);
                entered.notify_one();
                gate.notified().await;
                if fail.load(Ordering::SeqCst) { return StatusCode::BAD_GATEWAY.into_response(); }
                Json(json!({"contents":{"tvBrowseRenderer":{"content":{"tvSurfaceContentRenderer":{"content":{"sectionListRenderer":{
                    "contents":[{"shelfRenderer":{"title":{"simpleText":"Music"},"content":{"horizontalListRenderer":{"items":[
                        {"gridVideoRenderer":{"videoId":"aaaaaaaaaaa","title":{"simpleText":"A song"}}}
                    ]}}}}]
                }}}}}}})).into_response()
            }
        }
    }));
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address=listener.local_addr().unwrap();
    let task=tokio::spawn(async move {axum::serve(listener,upstream).await.unwrap()});
    let path=std::env::temp_dir().join(format!("refresh-{}.sqlite3",token()));
    let s=store::Store::open(path.clone()).unwrap();
    s.create_device("tv".into(),"TV".into(),"".into(),store::hash("device")).await.unwrap();
    let feed=Arc::new(Feed::new(Some(Rules::default()),format!("http://{address}/browse")));
    let app=crate::router(App {store:s.clone(),feed:feed.clone(),admin_hash:Arc::new(store::hash("owner")),secure_cookie:false,timezone:chrono_tz::UTC},".".into());
    async fn call(app:&Router,auth:&str)->(StatusCode,Value) {
        let response=app.clone().oneshot(axum::http::Request::builder().method("POST").uri("/api/device/home")
            .header("Authorization","Bearer device").header("X-YouTube-Authorization",auth).header("Content-Type","application/json")
            .body(Body::from(r#"{"accountKey":"stable-account","category":"music"}"#)).unwrap()).await.unwrap();
        (response.status(),serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }
    async fn settled(feed:&Feed) {
        tokio::time::timeout(Duration::from_secs(3),async {
            loop {
                if feed.refreshing.lock().unwrap().is_empty() {break;}
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.unwrap();
    }
    assert_eq!(call(&app,"Bearer old").await.0,StatusCode::ACCEPTED);
    entered.notified().await;
    assert_eq!(call(&app,"Bearer old").await.0,StatusCode::ACCEPTED);
    assert_eq!(calls.load(Ordering::SeqCst),1);
    gate.notify_one();
    settled(&feed).await;
    let (status,first)=call(&app,"Bearer rotated").await;
    assert_eq!(status,StatusCode::OK);
    assert_eq!(calls.load(Ordering::SeqCst),1);
    let id=first["feedId"].as_str().unwrap().to_owned();
    let id2=id.clone();
    s.run(move |db| {let mut doc=load(db,&id2)?;doc.next_refresh_at=0;store(db,&doc)}).await.unwrap();
    fail.store(true,Ordering::SeqCst);
    assert_eq!(call(&app,"Bearer rotated").await.1["snapshotVersion"],1);
    entered.notified().await;
    gate.notify_one();
    settled(&feed).await;
    s.read(move |db| {
        let doc=load(db,&id)?;
        assert!(doc.error.is_some());
        assert_eq!(doc.version,1);
        assert!(doc.retry_at>now());
        let text=encode(&doc)?;
        assert!(!text.contains("Bearer"));
        Ok(())
    }).await.unwrap();
    assert_eq!(call(&app,"Bearer rotated").await.1["rows"],first["rows"]);
    assert_eq!(calls.load(Ordering::SeqCst),2);
    task.abort();drop(app);drop(s);
    let _=std::fs::remove_file(path);
}

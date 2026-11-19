use super::*;
use axum::{body::Body, http::Request as HttpRequest};
use http_body_util::BodyExt;
use tower::ServiceExt;

fn video(id: &str, channel: &str) -> Value {
    json!({"tileRenderer":{
        "contentType":"TILE_CONTENT_TYPE_VIDEO",
        "onSelectCommand":{"watchEndpoint":{"videoId":id}},
        "onLongPressCommand":{"showMenuCommand":{"menu":{"menuRenderer":{"items":[{
            "menuNavigationItemRenderer":{"navigationEndpoint":{"browseEndpoint":{"browseId":channel}}}
        }]}}}},
        "metadata":{"tileMetadataRenderer":{"title":{"simpleText":format!("Video {id}")},"lines":[]}},
        "header":{"tileHeaderRenderer":{"thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/example.jpg","width":320}]},
            "thumbnailOverlays":[{"thumbnailOverlayTimeStatusRenderer":{"text":{"simpleText":"12:34"},"style":"DEFAULT"}}]}}
    }})
}
fn cont(key: &str) -> Value { json!([{"nextContinuationData":{"continuation":key}}]) }
fn shelf(title: &str, cards: Vec<Value>, key: &str) -> Value {
    json!({"shelfRenderer":{"headerRenderer":{"shelfHeaderRenderer":{"avatarLockup":{"avatarLockupRenderer":{"title":{"runs":[{"text":title}]}}}}},"content":{"horizontalListRenderer":{"items":cards,"continuations":cont(key)}}}})
}
fn home_fixture() -> Value {
    json!({"responseContext":{"visitorData":"visitor-from-youtube"},"contents":{"tvBrowseRenderer":{"content":{"tvSurfaceContentRenderer":{"content":{"sectionListRenderer":{
        "contents":[shelf("Recommended",vec![video("keep-video","keep-channel"),video("blocked-video","keep-channel"),video("channel-video","blocked-channel"),video("added-video","keep-channel")],"row-page")],
        "continuations":cont("section-page")
    }}}}}}})
}
fn request(cursor: Option<String>) -> Request {
    Request { account_key:"test-account".into(), category:"home".into(), language:"de".into(), country:"CH".into(), utc_offset_minutes:60, visitor_data:"initial-visitor".into(), cursor }
}
fn rules() -> Rules {
    Rules {
        insertions:vec![Card { video_id:Some("added-video".into()), title:"Our addition".into(), ..Default::default() }],
        blocked_videos:vec!["blocked-video".into()], blocked_channels:vec!["blocked-channel".into()],
    }
}

#[test]
fn tv_parser_preserves_shelves_and_distinguishes_both_pagination_levels() {
    let p = youtube::parse(&home_fixture(),false).unwrap();
    assert_eq!(p.rows.len(),1);
    assert_eq!(p.rows[0].title,"Recommended");
    assert_eq!(p.rows[0].items.len(),4);
    assert_eq!(p.rows[0].items[0].channel_id.as_deref(),Some("keep-channel"));
    assert_eq!(p.rows[0].items[0].badge.as_deref(),Some("12:34"));
    assert_eq!(p.rows[0].next.as_deref(),Some("row-page"));
    assert_eq!(p.next.as_deref(),Some("section-page"));
    assert!(youtube::parse(&json!({"contents":{"feedNudgeRenderer":{}}}),false).is_err());
    assert!(youtube::parse(&json!({"unexpected":"format"}),false).is_err());
}

#[tokio::test]
async fn gateway_fetches_composes_and_scopes_continuations_without_forwarding_device_credentials() {
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let recorded = calls.clone();
    let upstream = Router::new().route("/browse", post(move |headers: HeaderMap, Json(body): Json<Value>| {
        let recorded = recorded.clone();
        async move {
            assert_eq!(headers["authorization"],"Bearer youtube-access");
            assert_eq!(headers["x-goog-pageid"],"youtube-profile");
            assert!(!headers.contains_key("cookie"));
            assert!(!headers.contains_key("x-youtube-authorization"));
            recorded.lock().unwrap().push(body.clone());
            Json(match body["continuation"].as_str() {
                Some("row-page") => json!({"continuationContents":{"horizontalListContinuation":{
                    "items":[video("blocked-video","keep-channel"),video("row-next","keep-channel")],"continuations":cont("row-last")
                }}}),
                Some("section-page") => json!({"continuationContents":{"sectionListContinuation":{
                    "contents":[shelf("Second row",vec![video("second-video","keep-channel")],"second-next")]
                }}}),
                _ => home_fixture(),
            })
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener,upstream).await.unwrap() });
    let path = std::env::temp_dir().join(format!("owntube-feed-{}.sqlite3",token()));
    let store = store::Store::open(path.clone()).unwrap();
    store.create_device("tv".into(),"TV".into(),"".into(),store::hash("device-key")).await.unwrap();
    store.create_device("other".into(),"Other".into(),"".into(),store::hash("other-key")).await.unwrap();
    let feed = Arc::new(Feed::new(Some(rules()),format!("http://{address}/browse")));
    let app = Router::new().route("/api/device/home", post(super::upstream_home)).with_state(App { store:store.clone(),feed:feed.clone(),admin_hash:Arc::new(store::hash("owner")),secure_cookie:false,timezone:chrono_tz::UTC });
    async fn call(app: &Router, key: &str, cursor: Option<String>) -> (StatusCode,Value) {
        let response = app.clone().oneshot(HttpRequest::builder().method("POST").uri("/api/device/home")
            .header("Authorization",format!("Bearer {key}")).header("X-YouTube-Authorization","Bearer youtube-access")
            .header("X-YouTube-Page-Id","youtube-profile").header("Content-Type","application/json")
            .header("Cookie","must-not-reach-youtube")
            .body(Body::from(json!({"language":"de","country":"CH","utcOffsetMinutes":60,"visitorData":"initial-visitor","cursor":cursor}).to_string())).unwrap()).await.unwrap();
        (response.status(),serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap())
    }
    assert_eq!(call(&app,"wrong",None).await.0,StatusCode::UNAUTHORIZED);
    assert!(calls.lock().unwrap().is_empty());
    let (status,first) = call(&app,"device-key",None).await;
    assert_eq!(status,StatusCode::OK);
    assert_eq!(first["rows"][0]["items"][0]["videoId"],"added-video");
    assert_eq!(first["rows"][1]["items"].as_array().unwrap().len(),1);
    assert_eq!(first["rows"][1]["items"][0]["videoId"],"keep-video");
    let row_cursor = first["rows"][1]["next"].as_str().unwrap().to_string();
    assert_ne!(row_cursor,"row-page");
    assert_eq!(call(&app,"other-key",Some(row_cursor.clone())).await.0,StatusCode::GONE);
    let (_,row) = call(&app,"device-key",Some(row_cursor.clone())).await;
    assert_eq!(row["rows"][0]["id"],first["rows"][1]["id"]);
    assert_eq!(row["rows"][0]["title"],"Recommended");
    assert_eq!(row["rows"][0]["items"][0]["videoId"],"row-next");
    assert_eq!(row["rows"][0]["items"].as_array().unwrap().len(),1);
    let (_,second) = call(&app,"device-key",Some(first["next"].as_str().unwrap().into())).await;
    assert_eq!(second["rows"].as_array().unwrap().len(),1);
    assert_eq!(second["rows"][0]["title"],"Second row");
    let calls = calls.lock().unwrap();
    assert_eq!(calls[0]["browseId"],"default");
    assert_eq!(calls[0]["context"]["client"]["acceptLanguage"],"de");
    assert_eq!(calls[1]["continuation"],"row-page");
    assert_eq!(calls[1]["context"]["client"]["visitorData"],"visitor-from-youtube");
    drop(calls);
    feed.cursors.lock().unwrap().get_mut(&row_cursor).unwrap().created = Instant::now() - TTL;
    assert_eq!(call(&app,"device-key",Some(row_cursor)).await.0,StatusCode::GONE);
    store.revoke_device("tv".into()).await.unwrap();
    assert_eq!(call(&app,"device-key",None).await.0,StatusCode::UNAUTHORIZED);
    task.abort();
    drop(app); drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn channel_avatar_scheme_relative_urls_are_preserved_as_https() {
    // Shape from the recorded TV "Top channels you watch" shelf.
    let channel = |url: &str| json!({"tileRenderer":{
        "contentType":"TILE_CONTENT_TYPE_CHANNEL",
        "onSelectCommand":{"browseEndpoint":{"browseId":"UCchannel"}},
        "metadata":{"tileMetadataRenderer":{"title":{"simpleText":"A channel"}}},
        "header":{"tileHeaderRenderer":{"thumbnail":{"thumbnails":[
            {"url":"//yt3.googleusercontent.com/avatar=s88","width":88},
            {"url":url,"width":176}
        ]}}}
    }});
    let parse = |url: &str| youtube::parse(&json!({"continuationContents":{"horizontalListContinuation":{
        "items":[channel(url)]
    }}}), true).unwrap().rows.remove(0).items.remove(0);
    let avatar = parse("//yt3.googleusercontent.com/avatar=s176");
    assert_eq!(avatar.thumbnail.as_deref(), Some("https://yt3.googleusercontent.com/avatar=s176"));
    assert_eq!(avatar.channel_id.as_deref(), Some("UCchannel"));
    assert!(avatar.video_id.is_none());
    assert_eq!(parse("https://yt3.googleusercontent.com/avatar=s176").thumbnail, avatar.thumbnail);
    assert!(parse("javascript:bad").thumbnail.is_none());
    assert!(parse("http://example.com/avatar").thumbnail.is_none());
}

#[test]
fn explicit_blocks_win_and_filtered_pages_keep_their_continuation() {
    let mut rules = rules();
    rules.blocked_videos.push("added-video".into());
    assert!(!rules.allowed(&rules.insertions[0]));
    assert!(rules.validate().is_ok());
    let mut cards = vec![Card { video_id:Some("blocked-video".into()), ..Default::default() }];
    rules.filter(&mut cards);
    assert!(cards.is_empty());
    let parsed = youtube::parse(&json!({"continuationContents":{"horizontalListContinuation":{"items":[],"continuations":cont("more")}}}),true).unwrap();
    assert_eq!(parsed.rows[0].next.as_deref(),Some("more"));
}

#[tokio::test]
async fn disabled_feed_and_foreign_account_cursors_never_call_youtube() {
    let feed = Feed::disabled();
    assert_eq!(feed.home("device".into(),request(None),&HeaderMap::new()).await.err().unwrap().0,StatusCode::SERVICE_UNAVAILABLE);
    let feed = Feed::new(Some(Rules::default()),"http://127.0.0.1:1".into());
    let cursor = feed.cursor(Some("upstream".into()),"account-a",&request(None),None,&[]).unwrap();
    assert_eq!(feed.home("account-b".into(),request(cursor),&HeaderMap::new()).await.err().unwrap().0,StatusCode::GONE);
    assert!(feed.cursor(Some("upstream".into()),"account-a",&request(None),None,&[store::hash("upstream")]).is_err());
}

#[test]
#[ignore = "requires the pinned Android MediaServiceCore fixture checkout"]
fn recorded_upstream_home_preserves_row_titles_cards_and_pagination() {
    let root = std::path::Path::new("../apps/android/MediaServiceCore/youtubeapi/src/test/resources/browse/tv");
    for (file, expected) in [("2025.07.30_home.json", 3), ("2025.07.30_home_continuation.json", 4), ("2025.07.25_home_continuation.json", 5)] {
        let value: Value = serde_json::from_slice(&std::fs::read(root.join(file)).unwrap()).unwrap();
        let page = youtube::parse(&value, false).unwrap();
        assert_eq!(page.rows.len(), expected, "{file}");
        assert_eq!(page.next.is_some(), file != "2025.07.25_home_continuation.json", "{file}");
        assert!(page.rows.iter().any(|r| !r.items.is_empty()), "{file}");
        if file == "2025.07.30_home.json" {
            assert_eq!(page.rows[0].title, "Recommended");
            assert_eq!(page.rows[1].title, "Shorts");
            assert_eq!(page.rows.iter().map(|r| r.items.len()).collect::<Vec<_>>(), vec![5,8,2]);
            assert_eq!(page.rows[0].items[0].video_id.as_deref(), Some("K3nvny5x47w"));
            assert!(page.rows[0].next.is_some());
            assert!(page.rows[1].items.iter().all(|i| i.is_shorts));
        }
        println!("{file}: {} rows, {} cards",page.rows.len(),page.rows.iter().map(|r| r.items.len()).sum::<usize>());
    }
}

use super::*;
use super::super::tests::{card, document as base_document};

fn document() -> Document {
    let mut d=base_document();
    d.source[0].items.extend((3..10).map(|i|card(&format!("{i:011}"))));
    d.german.settings.replacement_positions=vec![1,2,3];
    d
}

fn candidate(original: &str, replacement: &str, channel: &str) -> Match {
    Match {original:original.into(),original_card:None,replacement:Card {channel_id:Some(channel.into()),..card(replacement)},
        original_duration:600.,duration:650.,topic:95,intent:95,depth:90,quality:90,
        reason:"First eligible translated-title search result; language is an estimate.".into(),
        evidence:Evidence {basis:"title-search-audio".into(),source_language:"en".into(),query:"Werkstatt bauen".into(),search_rank:1,
            audio_language:"de".into(),audio_checked_at:now(),asr_language:String::new(),original_production:true,
            transcript_excerpt:String::new(),chapters:vec![],
            description_excerpt:"Das ist eine ausführliche Erklärung des Themas mit praktischen Beispielen und nachvollziehbaren Schritten.".into(),checked_at:now()}}
}

#[test]
fn whole_home_target_counts_native_and_excluded_rows_without_forcing_weak_matches() {
    let mut d=document();
    d.source=(0..4).map(|i| Row {id:format!("row-{i}"),title:format!("Row {i}"),
        items:(0..10).map(|j|card(&format!("{:011}",i*10+j))).collect(),next:None}).collect();
    d.german.settings.enabled=true;
    d.german.settings.replacement_positions=vec![1,2,3,4,5];
    d.german.settings.excluded_rows.push("row-0".into());
    d.german.native_originals.push("00000000000".into());
    // Forty source cards -> target twelve, one title estimate -> eleven alternatives.
    d.german.matches=(0..40).map(|i| candidate(&format!("{i:011}"),&format!("{:011}",i+100),&format!("UC{i}"))).collect();
    let (rows,selected,total,native)=selection(&d,&d.published);
    assert_eq!((total,native,selected.len()),(51,1,11));
    assert_eq!(rows[0].items,d.source[0].items);
    assert!(rows[1].items.iter().any(|c|c.video_id.as_deref()==Some("00000000110")));
    // No row-title dependency: every Home row is eligible.
    d.german.settings.target_percent=100;
    for m in &mut d.german.matches {m.evidence.basis="metadata".into();}
    assert!(selection(&d,&d.published).1.is_empty());
    assert_eq!(selection(&d,&d.published).0[1].items,d.source[1].items);
}

#[test]
fn title_evidence_duration_format_duplicates_creator_limits_and_pins_are_hard_rules() {
    let mut d=document();
    d.german.settings.enabled=true;
    d.german.settings.target_percent=100;
    d.german.settings.creator_limit=1;
    let a=candidate("aaaaaaaaaaa","ddddddddddd","creator");
    let b=candidate("bbbbbbbbbbb","eeeeeeeeeee","creator");
    d.german.matches=vec![a.clone(),b.clone()];
    assert_eq!(selection(&d,&d.published).1.len(),1);
    d.german.settings.pinned_originals.push(a.original.clone());
    assert_eq!(selection(&d,&d.published).1[0].original,b.original);
    d.german.settings.blocked_channels.push("creator".into());
    assert!(selection(&d,&d.published).1.is_empty());
    d.german.settings=Settings {enabled:true,target_percent:100,replacement_positions:vec![1,2,3],..Default::default()};
    d.source[0].items.push(card("ddddddddddd"));
    d.german.matches=vec![a.clone()];
    assert!(selection(&d,&d.published).1.is_empty());
    d.source[0].items.pop();
    d.published.removed.push("video:ddddddddddd".into());
    assert!(selection(&d,&d.published).1.is_empty());
    d.published.removed.clear();
    for invalid in 0..11 {
        let mut m=a.clone();
        match invalid {
            0=>m.evidence.transcript_excerpt="Transcripts must not be used".into(),
            1=>m.evidence.source_language="de".into(),
            2=>m.evidence.search_rank=0,
            3=>m.duration=1800.,
            4=>m.evidence.checked_at=now()-31*86_400_000,
            5=>m.evidence.query=String::new(),
            6=>m.evidence.audio_language="en".into(),
            7=>m.evidence.audio_language=String::new(),
            8=>m.evidence.original_production=false,
            9=>m.evidence.audio_checked_at=now()-31*86_400_000,
            _=>m.evidence.basis="title-search".into(),
        }
        d.german.matches=vec![m];
        assert!(selection(&d,&d.published).1.is_empty());
    }
    let mut shorts=a.clone();shorts.replacement.is_shorts=true;
    d.german.matches=vec![shorts];
    assert!(selection(&d,&d.published).1.is_empty());
    // Duplicate originals across shelves must not produce duplicate replacements.
    d.german.matches=vec![a];
    let mut row=d.source[0].clone();row.id="another".into();d.source.push(row);
    assert_eq!(selection(&d,&d.published).1.len(),1);
}

#[tokio::test]
async fn jobs_publish_atomically_preserve_drafts_and_lose_to_newer_owner_decisions() {
    let path=std::env::temp_dir().join(format!("german-{}.sqlite3",token()));
    let s=store::Store::open(path.clone()).unwrap();
    s.create_device("tv".into(),"TV".into(),"".into(),store::hash("device")).await.unwrap();
    s.run(|db| {
        let mut d=document();
        d.german.settings.enabled=true;
        d.german.settings.pinned_originals.push("ccccccccccc".into());
        d.german.fill_pending=true;
        d.draft.removed.push("video:bbbbbbbbbbb".into());
        store(db,&d)?;
        publish_rows(db,&mut d)?;
        let initial=d.clone();
        let output=|| Ok(Output {matches:vec![candidate("aaaaaaaaaaa","ddddddddddd","creator")],
            native_originals:vec![],report:json!({"checked":3})});
        // Stale jobs never overwrite a newly saved control or source snapshot.
        d.revision+=1;store(db,&d)?;
        assert!(complete(db,"test",&initial,output())?);
        assert_eq!(load(db,"test")?.version,1);
        let current=load(db,"test")?;
        assert!(!complete(db,"test",&current,Err(upstream_error("Provider unavailable")))?);
        assert_eq!(load(db,"test")?.version,1);
        assert!(load(db,"test")?.german.error.is_some());
        assert!(load(db,"test")?.german.fill_pending);
        assert!(!complete(db,"test",&current,output())?);
        let saved=load(db,"test")?;
        assert_eq!(saved.version,2);
        assert_eq!(saved.draft.removed,vec!["video:bbbbbbbbbbb"]);
        assert_eq!(saved.german.settings.pinned_originals,vec!["ccccccccccc"]);
        assert_eq!(saved.german.undo_version,Some(1));
        assert_eq!(saved.german.publication.selected.len(),1);
        assert!(!saved.german.fill_pending);
        for (version,index,expected) in [(1,0,"aaaaaaaaaaa"),(2,0,"ddddddddddd")] {
            let rows:String=db.query_row("SELECT rows FROM curated_versions WHERE feed='test' AND version=?",[version],|r|r.get(0))?;
            let rows:Vec<Row>=decode(&rows)?;
            assert_eq!(page(&rows,"test",version,None)?["rows"][0]["items"][index]["videoId"],expected);
        }
        Ok(())
    }).await.unwrap();
    let reopened=store::Store::open(path.clone()).unwrap();
    reopened.read(|db| {
        let d=load(db,"test")?;
        assert!(d.german.settings.enabled);
        assert_eq!(d.german.matches.len(),1);
        assert_eq!(d.german.publication.total,11);
        Ok(())
    }).await.unwrap();
    s.add_session(store::hash("session")).await.unwrap();
    let app=App {store:s.clone(),feed:Arc::new(Feed::disabled()),admin_hash:Arc::new(store::hash("owner")),secure_cookie:false,timezone:chrono_tz::UTC};
    let mut headers=HeaderMap::new();headers.insert(header::COOKIE,"observer_session=session".parse().unwrap());
    assert_eq!(undo(axum::extract::State(app.clone()),headers.clone(),Path("test".into()),Json(Version {revision:0,generation:1})).await.err().unwrap().0,StatusCode::CONFLICT);
    let _=undo(axum::extract::State(app),headers,Path("test".into()),Json(Version {revision:1,generation:1})).await.unwrap();
    s.read(|db| {
        let d=load(db,"test")?;
        assert!(!d.german.settings.enabled);
        assert_eq!(d.version,3);
        let rows:String=db.query_row("SELECT rows FROM curated_versions WHERE feed='test' AND version=3",[],|r|r.get(0))?;
        assert_eq!(decode::<Vec<Row>>(&rows)?[0].items[0].video_id.as_deref(),Some("aaaaaaaaaaa"));
        assert_eq!(d.draft.removed,vec!["video:bbbbbbbbbbb"]);
        assert!(d.german.publication.selected.is_empty());
        Ok(())
    }).await.unwrap();
    drop(s);drop(reopened);let _=std::fs::remove_file(path);
}

#[test]
fn exact_original_is_retained_only_in_changed_row_without_moving_pins() {
    let mut d=document();
    d.source=vec![Row {id:"row".into(),title:"Workshop".into(),next:None,
        items:(0..20).map(|i|card(&format!("{i:011}"))).collect()}];
    let mut other=d.source[0].clone();other.id="other".into();d.source.push(other);
    d.german.settings.enabled=true;
    d.german.settings.replacement_positions=vec![2,6,9];
    d.german.settings.pinned_originals.push("00000000000".into());
    d.german.matches=vec![candidate("00000000001","ddddddddddd","creator")];
    let (rows,selected,_,_)=selection(&d,&d.published);
    assert_eq!(selected.len(),1);
    assert_eq!(rows[0].items[0].video_id.as_deref(),Some("00000000000"));
    assert_eq!(rows[0].items[1].video_id.as_deref(),Some("ddddddddddd"));
    assert_eq!(rows[0].items[2].video_id.as_deref(),Some("00000000002"));
    assert_eq!(rows[0].items[20].video_id.as_deref(),Some("00000000001"));
    assert_eq!(rows[0].items.len(),21);
    assert_eq!(rows[1].items,d.source[1].items);
    d.published.rows.insert("row".into(),RowEdit {
        order:d.source[0].items.iter().map(card_key).collect(),..Default::default()});
    let rows=selection(&d,&d.published).0;
    assert_eq!(rows[0].items[2].video_id.as_deref(),Some("00000000002"));
    assert_eq!(rows[0].items[1].video_id.as_deref(),Some("ddddddddddd"));
    d.published.card_limit=Some(20);
    let full=selection(&d,&d.published);
    assert_eq!(full.1.len(),1);
    assert_eq!(full.0[0].items.len(),20);
    assert_eq!(full.0[0].items[19].video_id.as_deref(),Some("00000000001"));
    d.german.settings.pinned_originals.extend((10..20).map(|i|format!("{i:011}")));
    assert!(selection(&d,&d.published).1.is_empty());
    d.published.card_limit=Some(9);
    assert!(selection(&d,&d.published).1.is_empty());
}

#[test]
fn exact_positions_never_spill_into_the_tail_and_row_overrides_win() {
    let mut d=document();
    d.source=vec![Row {id:"row".into(),title:"Workshop".into(),next:None,
        items:(0..20).map(|i|card(&format!("{i:011}"))).collect()}];
    d.german.settings.enabled=true;
    d.german.settings.replacement_positions=vec![2,6,9];
    d.german.matches=(0..20).map(|i|candidate(&format!("{i:011}"),&format!("{:011}",i+100),&format!("UC{i}"))).collect();
    let (rows,selected,_,_)=selection(&d,&d.published);
    assert_eq!(selected.len(),3);
    let ids:HashSet<_>=selected.iter().filter_map(|m|m.replacement.video_id.clone()).collect();
    assert_eq!(rows[0].items.iter().take(10).enumerate().filter(|(_,c)|c.video_id.as_ref().is_some_and(|id|ids.contains(id)))
        .map(|(i,_)|i).collect::<Vec<_>>(),vec![1,5,8]);
    let expected:Vec<_>=d.source[0].items.iter().enumerate().filter(|(i,_)|![1,5,8].contains(i)).map(|(_,c)|c.clone())
        .chain([1,5,8].into_iter().map(|i|d.source[0].items[i].clone())).collect();
    assert_eq!(rows[0].items.iter().filter(|c|!ids.contains(c.video_id.as_ref().unwrap())).cloned().collect::<Vec<_>>(),expected);
    assert!(rows[0].items.iter().skip(10).all(|c|!ids.contains(c.video_id.as_ref().unwrap())));
    assert_eq!(selected[0].original_card.as_ref(),Some(&d.source[0].items[1]));
    d.german.native_originals.push("00000000001".into());
    let rows=selection(&d,&d.published).0;
    assert_eq!(rows[0].items.iter().take(10).filter(|c|ids.contains(c.video_id.as_ref().unwrap())).count(),2);
    assert_eq!(rows[0].items[1].video_id.as_deref(),Some("00000000001"));
    d.german.settings.row_positions.insert("row".into(),vec![4,8]);
    let (rows,selected,_,_)=selection(&d,&d.published);
    assert_eq!(selected.len(),2);
    assert_eq!(rows[0].items[3].video_id.as_deref(),Some("00000000103"));
    assert_eq!(rows[0].items[7].video_id.as_deref(),Some("00000000107"));
    d.german.settings.row_positions.insert("row".into(),vec![]);
    assert!(selection(&d,&d.published).1.is_empty());
    let mut other=d.source[0].clone();other.id="other".into();d.source.push(other);
    d.german.settings.row_positions.insert("other".into(),vec![4,8]);
    let (rows,selected,_,_)=selection(&d,&d.published);
    assert_eq!(selected.len(),2);
    assert_eq!(rows[0].items,d.source[0].items);
}

#[tokio::test]
async fn all_mix_controls_require_owner_authentication() {
    use axum::body::Body;
    use tower::ServiceExt;
    let path=std::env::temp_dir().join(format!("german-auth-{}.sqlite3",token()));
    let s=store::Store::open(path.clone()).unwrap();
    let router=crate::router(App {store:s,feed:Arc::new(Feed::disabled()),admin_hash:Arc::new(store::hash("owner")),
        secure_cookie:false,timezone:chrono_tz::UTC},".".into());
    for (method,url,body) in [
        ("PUT","/api/curation/test/german",json!({"revision":0,"generation":0,"settings":{}})),
        ("POST","/api/curation/test/german/run",json!({})),
        ("POST","/api/curation/test/german/fill",json!({"revision":0,"generation":0})),
        ("POST","/api/curation/test/german/undo",json!({"revision":0,"generation":0})),
        ("PUT","/api/curation/deepseek-key",json!({"key":"sk-0123456789abcdef0123"})),
        ("DELETE","/api/curation/deepseek-key",json!({})),
    ] {
        let response=router.clone().oneshot(axum::http::Request::builder().method(method).uri(url)
            .header("Authorization","Bearer device").header("Content-Type","application/json")
            .body(Body::from(body.to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status(),StatusCode::UNAUTHORIZED);
    }
    drop(router);let _=std::fs::remove_file(path);
}

#[test]
fn saved_key_is_validated_private_and_atomically_replaced() {
    assert!(valid_key("sk-0123456789abcdef0123"));
    for bad in ["", "short", "sk-0123456789 abcdef0123", &"x".repeat(201), "sk-0123456789abcdéf0123"] {
        assert!(!valid_key(bad), "{bad:?}");
    }
    let dir=std::env::temp_dir().join(format!("deepseek-key-{}",token()));
    std::fs::create_dir(&dir).unwrap();
    let path=dir.join("deepseek-api-key");
    write_key(&path,"sk-first-key-0123456789").unwrap();
    write_key(&path,"sk-second-key-0123456789").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(),"sk-second-key-0123456789");
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode()&0o777,0o600);
    }
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(),1,"no temporary files remain");
    let _=std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn key_check_distinguishes_rejected_keys_from_unavailable_provider() {
    let upstream=Router::new().route("/models",axum::routing::get(|headers:HeaderMap| async move {
        match headers.get("authorization").and_then(|v|v.to_str().ok()) {
            Some("Bearer sk-good-key-0123456789") => StatusCode::OK,
            Some("Bearer sk-down-key-0123456789") => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::UNAUTHORIZED,
        }
    }));
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base=format!("http://{}",listener.local_addr().unwrap());
    let task=tokio::spawn(async move {axum::serve(listener,upstream).await.unwrap()});
    assert!(verify_key(&base,"sk-good-key-0123456789").await.is_ok());
    assert_eq!(verify_key(&base,"sk-bad-key-0123456789").await.err().unwrap().0,StatusCode::UNPROCESSABLE_ENTITY);
    assert_ne!(verify_key(&base,"sk-down-key-0123456789").await.err().unwrap().0,StatusCode::UNPROCESSABLE_ENTITY);
    task.abort();
    assert!(verify_key("http://127.0.0.1:1","sk-good-key-0123456789").await.is_err());
}

#[tokio::test]
async fn failed_mix_publishes_newer_source_once_and_never_freezes_home() {
    let path=std::env::temp_dir().join(format!("german-freeze-{}.sqlite3",token()));
    let s=store::Store::open(path.clone()).unwrap();
    s.create_device("tv".into(),"TV".into(),"".into(),store::hash("device")).await.unwrap();
    let mut d=document();
    d.german.settings.enabled=true;
    s.run({let mut d=d.clone();move |db| {store(db,&d)?;publish_rows(db,&mut d)}}).await.unwrap();
    // A refresh stored a newer source but the mix failed: publish it anyway.
    let refreshed=s.run(|db| {let mut d=load(db,"test")?;d.cached_at=Some(d.published_at.unwrap()+1);d.generation+=1;store(db,&d)?;Ok(d)}).await.unwrap();
    let missing=Err(invalid(MISSING_KEY));
    s.run({let r=refreshed.clone();move |db| complete(db,"test",&r,missing)}).await.unwrap();
    let after=s.read(|db| load(db,"test")).await.unwrap();
    assert_eq!(after.version,refreshed.version+1,"newer source published despite the failed mix");
    assert_eq!(after.german.error.as_deref(),Some(MISSING_KEY));
    // A repeated failure without newer source does not create another version.
    s.run({let a=after.clone();move |db| complete(db,"test",&a,Err(invalid(MISSING_KEY)))}).await.unwrap();
    assert_eq!(s.read(|db| load(db,"test")).await.unwrap().version,after.version);
    // Only an enabled, runnable Home mix may hold back a refreshed publication.
    let mut held=after.clone();
    held.german.retry_at=now()+60_000;
    assert!(!defer_to_mix(&held));
    held.german.retry_at=0;held.category="music".into();
    assert!(!defer_to_mix(&held));
    held.category="home".into();held.german.settings.enabled=false;
    assert!(!defer_to_mix(&held));
    held.german.settings.enabled=true;
    assert_eq!(defer_to_mix(&held),configured());
    drop(s);let _=std::fs::remove_file(path);
}

#[test]
fn a_new_key_lifts_only_the_missing_key_pause() {
    let mut d=document();
    for old in [MISSING_KEY,"Set DEEPSEEK_API_KEY or DEEPSEEK_API_KEY_FILE on the server to start matching."] {
        d.german.error=Some(old.into());d.german.retry_at=now()+WINDOW;
        assert!(!clear_missing_key(&mut d,false),"still no key: keep the pause");
        assert!(clear_missing_key(&mut d,true));
        assert_eq!((d.german.error.as_deref(),d.german.retry_at),(None,0));
    }
    d.german.error=Some("DeepSeek rate limit".into());d.german.retry_at=now()+WINDOW;
    assert!(!clear_missing_key(&mut d,true),"other provider errors keep their cooldown");
}

#[test]
fn settings_bounds_and_existing_documents_remain_compatible() {
    let mut s=Settings::default();
    assert_eq!(s.target_percent,30);
    assert_eq!(s.search_budget,12);
    assert_eq!(s.replacement_positions,vec![2,6,9]);
    assert!(validate_settings(&s).is_ok());
    s.search_budget=0;assert!(validate_settings(&s).is_err());
    s.search_budget=51;assert!(validate_settings(&s).is_err());
    s.search_budget=12;
    s.row_positions.insert("row".into(),vec![2,2]);assert!(validate_settings(&s).is_err());
    s.row_positions.insert("row".into(),vec![0]);assert!(validate_settings(&s).is_err());
    s.row_positions.insert("row".into(),vec![49]);assert!(validate_settings(&s).is_err());
    s.row_positions.insert("row".into(),vec![]);assert!(validate_settings(&s).is_ok());
    s.target_percent=101;assert!(validate_settings(&s).is_err());
    s.target_percent=30;s.creator_limit=0;assert!(validate_settings(&s).is_err());
    let mut value=serde_json::to_value(document()).unwrap();
    value.as_object_mut().unwrap().remove("german");
    let d:Document=serde_json::from_value(value).unwrap();
    assert!(!d.german.settings.enabled);
}

#[test]
fn title_mode_clears_only_obsolete_cooldown_and_preserves_owner_rules() {
    let mut d=document();
    d.german.settings.enabled=true;
    d.german.settings.pinned_originals.push("aaaaaaaaaaa".into());
    d.german.retry_at=now()+3_600_000;
    d.german.error=Some("YouTube is rate-limiting transcript access.".into());
    d.german.undo_version=Some(5);
    let mut legacy=candidate("aaaaaaaaaaa","ddddddddddd","creator");
    legacy.evidence.basis="title-search".into();
    d.german.matches.push(legacy);
    assert!(title_mode(&mut d));
    assert!(d.german.matches.is_empty());
    assert!(d.german.undo_version.is_none());
    assert_eq!(d.german.retry_at,0);
    assert!(d.german.error.is_none());
    assert!(d.german.settings.enabled);
    assert_eq!(d.german.settings.pinned_originals,vec!["aaaaaaaaaaa"]);
    assert!(!title_mode(&mut d));
    d.german.mode=String::new();
    d.german.retry_at=now()+3_600_000;
    d.german.error=Some("DeepSeek is rate-limiting requests.".into());
    assert!(title_mode(&mut d));
    assert!(d.german.retry_at>now());
}

#[tokio::test]
async fn reapplying_saved_rules_does_not_invalidate_running_work_or_publish_again() {
    let path=std::env::temp_dir().join(format!("german-noop-{}.sqlite3",token()));
    let s=store::Store::open(path.clone()).unwrap();
    s.create_device("tv".into(),"TV".into(),"".into(),store::hash("device")).await.unwrap();
    s.add_session(store::hash("session")).await.unwrap();
    s.run(|db| {
        let mut doc=document();
        doc.german.settings.enabled=true;
        store(db,&doc)?;
        publish_rows(db,&mut doc)
    }).await.unwrap();
    let app=App {store:s.clone(),feed:Arc::new(Feed::disabled()),admin_hash:Arc::new(store::hash("owner")),secure_cookie:false,timezone:chrono_tz::UTC};
    app.feed.mixing.lock().unwrap().insert("test".into());
    let mut headers=HeaderMap::new();headers.insert(header::COOKIE,"observer_session=session".parse().unwrap());
    let Json(result)=settings(axum::extract::State(app.clone()),headers,Path("test".into()),
        Json(Change {revision:0,generation:1,settings:Settings {enabled:true,replacement_positions:vec![1,2,3],..Default::default()}})).await.unwrap();
    assert_eq!(result["changed"],false);
    s.read(|db| {
        let doc=load(db,"test")?;
        assert_eq!(doc.revision,0);
        assert_eq!(doc.version,1);
        assert_eq!(doc.generation,1);
        assert!(doc.german.checked_at.is_none());
        Ok(())
    }).await.unwrap();
    assert!(app.feed.mixing.lock().unwrap().contains("test"));
    drop(app);drop(s);let _=std::fs::remove_file(path);
}

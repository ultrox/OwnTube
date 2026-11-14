use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use tower::ServiceExt;

fn approval(code: &str) -> Approval {
    Approval { code:code.into(), label:"Wife's Chrome".into(),person:"Wife".into() }
}

#[tokio::test]
async fn pairing_is_atomic_retryable_private_and_survives_reopen() {
    let path = std::env::temp_dir().join(format!("observer-pair-{}.sqlite3",uuid::Uuid::new_v4()));
    let s = store::Store::open(path.clone()).unwrap();
    let key = crate::token();
    let hash = store::hash(&key);
    let first = s.begin_pairing(hash.clone()).await.unwrap();
    let code = first["code"].as_str().unwrap();
    assert_eq!(first,s.begin_pairing(hash.clone()).await.unwrap());
    assert!(s.device(hash.clone()).await.is_err(),"pending key cannot ingest");
    assert_eq!(s.pairing_status(store::hash("another")).await.unwrap()["state"],"expired");
    let (a,b)=tokio::join!(s.approve_pairing(approval(code)),s.approve_pairing(approval(code)));
    let a=a.unwrap();
    assert_eq!(a,b.unwrap(),"concurrent approval creates exactly one device");
    assert_eq!(a["person"],"Wife");
    assert!(!a.to_string().contains(&key));
    assert_eq!(s.device(hash.clone()).await.unwrap()["deviceId"],a["deviceId"]);
    drop(s);
    let s=store::Store::open(path.clone()).unwrap();
    assert_eq!(s.pairing_status(hash.clone()).await.unwrap(),a);
    s.run(|db| {
        assert_eq!(db.query_row("SELECT count(*) FROM devices",[],|r|r.get::<_,i64>(0))?,1);
        db.execute("DELETE FROM pairing_requests",[])?;
        Ok(())
    }).await.unwrap();
    assert_eq!(s.pairing_status(hash.clone()).await.unwrap(),a,"lost final reply survives cleanup");
    assert_eq!(s.begin_pairing(hash.clone()).await.unwrap(),a,"lost start reply survives approval and cleanup");
    s.revoke_device(a["deviceId"].as_str().unwrap().into()).await.unwrap();
    assert_eq!(s.pairing_status(hash).await.unwrap()["state"],"expired");
    drop(s);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn expiry_invalid_person_and_start_limits_do_not_create_devices() {
    let s=store::Store::open(":memory:".into()).unwrap();
    let hash=store::hash(&crate::token());
    let value=s.begin_pairing(hash.clone()).await.unwrap();
    let code=value["code"].as_str().unwrap();
    let mut bad=approval(code);
    bad.person=uuid::Uuid::new_v4().to_string();
    assert!(s.approve_pairing(bad).await.is_err());
    s.run(|db| { db.execute("UPDATE pairing_requests SET expires=0",[])?; Ok(()) }).await.unwrap();
    assert_eq!(s.pairing_status(hash).await.unwrap()["state"],"expired");
    assert_eq!(s.approve_pairing(approval(code)).await.unwrap_err().0,StatusCode::GONE);
    for _ in 0..20 { s.begin_pairing(store::hash(&crate::token())).await.unwrap(); }
    assert_eq!(s.begin_pairing(store::hash(&crate::token())).await.unwrap_err().0,StatusCode::TOO_MANY_REQUESTS);
    s.read(|db| {
        assert_eq!(db.query_row("SELECT count(*) FROM devices",[],|r|r.get::<_,i64>(0))?,0);
        assert_eq!(db.query_row("SELECT count(*) FROM people",[],|r|r.get::<_,i64>(0))?,0);
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn routes_require_owner_to_approve_and_browser_secret_to_poll() {
    let store=store::Store::open(":memory:".into()).unwrap();
    store.add_session(store::hash("owner-session")).await.unwrap();
    let app=crate::App{store,admin_hash:std::sync::Arc::new(store::hash("owner")),secure_cookie:false,timezone:chrono_tz::UTC};
    let router=crate::router(app,".".into());
    async fn call(r:&axum::Router,path:&str,key:Option<&str>,cookie:bool,body:Value)->(StatusCode,Value) {
        let mut req=Request::builder().method("POST").uri(path).header("content-type","application/json");
        if let Some(key)=key { req=req.header("authorization",format!("Bearer {key}")); }
        if cookie { req=req.header("cookie","observer_session=owner-session"); }
        let response=r.clone().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let status=response.status();
        let value=serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
        (status,value)
    }
    let key=crate::token();
    assert_eq!(call(&router,"/api/pairing/start",Some("1234"),false,json!({})).await.0,StatusCode::UNAUTHORIZED);
    let (status,start)=call(&router,"/api/pairing/start",Some(&key),false,json!({})).await;
    assert_eq!(status,StatusCode::OK);
    let body=json!({"code":start["code"],"label":"Laptop","person":"Wife"});
    assert_eq!(call(&router,"/api/pairing/approve",Some(&key),false,body.clone()).await.0,StatusCode::UNAUTHORIZED);
    assert_eq!(call(&router,"/api/pairing/status",start["code"].as_str(),false,json!({})).await.0,StatusCode::UNAUTHORIZED);
    assert_eq!(call(&router,"/api/pairing/approve",None,true,body).await.0,StatusCode::OK);
    let (_,connected)=call(&router,"/api/pairing/status",Some(&key),false,json!({})).await;
    assert_eq!(connected["state"],"approved");
    assert!(connected.get("token").is_none());
}

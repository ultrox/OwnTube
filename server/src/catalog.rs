//! Local, owner-only source catalog. Reading it never contacts HackerTube or YouTube.
use crate::*;
use rusqlite::{Connection, OptionalExtension, params};

pub fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(include_str!("catalog.sql"))
}

fn metadata(db: &Connection) -> Result<Value> {
    let text: Option<String> = db.query_row("SELECT payload FROM catalog_sources WHERE id='hackertube'",
        [], |r| r.get(0)).optional()?;
    text.map(|text| serde_json::from_str(&text).map_err(|_| invalid("Cannot read catalog metadata")))
        .unwrap_or_else(|| Ok(json!({"id":"hackertube","videoCount":0,"areas":[]})))
}

pub async fn browse(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.read(|db| {
        let mut source = metadata(db)?;
        let mut query = db.prepare("SELECT category,count(*) FROM catalog_categories WHERE source='hackertube' GROUP BY category")?;
        let counts = query.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?)))?
            .collect::<rusqlite::Result<std::collections::HashMap<_,_>>>()?;
        if let Some(areas) = source["areas"].as_array_mut() {
            for area in areas {
                if let Some(categories) = area["categories"].as_array_mut() {
                    for category in categories {
                        category["count"] = json!(counts.get(category["id"].as_str().unwrap_or("")).copied().unwrap_or(0));
                    }
                }
            }
        }
        Ok(source)
    }).await?))
}

#[derive(Default, Deserialize)]
pub struct BrowseQuery {
    #[serde(default)]
    category: String,
    #[serde(default)]
    q: String,
    #[serde(default)]
    offset: usize,
    n: Option<usize>,
}

fn listing(db: &Connection, query: BrowseQuery) -> Result<Value> {
    let n = query.n.unwrap_or(24);
    if !(1..=48).contains(&n) || query.offset > 50000 || query.q.len() > 200 || query.category.len() > 100 {
        return Err(invalid("Invalid catalog filter or page"));
    }
    let category = query.category;
    let search = query.q.trim().to_lowercase();
    let where_sql = "v.source='hackertube' AND (?1='' OR EXISTS(
        SELECT 1 FROM catalog_categories c WHERE c.source=v.source AND c.video=v.video AND c.category=?1
    )) AND (?2='' OR instr(v.search,?2)>0)";
    let total: usize = db.query_row(&format!("SELECT count(*) FROM catalog_videos v WHERE {where_sql}"),
        params![category, search], |r| r.get(0))?;
    let mut statement = db.prepare(&format!("SELECT v.payload FROM catalog_videos v WHERE {where_sql}
        ORDER BY v.score DESC,v.video LIMIT ?3 OFFSET ?4"))?;
    let texts = statement.query_map(params![category, search, n, query.offset], |r| r.get::<_,String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let videos = texts.iter().map(|s| serde_json::from_str::<Value>(s)
        .map_err(|_| invalid("Cannot read catalog video"))).collect::<Result<Vec<_>>>()?;
    let next = (query.offset + videos.len() < total).then_some(query.offset + videos.len());
    Ok(json!({"videos":videos,"total":total,"next":next}))
}

pub async fn videos(State(app): State<App>, headers: HeaderMap, Query(query): Query<BrowseQuery>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.read(move |db| listing(db, query)).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    #[test]
    fn category_search_and_ranked_pages_are_local_and_deterministic() {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        db.execute("INSERT INTO catalog_sources VALUES('hackertube','{}')", []).unwrap();
        for (id, score, title, category) in [("a",10,"rust ownership","software"),("b",20,"rust systems","software"),("c",30,"physics","science")] {
            db.execute("INSERT INTO catalog_videos VALUES('hackertube',?,?,?,?)",
                params![id,score,title,json!({"card":{"videoId":id}}).to_string()]).unwrap();
            db.execute("INSERT INTO catalog_categories VALUES('hackertube',?,?)",params![category,id]).unwrap();
        }
        let query = |offset| BrowseQuery {category:"software".into(),q:"RUST".into(),offset,n:Some(1)};
        let page = listing(&db,query(0)).unwrap();
        assert_eq!(page["total"],2);
        assert_eq!(page["videos"][0]["card"]["videoId"],"b");
        assert_eq!(page["next"],1);
        let page = listing(&db,query(1)).unwrap();
        assert_eq!(page["videos"][0]["card"]["videoId"],"a");
        assert!(page["next"].is_null());
        assert!(listing(&db,BrowseQuery {n:Some(1000),..Default::default()}).is_err());
        assert_eq!(listing(&db,BrowseQuery {q:"%".into(),..Default::default()}).unwrap()["total"],0);
    }

    #[tokio::test]
    async fn catalog_requires_owner_session() {
        let path = std::env::temp_dir().join(format!("catalog-{}.sqlite3", token()));
        let store = store::Store::open(path.clone()).unwrap();
        let app = router(App {store,feed:Arc::new(feed::Feed::disabled()),admin_hash:Arc::new(store::hash("owner")),
            secure_cookie:false,timezone:chrono_tz::UTC},".".into());
        for uri in ["/api/catalog/hackertube","/api/catalog/hackertube/videos"] {
            let response = app.clone().oneshot(axum::http::Request::builder().uri(uri)
                .header("Authorization","Bearer device").body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(),StatusCode::UNAUTHORIZED);
        }
        drop(app);
        let _ = std::fs::remove_file(path);
    }
}

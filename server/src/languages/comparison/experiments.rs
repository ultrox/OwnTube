//! Named experiments own plans only; viewing and classifications remain independent.
use super::*;
use axum::extract::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    name: String,
    source_id: Option<String>,
    base_revision: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    base_revision: i64,
    name: Option<String>,
}

fn name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 120 {
        return Err(invalid("Use an experiment name from 1 to 120 characters"));
    }
    Ok(value.into())
}

fn owner_scope(db: &Connection, scope: &Scope, write: bool) -> Result<()> {
    validate_scope(db, scope)?;
    if scope.person.is_empty() || (write && !scope.device.is_empty()) {
        return Err(invalid("Choose a person. Devices only filter experiment results."));
    }
    Ok(())
}

pub(super) fn stored(db: &Connection, person: &str, id: &str) -> Result<(Value, Config)> {
    let row: Option<(String, i64, String, i64, i64)> = db.query_row(
        "SELECT name,revision,config,created,updated FROM language_experiments WHERE id=? AND person_id=?",
        params![id, person], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let Some((name, revision, text, created, updated)) = row else {
        return Err(Error(StatusCode::NOT_FOUND, "This experiment is no longer available for this person".into()));
    };
    let mut config: Config = decode(&text)?;
    config.base_revision = revision;
    Ok((json!({"id":id,"personId":person,"name":name,"revision":revision,"createdAt":created,"updatedAt":updated}), config))
}

fn revision(config: &Config, expected: i64) -> Result<()> {
    if config.base_revision != expected {
        return Err(conflict("This experiment changed in another browser. Refresh before trying again."));
    }
    Ok(())
}

impl Store {
    pub async fn experiments(&self, scope: Scope, tz: chrono_tz::Tz) -> Result<Value> {
        self.read(move |db| {
            owner_scope(db, &scope, false)?;
            let today = tz.timestamp_millis_opt(now()).unwrap().date_naive().to_string();
            let ids = db.prepare("SELECT id FROM language_experiments WHERE person_id=? ORDER BY created DESC,id")?
                .query_map([&scope.person], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut items = vec![];
            for id in ids {
                let (mut item, config) = stored(db, &scope.person, &id)?;
                let start = config.periods.iter().map(|p| p.start.as_str()).min();
                let end = config.periods.iter().map(|p| p.end.as_str()).max();
                let status = if config.concluded_at.is_some() { "concluded" }
                    else if start.is_none_or(|s| s > today.as_str()) { "planned" }
                    else if end.is_some_and(|e| e < today.as_str()) { "ready" }
                    else { "running" };
                item["start"] = json!(start); item["end"] = json!(end);
                item["status"] = json!(status);
                item["selectedLanguages"] = json!(config.selected_languages);
                item["periodCount"] = json!(config.periods.len());
                items.push(item);
            }
            Ok(json!({"experiments":items,"today":today}))
        }).await
    }

    pub async fn create_experiment(&self, scope: Scope, body: Create) -> Result<Value> {
        let name = name(&body.name)?;
        self.run(move |db| {
            let tx = db.transaction()?;
            owner_scope(&tx, &scope, true)?;
            let mut config = if let Some(source) = body.source_id {
                let (_, config) = stored(&tx, &scope.person, &source)?;
                revision(&config, body.base_revision.ok_or_else(|| invalid("Include the source revision"))?)?;
                config
            } else { empty() };
            config.base_revision = 0;
            config.concluded_at = None;
            let id = uuid::Uuid::new_v4().to_string();
            let at = now();
            tx.execute("INSERT INTO language_experiments(id,person_id,name,revision,config,created,updated) VALUES(?,?,?,0,?,?,?)",
                params![id,scope.person,name,serde_json::to_string(&config).unwrap(),at,at])?;
            let result = stored(&tx, &scope.person, &id)?.0;
            tx.commit()?;
            Ok(result)
        }).await
    }

    pub async fn change_experiment(&self, scope: Scope, id: String, body: Change, delete: bool) -> Result<Value> {
        self.run(move |db| {
            let tx = db.transaction()?;
            owner_scope(&tx, &scope, true)?;
            let (_, config) = stored(&tx, &scope.person, &id)?;
            revision(&config, body.base_revision)?;
            let result = if delete {
                tx.execute("DELETE FROM language_experiments WHERE id=? AND person_id=?",params![id,scope.person])?;
                json!({"ok":true})
            } else {
                let name = name(body.name.as_deref().unwrap_or(""))?;
                tx.execute("UPDATE language_experiments SET name=?,revision=revision+1,updated=? WHERE id=? AND person_id=?",
                    params![name,now(),id,scope.person])?;
                stored(&tx, &scope.person, &id)?.0
            };
            tx.commit()?;
            Ok(result)
        }).await
    }
}

pub async fn list(State(app): State<App>, headers: HeaderMap, Query(scope): Query<Scope>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.experiments(scope, app.timezone).await?))
}
pub async fn create(State(app): State<App>, headers: HeaderMap, Query(scope): Query<Scope>, Json(body): Json<Create>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.create_experiment(scope, body).await?))
}
pub async fn rename(State(app): State<App>, headers: HeaderMap, Path(id): Path<String>, Query(scope): Query<Scope>, Json(body): Json<Change>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.change_experiment(scope, id, body, false).await?))
}
pub async fn delete(State(app): State<App>, headers: HeaderMap, Path(id): Path<String>, Query(scope): Query<Scope>, Json(body): Json<Change>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.change_experiment(scope, id, body, true).await?))
}
pub async fn get(State(app): State<App>, headers: HeaderMap, Path(id): Path<String>, Query(scope): Query<Scope>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.comparison_for(scope, app.timezone, Some(id)).await?))
}
pub async fn save(State(app): State<App>, headers: HeaderMap, Path(id): Path<String>, Query(scope): Query<Scope>, Json(value): Json<Value>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    if scope.person.is_empty() || !scope.device.is_empty() {
        return Err(invalid("Choose a person. Devices only filter experiment results."));
    }
    if value.get("groups").is_some() {
        return Err(invalid("This comparison uses periods. Reload the page before saving."));
    }
    let config = serde_json::from_value(value).map_err(|e| invalid(&format!("Invalid comparison: {e}")))?;
    Ok(Json(app.store.save_comparison(config, scope.person, app.timezone, Some(id)).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(person: &str) -> Scope { Scope { person:person.into(), device:String::new() } }
    fn create(name: &str) -> Create { Create { name:name.into(),source_id:None,base_revision:None } }
    fn change(revision: i64, name: Option<&str>) -> Change { Change { base_revision:revision,name:name.map(Into::into) } }
    async fn owners(s: &Store) -> Vec<String> {
        s.create_device("a".into(),"A".into(),"Marko".into(),hash("a")).await.unwrap();
        s.create_device("b".into(),"B".into(),"Other".into(),hash("b")).await.unwrap();
        s.read(|db| Ok(db.prepare("SELECT person_id FROM devices ORDER BY id")?
            .query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?)).await.unwrap()
    }

    #[tokio::test]
    async fn migration_preserves_exact_plan_and_deleted_import_never_returns() {
        let path = std::env::temp_dir().join(format!("experiments-{}.sqlite3",uuid::Uuid::new_v4()));
        let s = Store::open(path.clone()).unwrap();
        let people = owners(&s).await;
        let person = people[0].clone();
        let mut config = empty();
        config.periods = vec![Period {label:"Off".into(),start:"2026-01-01".into(),end:"2026-01-03".into()}];
        config.selected_languages = vec!["de".into()];
        config.concluded_at = Some("2026-01-04".into());
        let old = s.save_language_comparison(config,person.clone(),chrono_tz::UTC).await.unwrap();
        drop(s);
        let s = Store::open(path.clone()).unwrap();
        let list = s.experiments(scope(&person),chrono_tz::UTC).await.unwrap();
        assert_eq!(list["experiments"].as_array().unwrap().len(),1);
        assert_eq!(list["experiments"][0]["status"],"concluded");
        let id = list["experiments"][0]["id"].as_str().unwrap().to_string();
        let read = s.comparison_for(scope(&person),chrono_tz::UTC,Some(id.clone())).await.unwrap();
        assert_eq!(read["config"],old);
        s.change_experiment(scope(&person),id,change(1,None),true).await.unwrap();
        drop(s);
        let s = Store::open(path.clone()).unwrap();
        assert_eq!(s.experiments(scope(&person),chrono_tz::UTC).await.unwrap()["experiments"],json!([]));
        assert_eq!(s.language_comparison(scope(&person),chrono_tz::UTC).await.unwrap()["config"],old);
        drop(s);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn lifecycle_is_revision_checked_person_scoped_and_never_deletes_viewing() {
        let s = Store::open(":memory:".into()).unwrap();
        let people = owners(&s).await;
        let (a,b) = (&people[0],&people[1]);
        let tz = chrono_tz::UTC;
        s.ingest(hash("a"),crate::store::Batch {device_id:"a".into(),evidence:Default::default(),events:vec![
            json!({"eventId":"watch","kind":"watch","t":1735732800000_i64,"seconds":10.,"title":"Recorded video","videoId":"abcdefghijk","lang":"de","source":"audio-track","conf":"high"})
        ]}).await.unwrap();
        let created = s.create_experiment(scope(a),create(" German trial ")).await.unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        assert_eq!(created["name"],"German trial");
        let sibling = s.create_experiment(scope(a),create("Second")).await.unwrap();
        assert_eq!(s.experiments(scope(a),tz).await.unwrap()["experiments"].as_array().unwrap().len(),2);
        assert_eq!(s.experiments(scope(b),tz).await.unwrap()["experiments"],json!([]));
        assert_eq!(s.comparison_for(scope(b),tz,Some(id.clone())).await.unwrap_err().0,StatusCode::NOT_FOUND);
        assert!(s.change_experiment(scope(b),id.clone(),change(0,None),true).await.is_err());
        assert!(s.create_experiment(scope(b),Create {name:"Steal".into(),source_id:Some(id.clone()),base_revision:Some(0)}).await.is_err());
        let mut config = empty();
        config.periods = vec![Period {label:"Off".into(),start:"2025-01-01".into(),end:"2025-01-02".into()}];
        config.selected_languages = vec!["de".into()];
        let saved = s.save_comparison(config,a.clone(),tz,Some(id.clone())).await.unwrap();
        let read = s.comparison_for(scope(a),tz,Some(id.clone())).await.unwrap();
        assert_eq!(read["periods"][0]["allSeconds"],10.);
        assert_eq!(s.experiments(scope(a),tz).await.unwrap()["experiments"].as_array().unwrap().iter().find(|x| x["id"]==id).unwrap()["status"],"ready");
        assert!(s.change_experiment(scope(a),id.clone(),change(0,Some("Stale")),false).await.is_err());
        s.change_experiment(scope(a),id.clone(),change(1,Some("Renamed")),false).await.unwrap();
        assert!(s.save_comparison(serde_json::from_value(saved).unwrap(),a.clone(),tz,Some(id.clone())).await.is_err());
        let mut config: Config = serde_json::from_value(s.comparison_for(scope(a),tz,Some(id.clone())).await.unwrap()["config"].clone()).unwrap();
        config.concluded_at = Some("2025-01-03".into());
        let concluded = s.save_comparison(config,a.clone(),tz,Some(id.clone())).await.unwrap();
        let copy = s.create_experiment(scope(a),Create {name:"Copy".into(),source_id:Some(id.clone()),base_revision:Some(3)}).await.unwrap();
        let copy = s.comparison_for(scope(a),tz,Some(copy["id"].as_str().unwrap().into())).await.unwrap();
        assert_eq!(copy["config"]["periods"],concluded["periods"]);
        assert_eq!(copy["config"]["concludedAt"],Value::Null);
        assert_eq!(copy["config"]["baseRevision"],0);
        let mut locked: Config = serde_json::from_value(concluded).unwrap();
        locked.periods[0].label = "Locked".into();
        assert!(s.save_comparison(locked,a.clone(),tz,Some(id.clone())).await.is_err());
        assert!(s.change_experiment(scope(a),id.clone(),change(2,None),true).await.is_err());
        s.change_experiment(scope(a),id.clone(),change(3,None),true).await.unwrap();
        assert_eq!(s.comparison_for(scope(a),tz,Some(id.clone())).await.unwrap_err().0,StatusCode::NOT_FOUND);
        assert_eq!(s.save_comparison(empty(),a.clone(),tz,Some(id)).await.unwrap_err().0,StatusCode::NOT_FOUND);
        assert!(s.comparison_for(scope(a),tz,Some(sibling["id"].as_str().unwrap().into())).await.unwrap()["periods"].as_array().unwrap().is_empty());
        let daily = s.language_comparison_days(DailyScope {from:"2025-01-01".into(),to:"2025-01-02".into(),person:a.clone(),device:String::new()},tz).await.unwrap();
        assert_eq!(daily["days"][0]["allSeconds"],10.);
        assert!(s.create_experiment(scope(a),create("  ")).await.is_err());
        assert!(s.create_experiment(scope(a),create(&"x".repeat(121))).await.is_err());
    }
}

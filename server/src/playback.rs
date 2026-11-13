//! Owner corrections to reported playback context; collector records stay immutable.
use crate::{App, Error, Result, invalid, now, owner, store::Store};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub fn overrides(db: &Connection) -> rusqlite::Result<BTreeMap<String, Value>> {
    db.prepare("SELECT c.device,c.context,c.reason,c.revision,c.created FROM device_context_overrides c
        WHERE c.revision=(SELECT MAX(v.revision) FROM device_context_overrides v WHERE v.device=c.device)
        AND c.context IS NOT NULL")?
        .query_map([], |r| Ok((r.get(0)?, json!({
            "context":r.get::<_,String>(1)?, "reason":r.get::<_,String>(2)?,
            "revision":r.get::<_,i64>(3)?, "created":r.get::<_,i64>(4)?
        }))))?.collect()
}

pub fn annotate(db: &Connection, devices: &mut [Value]) -> rusqlite::Result<()> {
    let overrides = overrides(db)?;
    for device in devices {
        device["contextOverride"] = overrides
            .get(device["id"].as_str().unwrap())
            .cloned()
            .unwrap_or(Value::Null);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Correction {
    context: Option<String>,
    reason: String,
}

impl Store {
    pub async fn correct_playback_context(
        &self,
        device: String,
        correction: Correction,
    ) -> Result<Value> {
        if correction
            .context
            .as_deref()
            .is_some_and(|s| s != "foreground")
            || correction.reason.trim().is_empty()
            || correction.reason.len() > 1000
        {
            return Err(invalid(
                "Choose foreground or null (reset), with a reason up to 1000 bytes",
            ));
        }
        self.run(move |db| {
            let tx = db.transaction()?;
            if tx.query_row("SELECT id FROM devices WHERE id=?", [&device], |r| r.get::<_,String>(0)).optional()?.is_none() {
                return Err(Error(StatusCode::NOT_FOUND,"Device not found".into()));
            }
            let revision: i64 = tx.query_row("SELECT COALESCE(MAX(revision),0)+1 FROM device_context_overrides WHERE device=?", [&device], |r| r.get(0))?;
            tx.execute("INSERT INTO device_context_overrides(device,revision,context,reason,created) VALUES(?,?,?,?,?)",
                params![device,revision,correction.context,correction.reason.trim(),now()])?;
            tx.execute("UPDATE viewing_state SET generation=generation+1 WHERE id=1", [])?;
            tx.commit()?;
            Ok(json!({"deviceId":device,"revision":revision,"context":correction.context}))
        }).await
    }
}

pub async fn correct(
    State(app): State<App>,
    headers: HeaderMap,
    Path(device): Path<String>,
    Json(correction): Json<Correction>,
) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(
        app.store
            .correct_playback_context(device, correction)
            .await?,
    ))
}

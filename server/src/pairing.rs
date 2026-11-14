//! A short code identifies a pending browser; only the owner can approve it.
//! The browser keeps a random 256-bit key locally. Only its hash reaches SQLite;
//! after approval that same key authenticates the new device. Lost replies are retryable.
use crate::{App, Error, Result, bearer, invalid, now, owner, store};
use axum::{Json, extract::State, http::{HeaderMap, StatusCode, header}, response::{IntoResponse, Response}};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};

const TTL: i64 = 10 * 60 * 1000;

pub fn initialize(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS pairing_requests(
        secret_hash TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL,
        created INTEGER NOT NULL, expires INTEGER NOT NULL,
        device_id TEXT REFERENCES devices(id));
        CREATE INDEX IF NOT EXISTS pairing_expiry ON pairing_requests(expires);")
}

fn reply(value: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}

fn secret(headers: &HeaderMap) -> Result<String> {
    let key = bearer(headers).ok_or_else(crate::unauthorized)?;
    if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(crate::unauthorized());
    }
    Ok(store::hash(key))
}

fn code() -> String {
    const LETTERS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let id = uuid::Uuid::new_v4();
    let bits = id.as_bytes()[..5].iter().fold(0u64, |n, b| (n << 8) | u64::from(*b));
    (0..8).map(|i| LETTERS[((bits >> (i * 5)) & 31) as usize] as char).collect()
}

fn normalized(value: &str) -> Result<String> {
    let code: String = value.chars().filter(|c| !c.is_ascii_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase()).collect();
    if code.len() != 8 || !code.bytes().all(|b| b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(&b)) {
        return Err(invalid("Enter the eight-character code shown in the extension"));
    }
    Ok(code)
}

fn pending(code: &str, expires: i64) -> Value {
    json!({"state":"pending","code":format!("{}-{}", &code[..4], &code[4..]),"expiresAt":expires,"pollAfter":5})
}

fn connection(db: &Connection, id: &str, hash: &str) -> Result<Value> {
    db.query_row("SELECT d.label,COALESCE(p.name,'') FROM devices d
        LEFT JOIN people p ON p.id=d.person_id
        WHERE d.id=? AND d.token_hash=? AND d.revoked=0", params![id,hash], |r| {
        Ok(json!({"state":"approved","deviceId":id,"label":r.get::<_,String>(0)?,"person":r.get::<_,String>(1)?}))
    }).optional()?.ok_or_else(crate::unauthorized)
}

impl store::Store {
    async fn begin_pairing(&self, hash: String) -> Result<Value> {
        self.run(move |db| {
            let tx = db.transaction()?;
            let at = now();
            // A lost start reply can outlive the pending row, even after approval.
            let approved: Option<String> = tx.query_row(
                "SELECT id FROM devices WHERE token_hash=? AND revoked=0",
                [&hash], |r| r.get(0)).optional()?;
            if let Some(id) = approved { return connection(&tx,&id,&hash); }
            // Retry with the same secret returns the same code, even after a lost start reply.
            let existing: Option<(String,i64,Option<String>)> = tx.query_row(
                "SELECT code,expires,device_id FROM pairing_requests WHERE secret_hash=?",
                [&hash], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            if let Some((code,expires,device)) = existing {
                if let Some(id) = device { return connection(&tx,&id,&hash); }
                if expires > at { return Ok(pending(&code,expires)); }
            }
            tx.execute("DELETE FROM pairing_requests WHERE expires<=?", [at])?;
            // Bound anonymous starts and storage globally; household pairing is infrequent.
            let recent: i64 = tx.query_row("SELECT count(*) FROM pairing_requests WHERE created>?",[at-60_000],|r| r.get(0))?;
            let active: i64 = tx.query_row("SELECT count(*) FROM pairing_requests",[],|r| r.get(0))?;
            if recent >= 20 || active >= 100 {
                return Err(Error(StatusCode::TOO_MANY_REQUESTS,"Too many pairing requests. Try again in a minute.".into()));
            }
            let used: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM devices WHERE token_hash=?)",[&hash],|r|r.get(0))?;
            if used { return Err(invalid("This browser key is already in use")); }
            let mut candidate = code();
            while tx.query_row("SELECT EXISTS(SELECT 1 FROM pairing_requests WHERE code=?)",[&candidate],|r|r.get::<_,bool>(0))? {
                candidate = code();
            }
            tx.execute("INSERT INTO pairing_requests(secret_hash,code,created,expires) VALUES(?,?,?,?)",
                params![hash,candidate,at,at+TTL])?;
            tx.commit()?;
            Ok(pending(&candidate,at+TTL))
        }).await
    }

    async fn pairing_status(&self, hash: String) -> Result<Value> {
        self.read(move |db| {
            let row: Option<(String,i64,Option<String>)> = db.query_row(
                "SELECT code,expires,device_id FROM pairing_requests WHERE secret_hash=?",
                [&hash], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            match row {
                Some((_,_,Some(id))) => connection(db,&id,&hash),
                Some((code,expires,None)) if expires > now() => Ok(pending(&code,expires)),
                _ => {
                    // A browser can recover an approved connection even after request cleanup.
                    let id: Option<String> = db.query_row("SELECT id FROM devices WHERE token_hash=? AND revoked=0",
                        [&hash], |r|r.get(0)).optional()?;
                    if let Some(id) = id { connection(db,&id,&hash) }
                    else { Ok(json!({"state":"expired"})) }
                }
            }
        }).await
    }

    async fn approve_pairing(&self, input: Approval) -> Result<Value> {
        let code = normalized(&input.code)?;
        if input.label.trim().is_empty() || input.person.trim().is_empty() || input.label.len()>200 || input.person.len()>200 {
            return Err(invalid("Enter a device name and person (up to 200 bytes each)"));
        }
        self.run(move |db| {
            let tx = db.transaction()?;
            let row: Option<(String,i64,Option<String>)> = tx.query_row(
                "SELECT secret_hash,expires,device_id FROM pairing_requests WHERE code=?",
                [&code], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let Some((hash,expires,existing)) = row else {
                return Err(Error(StatusCode::NOT_FOUND,"Code not found. Check the code shown in the extension.".into()));
            };
            if expires <= now() {
                return Err(Error(StatusCode::GONE,"This code expired. Click Get a new code in the extension.".into()));
            }
            // Atomic and idempotent: a double click/lost reply cannot create two devices.
            if let Some(id) = existing { return connection(&tx,&id,&hash); }
            let id = uuid::Uuid::new_v4().to_string();
            let person = store::person_id(&tx,input.person.trim())?;
            tx.execute("INSERT INTO devices(id,label,person,person_id,token_hash,created) VALUES(?,?,?,?,?,?)",
                params![id,input.label.trim(),input.person.trim(),person,hash,now()])?;
            tx.execute("UPDATE pairing_requests SET device_id=? WHERE code=?",params![id,code])?;
            let value = connection(&tx,&id,&hash)?;
            tx.commit()?;
            Ok(value)
        }).await
    }
}

pub async fn start(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    Ok(reply(app.store.begin_pairing(secret(&headers)?).await?))
}
pub async fn status(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    Ok(reply(app.store.pairing_status(secret(&headers)?).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Approval {
    code: String,
    label: String,
    #[serde(default)]
    person: String,
}
pub async fn approve(State(app): State<App>, headers: HeaderMap, Json(input): Json<Approval>) -> Result<Response> {
    owner(&app,&headers).await?;
    Ok(reply(app.store.approve_pairing(input).await?))
}
pub async fn people(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    owner(&app,&headers).await?;
    Ok(reply(app.store.read(|db| {
        let people = db.prepare("SELECT id,name FROM people ORDER BY name COLLATE NOCASE")?
            .query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?})))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({"people":people}))
    }).await?))
}

#[cfg(test)]
mod tests;

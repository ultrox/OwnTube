//! A reusable, revision-checked comparison; ranges select measured playback, not inferred use.
use super::*;
use chrono::{Days, NaiveDate, TimeZone};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Range {
    start: String,
    end: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    label: String,
    ranges: Vec<Range>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    base_revision: i64,
    groups: [Group; 2],
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    #[serde(default)]
    device: String,
    #[serde(default)]
    person: String,
}

fn empty() -> Config {
    Config {
        base_revision: 0,
        groups: ["Using it", "Not using it"].map(|label| Group {
            label: label.into(),
            ranges: vec![],
        }),
    }
}

fn date(value: &str) -> Result<NaiveDate> {
    let d = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| invalid("Use dates in YYYY-MM-DD format"))?;
    if d.to_string() != value || value < "2000-01-01" {
        return Err(invalid("Choose dates from 2000 onwards"));
    }
    Ok(d)
}

// Canonical day sets remove duplicate/overlapping dates without weighting them twice.
fn days(config: &Config, today: NaiveDate) -> Result<[BTreeSet<NaiveDate>; 2]> {
    if config.base_revision < 0 {
        return Err(invalid("Invalid comparison revision"));
    }
    let mut result = [BTreeSet::new(), BTreeSet::new()];
    for (group, selected) in config.groups.iter().zip(result.iter_mut()) {
        if group.label.trim().is_empty() || group.label.chars().count() > 80 || group.ranges.len() > 64 {
            return Err(invalid("Use a group name up to 80 characters and at most 64 ranges"));
        }
        for range in &group.ranges {
            let (start, end) = (date(&range.start)?, date(&range.end)?);
            if end < start || end > today {
                return Err(invalid("Ranges must end on or after their start, and no later than today"));
            }
            let length = (end - start).num_days();
            if length > 3660 {
                return Err(invalid("Choose at most 3,660 calendar days per group"));
            }
            for n in 0..=length {
                selected.insert(start.checked_add_days(Days::new(n as u64)).unwrap());
            }
            if selected.len() > 3660 {
                return Err(invalid("Choose at most 3,660 calendar days per group"));
            }
        }
    }
    if let Some(shared) = result[0].intersection(&result[1]).next() {
        return Err(invalid(&format!("{shared} belongs to both groups. Choose non-overlapping groups.")));
    }
    Ok(result)
}

fn saved(db: &Connection) -> Result<Config> {
    let row: Option<(i64, String)> = db
        .query_row("SELECT revision,config FROM language_comparison WHERE id=1", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match row {
        Some((revision, text)) => {
            let mut config: Config = decode(&text)?;
            config.base_revision = revision;
            Ok(config)
        }
        None => Ok(empty()),
    }
}

fn midnight(d: NaiveDate, tz: chrono_tz::Tz) -> Result<i64> {
    tz.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .map(|t| t.timestamp_millis())
        .ok_or_else(|| invalid("This time zone has no midnight on a selected date"))
}

// Coalesce adjacent selected days, preserving exact local calendar boundaries over DST.
fn windows(selected: &BTreeSet<NaiveDate>, tz: chrono_tz::Tz, at: i64) -> Result<Vec<Window>> {
    let mut runs: Vec<Vec<NaiveDate>> = vec![];
    for &d in selected {
        if let Some(run) = runs.last_mut()
            && run.last().unwrap().succ_opt() == Some(d)
        {
            run.push(d);
        } else {
            runs.push(vec![d]);
        }
    }
    runs.into_iter().map(|run| {
        Ok(Window {
            since: midnight(run[0], tz)?,
            until: midnight(run.last().unwrap().succ_opt().unwrap(), tz)?.min(at),
            before: i64::MAX,
            dates: run.iter().map(ToString::to_string).collect(),
        })
    }).collect()
}

impl Store {
    pub async fn save_language_comparison(&self, config: Config, tz: chrono_tz::Tz) -> Result<Value> {
        days(&config, tz.timestamp_millis_opt(now()).unwrap().date_naive())?;
        self.run(move |db| {
            let tx = db.transaction()?;
            let old = saved(&tx)?;
            if config.base_revision != old.base_revision {
                return Err(conflict("Comparison changed in another browser. Reload saved periods before saving."));
            }
            let mut next = config;
            next.base_revision += 1;
            tx.execute("INSERT INTO language_comparison(id,revision,config,updated) VALUES(1,?,?,?)
                ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config=excluded.config,updated=excluded.updated",
                params![next.base_revision, serde_json::to_string(&next).unwrap(), now()])?;
            tx.commit()?;
            Ok(json!(next))
        }).await
    }

    pub async fn language_comparison(&self, scope: Scope, tz: chrono_tz::Tz) -> Result<Value> {
        if scope.device.len() > 200 || scope.person.len() > 200 {
            return Err(invalid("Invalid comparison scope"));
        }
        self.sync_legacy().await?;
        self.read(move |db| {
            let at = now();
            let today = tz.timestamp_millis_opt(at).unwrap().date_naive();
            let config = saved(db)?;
            let selected_days = days(&config, today)?;
            let selected: BTreeSet<String> = db.prepare(
                "SELECT id FROM devices WHERE (?='' OR id=?) AND
                (?='' OR person_id=? OR (?='unassigned' AND person_id IS NULL))")?
                .query_map(params![scope.device, scope.device, scope.person, scope.person, scope.person], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut assessments = BTreeMap::new();
            let mut groups = vec![];
            for selected_days in &selected_days {
                let mut context = [0.; 3];
                let mut langs: BTreeMap<String, f64> = BTreeMap::new();
                let mut active = BTreeSet::new();
                let mut review = 0.;
                for window in windows(selected_days, tz, at)? {
                    for fact in Analytics::load_totals(db, &window)?.facts() {
                        if !selected.contains(&fact.device) { continue; }
                        let mid = hash(&serde_json::to_string(&fact.metadata).unwrap());
                        let key = (fact.device.clone(), mid);
                        if !assessments.contains_key(&key) {
                            assessments.insert(key.clone(), latest(db, &key.0, &key.1, &fact.metadata)?.1);
                        }
                        let assessment = &assessments[&key];
                        *langs.entry(assessment.lang.clone()).or_default() += fact.seconds;
                        context[fact.context] += fact.seconds;
                        if assessment.review() { review += fact.seconds; }
                        if fact.seconds > 0. {
                            active.insert(tz.timestamp_millis_opt(fact.first as i64).unwrap().date_naive());
                        }
                    }
                }
                let seconds: f64 = context.iter().sum();
                let count = selected_days.len();
                groups.push(json!({
                    "calendarDays": count, "activeDays": active.len(),
                    "includesToday": selected_days.contains(&today),
                    "seconds": seconds, "reviewSeconds": review,
                    "foregroundSeconds": context[0], "backgroundSeconds": context[1], "unspecifiedSeconds": context[2],
                    "minutesPerDay": (count > 0).then(|| seconds / 60. / count as f64),
                    "languages": langs.into_iter().map(|(lang, seconds)| json!({
                        "lang": lang, "seconds": seconds,
                        "minutesPerDay": (count > 0).then(|| seconds / 60. / count as f64),
                        "share": (context.iter().sum::<f64>() > 0.).then(|| seconds / context.iter().sum::<f64>())
                    })).collect::<Vec<_>>()
                }));
            }
            Ok(json!({"config":config, "groups":groups, "timezone":tz.to_string(), "today":today.to_string(), "asOf":at}))
        }).await
    }
}

pub async fn get(State(app): State<App>, headers: HeaderMap, Query(scope): Query<Scope>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.language_comparison(scope, app.timezone).await?))
}

pub async fn save(State(app): State<App>, headers: HeaderMap, Json(config): Json<Config>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.save_language_comparison(config, app.timezone).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(a: &[(&str, &str)], b: &[(&str, &str)]) -> Config {
        Config {
            base_revision: 0,
            groups: [a, b].map(|ranges| Group {
                label: "A group".into(),
                ranges: ranges.iter().map(|(a, b)| Range { start: (*a).into(), end: (*b).into() }).collect(),
            }),
        }
    }

    #[test]
    fn ranges_are_inclusive_deduplicated_disjoint_and_dst_aware() {
        let today = date("2026-11-13").unwrap();
        let c = config(&[("2026-03-28", "2026-03-29"), ("2026-03-29", "2026-03-30")], &[("2026-10-25", "2026-10-25")]);
        let sets = days(&c, today).unwrap();
        assert_eq!(sets[0].len(), 3);
        let spring = windows(&sets[0], chrono_tz::Europe::Zurich, i64::MAX).unwrap();
        assert_eq!(spring.len(), 1);
        assert_eq!(spring[0].until - spring[0].since, 71 * 3_600_000);
        let autumn = windows(&sets[1], chrono_tz::Europe::Zurich, i64::MAX).unwrap();
        assert_eq!(autumn[0].until - autumn[0].since, 25 * 3_600_000);
        for c in [
            config(&[("2026-03-29", "2026-03-30")], &[("2026-03-30", "2026-03-31")]),
            config(&[("2026-03-30", "2026-03-29")], &[]),
            config(&[("2026-02-30", "2026-03-01")], &[]),
            config(&[("2026-11-14", "2026-11-14")], &[]),
            config(&[("2000-01-01", "2026-11-13")], &[]),
        ] { assert!(days(&c, today).is_err()); }
    }

    #[tokio::test]
    async fn exact_ranges_current_assessments_scope_and_conflicts() {
        let s = Store::open(":memory:".into()).unwrap();
        s.create_device("browser".into(), "Browser".into(), "Owner".into(), hash("key")).await.unwrap();
        // The first legacy sample crosses local midnight; only its final five seconds belong
        // to March 29. The second period is separated by an unselected day.
        let tz = chrono_tz::Europe::Zurich;
        let boundary = midnight(date("2026-03-29").unwrap(), tz).unwrap();
        let event = |id: &str, t: i64, seconds: f64, lang: &str| json!({
            "eventId":id,"kind":"watch","t":t,"seconds":seconds,"videoId":"abcdefghijk",
            "title":"Recorded audio","lang":lang,"source":"unknown","conf":"low","playbackContext":"background"
        });
        s.ingest(hash("key"), crate::store::Batch {
            device_id: "browser".into(), evidence: Default::default(),
            events: vec![
                event("edge", boundary - 5_000, 10., "en"),
                event("unknown", boundary + 3_600_000, 15., "und"),
                event("excluded", boundary + 24 * 3_600_000, 20., "en"),
                event("second", midnight(date("2026-03-31").unwrap(), tz).unwrap(), 20., "en"),
                event("second-more", midnight(date("2026-03-31").unwrap(), tz).unwrap() + 20_000, 20., "en"),
            ],
        }).await.unwrap();
        let c = config(&[("2026-03-29", "2026-03-29"), ("2026-03-29", "2026-03-29")], &[("2026-03-31", "2026-04-01")]);
        assert_eq!(s.save_language_comparison(c.clone(), tz).await.unwrap()["baseRevision"], 1);
        assert_eq!(s.save_language_comparison(c, tz).await.unwrap_err().0, StatusCode::CONFLICT);
        let data = s.language_comparison(Scope::default(), tz).await.unwrap();
        assert_eq!(data["groups"][0]["seconds"], 20.);
        assert_eq!(data["groups"][0]["calendarDays"], 1);
        assert_eq!(data["groups"][0]["activeDays"], 1);
        assert_eq!(data["groups"][1]["seconds"], 40.);
        assert_eq!(data["groups"][1]["calendarDays"], 2);
        assert_eq!(data["groups"][1]["activeDays"], 1);
        assert_eq!(data["groups"][0]["minutesPerDay"], data["groups"][1]["minutesPerDay"]);
        let mid: String = s.read(|db| Ok(db.query_row(
            "SELECT id FROM video_metadata WHERE json_extract(payload,'$.lang')='en'", [], |r| r.get(0))?)).await.unwrap();
        s.language_change(Change {
            device_id:"browser".into(),metadata_id:mid,base_revision:0,
            action:"manual".into(),lang:Some("ja".into()),note:"Japanese audio".into(),provider:None
        }, None).await.unwrap();
        let updated = s.language_comparison(Scope::default(), tz).await.unwrap();
        assert_eq!(updated["groups"][0]["seconds"], 20.);
        assert_eq!(updated["groups"][0]["languages"][0]["lang"], "ja");
        assert_eq!(updated["groups"][0]["languages"][0]["seconds"], 5.);
        assert_eq!(updated["groups"][0]["languages"][1]["lang"], "und");
        assert_eq!(updated["groups"][0]["languages"][1]["share"], 0.75);
        let excluded = s.language_comparison(Scope { device:"other".into(),person:String::new() }, tz).await.unwrap();
        assert_eq!(excluded["groups"][0]["seconds"], 0.);
        assert_eq!(excluded["groups"][0]["calendarDays"], 1);
        assert_eq!(excluded["groups"][0]["minutesPerDay"], 0.);
        let count = s.read(|db| Ok(db.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))?)).await.unwrap();
        assert_eq!(count, 5);
    }

    #[tokio::test]
    async fn cumulative_playback_keeps_measured_time_and_owner_context() {
        let s = Store::open(":memory:".into()).unwrap();
        s.create_device("tv".into(), "TV".into(), "Owner".into(), hash("key")).await.unwrap();
        let tz = chrono_tz::Europe::Zurich;
        let midnight = midnight(date("2026-10-25").unwrap(), tz).unwrap();
        let record = |id: &str, bucket: i64, seconds: f64| json!({
            "eventId":id,"kind":"viewing","viewingId":"same-visit","bucket":bucket,"revision":1,
            "t":bucket+1000,"lastWatched":bucket+600_000,"seconds":seconds,
            "videoId":"abcdefghijk","title":"Paused playback","lang":"de","source":"audio-track",
            "conf":"high","playbackContext":"background","durationSeconds":900.,"coverage":[[0.,seconds]]
        });
        s.ingest(hash("key"), crate::store::Batch { device_id:"tv".into(), evidence:Default::default(),
            events:vec![record("before",midnight-900_000,20.),record("after",midnight,30.)]
        }).await.unwrap();
        s.correct_playback_context("tv".into(), serde_json::from_value(json!({
            "context":"foreground","reason":"TV playback is foreground"
        })).unwrap()).await.unwrap();
        s.save_language_comparison(config(&[("2026-10-24","2026-10-24")], &[("2026-10-25","2026-10-25")]),tz).await.unwrap();
        let value = s.language_comparison(Scope::default(),tz).await.unwrap();
        assert_eq!(value["groups"][0]["seconds"],20.);
        assert_eq!(value["groups"][1]["seconds"],30.);
        assert_eq!(value["groups"][1]["foregroundSeconds"],30.);
        assert_eq!(value["groups"][1]["backgroundSeconds"],0.);
        // A cumulative record lasts ten wall-clock minutes but contains only 30 measured seconds.
        assert_eq!(value["groups"][1]["minutesPerDay"],0.5);
        let person: String = s.read(|db| Ok(db.query_row("SELECT person_id FROM devices WHERE id='tv'",[],|r| r.get(0))?)).await.unwrap();
        assert_eq!(s.language_comparison(Scope {device:String::new(),person},tz).await.unwrap()["groups"],value["groups"]);
        assert_eq!(s.language_comparison(Scope {device:String::new(),person:"unassigned".into()},tz).await.unwrap()["groups"][1]["seconds"],0.);
    }

    #[tokio::test]
    async fn comparison_survives_store_reopen_and_empty_groups_have_no_average() {
        let path = std::env::temp_dir().join(format!("comparison-{}.sqlite", crate::token()));
        let s = Store::open(path.clone()).unwrap();
        let c = config(&[("2026-03-01", "2026-03-02")], &[]);
        s.save_language_comparison(c, chrono_tz::UTC).await.unwrap();
        drop(s);
        let s = Store::open(path.clone()).unwrap();
        let read = s.language_comparison(Scope::default(), chrono_tz::UTC).await.unwrap();
        assert_eq!(read["config"]["baseRevision"], 1);
        assert_eq!(read["groups"][0]["calendarDays"], 2);
        assert_eq!(read["groups"][1]["minutesPerDay"], Value::Null);
        drop(s);
        std::fs::remove_file(path).unwrap();
    }
}

//! A reusable, revision-checked comparison; ranges select measured playback, not inferred use.
use super::*;
use chrono::{Days, NaiveDate, TimeZone};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Period {
    label: String,
    start: String,
    end: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LegacyGroup {
    label: String,
    ranges: Vec<LegacyRange>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LegacyRange {
    start: String,
    end: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    base_revision: i64,
    periods: Vec<Period>,
    #[serde(default)]
    selected_languages: Vec<String>,
    #[serde(default)]
    concluded_at: Option<String>,
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
        selected_languages: vec![],
        periods: vec![],
        concluded_at: None,
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

// Normalize once before saving or interpreting an old row. Reads never rewrite storage.
fn normalize(config: &mut Config, today: NaiveDate) -> Result<()> {
    if config.base_revision < 0 {
        return Err(invalid("Invalid comparison revision"));
    }
    if config.selected_languages.len() > 128 || config.selected_languages.iter().any(|s| language(s).is_none()) {
        return Err(invalid("Choose up to 128 valid language codes"));
    }
    if config.periods.len() > 128 {
        return Err(invalid("Choose up to 128 periods"));
    }
    let mut occupied = BTreeMap::new();
    for period in &mut config.periods {
        period.label = period.label.trim().into();
        if period.label.is_empty() || period.label.chars().count() > 80 {
            return Err(invalid("Use a group name up to 80 characters"));
        }
        let (start, end) = (date(&period.start)?, date(&period.end)?);
        if end < start || end > today.checked_add_days(Days::new(366)).unwrap() {
            return Err(invalid("Periods must end on or after their start, at most 366 days after today"));
        }
        if (end - start).num_days() >= 3660 {
            return Err(invalid("Choose at most 3,660 unique calendar days"));
        }
        for n in 0..=(end - start).num_days() {
            let d = start.checked_add_days(Days::new(n as u64)).unwrap();
            if let Some(label) = occupied.insert(d, period.label.clone())
                && label != period.label
            {
                return Err(invalid("A date can belong to one period only"));
            }
        }
        if occupied.len() > 3660 {
            return Err(invalid("Choose at most 3,660 unique calendar days"));
        }
    }
    config.periods.sort_by(|a, b| a.start.cmp(&b.start).then(a.end.cmp(&b.end)));
    let mut merged: Vec<Period> = vec![];
    for period in &config.periods {
        if let Some(last) = merged.last_mut()
            && last.label == period.label
            && date(&period.start)? <= date(&last.end)?.succ_opt().unwrap()
        {
            if period.end > last.end { last.end = period.end.clone(); }
        } else {
            merged.push(period.clone());
        }
    }
    config.periods = merged;
    config.selected_languages = config.selected_languages.iter().map(|s| language(s).unwrap())
        .collect::<BTreeSet<_>>().into_iter().collect();
    if let Some(concluded) = &config.concluded_at {
        let concluded = date(concluded)?;
        if config.periods.is_empty() || config.periods.iter().any(|p| date(&p.end).unwrap() >= today) {
            return Err(invalid("Every period must be complete before concluding"));
        }
        if concluded > today || config.periods.iter().any(|p| date(&p.end).unwrap() >= concluded) {
            return Err(invalid("Choose a conclusion date after the periods and no later than today"));
        }
    }
    Ok(())
}

fn days(period: &Period, through: NaiveDate) -> Result<BTreeSet<NaiveDate>> {
    let (start, end) = (date(&period.start)?, date(&period.end)?.min(through));
    Ok((0..=(end - start).num_days()).map(|n| start.checked_add_days(Days::new(n as u64)).unwrap()).collect())
}

fn saved(db: &Connection, today: NaiveDate) -> Result<Config> {
    let row: Option<(i64, String)> = db
        .query_row("SELECT revision,config FROM language_comparison WHERE id=1", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match row {
        Some((revision, text)) => {
            let value: Value = decode(&text)?;
            let mut config: Config = if value.get("groups").is_some() {
                let groups: Vec<LegacyGroup> = serde_json::from_value(value["groups"].clone())
                    .map_err(|_| invalid("Could not read saved comparison groups"))?;
                Config {
                    base_revision: revision,
                    selected_languages: serde_json::from_value(value.get("selectedLanguages").cloned().unwrap_or(json!([])))
                        .map_err(|_| invalid("Could not read saved comparison languages"))?,
                    periods: groups.into_iter().flat_map(|g| g.ranges.into_iter().map(move |r| Period {
                        label: g.label.clone(), start: r.start, end: r.end
                    })).collect(),
                    concluded_at: None,
                }
            } else { decode(&text)? };
            config.base_revision = revision;
            normalize(&mut config, today)?;
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
    pub async fn save_language_comparison(&self, mut config: Config, tz: chrono_tz::Tz) -> Result<Value> {
        self.run(move |db| {
            let today = tz.timestamp_millis_opt(now()).unwrap().date_naive();
            normalize(&mut config, today)?;
            let tx = db.transaction()?;
            let old = saved(&tx, today)?;
            if config.base_revision != old.base_revision {
                return Err(conflict("Comparison changed in another browser. Reload saved periods before saving."));
            }
            if old.concluded_at.is_some() && config.periods != old.periods {
                return Err(invalid("Reopen the experiment to edit periods"));
            }
            if old.concluded_at.is_some() && config.concluded_at.is_some() && old.concluded_at != config.concluded_at {
                return Err(invalid("Reopen the experiment before changing its conclusion date"));
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
            let config = saved(db, today)?;
            let selected: BTreeSet<String> = db.prepare(
                "SELECT id FROM devices WHERE (?='' OR id=?) AND
                (?='' OR person_id=? OR (?='unassigned' AND person_id IS NULL))")?
                .query_map(params![scope.device, scope.device, scope.person, scope.person, scope.person], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut assessments = BTreeMap::new();
            let mut available_languages: BTreeSet<String> = config.selected_languages.iter().cloned().collect();
            let mut measure = |selected_days: &BTreeSet<NaiveDate>| -> Result<Value> {
                let mut context = [0.; 3];
                let mut langs: BTreeMap<String, f64> = config.selected_languages.iter().map(|l| (l.clone(), 0.)).collect();
                let mut all_seconds = 0.;
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
                        all_seconds += fact.seconds;
                        if fact.seconds > 0. { available_languages.insert(assessment.lang.clone()); }
                        if !config.selected_languages.is_empty() && !config.selected_languages.contains(&assessment.lang) { continue; }
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
                Ok(json!({
                    "calendarDays": count, "activeDays": active.len(),
                    "includesToday": selected_days.contains(&today),
                    "seconds": seconds, "allSeconds": all_seconds, "reviewSeconds": review,
                    "share": (all_seconds > 0.).then(|| seconds / all_seconds),
                    "foregroundSeconds": context[0], "backgroundSeconds": context[1], "unspecifiedSeconds": context[2],
                    "minutesPerDay": (count > 0).then(|| seconds / 60. / count as f64),
                    "languages": langs.into_iter().map(|(lang, seconds)| json!({
                        "lang": lang, "seconds": seconds,
                        "minutesPerDay": (count > 0).then(|| seconds / 60. / count as f64),
                        "share": (all_seconds > 0.).then(|| seconds / all_seconds)
                    })).collect::<Vec<_>>()
                }))
            };
            let mut periods = vec![];
            let mut pooled: Vec<(String, Vec<usize>, BTreeSet<NaiveDate>, BTreeSet<NaiveDate>)> = vec![];
            for (index, period) in config.periods.iter().enumerate() {
                let planned = days(period, date(&period.end)?)?;
                let elapsed = days(period, today)?;
                let mut result = measure(&elapsed)?;
                result["label"] = json!(period.label);
                result["start"] = json!(period.start);
                result["end"] = json!(period.end);
                result["plannedDays"] = json!(planned.len());
                result["status"] = json!(period_status(&planned, today));
                periods.push(result);
                let pos = pooled.iter().position(|g| g.0 == period.label).unwrap_or_else(|| {
                    pooled.push((period.label.clone(), vec![], BTreeSet::new(), BTreeSet::new()));
                    pooled.len() - 1
                });
                pooled[pos].1.push(index);
                pooled[pos].2.extend(elapsed);
                pooled[pos].3.extend(planned);
            }
            let mut groups = vec![];
            for (label, indexes, elapsed, planned) in pooled {
                let mut result = measure(&elapsed)?;
                result["label"] = json!(label);
                result["periods"] = json!(indexes);
                result["plannedDays"] = json!(planned.len());
                result["status"] = json!(period_status(&planned, today));
                groups.push(result);
            }
            // Future-only plans still offer languages actually recorded in this scope.
            if periods.iter().all(|p| p["calendarDays"] == 0) {
                let recent = (0..30).map(|n| today.checked_sub_days(Days::new(n)).unwrap()).collect();
                measure(&recent)?;
            }
            Ok(json!({"config":config, "periods":periods, "groups":groups, "availableLanguages":available_languages,
                "timezone":tz.to_string(), "today":today.to_string(), "asOf":at}))
        }).await
    }
}

fn period_status(planned: &BTreeSet<NaiveDate>, today: NaiveDate) -> &'static str {
    if planned.first().is_none_or(|d| *d > today) { "upcoming" }
    else if planned.last().is_some_and(|d| *d < today) { "complete" }
    else { "running" }
}

pub async fn get(State(app): State<App>, headers: HeaderMap, Query(scope): Query<Scope>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(app.store.language_comparison(scope, app.timezone).await?))
}

pub async fn save(State(app): State<App>, headers: HeaderMap, Json(value): Json<Value>) -> Result<Json<Value>> {
    owner(&app, &headers).await?;
    if value.get("groups").is_some() {
        return Err(invalid("Use comparison v2 periods instead of groups. Reload this page before saving."));
    }
    let config = serde_json::from_value(value).map_err(|e| invalid(&format!("Invalid comparison: {e}")))?;
    Ok(Json(app.store.save_language_comparison(config, app.timezone).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(a: &[(&str, &str)], b: &[(&str, &str)]) -> Config {
        Config {
            base_revision: 0,
            selected_languages: vec![],
            concluded_at: None,
            periods: [a, b].into_iter().enumerate().flat_map(|(i, ranges)| ranges.iter().map(move |(a,b)| Period {
                label: format!("Group {i}"), start: (*a).into(), end: (*b).into()
            })).collect(),
        }
    }

    #[test]
    fn ranges_are_inclusive_deduplicated_disjoint_and_dst_aware() {
        let today = date("2026-11-13").unwrap();
        let mut c = config(&[("2026-03-28", "2026-03-29"), ("2026-03-29", "2026-03-30")], &[("2026-10-25", "2026-10-25")]);
        normalize(&mut c, today).unwrap();
        assert_eq!(c.periods.len(), 2);
        let sets: Vec<_> = c.periods.iter().map(|p| days(p, today).unwrap()).collect();
        assert_eq!(sets[0].len(), 3);
        let spring = windows(&sets[0], chrono_tz::Europe::Zurich, i64::MAX).unwrap();
        assert_eq!(spring.len(), 1);
        assert_eq!(spring[0].until - spring[0].since, 71 * 3_600_000);
        let autumn = windows(&sets[1], chrono_tz::Europe::Zurich, i64::MAX).unwrap();
        assert_eq!(autumn[0].until - autumn[0].since, 25 * 3_600_000);
        for mut c in [
            config(&[("2026-03-29", "2026-03-30")], &[("2026-03-30", "2026-03-31")]),
            config(&[("2026-03-30", "2026-03-29")], &[]),
            config(&[("2026-02-30", "2026-03-01")], &[]),
            config(&[("2027-11-15", "2027-11-15")], &[]),
            config(&[("2000-01-01", "2026-11-13")], &[]),
        ] { assert!(normalize(&mut c, today).is_err()); }
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
        let mut chosen: Config = serde_json::from_value(updated["config"].clone()).unwrap();
        chosen.selected_languages = vec!["JA".into(), "ja".into(), "ru".into()];
        assert_eq!(s.save_language_comparison(chosen, tz).await.unwrap()["selectedLanguages"], json!(["ja","ru"]));
        let chosen = s.language_comparison(Scope::default(), tz).await.unwrap();
        assert_eq!(chosen["groups"][0]["seconds"], 5.);
        assert_eq!(chosen["groups"][0]["allSeconds"], 20.);
        assert_eq!(chosen["groups"][0]["share"], 0.25);
        assert_eq!(chosen["groups"][0]["calendarDays"], 1);
        assert_eq!(chosen["groups"][0]["backgroundSeconds"], 5.);
        assert_eq!(chosen["groups"][0]["reviewSeconds"], 0.);
        assert_eq!(chosen["groups"][0]["languages"][0]["share"], 0.25);
        assert_eq!(chosen["groups"][0]["languages"][1]["seconds"], 0.);
        assert_eq!(chosen["groups"][1]["seconds"], 40.);
        assert_eq!(chosen["availableLanguages"], json!(["ja","ru","und"]),
            "Suggestions retain the saved selection alongside recorded assessed languages");
        let mut invalid_choice: Config = serde_json::from_value(chosen["config"].clone()).unwrap();
        invalid_choice.selected_languages = vec!["Japanese".into()];
        assert!(s.save_language_comparison(invalid_choice,tz).await.is_err());
        let excluded = s.language_comparison(Scope { device:"other".into(),person:String::new() }, tz).await.unwrap();
        assert_eq!(excluded["groups"][0]["seconds"], 0.);
        assert_eq!(excluded["groups"][0]["calendarDays"], 1);
        assert_eq!(excluded["groups"][0]["minutesPerDay"], 0.);
        assert_eq!(excluded["availableLanguages"], json!(["ja","ru"]));
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
    async fn v1_migration_is_read_only_and_normalizes_populated_groups() {
        let s = Store::open(":memory:".into()).unwrap();
        s.run(|db| {
            let old = json!({"baseRevision":7,"selectedLanguages":["DE","en"],"groups":[
                {"label":" On ","ranges":[{"start":"2026-01-05","end":"2026-01-06"}]},
                {"label":"Off","ranges":[{"start":"2026-01-02","end":"2026-01-04"},{"start":"2026-01-01","end":"2026-01-02"},{"start":"2026-01-07","end":"2026-01-08"}]}
            ]}).to_string();
            db.execute("INSERT INTO language_comparison VALUES(1,7,?,123)", [&old])?;
            let c = saved(db, date("2026-11-13")?)?;
            assert_eq!(c.base_revision, 7);
            assert_eq!(c.selected_languages, vec!["de", "en"]);
            assert_eq!(c.periods.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), vec!["Off","On","Off"]);
            assert_eq!(c.periods[0].start, "2026-01-01");
            assert_eq!(c.periods[0].end, "2026-01-04");
            assert_eq!(db.query_row("SELECT config FROM language_comparison", [], |r| r.get::<_,String>(0))?, old);
            assert_eq!(db.query_row("SELECT updated FROM language_comparison", [], |r| r.get::<_,i64>(0))?, 123);
            Ok(())
        }).await.unwrap();
        let d = s.language_comparison(Scope::default(), chrono_tz::UTC).await.unwrap();
        assert_eq!(d["groups"][0]["periods"], json!([0,2]));
        assert_eq!(d["groups"][0]["calendarDays"], 6);
        let c: Config = serde_json::from_value(d["config"].clone()).unwrap();
        assert_eq!(s.save_language_comparison(c, chrono_tz::UTC).await.unwrap()["baseRevision"], 8);
        s.read(|db| {
            let text: String = db.query_row("SELECT config FROM language_comparison", [], |r| r.get(0))?;
            assert!(!text.contains("\"groups\""));
            Ok(())
        }).await.unwrap();
    }

    #[tokio::test]
    async fn planned_days_status_fallback_scope_and_conclusion_lock() {
        let s = Store::open(":memory:".into()).unwrap();
        let tz = chrono_tz::UTC;
        let today = tz.timestamp_millis_opt(now()).unwrap().date_naive();
        let day = |n: i64| (today + chrono::Duration::days(n)).to_string();
        s.create_device("browser".into(), "Browser".into(), "Owner".into(), hash("key")).await.unwrap();
        s.ingest(hash("key"), crate::store::Batch { device_id:"browser".into(), evidence:Default::default(), events:vec![
            json!({"eventId":"recent","kind":"watch","t":midnight(today.pred_opt().unwrap(),tz).unwrap()+1000,
                "seconds":12.,"title":"Recent audio","videoId":"abcdefghijk","lang":"de","source":"audio-track","conf":"high","playbackContext":"foreground"})
        ]}).await.unwrap();
        let mut c = config(&[(&day(1), &day(10))], &[]);
        c.selected_languages = vec!["ja".into()];
        s.save_language_comparison(c,tz).await.unwrap();
        let future = s.language_comparison(Scope::default(),tz).await.unwrap();
        assert_eq!(future["availableLanguages"], json!(["de","ja"]));
        assert_eq!(future["periods"][0]["status"], "upcoming");
        assert_eq!(future["periods"][0]["plannedDays"], 10);
        assert_eq!(future["periods"][0]["calendarDays"], 0);
        assert_eq!(future["periods"][0]["minutesPerDay"], Value::Null);
        assert_eq!(future["periods"][0]["share"], Value::Null);
        let scoped = s.language_comparison(Scope{device:"absent".into(),person:String::new()},tz).await.unwrap();
        assert_eq!(scoped["availableLanguages"], json!(["ja"]));
        let mut c: Config = serde_json::from_value(future["config"].clone()).unwrap();
        c.selected_languages.clear();
        c.periods = vec![
            Period{label:"Off".into(),start:day(-4),end:day(-2)},
            Period{label:"On".into(),start:day(-1),end:day(2)},
            Period{label:"Off".into(),start:day(3),end:day(5)},
        ];
        s.save_language_comparison(c,tz).await.unwrap();
        let d = s.language_comparison(Scope::default(),tz).await.unwrap();
        assert_eq!(d["periods"][0]["status"], "complete");
        assert_eq!(d["periods"][1]["status"], "running");
        assert_eq!(d["periods"][1]["includesToday"], true);
        assert_eq!(d["periods"][1]["calendarDays"], 2);
        assert_eq!(d["periods"][1]["plannedDays"], 4);
        assert_eq!(d["periods"][1]["minutesPerDay"], 0.1);
        assert_eq!(d["groups"][0]["status"], "running");
        assert_eq!(d["groups"][0]["calendarDays"], 3);
        assert_eq!(d["groups"][0]["plannedDays"], 6);
        assert_eq!(d["groups"][0]["periods"], json!([0,2]));
        let mut c: Config = serde_json::from_value(d["config"].clone()).unwrap();
        c.concluded_at = Some(day(0));
        assert_eq!(s.save_language_comparison(c.clone(),tz).await.unwrap_err().0,StatusCode::UNPROCESSABLE_ENTITY);
        c.periods = vec![Period{label:"Done".into(),start:day(-3),end:day(-1)}];
        let concluded = s.save_language_comparison(c,tz).await.unwrap();
        let mut c: Config = serde_json::from_value(concluded).unwrap();
        c.selected_languages = vec!["de".into()];
        let selected = s.save_language_comparison(c,tz).await.unwrap();
        let mut c: Config = serde_json::from_value(selected).unwrap();
        c.periods[0].label = "Changed".into();
        assert!(s.save_language_comparison(c.clone(),tz).await.is_err());
        c.concluded_at = None;
        assert!(s.save_language_comparison(c.clone(),tz).await.is_err(), "Reopen before editing");
        c.periods[0].label = "Done".into();
        let reopened = s.save_language_comparison(c,tz).await.unwrap();
        let mut c: Config = serde_json::from_value(reopened).unwrap();
        c.periods[0].label = "Changed".into();
        assert!(s.save_language_comparison(c,tz).await.is_ok());
    }

    #[test]
    fn future_limit_unique_day_limit_and_touching_merge() {
        let today = date("2026-11-13").unwrap();
        let limit = today.checked_add_days(Days::new(366)).unwrap().to_string();
        let mut c = config(&[(&limit,&limit)], &[]);
        normalize(&mut c,today).unwrap();
        let mut c = config(&[("2010-01-01","2020-01-08")], &[]);
        normalize(&mut c,today).unwrap();
        assert_eq!(days(&c.periods[0],today).unwrap().len(),3660);
        c.periods[0].end = "2020-01-09".into();
        assert!(normalize(&mut c,today).is_err());
        let mut c = config(&[("2026-01-03","2026-01-04"),("2026-01-01","2026-01-02")], &[]);
        normalize(&mut c,today).unwrap();
        assert_eq!(c.periods.len(),1);
        assert_eq!(c.periods[0].start,"2026-01-01");
        assert_eq!(c.periods[0].end,"2026-01-04");
        c.periods = vec![c.periods[0].clone();129];
        assert!(normalize(&mut c,today).is_err());
    }

    #[tokio::test]
    async fn comparison_survives_store_reopen_and_empty_groups_have_no_average() {
        let path = std::env::temp_dir().join(format!("comparison-{}.sqlite", crate::token()));
        let s = Store::open(path.clone()).unwrap();
        // Stored v1 is interpreted in memory and never rewritten by GET.
        let old = json!({"baseRevision":0,"groups":[
            {"label":"Using it","ranges":[]},{"label":"Not using it","ranges":[]}
        ]}).to_string();
        s.run(move |db| {
            db.execute("INSERT INTO language_comparison VALUES(1,0,?,123)", [&old])?;
            let read = saved(db, date("2026-11-13")?)?;
            assert!(read.selected_languages.is_empty());
            assert!(read.periods.is_empty());
            assert_eq!(db.query_row("SELECT config FROM language_comparison", [], |r| r.get::<_,String>(0))?, old);
            Ok(())
        }).await.unwrap();
        let mut c = config(&[("2026-03-01", "2026-03-02")], &[]);
        c.selected_languages = vec!["de".into(), "ja".into()];
        s.save_language_comparison(c, chrono_tz::UTC).await.unwrap();
        drop(s);
        let s = Store::open(path.clone()).unwrap();
        let read = s.language_comparison(Scope::default(), chrono_tz::UTC).await.unwrap();
        assert_eq!(read["config"]["baseRevision"], 1);
        assert_eq!(read["config"]["selectedLanguages"], json!(["de","ja"]));
        assert_eq!(read["groups"][0]["calendarDays"], 2);
        assert_eq!(read["groups"].as_array().unwrap().len(), 1);
        drop(s);
        std::fs::remove_file(path).unwrap();
    }
}

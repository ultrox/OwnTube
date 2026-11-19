//! Port of MediaServiceCore's TV Home request and shelf extraction boundary.
//! See AppClient.kt, BrowseApiHelper.kt, BrowseHelper.kt and CommonHelper.kt.
use super::*;

pub const USER_AGENT: &str = "Mozilla/5.0 (Linux armeabi-v7a; Android 7.1.2; Fire OS 6.0) Cobalt/22.lts.3.306369-gold (unlike Gecko) v8/8.8.278.8-jit gles Starboard/13, Amazon_ATV_mediatek8695_2019/NS6294 (Amazon, AFTMM, Wireless) com.amazon.firetv.youtube/22.3.r2.v66.0";

pub fn query(context: &Request, continuation: Option<&str>) -> Value {
    let mut body = json!({
        "context": {
            "client": {
                "clientName": "TVHTML5", "clientVersion": "7.20260901.15.00",
                "clientScreen": "WATCH", "userAgent": USER_AGENT,
                "browserName": "Cobalt", "browserVersion": "22.lts.3.306369-gold",
                "acceptLanguage": context.language, "acceptRegion": context.country,
                "utcOffsetMinutes": context.utc_offset_minutes.to_string(), "visitorData": context.visitor_data,
                "tvAppInfo": {"appQuality":"TV_APP_QUALITY_FULL_ANIMATION", "zylonLeftNav":true},
                "webpSupport": false, "animatedWebpSupport": true
            },
            "user": {"enableSafetyMode":false, "lockedSafetyMode":false}
        },
        "racyCheckOk":true, "contentCheckOk":true
    });
    if let Some(key) = continuation { body["continuation"] = json!(key); }
    else {
        body["browseId"] = json!(match context.category.as_str() {
            "music" => "FEtopics_music",
            "news" => "FEtopics_news",
            "gaming" => "FEtopics_gaming",
            "sports" => "FEtopics_sports",
            "live" => "FEtopics_live",
            "trending" => "FEtrending",
            _ => "default",
        });
        if context.category == "trending" { body["params"] = json!("6gQJRkVleHBsb3Jl"); }
    }
    body
}

pub struct Parsed { pub rows: Vec<ParsedRow>, pub next: Option<String> }
pub struct ParsedRow { pub title: String, pub items: Vec<Card>, pub next: Option<String> }

fn at<'a>(value: &'a Value, paths: &[&str]) -> &'a Value {
    paths.iter().find_map(|p| value.pointer(p)).unwrap_or(&Value::Null)
}
fn string(value: &Value) -> Option<String> { value.as_str().filter(|s| !s.is_empty()).map(str::to_owned) }
fn text(value: &Value) -> String {
    if let Some(s) = value.as_str().or_else(|| value["simpleText"].as_str()).or_else(|| value["content"].as_str()) { return s.into(); }
    value["runs"].as_array().map(|runs| runs.iter().filter_map(|r| r["text"].as_str()).collect::<String>()).unwrap_or_default()
}

// Search only inside one renderer/endpoint, never across a page: a parent card
// must not accidentally inherit an unrelated child video's identity.
fn find<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key).or_else(|| map.values().find_map(|v| find(v, key))),
        Value::Array(values) => values.iter().find_map(|v| find(v, key)),
        _ => None,
    }
}

fn continuation(value: &Value) -> Option<String> {
    value["continuations"].as_array().and_then(|entries| entries.iter().find_map(|c| {
        string(at(c, &["/nextContinuationData/continuation", "/reloadContinuationData/continuation"]))
    })).or_else(|| {
        at(value, &["/items", "/contents"]).as_array().and_then(|items| items.iter().find_map(|i| {
            string(at(i, &["/continuationItemRenderer/continuationEndpoint/continuationCommand/token"]))
        }))
    })
}

fn thumbnail(value: &Value) -> Option<String> {
    at(value, &["/thumbnails", "/sources"]).as_array()?.iter()
        .max_by_key(|t| t["width"].as_u64().unwrap_or(0))
        .and_then(|t| string(&t["url"]))
        // TV channel avatars use scheme-relative URLs, unlike video thumbnails.
        .map(|url| if url.starts_with("//") { format!("https:{url}") } else { url })
        .filter(|url| url.starts_with("https://"))
}

fn card(wrapper: &Value) -> Option<Card> {
    let (tile, value) = if let Some(tile) = wrapper.get("tileRenderer") { (true, tile) }
        else { (false, at(wrapper, &["/gridVideoRenderer", "/videoRenderer", "/playlistVideoRenderer", "/gridChannelRenderer", "/channelRenderer", "/gridPlaylistRenderer", "/playlistRenderer"])) };
    if value.is_null() { return None; }
    let endpoint = if tile { &value["onSelectCommand"] } else { &value["navigationEndpoint"] };
    let video_id = string(&value["videoId"]).or_else(|| find(endpoint, "videoId").and_then(string));
    let playlist_id = string(&value["playlistId"]).or_else(|| find(endpoint, "playlistId").and_then(string));
    let channel_id = string(&value["channelId"])
        .or_else(|| find(endpoint, "browseId").and_then(string))
        .or_else(|| find(at(value, &["/shortBylineText", "/longBylineText", "/ownerText"]), "browseId").and_then(string))
        .or_else(|| find(at(value, &["/menu", "/onLongPressCommand"]), "browseId").and_then(string));
    if video_id.is_none() && playlist_id.is_none() && channel_id.is_none() { return None; }
    let title = text(if tile { at(value, &["/metadata/tileMetadataRenderer/title", "/header/trackTileHeaderRenderer/title"]) }
        else { at(value, &["/title", "/headline"]) });
    let image = if tile { at(value, &["/header/tileHeaderRenderer/thumbnail", "/header/trackTileHeaderRenderer/thumbnail"]) } else { &value["thumbnail"] };
    let overlay = find(value, "thumbnailOverlayTimeStatusRenderer");
    let style = overlay.and_then(|o| o["style"].as_str()).unwrap_or("");
    let badge = overlay.map(|o| text(&o["text"])).filter(|s| !s.is_empty())
        .or_else(|| string(&value["lengthText"]["simpleText"]));
    let subtitle = if tile {
        value.pointer("/metadata/tileMetadataRenderer/lines").and_then(Value::as_array).map(|lines| {
            lines.iter().filter_map(|l| l.pointer("/lineRenderer/items").and_then(Value::as_array))
                .map(|items| items.iter().map(|i| text(&i["lineItemRenderer"]["text"])).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" "))
                .filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ")
        }).unwrap_or_default()
    } else {
        [text(at(value, &["/shortBylineText", "/longBylineText", "/ownerText"])), text(&value["viewCountText"]), text(&value["publishedTimeText"])]
            .into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ")
    };
    Some(Card { video_id, playlist_id, channel_id, title, subtitle, thumbnail: thumbnail(image), badge,
        is_live: style == "LIVE", is_upcoming: style == "UPCOMING" || value.get("upcomingEventData").is_some(),
        is_shorts: style == "SHORTS" || value["style"] == "TILE_STYLE_YTLR_SHORTS" })
}

fn items(container: &Value) -> Vec<Card> {
    at(container, &["/items", "/contents"]).as_array().map(|items| items.iter().filter_map(card).collect()).unwrap_or_default()
}

fn shelf(value: &Value) -> Option<ParsedRow> {
    let shelf = value.get("shelfRenderer")?;
    let container = at(shelf, &["/content/horizontalListRenderer", "/content/expandedShelfContentsRenderer", "/content/gridRenderer"]);
    if container.is_null() { return None; }
    Some(ParsedRow {
        title: text(at(shelf, &["/title", "/headerRenderer/shelfHeaderRenderer/avatarLockup/avatarLockupRenderer/title", "/headerRenderer/shelfHeaderRenderer/title"])),
        items: items(container), next: continuation(container)
    })
}

pub fn parse(value: &Value, is_row: bool) -> Result<Parsed> {
    if value.get("error").is_some() { return Err(upstream_error("YouTube rejected the Home request")); }
    if find(value, "feedNudgeRenderer").is_some() && find(value, "shelfRenderer").is_none() {
        return Err(upstream_error("YouTube Home requires sign-in or watch history. Check the selected TV account."));
    }
    let section = at(value, &[
        "/contents/tvBrowseRenderer/content/tvSurfaceContentRenderer/content/sectionListRenderer",
        "/continuationContents/sectionListContinuation",
        "/continuationContents/tvSurfaceContentContinuation/content/sectionListRenderer",
    ]);
    if !section.is_null() {
        let rows = section["contents"].as_array().ok_or_else(|| upstream_error("Unrecognized YouTube Home rows"))?
            .iter().filter_map(shelf).collect::<Vec<_>>();
        if is_row {
            let next = continuation(section).or_else(|| rows.first().and_then(|r| r.next.clone()));
            return Ok(Parsed { rows: vec![ParsedRow { title: String::new(), items: rows.into_iter().flat_map(|r| r.items).collect(), next }], next: None });
        }
        return Ok(Parsed { rows, next: continuation(section) });
    }
    let grid = at(value, &[
        "/contents/tvBrowseRenderer/content/tvSurfaceContentRenderer/content/gridRenderer",
        "/contents/tvBrowseRenderer/content/tvSurfaceContentRenderer/content/twoColumnRenderer/rightColumn/playlistVideoListRenderer",
        "/continuationContents/horizontalListContinuation",
        "/continuationContents/gridContinuation",
        "/continuationContents/playlistVideoListContinuation",
        "/continuationContents/tvSurfaceContentContinuation/content/gridRenderer",
    ]);
    if !grid.is_null() {
        return Ok(Parsed { rows: vec![ParsedRow { title: if is_row {String::new()} else {"Videos".into()}, items: items(grid), next: continuation(grid) }], next: None });
    }
    #[cfg(debug_assertions)]
    {
        fn renderers(value: &Value, names: &mut std::collections::BTreeSet<String>) {
            match value {
                Value::Object(map) => for (key, child) in map {
                    if key.ends_with("Renderer") || key.ends_with("Continuation") { names.insert(key.clone()); }
                    renderers(child,names);
                },
                Value::Array(values) => for child in values { renderers(child,names); },
                _ => {},
            }
        }
        let mut names = std::collections::BTreeSet::new();
        renderers(value,&mut names);
        eprintln!("Unsupported feed renderer shape (row={is_row}): {names:?}");
    }
    Err(upstream_error("YouTube Home format changed; no feed was substituted"))
}

use super::{Assessment, language};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;

fn code(raw: &str) -> Option<String> {
    let normalized = raw
        .trim()
        .to_lowercase()
        .replace(['‐', '‑', '‒', '–', '—', '―', '−'], "-");
    let mut value = normalized.as_str();
    for suffix in [" (original)", " (dubbed)", " (dubbed-auto)"] {
        if let Some(prefix) = value.strip_suffix(suffix) {
            value = prefix;
            break;
        }
    }
    let lang = language(value)?;
    // Assessments group spoken languages; the exact regional/script label stays
    // in immutable evidence (matching the collector's primary-language totals).
    let base = lang.split('-').next()?;
    Some(
        match base {
            "und" | "mul" | "zxx" => return None,
            "iw" => "he",
            "in" => "id",
            "ji" => "yi",
            _ => base,
        }
        .into(),
    )
}

fn fields(bytes: &[u8]) -> Option<Vec<(u32, &[u8])>> {
    fn int(bytes: &[u8], at: &mut usize) -> Option<u32> {
        let mut n = 0u32;
        for shift in (0..35).step_by(7) {
            let b = *bytes.get(*at)?;
            *at += 1;
            if shift == 28 && b > 15 {
                return None;
            }
            n |= u32::from(b & 127) << shift;
            if b & 128 == 0 {
                return Some(n);
            }
        }
        None
    }
    let mut at = 0;
    let mut result = Vec::new();
    while at < bytes.len() {
        let tag = int(bytes, &mut at)?;
        if tag >> 3 == 0 || tag & 7 != 2 {
            return None;
        }
        let size = int(bytes, &mut at)? as usize;
        let end = at.checked_add(size)?;
        result.push((tag >> 3, bytes.get(at..end)?));
        at = end;
    }
    Some(result)
}

pub(super) fn track_language(raw: &str) -> Option<String> {
    if raw.len() > 2000 {
        return None;
    }
    if let Some(lang) = code(raw) {
        return Some(lang);
    }
    if let Some((prefix, suffix)) = raw.split_once('.')
        && !suffix.is_empty()
        && suffix.bytes().all(|b| b.is_ascii_digit())
    {
        return code(prefix);
    }
    let (itag, encoded) = raw.split_once(';')?;
    if itag.is_empty() || itag.len() > 5 || !itag.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(encoded.trim_end_matches('=')).ok()?;
    let mut languages = Vec::new();
    for (tag, entry) in fields(&bytes)? {
        if tag != 1 {
            return None;
        }
        let pair = fields(entry)?;
        if pair.len() != 2 || pair[0].0 != 1 || pair[1].0 != 2 {
            return None;
        }
        if pair[0].1 == b"lang" {
            languages.push(code(std::str::from_utf8(pair[1].1).ok()?)?);
        }
    }
    (languages.len() == 1).then(|| languages[0].clone())
}

fn estimate(lang: String, source: &str, confidence: &str, reason: &str) -> Assessment {
    Assessment {
        lang,
        status: "estimated".into(),
        source: source.into(),
        confidence: confidence.into(),
        reason: reason.into(),
    }
}

pub(super) fn assess(evidence: &Value) -> Assessment {
    if let Some(lang) = [
        &evidence["selectedAudioTrackId"],
        &evidence["selectedAudioTrackMetadata"]["id"],
        &evidence["selectedAudioLanguage"],
    ]
    .into_iter()
    .find_map(|v| v.as_str().and_then(track_language))
    {
        return estimate(
            lang,
            "selected-audio-metadata",
            "high",
            "Language decoded from the saved selected audio track, including original/dub labels. Not the default track or subtitle language.",
        );
    }
    Assessment { lang:"und".into(), status:"undetermined".into(), source:"saved-evidence".into(),
        confidence:"unavailable".into(), reason:"The saved selected audio track has no decodable language. Default audio, captions and page text are not substituted for the track actually played.".into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn real_selected_track_ids_override_wrong_defaults_and_decode_tv_labels() {
        for raw in [
            "251;ChEKBWFjb250EghvcmlnaW5hbAoNCgRsYW5nEgVlbi1VUw",
            "251;ChEKBWFjb250EghvcmlnaW5hbAoNCgRsYW5nEgVlbi1VUwoHCgJ2YhIBMQ",
            "251;ChEKBWFjb250EghvcmlnaW5hbAoICgNkcmMSATEKDQoEbGFuZxIFZW4tVVM",
            "en‐us (dubbed-auto)",
            "en.4",
        ] {
            let result = assess(
                &json!({"selectedAudioLanguage":raw,"defaultAudioLanguage":"de-DE","captions":[{"kind":"asr","language":"de"}]}),
            );
            assert_eq!(result.lang, "en", "{raw}");
            assert!(!result.review());
        }
        assert_eq!(track_language("de‐de (original)").as_deref(), Some("de"));
        assert_eq!(
            track_language("251;ChEKBWFjb250EghvcmlnaW5hbAoICgNkcmMSATEKDQoEbGFuZxIFZGUtREU")
                .as_deref(),
            Some("de")
        );
        for raw in [
            "und",
            "251;broken",
            "251;ChEKBWFjb250EghvcmlnaW5hbAoNCgRsYW5nEgVlbi1V",
            "lang=en-US",
            "English",
        ] {
            assert!(track_language(raw).is_none(), "{raw}");
        }
    }
}

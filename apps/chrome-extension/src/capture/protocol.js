export const CHANNEL = 'youtube-observer/v1';
export const SIGNAL = 'youtube-observer/player/v1';
export const LANGS = ['de', 'en', 'bcs', 'es', 'other'];
export const SOURCES = ['manual-caption', 'audio-track', 'asr-caption', 'caption-heuristic', 'title-heuristic', 'description-heuristic', 'native-text', 'unknown', 'query-trigram'];
export const CONFIDENCE = ['high', 'medium', 'low'];
export const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const isTime = value => Number.isFinite(value) && value >= 0 && value < 8640000000000000;
export const isId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
export const isVideoId = value => typeof value === 'string' && /^[\w-]{11}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const duration = value => value === undefined || value === null || (Number.isFinite(value) && value > 0 && value <= 31536000);

export function isEvidence(value) {
  return isRecord(value) && value.schemaVersion === 1 && text(value.algorithmVersion,40) && text(value.title,500) && text(value.description,10000) &&
    ['videoDetails.shortDescription','microformat.description','none'].includes(value.descriptionSource) && typeof value.descriptionTruncated === 'boolean' &&
    text(value.selectedAudioLanguage,200) && text(value.defaultAudioLanguage,200) &&
    (value.selectedAudioTrackId === undefined || text(value.selectedAudioTrackId,2000)) &&
    (value.selectedAudioTrackMetadata == null || (isRecord(value.selectedAudioTrackMetadata) &&
      text(value.selectedAudioTrackMetadata.id,2000) && text(value.selectedAudioTrackMetadata.name,200) &&
      typeof value.selectedAudioTrackMetadata.isAutoDubbed === 'boolean')) &&
    Array.isArray(value.captions) && value.captions.length <= 100 && value.captions.every(row => isRecord(row) && text(row.language,64) && ['asr','manual'].includes(row.kind)) &&
    isRecord(value.text) && ['chrome-language-detector','local-trigram'].includes(value.text.engine) &&
    ['available','downloadable','downloading','loading','unavailable','unsupported','error','too-short'].includes(value.text.status) &&
    ['description','title'].includes(value.text.input) && text(value.text.language,64) &&
    (value.text.confidence === null || (Number.isFinite(value.text.confidence) && value.text.confidence >= 0 && value.text.confidence <= 1)) &&
    Array.isArray(value.text.candidates) && value.text.candidates.length <= 5 && value.text.candidates.every(row => isRecord(row) && text(row.language,64) && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1);
}

export function normalise(value) {
  if (typeof value !== 'string' || !/^[a-z]{2,5}(?:-[a-z0-9]{1,8})*$/i.test(value)) return 'other';
  const base = value.toLowerCase().split('-')[0];
  return ['sr','hr','bs','sh','bcs'].includes(base) ? 'bcs' : LANGS.includes(base) ? base : 'other';
}

export function isSignal(value) {
  return isRecord(value) && value.tag === SIGNAL && isVideoId(value.videoId) && text(value.title, 500) &&
    (value.channel === undefined || text(value.channel, 200)) &&
    (value.evidence === undefined || isEvidence(value.evidence)) &&
    duration(value.durationSeconds) && (value.isLive === undefined || typeof value.isLive === 'boolean') &&
    (value.isShort === undefined || typeof value.isShort === 'boolean') &&
    LANGS.includes(value.lang) && CONFIDENCE.includes(value.conf) && SOURCES.includes(value.source);
}

export function isEvent(value, now = Date.now()) {
  if (!isRecord(value) || !isId(value.eventId) || !isTime(value.t) || value.t > now + 60000 ||
      !LANGS.includes(value.lang) || !CONFIDENCE.includes(value.conf) || !SOURCES.includes(value.source)) return false;
  if (value.kind === 'search') return text(value.query, 1000) && value.query.trim().length > 0 && value.source === 'query-trigram';
  if(value.kind==='viewing')return isVideoId(value.videoId)&&isId(value.viewingId)&&text(value.title,500)&&
    (value.channel===undefined||text(value.channel,200))&&duration(value.durationSeconds)&&
    (value.evidence===undefined||isEvidence(value.evidence))&&
    Number.isSafeInteger(value.revision)&&value.revision>0&&Number.isSafeInteger(value.bucket)&&value.bucket>=0&&value.bucket%900000===0&&
    Number.isFinite(value.lastWatched)&&value.lastWatched>value.t&&value.lastWatched<=now+60000&&value.t>=value.bucket&&value.lastWatched<=value.bucket+900000&&
    Number.isFinite(value.seconds)&&value.seconds>0&&value.seconds<=900.001&&value.seconds<=(value.lastWatched-value.t)/1000+.001&&
    Array.isArray(value.coverage)&&value.coverage.length<=2000&&value.coverage.every(r=>Array.isArray(r)&&r.length===2&&r.every(Number.isFinite)&&r[0]>=0&&r[1]>r[0]&&r[1]<=value.durationSeconds)&&
    ['foreground','background'].includes(value.playbackContext);
  return value.kind === 'watch' && isVideoId(value.videoId) && text(value.title, 500) &&
    (value.channel === undefined || text(value.channel, 200)) &&
    (value.evidence === undefined || isEvidence(value.evidence)) &&
    duration(value.durationSeconds) &&
    (value.isShort === undefined || typeof value.isShort === 'boolean') &&
    (value.coverage === undefined || (Array.isArray(value.coverage) && value.coverage.length === 2 && value.coverage.every(Number.isFinite) && value.coverage[0] >= 0 && value.coverage[1] > value.coverage[0] && value.coverage[1] <= value.durationSeconds && value.coverage[1] - value.coverage[0] <= value.seconds * 16 + 0.5)) &&
    (value.playbackContext === undefined || ['foreground','background'].includes(value.playbackContext)) &&
    Number.isFinite(value.seconds) && value.seconds > 0 && value.seconds <= 20 &&
    (value.searchId === undefined || value.searchId === null || isId(value.searchId));
}

export function isOutbound(value) {
  if (!isRecord(value)) return false;
  switch (value.tag) {
    case 'GetSnapshot': return ['7d','30d','all'].includes(value.range) && (value.includeHistory === undefined || typeof value.includeHistory === 'boolean');
    case 'SetTargetLang': return LANGS.includes(value.lang);
    case 'SetHistoryCollapsed': return typeof value.collapsed === 'boolean';
    case 'SetVideoLanguage': return isVideoId(value.videoId) && (value.lang === null || LANGS.includes(value.lang));
    case 'SetSlanInstalledAt': return value.at === null || isTime(value.at);
    case 'OpenDashboard': return value.section === undefined || ['settings', 'watched-videos'].includes(value.section);
    case 'ExportShareCard': return true;
    default: return false;
  }
}

export const attempt = action => Promise.resolve().then(action).then(value => ({ ok: true, value }), error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));

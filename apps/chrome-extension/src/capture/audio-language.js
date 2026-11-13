// YouTube track IDs are either language IDs (en.4) or itag;base64url protobuf.
// Decode the named `lang` field, never an arbitrary substring or the viewer's default.
export function languageCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/ \((?:original|dubbed|dubbed-auto)\)$/i, '').toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/.test(code) || /^(und|mul|zxx)(-|$)/.test(code)) return null;
  return code;
}

function fields(bytes) {
  let at = 0;
  const result = [];
  const int = () => {
    let n = 0, shift = 0;
    for (let i = 0; i < 5; i++) {
      if (at >= bytes.length) throw Error('truncated');
      const b = bytes[at++]; n += (b & 127) * 2 ** shift;
      if (!(b & 128)) return n;
      shift += 7;
    }
    throw Error('oversized');
  };
  while (at < bytes.length) {
    const tag = int();
    if (!(tag >> 3) || (tag & 7) !== 2) throw Error('unexpected field');
    const size = int(), end = at + size;
    if (end > bytes.length) throw Error('truncated');
    result.push([tag >> 3, bytes.slice(at, end)]); at = end;
  }
  return result;
}

export function trackLanguage(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  const direct = languageCode(value);
  if (direct) return direct;
  const legacy = /^([a-z]{2,3}(?:-[a-z0-9]{1,8})*)\.\d+$/i.exec(value);
  if (legacy) return languageCode(legacy[1]);
  const encoded = /^\d{1,5};([A-Za-z0-9_-]+)={0,2}$/.exec(value)?.[1];
  if (!encoded) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true });
    const languages = [];
    for (const [tag, entry] of fields(bytes)) {
      if (tag !== 1) return null;
      const pair = fields(entry);
      if (pair.length !== 2 || pair[0][0] !== 1 || pair[1][0] !== 2) return null;
      if (text.decode(pair[0][1]) === 'lang') languages.push(languageCode(text.decode(pair[1][1])));
    }
    return languages.length === 1 ? languages[0] : null;
  } catch { return null; }
}

// YouTube currently nests selected-track metadata under a minified key. Match its
// audio-specific shape, not that key, and never traverse caption/default objects.
export function selectedMetadata(track) {
  if (!track || typeof track !== 'object') return null;
  const matches = Object.values(track).slice(0, 64).filter(v =>
    v && !Array.isArray(v) && typeof v.name === 'string' &&
    typeof v.id === 'string' && typeof v.isAutoDubbed === 'boolean');
  if (matches.length !== 1) return null;
  const v = matches[0];
  return { id: v.id.slice(0, 2000), name: v.name.slice(0, 200), isAutoDubbed: v.isAutoDubbed };
}

export const selectedLanguage = track => {
  for (const value of [track?.languageCode, track?.language, track?.id]) {
    const code = trackLanguage(value);
    if (code) return code;
  }
  return trackLanguage(selectedMetadata(track)?.id);
};

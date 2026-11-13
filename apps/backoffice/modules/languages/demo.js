// Demo adapter for the Languages module. Loaded only for an explicit `?demo=1`; never used as a
// fallback when the live API fails. Implements contracts/languages.md in memory with fictional
// data (no real people, devices or videos) and makes no network requests. Reload to reset.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PAGE = 20;
// Mirrors server/src/languages.rs `language`: a bounded, lowercased BCP-47-shaped code or null.
function language(value) {
  const v = String(value ?? '').trim().toLowerCase();
  const parts = v.split('-');
  const primary = parts[0];
  if (v.length > 35 || primary === 'other' || !/^[a-z]{2,3}$/.test(primary)
    || parts.slice(1).some((p) => !/^[a-z0-9]{1,8}$/.test(p))
    || (['und', 'mul', 'zxx'].includes(primary) && parts.length !== 1)) return null;
  return v;
}
const fail = (status, error) => Object.assign(new Error(error), { name: 'ApiError', status, body: { error } });
const later = (value, ms = 90) => new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

const PEOPLE = [{ id: 'demo-owner', name: 'Owner' }, { id: 'demo-guest', name: 'Guest' }];
const DEVICES = [
  { id: 'demo-living', label: 'Living room TV', personId: 'demo-owner', person: 'Owner' },
  { id: 'demo-bedroom', label: 'Bedroom TV', personId: 'demo-guest', person: 'Guest' },
  { id: 'demo-laptop', label: 'Laptop', personId: 'demo-owner', person: 'Owner' },
];

const chrome = (title, description, { sel = '', def = '', captions = [], text = null } = {}) => ({
  schemaVersion: 1, algorithmVersion: 'language-v2', title, description,
  descriptionSource: description ? 'videoDetails.shortDescription' : 'none', descriptionTruncated: false,
  selectedAudioLanguage: sel, defaultAudioLanguage: def, captions,
  text: text || { engine: 'local-trigram', status: 'unsupported', input: description ? 'description' : 'title', language: 'other', confidence: null, candidates: [] },
});
const android = (videoId, title, description, { captions = [], selected = '' } = {}) => {
  const ev = {
    schemaVersion: 1, collector: 'owntube-source-v1', videoId, languageAnalysis: 'not-run',
    defaultAudioLanguageStatus: 'not-exposed-by-MediaFormat', title, description: description ?? '',
    titleSource: 'MediaItemFormatInfo.getTitle', descriptionAvailable: description != null, descriptionTruncated: false,
    captions, captionsSource: 'MediaItemFormatInfo.getSubtitles; tlang options excluded; same-URL aliases deduplicated',
    captionCount: captions.length, captionTranslationOptionsOmitted: captions.length ? 154 : 0,
  };
  if (selected) {
    ev.selectedAudioLanguage = selected;
    ev.selectedAudioLanguageSource = 'SimpleExoPlayer.getAudioFormat.language (player-normalized)';
  }
  return ev;
};
const asr = (language) => ({ language, kind: 'asr' });

/* [device, metadataId, videoId, title, channel, recorded [lang, source, conf], evidence|null, plays [[daysAgo, hour, fg, bg, un]], seeded history (oldest first)] */
const RECORDS = [
  ['demo-living', 'm-zahnrad', 'demoZahnrad01', 'Wie funktioniert eine Zahnradbahn? Rigi, Pilatus und die Technik dahinter', 'Alpine Rail Archive', ['de', 'audio-track', 'high'],
    (v, t) => android(v, t, 'Wie Zahnradbahnen steile Strecken schaffen, erklärt an Rigi und Pilatus.', { captions: [asr('de')], selected: 'de' }), [[0, 9, 1122, 0, 0]]],
  ['demo-living', 'm-gotthard', 'demoGotthard2', 'Gotthard-Bergstrecke im Winter: Führerstandsmitfahrt', 'Alpine Rail Archive', ['de', 'audio-track', 'high'],
    (v, t) => android(v, t, 'Führerstandsmitfahrt ohne Kommentar, nur Fahrgeräusche.', { selected: 'de' }), [[1, 20, 2310, 0, 0], [12, 19, 1800, 600, 0]]],
  ['demo-laptop', 'm-ajvar', 'demoAjvar0003', 'Kako se pravi pravi ajvar — recept moje bake', 'Kuhinja kod Mire', ['sr', 'audio-track', 'high'],
    (v, t) => chrome(t, 'Pečene paprike i puno strpljenja. Recept korak po korak.', { sel: 'sr', def: 'sr', captions: [asr('sr')] }), [[1, 13, 862, 0, 0]],
    [['manual', 'sr', 'Checked: Serbian audio throughout.', 3]]],
  ['demo-living', 'm-djerdap', 'demoDjerdap04', 'Ђердапска клисура из ваздуха — пловидба од Голупца до Кладова', 'Дунавски записи', ['', 'android-player', ''],
    (v, t) => android(v, t, 'Пловидба Дунавом кроз Ђердапску клисуру, снимано дроном.', { captions: [asr('sr')] }), [[1, 21, 1500, 314, 0]]],
  ['demo-laptop', 'm-lathe', 'demoLathe0005', 'I restored a 1962 lathe and it changed how I think about tools', 'Small Workshop', ['en', 'audio-track', 'high'],
    (v, t) => chrome(t, 'A slow restoration of an old lathe, with every mistake left in.', { sel: 'en', def: 'en', captions: [asr('en'), { language: 'de', kind: 'manual' }] }), [[2, 18, 1450, 0, 0]]],
  ['demo-laptop', 'm-brahms', 'demoBrahms006', 'Brahms im Wohnzimmer: Klarinettentrio a-Moll', 'Hausmusik am Sonntag', ['und', 'unknown', 'low'],
    (v, t) => chrome(t, 'Johannes Brahms, Klarinettentrio a-Moll op. 114. Hausmusik.', { def: 'und', text: { engine: 'chrome-language-detector', status: 'available', input: 'description', language: 'de', confidence: 0.96, candidates: [{ language: 'de', confidence: 0.96 }] } }),
    [[1, 22, 0, 1634, 0]], [['manual', 'zxx', 'Instrumental. No speech at all.', 2]]],
  ['demo-living', 'm-rhine', 'demoRhine0007', 'Four hours on the Rhine: Basel to Strasbourg, no narration', 'Slow Rivers', ['en', 'description-heuristic', 'low'],
    (v, t) => android(v, t, 'Four hours on the Rhine. No narration, no music, ambient sound only.'), [[2, 14, 3900, 1520, 0]]],
  ['demo-laptop', 'm-twolang', 'demoTwoLang08', 'Zwei Sprachen, ein Tisch: ein Gespräch auf Deutsch und Serbisch', 'Map Room', ['de', 'audio-track', 'high'],
    (v, t) => chrome(t, 'Ein Gespräch, das zwischen Deutsch und Serbisch wechselt.', { sel: 'de', def: 'de' }), [[3, 20, 2100, 0, 0]],
    [['manual', 'mul', 'About half German, half Serbian.', 3]]],
  ['demo-bedroom', 'm-top10', 'demoTop100009', 'TOP 10 SCARIEST things caught on camera (#7 will SHOCK you)', 'TOP10 SHOCK', ['en', 'description-heuristic', 'low'],
    null, [[0, 23, 0, 0, 728]]],
  ['demo-laptop', 'm-luthier', 'demoLuthier10', 'Le métier de luthier : une guitare en douze semaines', 'Atelier Bois', ['fr', 'audio-track', 'high'],
    (v, t) => chrome(t, 'Douze semaines dans un atelier de lutherie.', { sel: 'fr', def: 'fr' }), [[4, 17, 1240, 60, 0]]],
  ['demo-laptop', 'm-stalker-en', 'demoStalker11', 'How Tarkovsky films a room: the long take in Stalker', 'The Long Take', ['en', 'audio-track', 'high'],
    (v, t) => chrome(t, 'A close reading of one room in Stalker.', { sel: 'en', def: 'en' }), [[2, 21, 1265, 0, 0]]],
  // The same video on the TV played a German dub: a different recorded version with its own language.
  ['demo-living', 'm-stalker-de', 'demoStalker11', 'How Tarkovsky films a room: the long take in Stalker', 'The Long Take', ['de', 'audio-track', 'high'],
    (v, t) => android(v, t, 'A close reading of one room in Stalker.', { selected: 'de' }), [[3, 21, 1265, 0, 0]],
    [['analyze', 'de', null, 2]]],
  ['demo-living', 'm-eis', 'demoEis000012', 'Warum Eis glatt ist – und warum wir es lange falsch erklärt haben', 'Physik im Alltag', ['de', 'audio-track', 'high'],
    (v, t) => android(v, t, null), [[4, 19, 775, 0, 0]]],
  ['demo-laptop', 'm-balkan', 'demoBalkan013', 'Why every map of the Balkans is a little bit wrong', 'Map Room', ['en', 'audio-track', 'high'],
    (v, t) => chrome(t, 'Borders, names and the maps that disagree about them.', { sel: 'en', def: 'en' }), [[5, 12, 993, 0, 0], [20, 12, 400, 0, 0]]],
  ['demo-bedroom', 'm-rijaliti', 'demoRijal0014', 'Rijaliti: ko je ispao sinoć? Sve što ste propustili', 'Rijaliti danas', ['sr', 'native-text', 'medium'],
    null, [[0, 21, 0, 0, 655], [0, 22, 0, 0, 120]]],
  ['demo-laptop', 'm-dashi', 'demoDashi0015', 'Dashi from scratch: kombu and katsuobushi', 'Kitchen Notes', ['ja', 'audio-track', 'high'],
    (v, t) => chrome(t, 'Making dashi the slow way.', { sel: 'ja', def: 'ja', captions: [{ language: 'en', kind: 'manual' }] }), [[6, 19, 840, 0, 0]]],
  ['demo-bedroom', 'm-unbox', 'demoUnbox0016', 'Unboxing 47 mystery boxes from an auction', 'Unboxing Loop', ['', 'android-player', ''],
    null, [[1, 23, 0, 0, 2642]]],
  ['demo-bedroom', 'm-mystery', 'demoMyst00017', 'The mystery of the empty town (part 3)', 'Mystery Shorts 24/7', ['', 'android-player', ''],
    null, [[2, 22, 0, 0, 99]]],
  ['demo-living', 'm-news', 'demoNews00018', 'Was heute wichtig ist: Bahnstreik, Wahlen, Wetter', 'Tagesnotizen', ['de', 'native-text', 'medium'],
    (v, t) => android(v, t, 'Die wichtigsten Meldungen des Tages in sechs Minuten.'), [[0, 7, 372, 0, 0]]],
  ['demo-laptop', 'm-derby', 'demoDerby0019', 'Derby notes: what changed after the red card', 'Derby Notes', ['en', 'audio-track', 'high'],
    (v, t) => chrome(t, 'A tactical look at the second half.', { sel: 'en', def: 'en' }), [[9, 20, 825, 0, 0]]],
  ['demo-laptop', 'm-plane', 'demoPlane0020', 'Sharpening a plane iron by hand: the only three things that matter', 'Small Workshop', ['en', 'asr-caption', 'medium'],
    (v, t) => chrome(t, 'Flat back, consistent bevel, no burr.', { captions: [asr('en')] }), [[0, 8, 520, 120, 0]]],
  ['demo-living', 'm-forelle', 'demoForel0021', 'Schubert: Forellenquintett, 4. Satz — Hausmusik in Winterthur', 'Hausmusik am Sonntag', ['', 'android-player', ''],
    (v, t) => android(v, t, 'Franz Schubert, Klavierquintett A-Dur D 667, 4. Satz.'), [[3, 20, 527, 0, 0]]],
  ['demo-laptop', 'm-house', 'demoHouse0022', 'The border that runs through a single house', 'Map Room', ['en', 'audio-track', 'high'],
    (v, t) => chrome(t, 'A house, two countries, one kitchen.', { sel: 'en', def: 'en' }), [[35, 10, 598, 0, 0]]],
  ['demo-living', 'm-cabride', 'demoCabRide23', 'Swiss rail in winter: cab ride over the pass', 'Alpine Rail Archive', ['de', 'audio-track', 'high'],
    (v, t) => android(v, t, 'Cab ride over the pass in snow.', { selected: 'de' }), [[60, 18, 4360, 0, 0]]],
  // A long multi-word channel name: on a phone it must wrap inside the row, not widen the page.
  ['demo-laptop', 'm-neon', 'demoNeonSign24', 'How neon signs are bent by hand, one glass tube at a time', 'Northfield Workshop Restoration and Repair Notes', ['en', 'audio-track', 'high'],
    (v, t) => chrome(t, 'Bending glass tubes over a ribbon burner.', { sel: 'en', def: 'en' }), [[0, 15, 610, 0, 0]]],
];

// Mirrors `baseline`: the original collector interpretation, always an estimate needing review.
function collectorAssessment(rec) {
  const lang = language(rec.lang) || 'und';
  const unknown = lang === 'und';
  return {
    lang, status: unknown ? 'undetermined' : 'estimated', source: `collector:${rec.source || ''}`,
    confidence: unknown ? 'unavailable' : ['high', 'medium', 'low'].includes(rec.conf) ? rec.conf : 'low',
    reason: unknown ? 'The collector did not determine the audio language.'
      : 'Original collector estimate; it may describe default audio, captions or text rather than the track actually played.',
  };
}
// Mirrors `Assessment::review`: only confirmed rows and high-confidence selected-audio (or
// audio-based external) estimates are settled; undetermined always needs review, manual `und` too.
const needsReview = (a) => a.status !== 'confirmed'
  && !(a.status === 'estimated' && a.confidence === 'high' && ['selected-audio-metadata', 'external-api:audio'].includes(a.source));
function pick(a) {
  return { lang: a.lang, status: a.status, source: a.source, confidence: a.confidence, reason: a.reason };
}

// Mirrors `saved_audio`: only the top-level selected-audio language label counts.
function analyzeSaved(ev) {
  const selected = language(ev?.selectedAudioLanguage);
  if (selected && selected !== 'und') {
    return { lang: selected, status: 'estimated', source: 'selected-audio-metadata', confidence: 'high', reason: 'Language label saved for the selected audio track. Metadata evidence, not speech recognition.' };
  }
  return { lang: 'und', status: 'undetermined', source: 'saved-evidence', confidence: 'unavailable', reason: 'No usable selected-audio language was recorded. Default audio, titles and caption lists do not establish which audio was heard.' };
}

async function sha256(text) {
  if (!globalThis.crypto?.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createDemoApi({ external = false } = {}) {
  const now = Date.now();
  const midnight = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const providers = [{ id: 'saved-evidence', label: 'Saved audio metadata' }, ...(external ? [{ id: 'external', label: 'Configured analysis API (demo)' }] : [])];
  const records = [];
  for (const [deviceId, metadataId, videoId, title, channel, [lang, source, conf], evFn, plays, seeded = []] of RECORDS) {
    const evidence = evFn ? evFn(videoId, title) : null;
    const evidenceText = evidence ? JSON.stringify(evidence) : null;
    const recorded = { lang, source, conf };
    const rec = {
      deviceId, metadataId, videoId, title, channel, recorded, evidence, evidenceText,
      evidenceId: evidenceText ? await sha256(evidenceText) : null,
      plays: plays.map(([daysAgo, hour, fg, bg, un]) => ({ at: Math.min(midnight - daysAgo * DAY + hour * HOUR, now - 5 * MIN), fg, bg, un })),
      assessment: collectorAssessment(recorded), revision: 0, history: [],
    };
    for (const [action, l, note, daysAgo] of seeded) apply(rec, { action, lang: l, note }, now - daysAgo * DAY);
    records.push(rec);
  }

  function apply(rec, { action, lang, note }, at = Date.now()) {
    if (action === 'manual') rec.assessment = { lang, status: lang === 'und' ? 'undetermined' : 'confirmed', source: 'manual', confidence: 'human', reason: 'Owner classification of this recorded audio version on this device.' };
    else if (action === 'reset') rec.assessment = collectorAssessment(rec.recorded);
    else rec.assessment = { ...analyzeSaved(rec.evidence) };
    rec.revision += 1;
    rec.history.unshift({ revision: rec.revision, action, ...pick(rec.assessment), note: note || '', createdAt: at });
  }

  const scopeOf = ({ days = 7, device = '', person = '' }) => {
    const n = [7, 30, 90].includes(Number(days)) ? Number(days) : 7;
    const start = new Date(midnight - (n - 1) * DAY).setHours(0, 0, 0, 0);
    const devices = DEVICES.filter((d) => (!device || d.id === device) && (!person || d.personId === person)).map((d) => d.id);
    const rows = [];
    for (const r of records) {
      if (!devices.includes(r.deviceId)) continue;
      const ps = r.plays.filter((p) => p.at >= start && p.at <= Date.now());
      if (!ps.length) continue;
      const fg = ps.reduce((s, p) => s + p.fg, 0), bg = ps.reduce((s, p) => s + p.bg, 0), un = ps.reduce((s, p) => s + p.un, 0);
      rows.push({ r, seconds: fg + bg + un, fg, bg, un, lastWatched: Math.max(...ps.map((p) => p.at)) });
    }
    return { n, start, rows };
  };
  const rowOut = ({ r, seconds, fg, bg, un, lastWatched }) => ({
    deviceId: r.deviceId, deviceLabel: DEVICES.find((d) => d.id === r.deviceId).label, metadataId: r.metadataId, videoId: r.videoId,
    title: r.title, channel: r.channel, seconds, foregroundSeconds: fg, backgroundSeconds: bg, unspecifiedSeconds: un, lastWatched,
    evidenceId: r.evidenceId, recorded: { ...r.recorded }, assessment: pick(r.assessment), revision: r.revision, needsReview: needsReview(r.assessment),
  });
  const find = (deviceId, metadataId) => records.find((r) => r.deviceId === deviceId && r.metadataId === metadataId);

  return {
    mode: 'demo',
    session: () => later({ ok: true }, 20),
    login: () => later({ ok: true }, 20),
    logout: () => later({ ok: true }, 20),
    languages(q) {
      const { n, start, rows } = scopeOf(q);
      const sum = (f) => rows.reduce((s, x) => s + f(x), 0);
      const byLang = new Map();
      for (const x of rows) {
        const e = byLang.get(x.r.assessment.lang) || { lang: x.r.assessment.lang, seconds: 0, ids: new Set() };
        e.seconds += x.seconds;
        e.ids.add(x.r.videoId);
        byLang.set(x.r.assessment.lang, e);
      }
      const text = String(q.query || '').trim().toLowerCase().slice(0, 200);
      const filtered = rows
        .filter((x) => !q.language || q.language === 'all' || x.r.assessment.lang === q.language)
        .filter((x) => !q.status || q.status === 'all' || (q.status === 'review' ? needsReview(x.r.assessment) : x.r.assessment.status === q.status))
        .filter((x) => !text || [x.r.title, x.r.channel, x.r.videoId].join(' ').toLowerCase().includes(text))
        .sort((a, b) => b.lastWatched - a.lastWatched);
      const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
      const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
      return later({
        seconds: sum((x) => x.seconds), foregroundSeconds: sum((x) => x.fg), backgroundSeconds: sum((x) => x.bg), unspecifiedSeconds: sum((x) => x.un),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, since: start, until: Date.now(), days: n,
        devices: DEVICES.map((d) => ({ ...d })), people: PEOPLE.map((p) => ({ ...p })), providers,
        languages: [...byLang.values()].map((e) => ({ lang: e.lang, seconds: e.seconds, videoCount: e.ids.size })).sort((a, b) => b.seconds - a.seconds),
        reviewSeconds: sum((x) => (needsReview(x.r.assessment) ? x.seconds : 0)),
        confirmedSeconds: sum((x) => (x.r.assessment.status === 'confirmed' ? x.seconds : 0)),
        estimatedSeconds: sum((x) => (x.r.assessment.status === 'estimated' ? x.seconds : 0)),
        videoCount: new Set(rows.map((x) => x.r.videoId)).size,
        count: filtered.length, page, pages,
        videos: filtered.slice((page - 1) * PAGE, page * PAGE).map(rowOut),
      });
    },
    evidence(device, metadata) {
      const r = find(device, metadata);
      if (!r) return Promise.reject(fail(404, 'Record not found.'));
      return later({
        videoId: r.videoId, title: r.title, deviceId: r.deviceId, metadataId: r.metadataId, evidenceId: r.evidenceId,
        evidenceText: r.evidenceText, evidence: r.evidence, recorded: { ...r.recorded }, assessment: pick(r.assessment), revision: r.revision,
        history: r.history.slice(0, 100), historyLimit: 100, historyHasMore: r.history.length > 100,
      });
    },
    assess(body) {
      const r = find(body.deviceId, body.metadataId);
      if (!r) return Promise.reject(fail(404, 'Record not found.'));
      if (Number(body.baseRevision) !== r.revision) return Promise.reject(fail(409, `Stale revision: this record is at revision ${r.revision}.`));
      if (body.action === 'manual') {
        const l = language(body.lang);
        if (!l) return Promise.reject(fail(400, 'Invalid language code.'));
        apply(r, { action: 'manual', lang: l, note: body.note });
        return later({ ok: true, revision: r.revision, assessment: pick(r.assessment) }, 150);
      } else if (body.action === 'analyze') {
        if (r.assessment.source === 'manual') return Promise.reject(fail(409, 'A manual classification is never replaced by automatic analysis.'));
        if (body.provider && !providers.some((p) => p.id === body.provider)) return Promise.reject(fail(400, 'Unknown analysis provider.'));
        if (body.provider === 'external') {
          r.revision += 1;
          // Shaped like the server's external result: basis "metadata" stays an estimate needing review.
          const lang = language(r.evidence?.text?.language) || 'und';
          r.assessment = { lang, status: lang === 'und' ? 'undetermined' : 'estimated', source: 'external-api:metadata', confidence: 'medium', reason: 'Demo answer based on metadata, not on the audio.' };
          r.history.unshift({ revision: r.revision, action: 'analyze', ...pick(r.assessment), note: '', createdAt: Date.now() });
          return later({ ok: true, revision: r.revision, assessment: pick(r.assessment) }, 250);
        }
      } else if (body.action !== 'reset') {
        return Promise.reject(fail(400, 'Unknown action.'));
      }
      apply(r, { action: body.action, lang: body.lang, note: body.note });
      return later({ ok: true, revision: r.revision, assessment: pick(r.assessment) }, 150);
    },
  };
}

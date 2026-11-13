/*
 * OwnTube backoffice design preview — SAMPLE DATA ONLY.
 *
 * Every channel, video, playlist, revision, history entry and search below is fictional and exists only
 * to exercise the design. Names are invented archetypes; no real creator is suggested or blocked.
 * IDs start with "smp" and are never linked to YouTube. Times are offsets from the moment the
 * sample is (re)seeded, so the preview always looks current.
 *
 * Artwork is described, not stored: `art.m` picks a motif drawn by app.js, `art.c` its colours.
 * Loud motifs ("face", "type") imitate clickbait thumbnails on purpose, so the curation story is
 * visible at a glance; calm motifs stand in for the kind of video someone would suggest.
 */
window.OwnTubeFixtures = (() => {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  const channels = [
    // Calm, suggestable channels
    { id: 'smpCalpine', name: 'Alpine Rail Archive', lang: 'de', color: '#2F3E35' },
    { id: 'smpCworkshop', name: 'Small Workshop', lang: 'en', color: '#5A3E2B' },
    { id: 'smpCkuhinja', name: 'Kuhinja kod Mire', lang: 'sr-Latn', color: '#8E2C1B' },
    { id: 'smpCdunav', name: 'Дунавски записи', lang: 'sr-Cyrl', color: '#2D3A4A' },
    { id: 'smpCslow', name: 'Slow Rivers', lang: 'en', color: '#3F5B66' },
    { id: 'smpCphysik', name: 'Physik im Alltag', lang: 'de', color: '#55606B' },
    { id: 'smpClongtake', name: 'The Long Take', lang: 'en', color: '#3B3C38' },
    { id: 'smpChausmusik', name: 'Hausmusik am Sonntag', lang: 'de', color: '#7A4A2A' },
    { id: 'smpCmaproom', name: 'Map Room', lang: 'en', color: '#4E6B78' },
    // Neutral channels that appear in the sample feed
    { id: 'smpCpixel', name: 'Pixel Bench', lang: 'en', color: '#30343A' },
    { id: 'smpCspeedrun', name: 'Speedrun Corner', lang: 'en', color: '#3A2F5C' },
    { id: 'smpCderby', name: 'Derby Notes', lang: 'en', color: '#24513A' },
    { id: 'smpCnotiz', name: 'Tagesnotizen', lang: 'de', color: '#5C5F62' },
    // Loud archetypes — the kind of channel someone blocks
    { id: 'smpCdrama', name: 'Drama Recap Daily', lang: 'en', color: '#C4161C' },
    { id: 'smpCreacts', name: 'Reacts to Reacts', lang: 'en', color: '#E05A00' },
    { id: 'smpCtop10', name: 'TOP10 SHOCK', lang: 'en', color: '#D10A0A' },
    { id: 'smpCprank', name: 'Prank Lab TV', lang: 'en', color: '#E8B400' },
    { id: 'smpCcrypto', name: 'Crypto Signals Live', lang: 'en', color: '#1F9D55' },
    { id: 'smpCrijaliti', name: 'Rijaliti danas', lang: 'sr-Latn', color: '#C2187A' },
    { id: 'smpCmystery', name: 'Mystery Shorts 24/7', lang: 'en', color: '#4B0FA3' },
    { id: 'smpCunbox', name: 'Unboxing Loop', lang: 'en', color: '#D9480F' },
  ];

  // Palettes are hand-picked per motif; `c` order is documented in app.js `drawArt`.
  const A = {
    rails: (sky = '#B9C6CC') => ({ m: 'rails', c: [sky, '#EEF0EE', '#2F3E35', '#5F625E'] }),
    railsDusk: () => ({ m: 'rails', c: ['#5B6B7D', '#C9CDD0', '#1F2A25', '#3B3E3B'] }),
    waves: (sky = '#2D3A4A', w1 = '#4C6A7A', w2 = '#36505E', sun = '#D8C9A3') => ({ m: 'waves', c: [sky, w1, w2, sun] }),
    peaks: (sky = '#C6D3DA', rock = '#55606B', snow = '#F1F1EC', sun = '#6B4430') => ({ m: 'peaks', c: [sky, rock, snow, sun] }),
    bench: (bg = '#2A2622', w1 = '#B08A5E', w2 = '#7C5A3C', steel = '#8C9298') => ({ m: 'bench', c: [bg, w1, w2, steel] }),
    bowl: (table = '#5C4033', bowl = '#D8D2C4', food = '#A3321F', steam = '#EDE6D6') => ({ m: 'bowl', c: [table, bowl, food, steam] }),
    rings: (bg = '#1E1B18', disc = '#2E2925', groove = '#5B514A', label = '#C9A24A') => ({ m: 'rings', c: [bg, disc, groove, label] }),
    grid: (facade = '#8A8B83', win = '#4A4B46', lit = '#E3D9B8', shade = '#3B3C38') => ({ m: 'grid', c: [facade, win, lit, shade] }),
    map: (sea = '#6C8EA0', land = '#E6DCC3', land2 = '#C9C29F', border = '#B3341C') => ({ m: 'map', c: [sea, land, land2, border] }),
    face: (bg = '#FFD400', skin = '#FF9F6B', dark = '#141414', mark = '#E10600') => ({ m: 'face', c: [bg, skin, dark, mark] }),
    type: (text, bg = '#E10600', fg = '#FFE600', stroke = '#111111') => ({ m: 'type', c: [bg, fg, stroke], t: text }),
  };

  // dur is "h:mm:ss" or "m:ss"; live videos have no duration.
  const videos = [
    // Suggested / calm
    { id: 'smpVzahnrad01', ch: 'smpCalpine', lang: 'de', dur: '18:42', title: 'Wie funktioniert eine Zahnradbahn? Rigi, Pilatus und die Technik dahinter', art: A.rails() },
    { id: 'smpVdjerdap02', ch: 'smpCdunav', lang: 'sr-Cyrl', dur: '1:02:15', title: 'Ђердапска клисура из ваздуха — пловидба од Голупца до Кладова', art: A.waves('#3A4B5C', '#5B7A86', '#2F4552', '#E3C98E') },
    { id: 'smpVlathe0003', ch: 'smpCworkshop', lang: 'en', dur: '24:10', title: 'I restored a 1962 lathe and it changed how I think about tools', art: A.bench() },
    { id: 'smpVajvar0004', ch: 'smpCkuhinja', lang: 'sr-Latn', dur: '14:22', title: 'Kako se pravi pravi ajvar — recept moje bake', art: A.bowl() },
    { id: 'smpVrhine0005', ch: 'smpCslow', lang: 'en', dur: '4:03:10', title: 'Four hours on the Rhine: Basel to Strasbourg, no narration', art: A.waves('#9FB3BA', '#5E7F86', '#47646B', '#F1E6C8') },
    { id: 'smpVkaffee006', ch: 'smpCphysik', lang: 'de', dur: '9:31', title: 'Warum das Wasser auf dem Berg früher kocht', art: A.peaks() },
    { id: 'smpVstalker07', ch: 'smpClongtake', lang: 'en', dur: '21:05', title: 'How Tarkovsky films a room: the long take in Stalker', art: A.grid('#6E705F', '#3C3E33', '#C9B98A', '#2B2C25') },
    { id: 'smpVforelle08', ch: 'smpChausmusik', lang: 'de', dur: '8:47', title: 'Schubert: Forellenquintett, 4. Satz — Hausmusik in Winterthur', art: A.rings() },
    { id: 'smpVbalkan009', ch: 'smpCmaproom', lang: 'en', dur: '16:33', title: 'Why every map of the Balkans is a little bit wrong', art: A.map() },
    // Subscriptions sample
    { id: 'smpVgotthard0', ch: 'smpCalpine', lang: 'de', dur: '1:12:40', title: 'Gotthard-Bergstrecke im Winter: Führerstandsmitfahrt Erstfeld – Göschenen', art: A.railsDusk() },
    { id: 'smpVplane0011', ch: 'smpCworkshop', lang: 'en', dur: '17:26', title: 'Sharpening a plane iron by hand: the only three things that matter', art: A.bench('#33302B', '#C9A77A', '#8C6B4A', '#A3A9AE') },
    { id: 'smpVjezero012', ch: 'smpCdunav', lang: 'sr-Cyrl', dur: '32:08', title: 'Сребрно језеро у зору', art: A.waves('#C9B7A0', '#7F9AA3', '#5D7A84', '#F4E2C0') },
    { id: 'smpVeis000013', ch: 'smpCphysik', lang: 'de', dur: '12:55', title: 'Warum Eis glatt ist – und warum wir es lange falsch erklärt haben', art: A.peaks('#DCE5EA', '#7D8C99', '#FFFFFF', '#3F6E8C') },
    { id: 'smpVozu000014', ch: 'smpClongtake', lang: 'en', dur: '15:40', title: 'Ozu’s pillow shots, explained without a single cut', art: A.grid('#B7A98F', '#6F6452', '#F0E3C2', '#4A4234') },
    { id: 'smpVhouse0015', ch: 'smpCmaproom', lang: 'en', dur: '9:58', title: 'The border that runs through a single house', art: A.map('#7FA1B0', '#ECE3CC', '#D4CBA8', '#1F3B4D') },
    { id: 'smpVbrahms016', ch: 'smpChausmusik', lang: 'de', dur: '27:14', title: 'Brahms im Wohnzimmer: Klarinettentrio a-Moll', art: A.rings('#2A1F18', '#3A2D24', '#6E5A4A', '#B9873A') },
    // Neutral feed items
    { id: 'smpVpixel0017', ch: 'smpCpixel', lang: 'en', dur: '14:50', title: 'Pixel 11 Pro, one month later: the camera is the whole story', art: A.grid('#2C3036', '#454A52', '#9FB4C7', '#1C1F23') },
    { id: 'smpVrun000018', ch: 'smpCspeedrun', lang: 'en', dur: '31:12', title: 'Any% world record explained frame by frame', art: A.grid('#3A2F5C', '#5A4C86', '#F2C14E', '#241D3B') },
    { id: 'smpVderby019', ch: 'smpCderby', lang: 'en', dur: '13:45', title: 'Derby notes: what changed after the red card', art: A.map('#2E6B45', '#3F8A5B', '#2E6B45', '#F4F4F0') },
    { id: 'smpVnotiz020', ch: 'smpCnotiz', lang: 'de', dur: '6:12', title: 'Was heute wichtig ist: Bahnstreik, Wahlen, Wetter', art: A.grid('#5C5F62', '#3E4043', '#D6D6D0', '#2E3032') },
    // Loud archetypes
    { id: 'smpVdrama021', ch: 'smpCdrama', lang: 'en', dur: '23:41', title: 'She SAID WHAT?! The full timeline of this week’s meltdown', art: A.type('WHAT?!') },
    { id: 'smpVdrama022', ch: 'smpCdrama', lang: 'en', dur: '18:02', title: 'Everyone is talking about this video. Here’s why.', art: A.face('#FF2D55', '#FFC09F', '#141414', '#FFE600') },
    { id: 'smpVtop10023', ch: 'smpCtop10', lang: 'en', dur: '12:08', title: 'TOP 10 SCARIEST things caught on camera (#7 will SHOCK you)', art: A.type('TOP 10', '#111111', '#FFE600', '#D10A0A') },
    { id: 'smpVprank024', ch: 'smpCprank', lang: 'en', dur: '19:59', title: 'PRANKING my roommate for 24 HOURS straight', art: A.face() },
    { id: 'smpVprank025', ch: 'smpCprank', lang: 'en', dur: '16:30', title: 'I pretended to be a waiter at a fancy restaurant', art: A.face('#00C2FF', '#FFB38A', '#141414', '#E10600') },
    { id: 'smpVcrypto26', ch: 'smpCcrypto', lang: 'en', live: true, title: 'LIVE: This coin will 100× before Friday', art: A.type('100×', '#0B3D1E', '#3DFF8A', '#000000') },
    { id: 'smpVreacts27', ch: 'smpCreacts', lang: 'en', dur: '28:14', title: 'Reacting to the reaction of the reaction', art: A.face('#FF7A00', '#FFC7A1', '#141414', '#FFFFFF') },
    { id: 'smpVrijal028', ch: 'smpCrijaliti', lang: 'sr-Latn', dur: '11:20', title: 'Rijaliti: ko je ispao sinoć? Sve što ste propustili', art: A.face('#FF2E93', '#FFB28F', '#141414', '#FFE600') },
    { id: 'smpVmyst0029', ch: 'smpCmystery', lang: 'en', dur: '0:58', short: true, title: 'The mystery of the empty town (part 3)', art: A.type('???', '#24064F', '#B794FF', '#000000') },
    { id: 'smpVunbox030', ch: 'smpCunbox', lang: 'en', dur: '44:02', title: 'Unboxing 47 mystery boxes from an auction', art: A.type('47', '#FF6B00', '#FFFFFF', '#3A1400') },
    // Single bad videos from otherwise fine channels
    { id: 'smpVdeal0031', ch: 'smpCpixel', lang: 'en', dur: '8:11', title: 'This phone deal is INSANE (sponsored)', art: A.type('DEAL', '#FFE600', '#111111', '#FFFFFF') },
    { id: 'smpVrage0032', ch: 'smpCspeedrun', lang: 'en', dur: '10:01', title: 'RAGE QUIT compilation 2026', art: A.type('RAGE', '#D10A0A', '#FFFFFF', '#000000') },
    { id: 'smpVfight033', ch: 'smpCderby', lang: 'en', dur: '22:30', title: 'Every fight from this season, ranked', art: A.type('#1', '#0B0B0B', '#FF3B30', '#FFFFFF') },
    { id: 'smpVunfall34', ch: 'smpCalpine', lang: 'de', dur: '26:40', title: 'Bahnunfälle der 1970er: die Archivaufnahmen', art: A.railsDusk() },
  ];

  const playlists = [
    { id: 'smpPLcab0001', ch: 'smpCalpine', count: 24, cover: 'smpVgotthard0', title: 'Führerstandsmitfahrten: Schweiz im Winter' },
    { id: 'smpPLtools002', ch: 'smpCworkshop', count: 11, cover: 'smpVplane0011', title: 'Hand tools from scratch' },
    { id: 'smpPLsunday03', ch: 'smpCslow', count: 9, cover: 'smpVrhine0005', title: 'Slow Sunday: rivers without narration' },
  ];

  // The fixed sample of what the TV's own feed would contain before curation.
  const feed = [
    {
      id: 'home', title: 'Home',
      videoIds: ['smpVtop10023', 'smpVkaffee006', 'smpVdrama021', 'smpVpixel0017', 'smpVprank024', 'smpVdeal0031',
        'smpVcrypto26', 'smpVrun000018', 'smpVrijal028', 'smpVmyst0029', 'smpVreacts27', 'smpVnotiz020',
        'smpVfight033', 'smpVunbox030', 'smpVderby019', 'smpVrage0032'],
    },
    {
      id: 'subscriptions', title: 'Subscriptions',
      videoIds: ['smpVgotthard0', 'smpVplane0011', 'smpVdrama022', 'smpVjezero012', 'smpVeis000013', 'smpVunfall34',
        'smpVozu000014', 'smpVhouse0015', 'smpVprank025', 'smpVbrahms016'],
    },
  ];

  // Notes are the owner's own words; empty notes are normal.
  const e = (id, daysAgo, note = '') => ({ id, note, ago: daysAgo * DAY });

  // r14: the published baseline.
  const r14 = {
    suggested: {
      videos: [
        e('smpVzahnrad01', 18, 'For Sunday mornings. Long, calm, no music.'),
        e('smpVlathe0003', 16),
        e('smpVajvar0004', 15, 'Make this in September.'),
        e('smpVrhine0005', 12, 'Background for rainy evenings.'),
        e('smpVdjerdap02', 11),
        e('smpVkaffee006', 9),
        e('smpVstalker07', 6),
        e('smpVforelle08', 3),
      ],
      channels: [
        e('smpCalpine', 30, 'Everything they upload is fine.'),
        e('smpCworkshop', 28),
        e('smpCdunav', 20),
        e('smpCphysik', 14),
        e('smpClongtake', 8),
      ],
      playlists: [
        e('smpPLcab0001', 25),
        e('smpPLsunday03', 9, 'Put on when guests are over.'),
        e('smpPLtools002', 5),
      ],
    },
    blocked: {
      videos: [
        e('smpVunfall34', 19, 'Archive footage of accidents. Not on the TV.'),
        e('smpVdeal0031', 13, 'Ad, not a review.'),
        e('smpVrage0032', 10),
        e('smpVfight033', 4),
      ],
      channels: [
        e('smpCdrama', 21, 'Outrage recaps.'),
        e('smpCtop10', 21),
        e('smpCprank', 20),
        e('smpCcrypto', 17, 'Financial advice from strangers.'),
        e('smpCreacts', 2),
        e('smpCmystery', 2, 'Endless shorts.'),
        e('smpCunbox', 2),
      ],
    },
  };

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const without = (list, id) => list.filter((x) => x.id !== id);

  // r13 and r12 are derived from r14 so each sample revision has a real, restorable snapshot.
  const r13 = clone(r14);
  r13.blocked.channels = without(without(without(r13.blocked.channels, 'smpCreacts'), 'smpCmystery'), 'smpCunbox');
  r13.blocked.videos = without(r13.blocked.videos, 'smpVfight033');
  r13.suggested.videos = without(r13.suggested.videos, 'smpVforelle08');

  const r12 = clone(r13);
  r12.suggested.playlists = without(r12.suggested.playlists, 'smpPLsunday03');
  r12.suggested.playlists = without(r12.suggested.playlists, 'smpPLtools002');
  r12.suggested.videos = without(r12.suggested.videos, 'smpVstalker07');
  r12.suggested.videos = without(r12.suggested.videos, 'smpVkaffee006');
  r12.suggested.channels = without(r12.suggested.channels, 'smpClongtake');

  // The draft starts four changes ahead of r14, so the publishing flow is visible immediately.
  // New suggestions go to the front of their row (see app.js `suggest`).
  const draft = clone(r14);
  const djerdap = draft.suggested.videos.find((x) => x.id === 'smpVdjerdap02');
  draft.suggested.videos = without(draft.suggested.videos, 'smpVdjerdap02');
  draft.suggested.videos.splice(1, 0, djerdap);
  draft.suggested.videos.unshift(e('smpVbalkan009', 0.04));
  draft.blocked.channels.push(e('smpCrijaliti', 0.02, 'Reality-show recaps.'));
  draft.blocked.videos = without(draft.blocked.videos, 'smpVfight033');

  const revisions = [
    { n: 12, ago: 21 * DAY + 3 * HOUR, note: 'First pass: blocked the loudest channels.', snapshot: r12 },
    { n: 13, ago: 9 * DAY + 5 * HOUR, note: 'Added the cab-ride playlist and two long reads.', snapshot: r13 },
    { n: 14, ago: 2 * DAY + 1 * HOUR, note: 'Cleaned up reaction and mystery-shorts channels.', snapshot: r14 },
  ];

  // Collectors as they exist today: OwnTube on Android TV records playback only; the Chrome
  // collector records playback and YouTube searches. Labels are the owner's own device names.
  // `context` says whether the device's collector records foreground/background (Bedroom TV runs an
  // older OwnTube build: no context, no snapshots). Plays default to all-foreground or all-unspecified.
  const devices = [
    { label: 'Living room TV', kind: 'tv', context: true },
    { label: 'Bedroom TV', kind: 'tv', context: false },
    { label: 'Laptop', kind: 'browser', context: true },
  ];

  /*
   * Evidence snapshots, shaped like the real collectors' output:
   *   Chrome (apps/chrome-extension/src/capture/language.js): schemaVersion 1, algorithmVersion
   *     "language-v2", saved title/description, audio languages, caption tracks, text detector.
   *   OwnTube on Android TV (apps/android/owntube SourceEvidence/SelectedEvidence): collector
   *     "owntube-source-v1", languageAnalysis "not-run", default audio not exposed, provenance fields.
   * Each snapshot is an exact JSON string; its evidence ID is the SHA-256 of that string (the
   * server's rule). IDs below were computed from these strings; check.mjs re-verifies them.
   */
  const videoById = Object.fromEntries(videos.map((v) => [v.id, v]));
  const channelById = Object.fromEntries(channels.map((c) => [c.id, c]));
  const seconds = (dur) => dur.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
  const OBSERVED = 1794480000000; // fixed, so the strings (and their digests) never change

  const chrome = (vid, { description, descriptionTruncated = false, selectedAudio = '', defaultAudio = '', captions = [], text }) => JSON.stringify({
    schemaVersion: 1, algorithmVersion: 'language-v2', title: videoById[vid].title, description,
    descriptionSource: description ? 'videoDetails.shortDescription' : 'none', descriptionTruncated,
    selectedAudioLanguage: selectedAudio, defaultAudioLanguage: defaultAudio, captions, text,
  });

  const android = (vid, { description = null, captions = [], translationOptions = 0, selectedAudio = null, metadataError = null }) => {
    const v = videoById[vid];
    const ch = channelById[v.ch];
    const root = {
      schemaVersion: 1, collector: 'owntube-source-v1', videoId: vid, languageAnalysis: 'not-run',
      defaultAudioLanguageStatus: 'not-exposed-by-MediaFormat', title: v.title, description: description ?? '',
      titleSource: 'MediaItemFormatInfo.getTitle', descriptionAvailable: description !== null,
      descriptionTruncated: description !== null && description.length >= 10000,
    };
    if (description !== null) root.descriptionSource = 'videoDetails.shortDescription';
    root.captions = captions;
    root.captionsSource = 'MediaItemFormatInfo.getSubtitles; tlang options excluded; same-URL aliases deduplicated';
    root.captionDuplicateOptionsOmitted = 0;
    root.captionCount = captions.length;
    root.captionTranslationOptionsOmitted = translationOptions;
    root.formatInfo = {
      source: 'MediaItemFormatInfo', observedAt: OBSERVED, author: ch.name, channelId: ch.id, lengthSeconds: String(seconds(v.dur)),
      isLive: false, isLiveContent: false, isLiveDvrEnabled: false,
      urlFormats: [{ isDrc: false, itag: '18', mimeType: 'video/mp4', qualityLabel: '360p', width: 640, height: 360 }],
      urlFormatsCount: 1, formatLanguageSource: 'MediaFormat.getLanguage (SmartTube-normalized label)',
    };
    root.metadata = metadataError
      ? { source: 'MediaItemMetadata', observedAt: OBSERVED, title: v.title, mappingError: metadataError }
      : { source: 'MediaItemMetadata', observedAt: OBSERVED, title: v.title, author: ch.name, channelId: ch.id, isLive: false, isUpcoming: false };
    if (selectedAudio) {
      root.selectedFormats = { source: 'SimpleExoPlayer selected decoder formats', audio: { id: '140', sampleMimeType: 'audio/mp4a-latm', language: selectedAudio, channelCount: 2, sampleRate: 44100, selectionFlags: 1 } };
      root.selectedAudioLanguage = selectedAudio;
      root.selectedAudioLanguageSource = 'SimpleExoPlayer.getAudioFormat.language (player-normalized)';
    }
    return JSON.stringify(root);
  };

  const asr = (language, name) => ({ language, kind: 'asr', vssId: `a.${language}`, name, isTranslatable: true });
  const track = (language, name) => ({ language, vssId: `.${language}`, name, isTranslatable: true }); // SmartTube exposes no kind for these

  // A description the collector cut at its 10,000-character limit.
  const cabRide = (() => {
    const stops = ['Erstfeld', 'Amsteg-Silenen', 'Intschi', 'Gurtnellen', 'Pfaffensprung', 'Wassen', 'Wattinger Kehrtunnel', 'Göschenen'];
    let s = 'Führerstandsmitfahrt über die Gotthard-Bergstrecke im Winter, ohne Kommentar, in Echtzeit.\n\nKapitel:\n';
    for (let k = 0; s.length < 10400; k++) {
      const stop = stops[k % stops.length];
      s += `${String(Math.floor(k * 1.7)).padStart(2, '0')}:${String((k * 37) % 60).padStart(2, '0')} ${stop}, Abschnitt ${k + 1}: Schnee auf der Strecke, Blick auf die Reuss, Kehrtunnel und Brücken der Bergstrecke.\n`;
    }
    return s.slice(0, 10000);
  })();

  const snapshots = {
    cPlaneV2: chrome('smpVplane0011', {
      description: 'Three things decide whether a plane iron cuts: a flat back, a consistent bevel, and a burr you remove completely. Everything else is preference.\n\nThis video is supported by a local tool library. No affiliate links.',
      selectedAudio: 'en', defaultAudio: 'en',
      captions: [{ language: 'de', kind: 'manual' }, { language: 'en', kind: 'asr' }, { language: 'en', kind: 'manual' }],
      text: { engine: 'chrome-language-detector', status: 'available', input: 'description', language: 'en', confidence: 0.98, candidates: [{ language: 'en', confidence: 0.98 }, { language: 'de', confidence: 0.01 }] },
    }),
    cStalker: chrome('smpVstalker07', {
      description: 'A close reading of one room in Stalker: how long takes, sound and slow camera movement make a space feel alive. Clips are used for criticism.',
      selectedAudio: 'en', defaultAudio: 'en',
      captions: [{ language: 'en', kind: 'manual' }, { language: 'sr', kind: 'manual' }],
      text: { engine: 'chrome-language-detector', status: 'available', input: 'description', language: 'en', confidence: 0.99, candidates: [{ language: 'en', confidence: 0.99 }] },
    }),
    // Music in a background tab: no usable audio language ("und" is what YouTube reported), so the
    // estimate comes from the text detector.
    cBrahms: chrome('smpVbrahms016', {
      description: 'Johannes Brahms, Klarinettentrio a-Moll op. 114. Hausmusik, aufgenommen an einem Sonntagnachmittag im Wohnzimmer.',
      defaultAudio: 'und',
      text: { engine: 'chrome-language-detector', status: 'available', input: 'description', language: 'de', confidence: 0.96, candidates: [{ language: 'de', confidence: 0.96 }, { language: 'nl', confidence: 0.02 }] },
    }),
    // Untrusted page text, saved verbatim. The inspector must show it as text, never as markup.
    cTop10: chrome('smpVtop10023', {
      description: 'WATCH TILL THE END!!! 😱 #7 is unreal\n<img src=x onerror="window.__ownTubeXss=1">\n</pre><script>window.__ownTubeXss=2</script>\nLinks & sponsors below 👇',
      text: { engine: 'local-trigram', status: 'unavailable', input: 'description', language: 'en', confidence: null, candidates: [] },
    }),
    aGotthard: android('smpVgotthard0', { description: cabRide, captions: [asr('de', 'Deutsch (automatisch erzeugt)')], translationOptions: 154, selectedAudio: 'de' }),
    aKaffee: android('smpVkaffee006', { description: 'Warum siedet Wasser auf 3000 Metern schon bei rund 90 Grad? Ein Versuch mit Thermometer und Gaskocher.', captions: [asr('de', 'Deutsch (automatisch erzeugt)')], translationOptions: 154 }),
    aAjvar: android('smpVajvar0004', { description: 'Pečene paprike, malo patlidžana i puno strpljenja. Recept moje bake, korak po korak.', captions: [] }),
    aDjerdap: android('smpVdjerdap02', { description: 'Пловидба Дунавом кроз Ђердапску клисуру, снимано дроном у рану јесен.', captions: [track('sr', 'Српски')], translationOptions: 154 }),
    aPlaneV1: android('smpVplane0011', { description: 'Three things decide whether a plane iron cuts: a flat back, a consistent bevel, and a burr you remove completely. Everything else is preference.', captions: [track('en', 'English'), asr('en', 'English (auto-generated)')], translationOptions: 154, selectedAudio: 'en' }),
    aRhine: android('smpVrhine0005', { description: 'Four hours on the Rhine from Basel to Strasbourg. No narration, no music, ambient sound only.', captions: [] }),
    aForelle: android('smpVforelle08', { description: 'Franz Schubert, Klavierquintett A-Dur D 667, 4. Satz. Live im Wohnzimmer.', captions: [] }),
    aBrahms: android('smpVbrahms016', { description: 'Johannes Brahms, Klarinettentrio a-Moll op. 114. Hausmusik, aufgenommen an einem Sonntagnachmittag.', captions: [] }),
    aStalker: android('smpVstalker07', { description: 'A close reading of one room in Stalker: how long takes, sound and slow camera movement make a space feel alive.', captions: [track('en', 'English')], translationOptions: 154 }),
    // Description not exposed by the app and a metadata getter that failed: partial values only.
    aEisPartial: android('smpVeis000013', { description: null, captions: [], metadataError: 'NullPointerException' }),
  };

  // SHA-256 of each exact string above (lowercase hex), as the server would key them.
  const EVIDENCE_IDS = {
    cPlaneV2: 'b05024256666c250ece624c49eaadf430c27b0a633e27797fb67885e30c1e573', // 821 bytes
    cStalker: '19b1473e63c13e48a1e704e700a6a05ca6a8632d740debb411f8214b2dcdcef8', // 665 bytes
    cBrahms: '160a2789d8984b30db4d77d809640ed90ed055ef4169806392adaa8f2724f412', // 597 bytes
    cTop10: '5d6e7bedf409b9350dcff8a469c77d3181f5ea8c6fa067bd6f6874a6eaeefe9f', // 577 bytes
    aGotthard: '4572d948f05253f61941320acae9b34d344d03b33eee67ed9aa0ab99ba6f69b5', // 11,914 bytes
    aKaffee: '2421c250850dd316e795748507d825fd6f6fe5f3e7f1cbff1b0a7db35622e83c', // 1,440 bytes
    aAjvar: '31def0c15aae3f92bfdd20039585f25f15c7d34773b5e6584b78e067e1ca7841', // 1,324 bytes
    aDjerdap: 'e648e4a08aa14c02ae0ee916d1a03247eb42b4063fc1a3e41327dca1c7960d54', // 1,601 bytes
    aPlaneV1: 'b3a347a4a3de4a020e09a4ee857c8f33b80720b7e1ffb0602cb97c2b6805a824', // 1,915 bytes
    aRhine: '67fa6c282ca61605beecf91b98fb219435e9628a2ec02fafb158c88cce537d49', // 1,341 bytes
    aForelle: 'e88a6aa6be44c73a8fecd70138d4cc4ea17acdcfd8f302e9f4c82f86e55be1e1', // 1,357 bytes
    aBrahms: '95130be97e9d6f3a878f23550f51b26bf8c6c62427f88be26420e0c005f4e3b3', // 1,346 bytes
    aStalker: '3e08ce7623200f06f27879406f3fdb611d704cb97a1df2e222e0568f39ca2827', // 1,430 bytes
    aEisPartial: '3299ca3a949ccaa9d7a299bd028f042a3d9d198b91498a83f669e779f927c691', // 1,180 bytes
  };
  const evidence = Object.fromEntries(Object.entries(snapshots).map(([key, raw]) => [key, { id: EVIDENCE_IDS[key], raw }]));

  /*
   * What played, per device. m: minutes before seeding · s: watched seconds · cov: coverage.
   * e: evidence snapshot saved with this play (none on Bedroom TV, an older OwnTube build).
   * est: the collector's language estimate [language, confidence, signal] (Chrome only; OwnTube
   *   on Android TV does not run language analysis).
   * ctx: playback context seconds for this play [foreground, background, unspecified]; defaults
   *   to all foreground for the Living room TV and all unspecified for Bedroom TV.
   */
  const history = [
    { m: 38, v: 'smpVgotthard0', d: 0, s: 2310, cov: 0.53, e: 'aGotthard' },
    { m: 95, v: 'smpVkaffee006', d: 0, s: 571, cov: 1, e: 'aKaffee' },
    { m: 140, v: 'smpVrijal028', d: 1, s: 655, cov: 0.96 },
    { m: 152, v: 'smpVrijal028', d: 1, s: 120, cov: 0.18 },
    { m: 60 * 22, v: 'smpVajvar0004', d: 0, s: 862, cov: 1, e: 'aAjvar' },
    { m: 60 * 23 + 10, v: 'smpVdjerdap02', d: 0, s: 1814, cov: 0.49, e: 'aDjerdap' },
    { m: 60 * 26, v: 'smpVfight033', d: 1, s: 410, cov: 0.3 },
    { m: 60 * 27, v: 'smpVplane0011', d: 0, s: 1046, cov: 0.97, e: 'aPlaneV1' },
    { m: 60 * 47, v: 'smpVrhine0005', d: 0, s: 5420, cov: 0.37, e: 'aRhine', ctx: [3900, 1520, 0] },
    { m: 60 * 50, v: 'smpVmyst0029', d: 1, s: 58, cov: 1 },
    { m: 60 * 50 + 3, v: 'smpVmyst0029', d: 1, s: 41, cov: 0.7 },
    { m: 60 * 71, v: 'smpVforelle08', d: 0, s: 527, cov: 1, e: 'aForelle' },
    { m: 60 * 72, v: 'smpVbrahms016', d: 0, s: 1210, cov: 0.74, e: 'aBrahms' },
    { m: 60 * 74, v: 'smpVpixel0017', d: 1, s: 302, cov: 0.34 },
    { m: 60 * 96, v: 'smpVstalker07', d: 0, s: 1265, cov: 0.92, e: 'aStalker' },
    { m: 60 * 99, v: 'smpVeis000013', d: 0, s: 775, cov: 1, e: 'aEisPartial' },
    // Chrome playback, opened from searches below.
    { m: 60 * 5 + 2, v: 'smpVplane0011', d: 2, s: 640, cov: 0.61, e: 'cPlaneV2', est: ['en', 'high', 'audio-track'], ctx: [520, 120, 0] },
    { m: 60 * 29, v: 'smpVbrahms016', d: 2, s: 1634, cov: 1, e: 'cBrahms', est: ['de', 'medium', 'native-text'], ctx: [0, 1634, 0] },
    { m: 60 * 50 + 2, v: 'smpVstalker07', d: 2, s: 1265, cov: 1, e: 'cStalker', est: ['en', 'high', 'audio-track'], ctx: [1100, 0, 165] },
    { m: 60 * 74 + 3, v: 'smpVtop10023', d: 2, s: 222, cov: 0.3, e: 'cTop10', est: ['en', 'low', 'description-heuristic'], ctx: [180, 42, 0] },
  ];

  // YouTube searches from the Chrome collector (fictional queries). Spread over 120 days so the
  // 7/30/90-day periods differ, and more than 20 fall inside 90 days to show the listing limit.
  const dayMin = (days, hours = 0) => days * 24 * 60 + hours * 60;
  const searches = [
    { m: 40, q: 'zahnradbahn rigi technik' },
    { m: dayMin(0, 5), q: 'how to sharpen a hand plane' },
    { m: dayMin(1, 2), q: 'ajvar recept bez kuvanja' },
    { m: dayMin(1, 3.5), q: 'ђердап крстарење' },
    { m: dayMin(2, 1), q: 'why does every video about the iron gates use the same three shots from the same bridge' },
    { m: dayMin(2, 2.1), q: 'tarkovsky stalker long take' },
    { m: dayMin(3, 2), q: 'schubert forellenquintett' },
    { m: dayMin(3, 1.3), q: 'top 10 scariest videos' },
    { m: dayMin(4, 1), q: '"slow tv" -compilation' },
    { m: dayMin(5, 3), q: 'warum kocht wasser auf dem berg früher' },
    { m: dayMin(5, 6.5), q: 'lathe restoration 1962' },
    { m: dayMin(9, 4), q: 'gotthard bergstrecke führerstand' },
    { m: dayMin(11, 2), q: 'slow tv river norway' },
    { m: dayMin(14, 3), q: 'how to sharpen a hand plane' },
    { m: dayMin(17, 5), q: 'balkan borders map explained' },
    { m: dayMin(19, 1), q: 'kids & cartoons < 20 min' },
    { m: dayMin(22, 4), q: 'brahms klarinettentrio' },
    { m: dayMin(25, 2), q: 'unboxing mystery box' },
    { m: dayMin(28, 3), q: 'ozu pillow shots' },
    { m: dayMin(34, 2), q: 'kafana muzika uživo' },
    { m: dayMin(41, 6), q: 'sourdough starter not rising' },
    { m: dayMin(47, 1), q: 'dunav biciklistička staza' },
    { m: dayMin(55, 3), q: 'reaction compilation' },
    { m: dayMin(63, 2), q: 'swiss rail winter cab ride' },
    { m: dayMin(71, 4), q: 'physik experimente für zuhause' },
    { m: dayMin(86, 2), q: 'hand tool woodworking beginner' },
    { m: dayMin(120, 1), q: 'fpv drone alps' },
  ].map((s) => ({ ...s, d: 2 }));

  return { MIN, HOUR, DAY, channels, videos, playlists, feed, draft, revisions, devices, history, searches, evidence };
})();

import { normalise, SIGNAL } from './protocol.js';

// Local, deliberately small character-trigram profiles. No model or network download.
const corpus = {
  de: 'der die das und ein eine einen mit für auf nicht ist sind wie kann man lernen deutsch deutsche sprache kochen rezept sauerteig brot backen anfänger anschließen anschliessen relais schalter dativ akkusativ übung winterthur altstadt rundgang geschichte erklärung selber machen richtig einfach heute warum über unter zwischen schöne schweiz musik nachrichten',
  en: 'the and this that with for from how to make learn english language cooking recipe bread beginner connect relay switch programming effect error handling typed errors short version history explained yourself easy today why about between beautiful music news watch guide tutorial build your best things you should know',
  bcs: 'kako napraviti kiseli kupus recept za početnike bosanski hrvatski srpski jezik učenje kuhanje kuvanje hljeb kruh praviti domaći jednostavno zašto koji koja što šta ovo dobro danas može treba iz između priča muzika glazba vijesti video objasniti način naučiti priključiti relej kako spojiti кисели купус како направити српски језик рецепт за почетнике хлеб домаћи учење музика данас зашто',
  es: 'el la los las un una que de del para por con cómo hacer aprender español lengua receta tortilla española pan cocinar principiantes conectar interruptor explicación historia fácil hoy por qué entre hermoso música noticias vídeo guía aprender mejores cosas sobre sin cuando quiero puedes mucho hacer',
};

function grams(text) {
  const cleaned = ` ${text.toLowerCase().normalize('NFC').replace(/[^\p{L}]+/gu, ' ').trim()} `;
  const counts = new Map();
  for (let i = 0; i < cleaned.length - 2; i++) {
    const gram = cleaned.slice(i, i + 3);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}
const profiles = Object.entries(corpus).map(([lang, text]) => [lang, grams(text)]);
const norm = vector => Math.sqrt([...vector.values()].reduce((sum, n) => sum + n * n, 0));

export function classify(text) {
  if (typeof text !== 'string' || (text.match(/\p{L}/gu)?.length ?? 0) < 5) return { lang: 'other', conf: 'low' };
  const query = grams(text.slice(0, 2000));
  const ranked = profiles.map(([lang, profile]) => [lang, [...query].reduce((sum, [g, n]) => sum + n * (profile.get(g) ?? 0), 0) / (norm(query) * norm(profile) || 1)]).sort((a,b) => b[1] - a[1]);
  const [[lang, score], [, next]] = ranked;
  if (score < 0.12 || score - next < 0.025) return { lang: 'other', conf: 'low' };
  return { lang, conf: score >= 0.24 && score - next >= 0.07 ? 'high' : 'medium' };
}

const readText = value => typeof value === 'string' ? value : value?.simpleText ?? value?.runs?.map(run => run.text ?? '').join('') ?? '';
const audioCode = track => track?.languageCode ?? track?.language ?? track?.id?.split('.')[0];
// YouTube's default audio often has id="und". It is not language evidence and
// must not mask an ASR track with a real language (or a known default audio code).
const usableCode = code => typeof code === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i.test(code) && !['und', 'zxx', 'mul'].includes(code.toLowerCase().split('-')[0]);

export function videoSignal(response, audio, expectedId, nativeText = null) {
  if (!response || response.videoDetails?.videoId !== expectedId) return null;
  const details = response.videoDetails;
  const micro = response.microformat?.playerMicroformatRenderer;
  const title = String(details.title ?? readText(micro?.title)).slice(0, 500);
  const fullDescription = String(details.shortDescription || readText(micro?.description) || '');
  const description = fullDescription.slice(0,10000);
  const descriptionSource = details.shortDescription ? 'videoDetails.shortDescription' : description ? 'microformat.description' : 'none';
  const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const captions = Array.isArray(tracks) ? tracks : [];
  const manual = captions.filter(track => track.kind !== 'asr' && usableCode(track.languageCode));
  const defaultAudio = response.streamingData?.adaptiveFormats?.find(format => format.audioTrack?.audioIsDefault)?.audioTrack;
  const audioLanguage = [audioCode(audio), audioCode(defaultAudio)].find(usableCode);
  const asr = captions.find(track => track.kind === 'asr' && usableCode(track.languageCode));
  const localEstimate = classify(description.trim() || title);
  const top = nativeText?.candidates?.[0];
  const nativeAccepted = nativeText?.status === 'available' && top?.confidence >= 0.8 && top.confidence - (nativeText.candidates[1]?.confidence ?? 0) >= 0.2;
  const estimate = nativeAccepted ? { lang: normalise(top.language), conf: 'medium' } : localEstimate;
  const manualLanguages = new Set(manual.map(track => track.languageCode.toLowerCase().split('-')[0]));
  let result;
  // Actual audio and original ASR are stronger spoken-language evidence than
  // translated subtitles. Caption order/defaults follow the viewer's UI locale.
  if (audioLanguage) result = { lang: normalise(audioLanguage), conf: 'high', source: 'audio-track' };
  else if (asr) result = { lang: normalise(asr.languageCode), conf: 'medium', source: 'asr-caption' };
  else if (nativeAccepted) result = { lang: estimate.lang, conf: description.trim() ? 'medium' : 'low', source: 'native-text' };
  else if (manualLanguages.size > 1 && estimate.lang !== 'other' && manual.some(track => normalise(track.languageCode) === estimate.lang)) result = { lang: estimate.lang, conf: 'low', source: 'caption-heuristic' };
  else if (description.trim() && estimate.lang !== 'other') result = { lang: estimate.lang, conf: 'low', source: 'description-heuristic' };
  else if (manualLanguages.size === 1) result = { lang: normalise(manual[0].languageCode), conf: 'medium', source: 'manual-caption' };
  else result = { ...estimate, conf: 'low', source: title ? 'title-heuristic' : 'unknown' };
  const isLive = details.isLive === true || !!response.playabilityStatus?.liveStreamability;
  const length = Number(details.lengthSeconds);
  const durationSeconds = !isLive && Number.isFinite(length) && length > 0 ? length : null;
  const evidence = { schemaVersion: 1, algorithmVersion: 'language-v2', title, description, descriptionSource,
    descriptionTruncated: fullDescription.length > description.length,
    selectedAudioLanguage: String(audioCode(audio) ?? '').slice(0,200), defaultAudioLanguage: String(audioCode(defaultAudio) ?? '').slice(0,200),
    captions: captions.slice(0,100).map(track => ({ language: String(track.languageCode ?? '').slice(0,64), kind: track.kind === 'asr' ? 'asr' : 'manual' }))
      .sort((a,b) => a.language.localeCompare(b.language) || a.kind.localeCompare(b.kind)),
    text: { engine: nativeAccepted ? 'chrome-language-detector' : 'local-trigram', status: nativeText?.status ?? 'unsupported',
      input: description.trim() ? 'description' : 'title', language: nativeAccepted ? top.language : localEstimate.lang,
      confidence: nativeAccepted ? top.confidence : null, candidates: nativeText?.candidates ?? [] } };
  return { tag: SIGNAL, videoId: expectedId, title, channel: String(details.author ?? '').slice(0, 200), durationSeconds, isLive, evidence, ...result };
}

export function videoIdFromUrl(value) {
  const url = new URL(value);
  const id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|live)\/([^/]+)/.exec(url.pathname)?.[1];
  return /^[\w-]{11}$/.test(id ?? '') ? id : null;
}

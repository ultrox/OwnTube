import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, videoSignal } from '../src/capture/language.js';
import { normalise, isEvent, isSignal } from '../src/capture/protocol.js';
import { createClock } from '../src/capture/clock.js';
import { parseDate, splitInterval } from '../src/capture/calendar.js';

test('local trigram detection keeps uncertainty visible', () => {
  for (const [query, lang] of [ ['Sauerteig Rezept für Anfänger','de'], ['zigbee relais anschliessen','de'], ['effect-ts error handling','en'], ['kako napraviti kiseli kupus','bcs'], ['Dativ oder Akkusativ Übung','de'], ['receta tortilla española','es'], ['how to wire a zigbee relay','en'] ]) {
    assert.equal(classify(query).lang, lang, query);
  }
  for (const query of ['hi','123','猫のかわいい動画','xyzzy qwerty']) assert.equal(classify(query).conf, 'low');
});

test('fresh player signals prefer spoken audio and ASR over translated captions', () => {
  const response = { videoDetails: { videoId: 'abcdefghijk', title: 'Sauerteig Rezept für Anfänger' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ kind: 'asr', languageCode: 'en-US' }, { languageCode: 'de-DE' }] } } };
  assert.equal(videoSignal(response, { id: 'es.4' }, 'abcdefghijk').source, 'audio-track');
  assert.equal(videoSignal(response, { id: 'es.4' }, 'abcdefghijk').lang, 'es');
  assert.equal(videoSignal(response, null, 'abcdefghijk').lang, 'en');
  assert.equal(videoSignal(response, null, 'different01'), null);
  response.captions.playerCaptionsTracklistRenderer.captionTracks.pop();
  assert.equal(videoSignal(response, { id: 'es.4' }, 'abcdefghijk').lang, 'es');
  assert.equal(videoSignal(response, null, 'abcdefghijk').conf, 'medium');
  assert.equal(videoSignal(response, { id: 'und' }, 'abcdefghijk').source, 'asr-caption');
  assert.equal(videoSignal(response, { id: 'und' }, 'abcdefghijk').lang, 'en');
  response.streamingData = { adaptiveFormats: [{ audioTrack: { id: 'de.4', audioIsDefault: true } }] };
  assert.equal(videoSignal(response, { id: 'und' }, 'abcdefghijk').lang, 'de');
  delete response.streamingData;
  assert.equal(videoSignal(response, { id: 'fr.4' }, 'abcdefghijk').source, 'audio-track');
  assert.equal(videoSignal(response, { id: 'fr.4' }, 'abcdefghijk').lang, 'other');
  delete response.captions;
  assert.equal(videoSignal(response, null, 'abcdefghijk').conf, 'low');
  assert.equal(normalise('sr-Cyrl'), 'bcs');
  assert.equal(normalise('de-'), 'other');
});

test('SWR pizza regression: English subtitles listed first must not classify German audio as English', () => {
  const response = {
    videoDetails: { videoId: 'vf0god0LtP8', title: 'Wie man Pizza macht | SWR Handwerkskunst', author: 'SWR Handwerkskunst',
      shortDescription: 'Backpfeifen für den Teig, dann mit den Händen die Tomaten zerhackt und das sekundengenaue Gefühl, wie lange die Pizza im Ofen bleibt: perfekte Handwerkskunst des Ingelheimers Francesco Ialazzo. Seit Herbst 2021 ist er Pizza-Weltmeister. Was dazugehört? Nur beste Zutaten und eine gehörige Portion Leidenschaft.' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }, { languageCode: 'de' }], audioTracks: [{ defaultCaptionTrackIndex: 0 }] } },
  };
  const signal = videoSignal(response, { id: 'und' }, 'vf0god0LtP8');
  assert.equal(signal.lang, 'de');
  assert.equal(signal.conf, 'low');
  assert.equal(signal.source, 'caption-heuristic');
  response.captions.playerCaptionsTracklistRenderer.captionTracks.reverse();
  assert.deepEqual(videoSignal(response, { id: 'und' }, 'vf0god0LtP8'), signal);
  assert.equal(videoSignal(response, { id: 'en.4' }, 'vf0god0LtP8').lang, 'en', 'an explicitly selected English dub must remain English');
});

test('watch clock counts wall time, stops promptly, and drops sleep gaps', () => {
  const clock = createClock(), state = { videoId: 'abcdefghijk' };
  assert.equal(clock.sample(0, 100000, state), null);
  assert.equal(clock.sample(5000, 105000, state).seconds, 5);
  assert.equal(clock.sample(7000, 107000, null).seconds, 2);
  assert.equal(clock.sample(12000, 112000, null), null);
  clock.sample(15000, 115000, state);
  assert.equal(clock.sample(50000, 150000, state), null);
  assert.equal(clock.sample(55000, 155000, state).seconds, 5);
});

test('Zurich DST day is 25 hours; midnight intervals split by local date', () => {
  const old = process.env.TZ; process.env.TZ = 'Europe/Zurich';
  try {
    assert.equal((parseDate('2026-10-26') - parseDate('2026-10-25')) / 3600000, 25);
    assert.deepEqual(splitInterval(new Date(2026,9,25,23,59,58).getTime(),5), [{ date: '2026-10-25', seconds: 2 },{ date: '2026-10-26', seconds: 3 }]);
    assert.equal(parseDate('2026-02-30'), null);
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ=old; }
});

test('untrusted page and port messages reject malformed values', () => {
  assert.equal(isSignal({ tag: 'youtube-observer/player/v1', videoId:'abcdefghijk', title:'', lang:'de', conf:'high', source:'manual-caption' }),true);
  assert.equal(isSignal({tag:'youtube-observer/player/v1',lang:'anything'}),false);
  assert.equal(isEvent({eventId:'one',kind:'watch',videoId:'abcdefghijk',title:'x',lang:'de',conf:'high',source:'manual-caption',seconds:Infinity,t:Date.now()}),false);
});

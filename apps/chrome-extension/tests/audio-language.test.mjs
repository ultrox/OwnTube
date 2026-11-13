import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trackLanguage, selectedLanguage, selectedMetadata } from '../src/capture/audio-language.js';
import { videoSignal } from '../src/capture/language.js';

const english = '251;ChEKBWFjb250EghvcmlnaW5hbAoNCgRsYW5nEgVlbi1VUw';
const german = '251;ChEKBWFjb250EghvcmlnaW5hbAoICgNkcmMSATEKDQoEbGFuZxIFZGUtREU';
test('saved real YouTube selected IDs decode their language, not the default', () => {
  assert.equal(trackLanguage(english), 'en-us');
  assert.equal(trackLanguage('251;ChEKBWFjb250EghvcmlnaW5hbAoNCgRsYW5nEgVlbi1VUwoHCgJ2YhIBMQ'), 'en-us');
  assert.equal(trackLanguage('251;ChEKBWFjb250EghvcmlnaW5hbAoICgNkcmMSATEKDQoEbGFuZxIFZW4tVVM'), 'en-us');
  assert.equal(trackLanguage(german), 'de-de');
  assert.equal(trackLanguage('de‐de (original)'), 'de-de');
  assert.equal(trackLanguage('en‐us (dubbed-auto)'), 'en-us');
  for (const value of ['und', '251;broken', english.slice(0, -3), 'English', 'lang=en-US', null]) assert.equal(trackLanguage(value), null, value);
  const response = { videoDetails: { videoId: 'qHlyWqUJVSw', title: 'That’s Funny 💀' },
    streamingData: { adaptiveFormats: [{ audioTrack: { id: 'de-DE', audioIsDefault: true } }] } };
  const signal = videoSignal(response, { id: english }, 'qHlyWqUJVSw');
  assert.equal(signal.lang, 'en');
  assert.equal(signal.source, 'audio-track');
  assert.equal(signal.evidence.selectedAudioLanguage, 'en-us');
  assert.equal(signal.evidence.selectedAudioTrackId, english);
  assert.equal(signal.evidence.defaultAudioLanguage, 'de-de');
  assert.equal(videoSignal(response, { id: german }, 'qHlyWqUJVSw').lang, 'de', 'switching selected audio changes the signal');
  assert.notEqual(videoSignal(response, { id: 'und' }, 'qHlyWqUJVSw').source, 'audio-track');
});

test('selected nested audio metadata follows its shape and never reads captions', () => {
  const metadata = { name:'English (US) original', id:'en-US.4', isDefault:true, isAutoDubbed:false };
  const selected = { id:'und', renamedMinifiedKey:metadata, captionTracks:[{languageCode:'de'}], B:{languageCode:'de',name:'German',id:'de'} };
  assert.equal(selectedLanguage(selected),'en-us');
  assert.deepEqual(selectedMetadata(selected),{name:metadata.name,id:metadata.id,isAutoDubbed:false});
  assert.equal(selectedLanguage({id:'und',captionTracks:[metadata],B:{languageCode:'de',name:'German',id:'de'}}),null);
  const signal = videoSignal({videoDetails:{videoId:'abcdefghijk'}},selected,'abcdefghijk');
  assert.deepEqual(signal.evidence.selectedAudioTrackMetadata,selectedMetadata(selected));
});

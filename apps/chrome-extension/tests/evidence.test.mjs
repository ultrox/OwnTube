import assert from 'node:assert/strict';
import { test } from 'node:test';
import { videoSignal } from '../src/capture/language.js';
import { isSignal, isEvent } from '../src/capture/protocol.js';
import { createTextDetector } from '../src/capture/text-detector.js';

const id='abcdefghijk';
const description='Heute erklären wir auf Deutsch, wie man ein einfaches Rezept für Sauerteigbrot selber machen kann. Lernen Sie mit uns Schritt für Schritt das Backen.';
const response={videoDetails:{videoId:id,title:'A translated English title',shortDescription:description},microformat:{playerMicroformatRenderer:{description:{simpleText:'An abbreviated translation'}}}};
const native={status:'available',candidates:[{language:'de',confidence:0.98},{language:'en',confidence:0.01}]};

test('full descriptions and raw language evidence survive even when selected audio wins',()=>{
  const signal=videoSignal(response,{languageCode:'en'},id,native);
  assert.equal(signal.lang,'en');
  assert.equal(signal.source,'audio-track');
  assert.equal(signal.evidence.description,description);
  assert.equal(signal.evidence.descriptionSource,'videoDetails.shortDescription');
  assert.equal(signal.evidence.title,'A translated English title');
  assert.equal(signal.evidence.selectedAudioLanguage,'en');
  assert.equal(signal.evidence.text.language,'de');
  assert.equal(signal.evidence.text.confidence,0.98);
  assert.deepEqual(signal.evidence.text.candidates,native.candidates);
  assert.equal(isSignal(signal),true);
  assert.equal(isEvent({...signal,kind:'watch',eventId:'one',seconds:1,t:Date.now()}),true);
});

test('description-based classification stays an estimate and native failures use a local fallback',()=>{
  const signal=videoSignal(response,null,id,native);
  assert.equal(signal.lang,'de');
  assert.equal(signal.source,'native-text');
  assert.equal(signal.conf,'medium','Text confidence is not spoken-language confidence');
  for(const status of ['unsupported','unavailable','downloadable','loading','error']){
    const fallback=videoSignal(response,null,id,{status,candidates:[]});
    assert.equal(fallback.lang,'de');
    assert.equal(fallback.source,'description-heuristic');
    assert.equal(fallback.conf,'low');
    assert.equal(fallback.evidence.description,description);
  }
  const uncertain=videoSignal(response,null,id,{status:'available',candidates:[{language:'en',confidence:0.51},{language:'de',confidence:0.49}]});
  assert.equal(uncertain.source,'description-heuristic');
  assert.equal(uncertain.evidence.text.candidates[0].confidence,0.51,'Rejected native scores are still preserved');
});

test('untrusted evidence rejects oversized or malformed text and scores; legacy records stay valid',()=>{
  const signal=videoSignal(response,null,id,native);
  assert.equal(isSignal({...signal,evidence:{...signal.evidence,description:'x'.repeat(10001)}}),false);
  assert.equal(isSignal({...signal,evidence:{...signal.evidence,text:{...signal.evidence.text,confidence:Infinity}}}),false);
  const {evidence,...legacy}=signal;
  assert.equal(isSignal(legacy),true);
  const truncated=videoSignal({videoDetails:{videoId:id,title:'Title',shortDescription:'x'.repeat(11000)}},null,id);
  assert.equal(truncated.evidence.description.length,10000);
  assert.equal(truncated.evidence.descriptionTruncated,true);
});

test('native detector caches text, waits for interaction to download, and tolerates rejection',async()=>{
  let calls=0,creates=0;
  const detector=createTextDetector({availability:async()=> 'downloadable',create:async()=>{creates++;return{detect:async text=>{calls++;assert.equal(text,description);return[{detectedLanguage:'de',confidence:0.98}]}}}});
  await new Promise(setImmediate);
  assert.equal(detector.lookup(description).status,'downloadable');
  assert.equal(creates,0);
  detector.enable();
  await new Promise(setImmediate);
  assert.equal(detector.lookup(description).status,'loading');
  await new Promise(setImmediate);
  assert.equal(detector.lookup(description).candidates[0].language,'de');
  detector.lookup(description);
  assert.equal(calls,1);
  const broken=createTextDetector({availability:async()=> 'available',create:async()=>{throw Error('not supported')}});
  await new Promise(setImmediate);
  assert.equal(broken.lookup(description).status,'error');
  assert.equal(createTextDetector(null).lookup(description).status,'unsupported');
  assert.equal(detector.lookup('hi').status,'too-short');
  const unknown=createTextDetector({availability:async()=> 'unexpected-browser-status'});
  await new Promise(setImmediate);
  assert.equal(unknown.lookup(description).status,'unavailable','Unknown API states cannot invalidate capture signals');
});

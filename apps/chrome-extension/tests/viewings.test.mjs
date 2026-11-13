import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createViewings,BUCKET_MS} from '../src/capture/viewings.js';
import {isEvent} from '../src/capture/protocol.js';

const bucket=Math.floor((Date.now()-3600000)/BUCKET_MS)*BUCKET_MS;
const segment=(t,seconds=1,extra={})=>({kind:'watch',videoId:'abcdefghijk',title:'Example',lang:'en',source:'audio-track',conf:'high',playbackContext:'foreground',durationSeconds:10000,t,seconds,coverage:[0,seconds],...extra});
test('thousands of samples replace one record; revisions and coverage remain cumulative',()=>{
  const v=createViewings();let first,last;
  for(let i=0;i<3000;i++) {
    [last]=v.add(segment(bucket+i*100,.1,{coverage:[i/10,(i+1)/10]}));first??=last;
    assert.ok(isEvent(last));assert.equal(last.eventId,first.eventId);
  }
  assert.equal(first.revision,1);assert.equal(last.revision,3000);
  assert.ok(Math.abs(last.seconds-300)<1e-8);assert.deepEqual(last.coverage,[[0,300]]);
  assert.equal(first.seconds,.1,'Previously sent revisions are immutable');
});
test('buckets, pauses, seeks, metadata and context retain their distinct measurements',()=>{
  const v=createViewings();const split=v.add(segment(bucket+BUCKET_MS-500,1,{coverage:[5,6]}));
  assert.equal(split.length,2);assert.equal(split[0].viewingId,split[1].viewingId);
  assert.notEqual(split[0].eventId,split[1].eventId);assert.deepEqual(split.map(r=>r.seconds),[.5,.5]);
  const [later]=v.add(segment(bucket+BUCKET_MS+10000,1,{coverage:[20,21]}));
  assert.equal(later.eventId,split[1].eventId);assert.equal(later.seconds,1.5);
  assert.deepEqual(later.coverage,[[5.5,6],[20,21]]);
  for(const extra of [{playbackContext:'background'},{lang:'de'},{title:'Changed'},{evidence:{title:'Changed'}}]) {
    const [r]=v.add(segment(bucket+BUCKET_MS+12000,1,extra));assert.notEqual(r.eventId,later.eventId);
  }
  v.reset();assert.notEqual(v.add(segment(bucket+BUCKET_MS+15000))[0].viewingId,later.viewingId);
  assert.notEqual(createViewings().add(segment(bucket+BUCKET_MS+16000))[0].eventId,later.eventId);
});
test('disjoint seek coverage seals bounded records without losing measured seconds',()=>{
  const v=createViewings(),records=new Map();
  for(let i=0;i<600;i++){const [r]=v.add(segment(bucket+i*1000,1,{coverage:[i*2,i*2+1]}));records.set(r.eventId,r);}
  assert.equal(records.size,2);assert.equal([...records.values()].reduce((sum,r)=>sum+r.seconds,0),600);
  assert.ok([...records.values()].every(r=>r.coverage.length<=500&&JSON.stringify(r).length<64000));
});

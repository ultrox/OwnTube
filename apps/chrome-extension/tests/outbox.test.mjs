import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openOutbox,configure,append,nextBatch,status,acknowledge,heldEvents,retryHeld,hold} from '../src/outbox.js';
import {createDrainer} from '../src/drain.js';
import {sanitizeReport,validNetwork} from '../src/network.js';

const config={server:'https://observer.example',deviceId:'device',token:'secret'};
const event=id=>({eventId:id,kind:'watch',t:Date.now()-10000,seconds:5,videoId:'abcdefghijk',title:'Test',evidence:{title:'Test',description:'Original',text:{confidence:0.000001}}});
test('in-flight acknowledgements and rejections cannot remove a newer cumulative revision',async()=>{
  let db=await fresh();const a={...event('viewing'),kind:'viewing',revision:1};
  await append(db,[a]);const sent=(await nextBatch(db)).batch.events;
  await append(db,[{...a,revision:2,seconds:8}]);
  await acknowledge(db,sent,['viewing']);await hold(db,sent[0],'late rejection',Date.now());
  assert.equal((await status(db)).count,1);assert.equal((await status(db)).blockedCount,0);
  db.close();db=await openOutbox();await append(db,[a]);
  assert.equal((await nextBatch(db)).batch.events[0].revision,2);
  assert.equal(Object.keys((await nextBatch(db)).batch.evidence).length,1);
  await assert.rejects(append(db,[{...a,revision:2,seconds:9}]),/different data/);
  await acknowledge(db,(await nextBatch(db)).batch.events,['viewing']);assert.equal((await status(db)).count,0);db.close();
});
async function fresh() {
  await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('youtube-observer');r.onsuccess=resolve;r.onerror=reject;});
  const db=await openOutbox();await configure(db,config);return db;
}
test('outbox survives reopen, deduplicates capture and retains shared evidence until final acknowledgement',async()=>{
  let db=await fresh();const a=event('a'),b=event('b');
  await append(db,[a,b,a]);
  assert.equal((await status(db)).count,2);
  await assert.rejects(configure(db,{...config,deviceId:'other'}),/Drain/);
  db.close();db=await openOutbox();
  let next=await nextBatch(db);assert.equal(Object.keys(next.batch.evidence).length,1);
  assert.equal(typeof Object.values(next.batch.evidence)[0],'string');
  await acknowledge(db,next.batch.events,['a']);
  next=await nextBatch(db);assert.equal(next.batch.events.length,1);assert.equal(Object.keys(next.batch.evidence).length,1);
  await acknowledge(db,next.batch.events,['b']);
  assert.equal((await status(db)).count,0);await configure(db,{...config,deviceId:'other'});db.close();
});
test('lost acknowledgement retries identical IDs; invalid receipts and offline failures never delete',async()=>{
  let db=await fresh();await append(db,[event('a'),event('b')]);
  const saved=new Set();let mode='lost',requests=0,active=0,maximum=0;
  const request=async(_url,options)=>{
    requests++;active++;maximum=Math.max(maximum,active);
    const body=JSON.parse(options.body);
    for(const e of body.events) saved.add(e.eventId);
    await new Promise(setImmediate);active--;
    if(mode==='lost') throw Error('Connection lost after commit');
    return {ok:true,json:async()=>({deviceId:config.deviceId,accepted:mode==='bad'?['unrelated']:body.events.map(e=>e.eventId)})};
  };
  let drain=createDrainer(db,request);
  await Promise.all([drain(),drain()]);assert.equal(requests,1);assert.equal(maximum,1);assert.equal(saved.size,2);assert.equal((await status(db)).count,2);
  await drain();assert.equal(requests,1,'Persisted backoff prevents immediate retry');
  db.close();db=await openOutbox();drain=createDrainer(db,request);
  mode='bad';await drain(true);assert.equal((await status(db)).count,2);
  mode='ok';await drain(true);assert.equal((await status(db)).count,0);assert.equal(saved.size,2);assert.equal((await status(db)).sync.failures,0);db.close();
});
test('backlog drains in bounded batches and partial acknowledgements retain remaining events',async()=>{
  const db=await fresh();await append(db,Array.from({length:251},(_,i)=>event(`e${i}`)));
  const sizes=[];
  const drain=createDrainer(db,async(_url,{body})=>{const b=JSON.parse(body);sizes.push(b.events.length);return{ok:true,json:async()=>({deviceId:config.deviceId,accepted:b.events.slice(0,70).map(e=>e.eventId)})};});
  await drain();assert.equal((await status(db)).count,0);assert.ok(sizes.every(n=>n<=100));assert.equal(sizes.length,4);db.close();
});
test('reports whitelist evidence, replace YouTube session IDs, and retain report video identity',()=>{
  const report=sanitizeReport('https://www.youtube.com/api/stats/watchtime?docid=abcdefghijk&cpn=tracking&st=0,0&et=77,3&au=en-US.4&session_token=secret&vm=opaque&euri=https://private.example','https://www.youtube.com/shorts/other000000',()=> 'local-session');
  assert.equal(report.videoId,'abcdefghijk');assert.equal(report.sessionId,'local-session');assert.equal(validNetwork(report),true);
  assert.deepEqual(Object.keys(report.fields).sort(),['au','et','st']);assert.ok(!JSON.stringify(report).includes('tracking'));assert.ok(!JSON.stringify(report).includes('secret'));
  assert.equal(sanitizeReport('https://evil.example/api/stats/watchtime','https://www.youtube.com',()=>''),null);
  assert.equal(validNetwork({...report,fields:{session_token:'secret'}}),false);
});
test('batches respect the HTTP byte limit with many distinct Unicode descriptions',async()=>{
  const db=await fresh();
  await append(db,Array.from({length:100},(_,i)=>({...event(`large${i}`),evidence:{title:`Video ${i}`,description:'語'.repeat(10000),captions:'字'.repeat(5000)}})));
  const {batch}=await nextBatch(db);
  assert.ok(batch.events.length<100);assert.ok(batch.events.length>1);
  assert.ok(new TextEncoder().encode(JSON.stringify(batch)).length<4*1024*1024);db.close();
});
test('late capture retries from an old document cannot move to a new device after the queue drains',async()=>{
  let db=await fresh();const a=event('old');await append(db,[a],'document-one');
  await acknowledge(db,(await nextBatch(db)).batch.events,['old']);
  await configure(db,{...config,deviceId:'new-device'});db.close();db=await openOutbox();
  await assert.rejects(append(db,[a],'document-one'),/Pairing changed/);
  assert.equal((await status(db)).count,0);
  await append(db,[event('new')],'document-two');assert.equal((await status(db)).count,1);db.close();
});
test('status exposes bounded queue contents and live attempts; receipts commit with queue removal',async()=>{
  const db=await fresh();
  await append(db,[event('watch'),{eventId:'report',kind:'network',endpoint:'qoe',t:Date.now(),fields:{cmt:'1:360.217'}}]);
  const before=await status(db);
  assert.equal(before.count,2);assert.equal(before.nextBatch.watchSeconds,5);
  assert.deepEqual(before.nextBatch.kinds,{watch:1,viewing:0,search:0,network:1});
  assert.equal(before.nextBatch.evidenceCount,1);assert.ok(before.capture.at>0);
  assert.equal(JSON.stringify(before).includes('secret'),false,'Status never exposes pairing credentials');
  let release,started;const response=new Promise(resolve=>{release=resolve;});
  const invoked=new Promise(resolve=>{started=resolve;});
  const drain=createDrainer(db,()=>{started();return response;});
  const pending=drain();await invoked;
  assert.equal(drain.activity().count,2);assert.equal((await status(db)).count,2,'In-flight events stay queued');
  release({ok:true,json:async()=>({deviceId:config.deviceId,accepted:['watch','report']})});await pending;
  const after=await status(db);assert.equal(drain.activity(),null);assert.equal(after.count,0);
  assert.equal(after.sync.lastAcknowledged.count,2);assert.equal(after.sync.lastAcknowledged.watchSeconds,5);
  assert.ok(after.sync.lastAttempt<=after.sync.lastSuccess);assert.equal(after.evidenceCount,0);
  db.close();
});
test('one rejected event is isolated durably without blocking valid events or losing evidence',async()=>{
  let db=await fresh();const bad=event('bad');await append(db,[event('a'),bad,event('z')]);
  let reject=true;const received=new Set();
  const request=async(_url,{body})=>{
    const b=JSON.parse(body);
    if(reject && b.events.some(e=>e.eventId==='bad')) return {ok:false,status:422,json:async()=>({error:'Rejected fixture'})};
    b.events.forEach(e=>received.add(e.eventId));return{ok:true,json:async()=>({deviceId:config.deviceId,accepted:b.events.map(e=>e.eventId)})};
  };
  await createDrainer(db,request)();
  assert.deepEqual([...received].sort(),['a','z']);assert.equal((await status(db)).count,0);assert.equal((await status(db)).blockedCount,1);
  await assert.rejects(configure(db,{...config,deviceId:'wrong'}),/held/);
  await append(db,[bad]);assert.equal((await status(db)).count,0,'Late capture retry remains held');
  db.close();db=await openOutbox();const held=await heldEvents(db);
  assert.equal(held[0].event.eventId,'bad');assert.equal(JSON.parse(held[0].evidence).description,'Original');
  await retryHeld(db);assert.equal((await status(db)).count,1);reject=false;
  await createDrainer(db,request)();assert.equal((await status(db)).blockedCount,0);assert.equal((await status(db)).count,0);assert.equal(received.size,3);db.close();
});
test('auth errors pause automatic uploads; same-device credential replacement preserves the queue',async()=>{
  const db=await fresh();await append(db,[event('one')]);let calls=0;
  const request=async(_url,options)=>{calls++;return options.headers.Authorization==='Bearer replacement'?{ok:true,json:async()=>({deviceId:config.deviceId,accepted:['one']})}:{ok:false,status:401,json:async()=>({error:'Revoked key'})};};
  let drain=createDrainer(db,request);await drain();assert.equal((await status(db)).sync.paused,true);
  drain=createDrainer(db,request,()=>Date.now()+86400000);await drain();assert.equal(calls,1);
  await configure(db,{...config,token:'replacement'});assert.equal((await status(db)).count,1);
  await drain();assert.equal((await status(db)).count,0);assert.equal(calls,2);db.close();
});
test('server Retry-After survives restart; smaller proxy limits split batches without loss',async()=>{
  const db=await fresh();await append(db,[event('a'),event('b')]);let now=100000,calls=0;
  const busy=async()=>{calls++;return{ok:false,status:429,headers:{get:()=> '120'},json:async()=>({error:'Slow down'})};};
  await createDrainer(db,busy,()=>now,()=>0)();assert.equal((await status(db)).sync.nextAttempt,220000);
  now=200000;await createDrainer(db,busy,()=>now)();assert.equal(calls,1);
  const sizes=[];
  await createDrainer(db,async(_url,{body})=>{
    const b=JSON.parse(body);sizes.push(b.events.length);
    return b.events.length>1?{ok:false,status:413,json:async()=>({})}:{ok:true,json:async()=>({deviceId:config.deviceId,accepted:b.events.map(e=>e.eventId)})};
  },()=>220000)(true);
  assert.deepEqual(sizes,[2,1,1]);assert.equal((await status(db)).count,0);assert.equal((await status(db)).blockedCount,0);db.close();
});
test('local conflicting IDs abort the complete capture transaction',async()=>{
  const db=await fresh(),original=event('original');await append(db,[original]);
  await assert.rejects(append(db,[event('new'),{...original,seconds:9}]),/different data/);
  assert.equal((await status(db)).count,1);assert.equal((await nextBatch(db)).batch.events[0].seconds,5);db.close();
});
test('outbox schema upgrade preserves a v1 offline queue and credentials',async()=>{
  const initial=await fresh();initial.close();await new Promise(resolve=>{indexedDB.deleteDatabase('youtube-observer').onsuccess=resolve;});
  const legacy=await new Promise(resolve=>{
    const r=indexedDB.open('youtube-observer',1);r.onupgradeneeded=()=>{
      r.result.createObjectStore('settings');r.result.createObjectStore('evidence');
      const s=r.result.createObjectStore('events',{keyPath:'eventId'});s.createIndex('t','t');s.createIndex('evidenceId','evidenceId');
    };r.onsuccess=()=>resolve(r.result);
  });
  await new Promise(resolve=>{const tx=legacy.transaction(['settings','events'],'readwrite');tx.objectStore('settings').put(config,'config');tx.objectStore('events').put({eventId:'legacy',kind:'watch',t:Date.now(),seconds:5});tx.oncomplete=resolve;});legacy.close();
  const db=await openOutbox();assert.equal(db.version,2);assert.equal((await status(db)).count,1);assert.equal((await status(db)).config.deviceId,'device');db.close();
});

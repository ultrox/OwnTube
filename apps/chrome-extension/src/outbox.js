const req = request => new Promise((resolve,reject) => { request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); });
const done = tx => new Promise((resolve,reject) => { tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error ?? Error('Local transaction aborted')); tx.onerror=()=>{}; });
export function openOutbox() {
  const r=indexedDB.open('youtube-observer',2);
  r.onupgradeneeded=()=>{
    if(!r.result.objectStoreNames.contains('blocked')) r.result.createObjectStore('blocked',{keyPath:'eventId'});
    if(r.result.objectStoreNames.contains('events')) return;
    r.result.createObjectStore('settings');
    const events=r.result.createObjectStore('events',{keyPath:'eventId'});
    events.createIndex('evidenceId','evidenceId');
    events.createIndex('t','t');
    r.result.createObjectStore('evidence');
  };
  return req(r);
}
export async function readSetting(db,key) { return req(db.transaction('settings').objectStore('settings').get(key)); }
export async function writeSetting(db,key,value) { const tx=db.transaction('settings','readwrite'), finished=done(tx); tx.objectStore('settings').put(value,key); await finished; }
export async function configure(db,config) {
  const tx=db.transaction(['settings','events','blocked'],'readwrite'), finished=done(tx);
  const settings=tx.objectStore('settings');
  const [old,count,blocked,sync]=await Promise.all([req(settings.get('config')),req(tx.objectStore('events').count()),req(tx.objectStore('blocked').count()),req(settings.get('sync'))]);
  if((count || blocked) && (old?.server!==config.server || old?.deviceId!==config.deviceId)) { await finished; throw Error('Drain this device’s queue and resolve held events before changing its pairing.'); }
  if(JSON.stringify(old)===JSON.stringify(config)) {await finished;return;}
  settings.put(config,'config');
  settings.put({...sync,failures:0,nextAttempt:0,error:'',paused:false,batchLimit:100},'sync');await finished;
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value==='object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
export async function append(db,events,documentId=null) {
  const evidence=new Map();
  const prepared=await Promise.all(events.map(async ({evidence:snapshot,...event})=>{
    if(new TextEncoder().encode(JSON.stringify(event)).length>64000) throw Error('Event exceeds server size limit');
    if(!snapshot) return event;
    const serialized=JSON.stringify(canonical(snapshot));
    if(new TextEncoder().encode(serialized).length>64000) throw Error('Evidence exceeds server size limit');
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serialized));
    const id=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
    evidence.set(id,serialized); return {...event,evidenceId:id};
  }));
  const tx=db.transaction(['settings','events','evidence','blocked'],'readwrite'), finished=done(tx);
  const config=await req(tx.objectStore('settings').get('config'));
  if(!config) { await finished; throw Error('Pair this collector first.'); }
  if(documentId) {
    const key=`document:${documentId}`,binding={server:config.server,deviceId:config.deviceId};
    const old=await req(tx.objectStore('settings').get(key));
    if(old && JSON.stringify(old)!==JSON.stringify(binding)) { await finished; throw Error('Pairing changed. Refresh this YouTube tab before capturing.'); }
    tx.objectStore('settings').put(binding,key);
  }
  const store=tx.objectStore('events');
  for(const event of prepared) {
    const old=await req(store.get(event.eventId)) ?? (await req(tx.objectStore('blocked').get(event.eventId)))?.event;
    if(old?.kind==='viewing'&&event.kind==='viewing'&&event.revision>old.revision){
      store.put(event);tx.objectStore('blocked').delete(event.eventId);
      if(event.evidenceId)tx.objectStore('evidence').put(evidence.get(event.evidenceId),event.evidenceId);
      continue;
    }
    if(old?.kind==='viewing'&&event.kind==='viewing'&&event.revision<old.revision)continue;
    if(old && JSON.stringify(canonical(old))!==JSON.stringify(canonical(event))) {
      tx.abort();await finished.catch(()=>{});throw Error('Capture event ID already has different data');
    }
    if(!old) {store.add(event);if(event.evidenceId) tx.objectStore('evidence').put(evidence.get(event.evidenceId),event.evidenceId);}
  }
  tx.objectStore('settings').put({at:Date.now(),count:prepared.length,error:''},'capture');
  await finished;
}
export async function nextBatch(db) {
  const tx=db.transaction(['settings','events','evidence','blocked']), finished=done(tx);
  const [config,candidates,count,sync,capture,evidenceCount,blockedCount,blocked]=await Promise.all([
    req(tx.objectStore('settings').get('config')),req(tx.objectStore('events').index('t').getAll(null,100)),
    req(tx.objectStore('events').count()),req(tx.objectStore('settings').get('sync')),
    req(tx.objectStore('settings').get('capture')),req(tx.objectStore('evidence').count()),
    req(tx.objectStore('blocked').count()),req(tx.objectStore('blocked').getAll(null,20)),
  ]);
  const evidence={},events=[],encoder=new TextEncoder();let size=1024;
  for(const event of candidates.slice(0,sync?.batchLimit??100)) {
    const id=event.evidenceId;
    const snapshot=id && !Object.hasOwn(evidence,id) ? await req(tx.objectStore('evidence').get(id)) : null;
    const bytes=encoder.encode(JSON.stringify(event)).length+(snapshot ? encoder.encode(JSON.stringify(snapshot)).length+70 : 0)+1;
    if(events.length && size+bytes>3.5*1024*1024) break;
    size+=bytes;events.push(event);if(snapshot) evidence[id]=snapshot;
  }
  await finished; return {config,batch:{deviceId:config?.deviceId,events,evidence},meta:{count,sync:sync??{},capture:capture??{},evidenceCount,blockedCount,blocked:blocked.map(({evidence,...record})=>record)}};
}
export async function acknowledge(db,events,ids,receipt=null) {
  const tx=db.transaction(['events','evidence','settings'],'readwrite'), finished=done(tx), store=tx.objectStore('events');
  const accepted=new Set(ids);
  for(const event of events) if(accepted.has(event.eventId)) {
    const current=await req(store.get(event.eventId));
    if(current?.revision===event.revision)store.delete(event.eventId);
  }
  for(const id of new Set(events.filter(e=>accepted.has(e.eventId)).map(e=>e.evidenceId).filter(Boolean))) {
    if(await req(store.index('evidenceId').count(id))===0) tx.objectStore('evidence').delete(id);
  }
  if(receipt) tx.objectStore('settings').put(receipt,'sync');
  await finished;
}
export async function status(db) {
  const {config,batch,meta}=await nextBatch(db);
  return {config:config ? {server:config.server,deviceId:config.deviceId} : null,...meta,
    nextBatch:{...summarize(batch.events),bytes:new TextEncoder().encode(JSON.stringify(batch)).length,evidenceCount:Object.keys(batch.evidence).length,events:batch.events,evidence:batch.evidence}};
}
export function summarize(events) {
  const kinds={watch:0,viewing:0,search:0,network:0};let watchSeconds=0;
  for(const event of events) { kinds[event.kind]=(kinds[event.kind]??0)+1;if(event.kind==='watch'||event.kind==='viewing') watchSeconds+=event.seconds; }
  return {count:events.length,kinds,watchSeconds,oldest:events[0]?.t??null};
}
// Rejections are moved, never discarded. Their exact evidence stays available for export/retry.
export async function hold(db,event,reason,at) {
  const tx=db.transaction(['settings','events','evidence','blocked'],'readwrite'),finished=done(tx);
  const store=tx.objectStore('events'),current=await req(store.get(event.eventId));
  if(current && current.revision===event.revision) {
    const evidence=current.evidenceId?await req(tx.objectStore('evidence').get(current.evidenceId)):null;
    tx.objectStore('blocked').put({eventId:current.eventId,event:current,evidence,reason,at});
    store.delete(current.eventId);
    if(current.evidenceId && await req(store.index('evidenceId').count(current.evidenceId))===0) tx.objectStore('evidence').delete(current.evidenceId);
  }
  const settings=tx.objectStore('settings'),sync=await req(settings.get('sync'))??{};
  settings.put({...sync,batchLimit:100,error:'',failures:0,nextAttempt:0,lastHeldAt:at},'sync');
  await finished;
}
export async function heldEvents(db) {return req(db.transaction('blocked').objectStore('blocked').getAll());}
export async function retryHeld(db) {
  const tx=db.transaction(['settings','events','evidence','blocked'],'readwrite'),finished=done(tx);
  const rows=await req(tx.objectStore('blocked').getAll(null,100));
  for(const row of rows) {
    const store=tx.objectStore('events'),existing=await req(store.get(row.eventId));
    if(existing && JSON.stringify(canonical(existing))!==JSON.stringify(canonical(row.event))) {tx.abort();await finished.catch(()=>{});throw Error('Held event conflicts with queued data');}
    store.put(row.event);if(row.evidence) tx.objectStore('evidence').put(row.evidence,row.event.evidenceId);
    tx.objectStore('blocked').delete(row.eventId);
  }
  const settings=tx.objectStore('settings'),sync=await req(settings.get('sync'))??{};
  settings.put({...sync,batchLimit:100,nextAttempt:0,paused:false},'sync');await finished;
}

// Read-only API comparison against an isolated production copy (plus login).
// Usage: node tooling/check-history-parity.mjs http://127.0.0.1:3212 /path/to/admin-token
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const [origin,keyFile]=process.argv.slice(2);
if (!origin || !keyFile) throw new Error('Supply an isolated server origin and owner-key file');
const database=new DatabaseSync(path.join(path.dirname(keyFile),'observer.sqlite3'),{readOnly:true});
const savedEvidence=database.prepare('SELECT payload FROM evidence WHERE id=?');
const sourceSearches=database.prepare(`SELECT e.seq,e.device,e.payload FROM events e
  JOIN devices d ON d.id=e.device
  WHERE e.kind='search' AND e.t>=? AND e.t<? AND e.seq<=?
    AND (?='' OR d.id=?) AND (?='' OR d.person_id=? OR (?='unassigned' AND d.person_id IS NULL))
  ORDER BY e.t DESC,e.seq DESC`);
const login=await fetch(`${origin}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({token:(await fs.readFile(keyFile,'utf8')).trim()})});
assert.equal(login.status,200);
const cookie=login.headers.get('set-cookie').split(';')[0];
const get=async(route,params={})=>{
  const response=await fetch(`${origin}${route}?${new URLSearchParams(params)}`,{headers:{Cookie:cookie}});
  assert.equal(response.status,200,`${route}: ${response.status}`);
  return response.json();
};
const close=(a,b,label)=>assert.ok(Math.abs(a-b)<0.00001,`${label}: ${a} versus ${b}`);
function sameEvidence(a,b) {
  // Rust and JS JSON parsers can differ by one ULP; exact bytes are checked by SHA.
  if (typeof a==='number' && typeof b==='number') {
    assert.ok(Math.abs(a-b)<=Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b)));
  } else if (a && b && typeof a==='object' && typeof b==='object') {
    assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort());
    for (const key of Object.keys(a)) sameEvidence(a[key],b[key]);
  } else assert.deepEqual(a,b);
}
const fields=['seconds','foregroundSeconds','backgroundSeconds','unspecifiedSeconds'];
const initial=await get('/api/history');
const scopes=[{},...initial.devices.map(d=>({device:d.id})),...initial.people.map(p=>({person:p.id})),{person:'unassigned'}];
let checks=0,evidenceChecks=0,searchRows=0;
const historicalDigestMismatches=new Set();
const evidenceSeen=new Set();
for (const days of [7,30,90]) for (const scope of scopes) {
  const params={days,...scope},history=await get('/api/history',params);
  const legacy=await get('/api/dashboard',params);
  const languages=await get('/api/modules/languages',params);
  for (const field of fields) {
    close(history[field],legacy[field],`Legacy ${field}`);
    close(history[field],languages[field],`Languages ${field}`);
  }
  const grouped=await get('/api/modules/languages',{...params,group:'video'});
  for (const field of [...fields,'reviewSeconds','confirmedSeconds','estimatedSeconds']) {
    close(grouped[field],languages[field],`Grouped Languages ${field}`);
  }
  assert.deepEqual(grouped.languages,languages.languages);
  const videos=[...grouped.videos];
  for (let page=2;page<=grouped.pages;page++) {
    videos.push(...(await get('/api/modules/languages',{...params,group:'video',page})).videos);
  }
  assert.equal(videos.length,grouped.count);
  assert.equal(new Set(videos.map(v=>v.videoId)).size,videos.length);
  assert.equal(videos.length,history.videoCount);
  assert.equal(videos.reduce((n,v)=>n+v.versionCount,0),languages.count);
  for (const field of fields) close(videos.reduce((n,v)=>n+v[field],0),history[field],`Grouped page ${field}`);
  for (const video of videos) {
    assert.equal(video.versions.length,video.versionCount);
    assert.equal(video.matchedVersionCount,video.versionCount);
    for (const version of video.versions) assert.equal(version.videoId,video.videoId);
    for (const field of fields) close(video.versions.reduce((n,v)=>n+v[field],0),video[field],`Grouped version ${field}`);
  }
  assert.equal(history.videoCount,legacy.videoCount);
  const rows=[...history.rows];
  for (let page=2;page<=history.pages;page++) {
    const next=await get('/api/history',{...params,page,generation:history.generation,until:history.until});
    assert.equal(next.count,history.count);
    rows.push(...next.rows);
  }
  assert.equal(rows.length,history.count);
  assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);
  for (const field of fields) close(rows.reduce((sum,r)=>sum+r[field],0),history[field],`Paged ${field}`);
  for (const day of history.daily) {
    const dailyRows=rows.filter(r=>r.date===day.date);
    assert.equal(dailyRows.length,day.rowCount);
    for (const field of fields) close(dailyRows.reduce((sum,r)=>sum+r[field],0),day[field],`Daily ${field}`);
  }
  for (const row of rows) {
    const key=`${row.deviceId}/${row.metadataId}`;
    if (evidenceSeen.has(key)) continue;
    evidenceSeen.add(key);
    const detail=await get('/api/history/evidence',{device:row.deviceId,metadata:row.metadataId});
    assert.equal(detail.title,row.title);
    assert.deepEqual(detail.recorded,row.recorded);
    if (detail.evidenceText!==null) {
      assert.equal(detail.evidenceText,savedEvidence.get(detail.evidenceId).payload);
      if (createHash('sha256').update(detail.evidenceText).digest('hex')!==detail.evidenceId) {
        historicalDigestMismatches.add(detail.evidenceId);
      }
      sameEvidence(JSON.parse(detail.evidenceText),detail.evidence);
    }
    evidenceChecks++;
  }
  const searches=await get('/api/history/searches',params),saved=[...searches.rows];
  for (let page=2;page<=searches.pages;page++) {
    const next=await get('/api/history/searches',{...params,page,before:searches.before,until:searches.until});
    saved.push(...next.rows);
  }
  assert.equal(saved.length,searches.count);
  assert.equal(new Set(saved.map(r=>r.id)).size,saved.length);
  const original=sourceSearches.all(searches.since,searches.until,searches.before,
    scope.device??'',scope.device??'',scope.person??'',scope.person??'',scope.person??'');
  assert.equal(saved.length,original.length);
  for (let i=0;i<saved.length;i++) {
    const event=JSON.parse(original[i].payload);
    assert.equal(saved[i].id,original[i].seq);
    assert.equal(saved[i].deviceId,original[i].device);
    assert.equal(saved[i].query,event.query);
    assert.equal(saved[i].t,event.t);
  }
  assert.equal(searches.daily.reduce((n,d)=>n+d.count,0),saved.length);
  for (const day of searches.daily) assert.equal(saved.filter(r=>r.date===day.date).length,day.count);
  searchRows+=saved.length;
  const narrowed=await get('/api/history',{...params,generation:history.generation,until:history.until,query:'no-match-history-parity-8942'});
  assert.equal(narrowed.filteredCount,0);
  for (const field of fields) assert.equal(narrowed[field],history[field]);
  checks++;
}
database.close();
console.log(`History parity: ${checks} period/scope combinations, ${evidenceChecks} exact evidence versions, ${searchRows} paged search rows; legacy/Language totals, grouped videos/versions across pages, daily sums, IDs and filter invariance passed. ${historicalDigestMismatches.size} pre-existing saved evidence digest mismatches preserved.`);

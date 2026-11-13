// Post-release read-only browser smoke (only session login/logout write).
// Usage: node tooling/check-history-public.mjs ORIGIN OWNER_KEY_FILE OUTPUT_DIRECTORY
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {launch} from '../tests/support/browser.mjs';

const [origin,keyFile,output]=process.argv.slice(2);
if (!origin || !keyFile || !output) throw new Error('Supply origin, owner-key file and screenshot directory');
await fs.mkdir(output,{recursive:true});
const root=fileURLToPath(new URL('../../',import.meta.url));
const dist=path.join(root,'apps/backoffice/dist');
const html=await fetch(origin+'/').then(r=>{assert.equal(r.status,200);return r.text();});
assert.equal(html,await fs.readFile(path.join(dist,'index.html'),'utf8'),'Public HTML matches the built release');
const checked=new Set();
async function asset(url) {
  if (checked.has(url.href) || url.origin!==origin) return;
  checked.add(url.href);
  const response=await fetch(url);
  assert.equal(response.status,200);
  const text=await response.text();
  const hash=url.pathname.match(/\.([a-f0-9]{16})\.(?:js|css)$/)?.[1];
  assert.ok(hash,`Content-addressed asset: ${url.pathname}`);
  assert.equal(createHash('sha256').update(text).digest('hex').slice(0,16),hash);
  for (const [,dependency] of text.matchAll(/from\s+['"]((?:\.\/|\/)[^'"]+\.js)['"]/g)) await asset(new URL(dependency,url));
}
for (const [,file] of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) await asset(new URL(file,origin+'/'));
for (const route of ['/legacy/','/modules/languages/','/diagnostics.html','/android-integration.html']) {
  assert.equal((await fetch(origin+route)).status,200,route);
}
for (const route of ['/api/history','/api/history/searches']) assert.equal((await fetch(origin+route)).status,401);
const browser=await launch({
  extensionPath:path.join(root,'apps/chrome-extension/dist'),
  profileRoot:output,
});
const errors=[];
try {
  const ui=await browser.newPage();
  ui.s.on('Runtime.exceptionThrown',e=>errors.push(e.exceptionDetails.text));
  // The test inspects saved records; third-party thumbnails are unnecessary.
  ui.s.on('Fetch.requestPaused',e=>{
    const url=new URL(e.request.url);
    void ui.s.send(url.origin===origin?'Fetch.continueRequest':'Fetch.failRequest',
      url.origin===origin?{requestId:e.requestId}:{requestId:e.requestId,errorReason:'BlockedByClient'});
  });
  await ui.s.send('Fetch.enable',{patterns:[{urlPattern:'http*'}]});
  await ui.setSize(1440,1000);
  await ui.goto(origin+'/#/history');
  await ui.type('#owner-key',(await fs.readFile(keyFile,'utf8')).trim());
  await ui.click('button[type="submit"]');
  await ui.waitFor('[data-ledger]');
  const total=Number(await ui.attr('[data-ledger]','data-seconds'));
  assert.ok(total>0,'Real playback is displayed');
  await ui.screenshot(path.join(output,'history-desktop.png'));
  await ui.click('[data-action="evidence"]');
  await ui.waitFor('[data-ev-estimate]');
  assert.equal(await ui.eval(()=>document.querySelector('#dlg').matches(':modal')),true);
  assert.ok(await ui.count('[data-ev-scope]'));
  await ui.screenshot(path.join(output,'history-evidence.png'));
  await ui.setSize(390,844);
  assert.equal(await ui.eval(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await ui.screenshot(path.join(output,'history-evidence-phone.png'));
  await ui.click('[data-action="close"]');
  await ui.type('#f-q','no-match-public-smoke-8942');
  await ui.waitFor('[data-empty="filter"]');
  assert.equal(Number(await ui.attr('[data-ledger]','data-seconds')),total,'Text filter preserves totals');
  await ui.click('[data-action="clear-q"]');
  await ui.waitFor('[data-row]');
  await ui.screenshot(path.join(output,'history-phone.png'));
  assert.equal(await ui.eval(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await ui.click('.htabs__tab','Searches');
  await ui.waitFor('[data-search-ledger]');
  assert.ok(Number(await ui.attr('[data-search-ledger]','data-count'))>0,'Real searches are displayed');
  assert.equal(await ui.eval(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await ui.screenshot(path.join(output,'searches-phone.png'));
  await ui.setSize(1440,1000);
  await ui.screenshot(path.join(output,'searches-desktop.png'));
  await ui.goto(origin+'/#/history');
  await ui.waitFor('[data-ledger]');
  assert.equal(await ui.count('#owner-key'),0,'Session restored');
  await ui.goto(origin+'/#/history?days=90&q=USBk_L36Rhc');
  await ui.waitFor('[data-row]');
  const reported=await ui.eval(async()=> {
    const data=await fetch('/api/history?days=90&query=USBk_L36Rhc').then(r=>r.json());
    return data.rows.filter(r=>r.videoId==='USBk_L36Rhc');
  });
  assert.equal(reported.length,1,'Reported video is one entry across every visit');
  const visit=reported[0].visits.find(v=>v.viewingId==='dc781504-d8b7-43fe-970d-7367bbd86a92');
  assert.equal(visit.versionCount,2);
  assert.ok(Math.abs(visit.seconds-370.7307000012399)<0.001);
  await ui.click(`[data-row="${reported[0].id}"] [data-action="evidence"]`);
  await ui.waitFor('[data-ev-estimate]');
  assert.equal(await ui.count('#f-version option'),reported[0].versionCount);
  assert.equal(await ui.count('[data-visit]'),reported[0].visitCount);
  const earlier=visit.versions.find(v=>v.seconds<1);
  await ui.eval((value)=>{
    const select=document.querySelector('#f-version'); select.value=value; select.dispatchEvent(new Event('change',{bubbles:true}));
  },`${earlier.deviceId}:${earlier.metadataId}`);
  await ui.waitFor('[data-ev-estimate]');
  const exact=await ui.eval(async(metadata)=>fetch('/api/history/evidence?device=f78d809a-7318-44f8-8336-f6ca1a6f30f5&metadata='+metadata).then(r=>r.json()),earlier.metadataId);
  assert.equal(await ui.text('[data-raw="exact"]'),exact.evidenceText);
  await ui.screenshot(path.join(output,'history-grouped-reported-viewing.png'));
  await ui.setSize(390,844);
  assert.equal(await ui.eval(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await ui.screenshot(path.join(output,'history-grouped-phone.png'));
  await ui.click('[data-key="dlg:languages"]');
  await ui.waitFor('[data-assessment]');
  assert.equal(await ui.eval(()=>document.querySelector('#f-version')?.value),`${earlier.deviceId}:${earlier.metadataId}`,'History deep link selects exact Languages version');
  await ui.setSize(1440,1000);
  await ui.goto(origin+'/legacy/');
  await ui.waitFor('#watch-total');
  await ui.goto(origin+'/modules/languages/');
  await ui.waitFor('[data-ledger]');
  const languageHtml=await fetch(origin+'/modules/languages/').then(r=>r.text());
  assert.equal(languageHtml,await fs.readFile(path.join(dist,'modules/languages/index.html'),'utf8'));
  for (const [,file] of languageHtml.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
    await asset(new URL(file,origin+'/modules/languages/'));
  }
  const grouped=await ui.eval(async()=>{
    const response=await fetch('/api/modules/languages?days=90&group=video');
    if (!response.ok) throw new Error('Grouped Languages unavailable');
    return response.json();
  });
  assert.equal(new Set(grouped.videos.map(v=>v.videoId)).size,grouped.videos.length);
  assert.ok(grouped.videos.every(v=>v.versions.length===v.versionCount));
  for (const videoId of ['qHlyWqUJVSw','6bb7wBcw-mM','YvRrNW0ZaUc']) {
    const video=await ui.eval(async(id)=>(await fetch('/api/modules/languages?days=90&group=video&query='+id).then(r=>r.json())).videos[0],videoId);
    assert.ok(video,videoId);
    assert.ok(video.versions.some(v=>v.assessment.lang==='en'&&v.assessment.source==='selected-audio-metadata'),`Saved English selected track decoded: ${videoId}`);
    assert.ok(!video.versions.some(v=>v.assessment.source==='collector:audio-track'&&v.assessment.lang==='de'),`Wrong German fallback removed: ${videoId}`);
  }
  await ui.type('#f-query','Lead In Silence');
  await ui.waitFor('[data-count="1"]');
  await ui.waitFor('[data-row]','Lead In Silence');
  assert.equal(await ui.count('[data-row]'),1,'Screenshot video appears only once');
  assert.match(await ui.text('[data-row]'),/English/);
  assert.equal(await ui.count('[data-row] .flag-review'),0,'Saved selected audio is classified automatically');
  await ui.click('[data-action="open"]');
  await ui.waitFor('[data-assessment]');
  assert.match(await ui.text('[data-group-assessment]'),/English/);
  assert.match(await ui.text('[data-group-review]'),/Nothing here needs review/);
  await ui.screenshot(path.join(output,'languages-automatic-english.png'));
  await ui.setSize(390,844);
  assert.equal(await ui.eval(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await ui.screenshot(path.join(output,'languages-automatic-phone.png'));
  await ui.click('[data-action="close"]');
  assert.equal(errors.length,0,JSON.stringify(errors));
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({
    origin,checkedAt:new Date().toISOString(),assets:[...checked],seconds:total,
    checks:['public asset hashes','authentication','real History','real Searches','evidence modal',
      'stable filtered totals','phone layout','session restoration','legacy dashboard',
      'grouped Languages','automatic English classification','Languages asset hashes and phone layout',
      'reported History viewing grouped','exact older evidence','selected-version Languages deep link'],
    pageErrors:errors,
  },null,2));
  console.log('Public desk: asset hashes, authentication, real records, evidence, stable totals, phone layouts, legacy, grouped Languages and automatic English classification passed.');
} finally { await browser.close(); }

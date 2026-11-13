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
  for (const [,dependency] of text.matchAll(/from\s+['"](\.\/[^'"]+\.js)['"]/g)) await asset(new URL(dependency,url));
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
  await ui.goto(origin+'/legacy/');
  await ui.waitFor('#watch-total');
  await ui.goto(origin+'/modules/languages/');
  await ui.waitFor('[data-ledger]');
  assert.equal(errors.length,0,JSON.stringify(errors));
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({
    origin,checkedAt:new Date().toISOString(),assets:[...checked],seconds:total,
    checks:['public asset hashes','authentication','real History','real Searches','evidence modal',
      'stable filtered totals','phone layout','session restoration','legacy dashboard','Languages'],
    pageErrors:errors,
  },null,2));
  console.log('Public History: assets, authentication, real records, evidence, stable filter totals, phone layouts, session restoration, legacy and Languages passed.');
} finally { await browser.close(); }

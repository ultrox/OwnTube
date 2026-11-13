import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {launch,waitFor} from '../support/browser.mjs';

test('sign-in is independent of slow history; Observer and Languages retain separate scopes',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'observer-dashboard-'));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`,admin='dashboard-test-owner-key-only';
  const server=spawn(path.resolve('target/debug/youtube-observer'),[],{env:{...process.env,BIND:`127.0.0.1:${port}`,DATA_DIR:folder,ADMIN_TOKEN:admin},stdio:'ignore'});
  let browser;
  try {
    await waitFor(()=>fetch(`${origin}/health`).then(r=>r.ok));
    const login=await fetch(`${origin}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:admin})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const create=async(label,person)=>fetch(`${origin}/api/devices`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({label,person})}).then(r=>r.json());
    const laptop=await create('My laptop','Me'),tablet=await create('My tablet','Me'),sister=await create('Sister phone','Sister');
    const event=(id,lang,seconds,n=0)=>({eventId:id,kind:'watch',t:Date.now()-60000,seconds,videoId:`v${String(n).padStart(10,'0')}`,title:`Video ${String(n).padStart(2,'0')}`,lang,source:'audio-track',conf:'high',playbackContext:'background'});
    const upload=async(device,events)=>{
      const response=await fetch(`${origin}/api/ingest`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${device.token}`},body:JSON.stringify({deviceId:device.deviceId,events,evidence:{}})});
      assert.equal(response.status,200);
    };
    await upload(laptop,[...Array.from({length:25},(_,i)=>event(`en-${i}`,'en',2,i)),event('de','de',20),event('other','other',10)]);
    await upload(tablet,[event('tablet','de',10)]);
    await upload(sister,[event('sister','es',5)]);

    browser=await launch({extensionPath:path.resolve('../apps/chrome-extension/dist')});
    const ui=await browser.newPage();
    // Hold history indefinitely, so the test proves sign-in does not wait for it.
    const pending=[];
    let hold=true;
    await ui.s.send('Fetch.enable',{patterns:[{urlPattern:`${origin}/api/dashboard*`}]});
    ui.s.on('Fetch.requestPaused',request=>{
      if(hold) pending.push(request.requestId);
      else void ui.s.send('Fetch.continueRequest',{requestId:request.requestId});
    });
    await ui.goto(origin+'/');await ui.type('#owner-key',admin);await ui.click('button','Sign in');
    await waitFor(()=>pending.length===1);
    await ui.waitFor('#observer-panel','You’re signed in');
    assert.equal(await ui.count('#owner-key'),0,'The login form closes before history finishes');
    await ui.click('#languages-tab');await ui.waitFor('#language-total','1m 35s');
    assert.equal(await ui.text('#language-focus-share'),'31.6%');
    assert.equal(await ui.count('#watch-total'),0,'Only the active view is rendered');
    hold=false;await ui.s.send('Fetch.continueRequest',{requestId:pending.shift()});
    await ui.click('#observer-tab');await ui.waitFor('#watch-total','1m 35s');

    // A restored owner session should also bypass the Welcome back form during slow loading.
    hold=true;await ui.goto(origin+'/');await waitFor(()=>pending.length===1);
    await ui.waitFor('#observer-panel','You’re signed in');assert.equal(await ui.count('#owner-key'),0);
    await waitFor(()=>ui.eval(()=>document.body.textContent.includes('Loading took too long. Please try again.')),{timeout:12000,message:'bounded history timeout'});
    hold=false;await ui.s.send('Fetch.continueRequest',{requestId:pending.shift()}).catch(()=>{});
    await ui.click('#observer-panel button','Try again');
    await ui.waitFor('#watch-total','1m 35s');await ui.s.send('Fetch.disable');
    const select=async(selector,value)=>{
      await waitFor(()=>ui.eval(s=>{const el=document.querySelector(s);return el&&!el.disabled;},selector));
      await ui.type(selector,value);
    };
    const personId=async name=>ui.eval(n=>[...document.querySelectorAll('#person-filter option')].find(o=>o.textContent===n).value,name);
    const me=await personId('Me'),sisterId=await personId('Sister');
    await select('#person-filter',me);await ui.waitFor('#watch-total','1m 30s');
    await ui.click('button','Show videos');await ui.type('#history-query','Video');
    await select('select[aria-label="Videos per page"]','10');await ui.waitFor('.page-label','Page 1 of 3');
    await ui.click('button','Next');await ui.waitFor('.page-label','Page 2 of 3');

    await ui.click('#languages-tab');await ui.waitFor('#language-total','1m 35s');
    assert.equal(await ui.eval(()=>document.querySelector('#language-person-filter').value),'','Language scope does not inherit the Observer person');
    await select('#language-person-filter',me);await ui.waitFor('#language-total','1m 30s');
    await select('#language-device-filter',laptop.deviceId);await ui.waitFor('#language-total','1m 20s');
    assert.equal(await ui.text('[data-language="de"] .language-duration'),'0m 20s');
    assert.equal(await ui.text('[data-language="en"] .language-percentage'),'62.5%');
    assert.equal(await ui.text('#language-focus-share'),'25%');
    assert.equal(await ui.text('#language-rest-share'),'75%');
    assert.equal(await ui.text('[data-language="other"] .language-percentage'),'12.5%');
    await ui.click('#language-review-toggle');await ui.waitFor('.review-video-link','Video 00');
    assert.equal(await ui.count('.review-video'),1);
    assert.equal(await ui.attr('.review-video-link','href'),'https://www.youtube.com/watch?v=v0000000000');
    assert.equal(await ui.attr('.review-video-link','target'),'_blank');
    assert.ok((await ui.text('.review-time')).includes('0m 10s'),'Review counts only the uncertain segment, not all playback of the same video');
    await select('#language-person-filter',sisterId);await ui.waitFor('#language-total','0m 5s');
    await ui.waitFor('#language-review-empty');
    assert.equal(await ui.eval(()=>document.querySelector('#language-device-filter').value),'','Changing person clears only the language device filter');
    assert.equal(await ui.count('#language-device-filter option','My tablet'),0);
    await ui.click('#languages-panel .range-buttons button','30 days');await ui.waitFor('#language-total','0m 5s');
    await select('#language-comparison','es');await ui.waitFor('#language-focus-share','100%');

    await ui.click('#observer-tab');await ui.waitFor('.page-label','Page 2 of 3');
    assert.equal(await ui.eval(()=>document.querySelector('#person-filter').value),me);
    assert.equal(await ui.eval(()=>document.querySelector('#history-query').value),'Video');
    assert.equal(await ui.text('#observer-panel .range-buttons [aria-pressed="true"]'),'7 days');
    assert.equal(await ui.text('#watch-total'),'1m 30s');
    // Keyboard tabs support arrows, selection state and focus.
    await ui.realClick('#observer-tab');
    await ui.s.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    await ui.s.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
    await ui.waitFor('#language-total','0m 5s');
    assert.equal(await ui.eval(()=>document.activeElement.id),'languages-tab');
    assert.equal(await ui.attr('#languages-tab','aria-selected'),'true');
    assert.equal(await ui.text('#languages-panel .range-buttons [aria-pressed="true"]'),'30 days');
    assert.equal(await ui.eval(()=>document.querySelector('#language-comparison').value),'es');

    await select('#language-person-filter','unassigned');await ui.waitFor('#language-empty');
    assert.equal(await ui.text('#language-focus-share'),'—');
    assert.equal(await ui.count('#language-table'),0);
    await select('#language-person-filter','');await ui.waitFor('#language-total','1m 35s');
    await select('#language-comparison','de');
    fs.mkdirSync('artifacts',{recursive:true});
    await ui.setSize(1280,1200);await ui.eval(()=>window.scrollTo(0,0));await ui.screenshot('artifacts/languages.png');
    await ui.click('button','Light theme');await ui.screenshot('artifacts/languages-light.png');
    await ui.setSize(390,844);await ui.eval(()=>window.scrollTo(0,0));
    assert.equal(await ui.eval(()=>document.documentElement.scrollWidth<=innerWidth),true,'Language breakdown fits mobile');
    await ui.screenshot('artifacts/languages-mobile.png');

    await waitFor(()=>ui.eval(async()=>{
      const data=await fetch('/api/diagnostics').then(r=>r.json());
      return data.browser['dashboard.ready']?.samples>0&&data.browser['languages.network']?.samples>0&&data.browser['review.ready']?.samples>0;
    }),{message:'real browser measurements'});
    const diagnostics=await browser.newPage(origin+'/diagnostics.html');
    await diagnostics.waitFor('#requests','/api/dashboard');
    await diagnostics.waitFor('#stages','analytics_compute');
    await diagnostics.waitFor('#browser','dashboard.ready');
    await diagnostics.close();

    // Expired/revoked owner sessions clear both views instead of leaving stale private data.
    await ui.eval(()=>fetch('/api/logout',{method:'POST'}));
    await ui.click('#language-refresh');await ui.waitFor('#owner-key');
    assert.equal(await ui.count('#language-total'),0);assert.equal(await ui.count('#watch-total'),0);
    assert.equal(ui.dialogs.length,0);
  } finally {
    if(browser) await browser.close();
    if(server.exitCode===null){const stopped=once(server,'exit');server.kill('SIGINT');await stopped;}
    fs.rmSync(folder,{recursive:true,force:true});
  }
});

// Opt-in public YouTube smoke check, with a temporary database and signed-out browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {launch,waitFor} from '../tests/support/browser.mjs';

const folder=fs.mkdtempSync(path.join(os.tmpdir(),'observer-live-'));
const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
const origin=`http://127.0.0.1:${port}`,key=crypto.randomUUID();
const server=spawn(path.resolve('target/debug/youtube-observer'),[],{env:{...process.env,BIND:`127.0.0.1:${port}`,DATA_DIR:folder,ADMIN_TOKEN:key},stdio:'ignore'});
const report={checkedAt:new Date().toISOString(),profile:'disposable, signed out',videos:[]};
let browser;
try {
  await waitFor(()=>fetch(`${origin}/health`).then(r=>r.ok));
  const login=await fetch(`${origin}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:key})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const device=await fetch(`${origin}/api/devices`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({label:'Live probe'})}).then(r=>r.json());
  browser=await launch({extensionPath:path.resolve('../apps/chrome-extension/dist')});
  const popup=await browser.newPage(`chrome-extension://${browser.extId}/popup.html`);
  const result=await popup.eval(v=>chrome.runtime.sendMessage({tag:'Configure',...v}),{server:origin,token:device.token});
  if(!result.ok) throw Error(result.error);
  const page=await browser.newPage();await page.setSize(1280,900);
  for(const url of ['https://www.youtube.com/shorts/nOMbBrCYmqE','https://www.youtube.com/watch?v=vf0god0LtP8']) {
    const observation={url,passed:false};report.videos.push(observation);
    try {
      await page.s.send('Page.navigate',{url});await page.foreground();
      let since=null;
      await waitFor(async()=>{
        const {frameTree}=await page.s.send('Page.getFrameTree');
        const frames=t=>[t.frame,...(t.childFrames??[]).flatMap(frames)];
        for(const frame of frames(frameTree).filter(f=>f.url.startsWith('https://consent.youtube.com/'))) {
          const {executionContextId}=await page.s.send('Page.createIsolatedWorld',{frameId:frame.id,worldName:'observer-live-probe'});
          await page.s.send('Runtime.evaluate',{contextId:executionContextId,expression:"[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Reject all')?.click()"});
        }
        const playing=await page.eval(()=>{
          [...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Reject all')?.click();
          const p=document.querySelector('[data-youtube-observer-video-id]'),v=p?.querySelector('video');
          if(!v) return false;v.muted=true;if(v.paused) void v.play().catch(()=>{});
          return !v.paused && v.readyState>=2 && v.currentTime>0 && !p.classList.contains('ad-showing');
        });
        since=playing?(since??Date.now()):null;return since!==null && Date.now()-since>5000;
      },{timeout:45000,interval:500,message:'live content playback'});
      await page.eval(()=>document.querySelector('[data-youtube-observer-video-id] video')?.pause());
      const videoId=new URL(url).searchParams.get('v')??new URL(url).pathname.split('/').pop();
      await waitFor(async()=>{
        await popup.eval(()=>chrome.runtime.sendMessage({tag:'Drain'}));
        const snapshot=await fetch(`${origin}/api/dashboard`,{headers:{Cookie:cookie}}).then(r=>r.json());
        const video=snapshot.videos.find(v=>v.videoId===videoId);
        if(video?.seconds>0) { observation.saved=video;return true; } return false;
      },{timeout:10000,interval:1000,message:'live watch saved on server'});
      observation.passed=true;
    } catch(error) {
      observation.error=error.message;
      observation.page=await page.eval(()=>({title:document.title,text:document.body?.innerText.slice(0,1500)})).catch(()=>null);
    }
  }
  const ui=await browser.newPage(origin+'/legacy/');await ui.type('#owner-key',key);await ui.click('button','Sign in');await ui.waitFor('#watch-total');await ui.setSize(1280,1000);
  fs.mkdirSync('artifacts',{recursive:true});await ui.screenshot('artifacts/live-dashboard.png');
  report.passed=report.videos.every(v=>v.passed);
} catch(error) {report.error=error.message;report.passed=false;}
finally {
  if(browser) await browser.close();
  const stopped=once(server,'exit');server.kill('SIGINT');await stopped;
  fs.rmSync(folder,{recursive:true,force:true});fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/live.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,videos:report.videos.map(v=>({url:v.url,passed:v.passed,seconds:v.saved?.seconds,error:v.error})),error:report.error},null,2));
  if(!report.passed) process.exitCode=1;
}

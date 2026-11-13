import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {waitFor} from '../tests/support/browser.mjs';

const name=`observer-check-${crypto.randomUUID()}`,volume=`${name}-data`;
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8'}).trim();
const start=async()=>{
  docker('run','-d','--name',name,'-p','127.0.0.1::3210','-v',`${volume}:/app/data`,'youtube-observer:local');
  const address=docker('port',name,'3210/tcp');const origin=`http://${address}`;
  await waitFor(()=>fetch(`${origin}/health`).then(r=>r.ok),{timeout:15000});return origin;
};
try {
  let origin=await start();
  assert.equal(docker('exec',name,'id','-u'),'10001');
  const deskHtml=await fetch(origin).then(r=>r.text());
  assert.match(deskHtml,/OwnTube/);
  assert.match(deskHtml,/desk\.[a-f0-9]{16}\.js/);
  assert.match(await fetch(`${origin}/legacy/`).then(r=>r.text()),/YouTube Observer/);
  for (const [,asset] of deskHtml.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)) {
    const url=new URL(asset,origin);
    if (url.origin!==origin) continue;
    const response=await fetch(url);
    assert.equal(response.status,200,`Packaged desk asset: ${asset}`);
    assert.doesNotMatch(response.headers.get('content-type')??'',/text\/html/);
    if (asset.endsWith('.js')) {
      const script=await response.text();
      for (const [,dependency] of script.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
        assert.match(dependency,/\.[a-f0-9]{16}\.js$/);
        const imported=await fetch(new URL(dependency,url));
        assert.equal(imported.status,200);
        assert.doesNotMatch(imported.headers.get('content-type')??'',/text\/html/);
      }
    }
  }
  const modulePage=await fetch(`${origin}/modules/languages/`);
  assert.equal(modulePage.status,200);
  const moduleHtml=await modulePage.text();
  assert.match(moduleHtml,/Languages/i);
  for (const [,asset] of moduleHtml.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)) {
    const url=new URL(asset,`${origin}/modules/languages/`);
    if (url.origin!==origin) continue;
    const response=await fetch(url);
    assert.equal(response.status,200,`Packaged module asset: ${asset}`);
    assert.doesNotMatch(response.headers.get('content-type')??'',/text\/html/,`Asset is not an HTML fallback: ${asset}`);
  }
  assert.equal((await fetch(`${origin}/api/modules/languages`)).status,401);
  for (const route of ['/api/history','/api/history/searches','/api/history/evidence']) {
    assert.equal((await fetch(`${origin}${route}${route.endsWith('evidence')?'?device=none&metadata='+'a'.repeat(64):''}`)).status,401);
  }
  const token=docker('exec',name,'cat','/app/data/admin-token');
  const login=await fetch(`${origin}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const languages=await fetch(`${origin}/api/modules/languages`,{headers:{Cookie:cookie}});
  assert.equal(languages.status,200);
  assert.equal((await languages.json()).seconds,0);
  for (const route of ['/api/history','/api/history/searches']) {
    const response=await fetch(`${origin}${route}`,{headers:{Cookie:cookie}});
    assert.equal(response.status,200);
    const history=await response.json();
    assert.equal(history.count,0);
    assert.equal(history.daily.length,7);
  }
  const created=await fetch(`${origin}/api/devices`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({label:'Container persistence check'})});
  assert.equal(created.status,200);
  docker('stop','--signal','SIGINT',name);docker('rm',name);origin=await start();
  assert.equal(docker('exec',name,'cat','/app/data/admin-token'),token);
  const snapshot=await fetch(`${origin}/api/dashboard`,{headers:{Cookie:cookie}}).then(r=>r.json());
  assert.equal(snapshot.devices[0].label,'Container persistence check');
  console.log('Docker: non-root runtime, hashed History desk, legacy dashboard, Languages, authenticated APIs, and persistent volume recreation passed.');
} finally {
  try {docker('rm','-f',name);} catch { /* The container may already have been removed. */ }
  docker('volume','rm',volume);
}

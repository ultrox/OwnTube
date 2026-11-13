import { CHANNEL, isEvent } from './capture/protocol.js';
import { openOutbox, append, configure, status, writeSetting, heldEvents, retryHeld } from './outbox.js';
import { createDrainer } from './drain.js';
import { validNetwork } from './network.js';

const db=openOutbox();
const drainer=db.then(value=>createDrainer(value));
// Waking the worker or opening its popup must not postpone an existing alarm.
const alarm=async()=>{if(!await chrome.alarms.get('upload')) await chrome.alarms.create('upload',{periodInMinutes:0.5});};
chrome.runtime.onInstalled.addListener(alarm);
chrome.runtime.onStartup.addListener(alarm);
void alarm();
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='upload') void drainer.then(run=>run());});
async function snapshot(store) {
  await alarm();
  const [saved,scheduled,run]=await Promise.all([status(store),chrome.alarms.get('upload'),drainer]);
  return {ok:true,...saved,active:run.activity(),nextCheck:scheduled?.scheduledTime??null};
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id) return;
  const trustedUI=sender.url?.startsWith(chrome.runtime.getURL(''));
  const youtube=sender.tab && sender.frameId===0 && /^https:\/\/(www\.|m\.)?youtube\.com\//.test(sender.url??'');
  void (async()=>{
    const store=await db;
    if(youtube && message?.channel===CHANNEL && message.tag==='Capture') {
      if(!Array.isArray(message.events) || !message.events.length || message.events.length>100 || !message.events.every(e=>isEvent(e)||validNetwork(e))) throw Error('Invalid capture');
      if(!sender.documentId) throw Error('Missing capture document identity');
      try { await append(store,message.events,sender.documentId); }
      catch(error) {await writeSetting(store,'capture',{at:Date.now(),error:error.message});throw error;}
      return {ok:true};
    }
    if(!trustedUI) throw Error('Unknown sender');
    if(message.tag==='Status') return snapshot(store);
    if(message.tag==='ExportHeld') return {ok:true,events:await heldEvents(store)};
    if(message.tag==='RetryHeld') {await retryHeld(store);return snapshot(store);}
    if(message.tag==='Drain') { await (await drainer)(true); return snapshot(store); }
    if(message.tag==='Configure') {
      const url=new URL(message.server);
      if(url.username || url.password || url.pathname!=='/' || url.search || url.hash || !(url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw Error('Use an HTTPS server origin, or local HTTP.');
      if(typeof message.token!=='string' || message.token.length>200) throw Error('Invalid device key');
      const server=url.origin;
      const response=await fetch(`${server}/api/device`,{headers:{Authorization:`Bearer ${message.token}`},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!response.ok) throw Error(`Pairing failed (${response.status})`);
      const identity=await response.json();
      if(typeof identity.deviceId!=='string') throw Error('Invalid device response');
      await configure(store,{server,deviceId:identity.deviceId,token:message.token});
      return snapshot(store);
    }
    throw Error('Unknown message');
  })().then(respond,error=>respond({ok:false,error:error.message}));
  return true;
});

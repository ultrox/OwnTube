const $=id=>document.getElementById(id);
const message=async value=>{const result=await chrome.runtime.sendMessage(value);if(!result.ok) throw Error(result.error);return result;};
const duration=seconds=>seconds>0 && seconds<0.1?'<0.1s':seconds<60?`${seconds.toFixed(1)}s`:`${Math.floor(seconds/60)}m ${(seconds%60).toFixed(1)}s`;
const timestamp=at=>at?new Date(at).toLocaleString():'Not yet';
const reportName=endpoint=>({qoe:'Playback quality (QoE)',watchtime:'YouTube-reported media ranges',playback:'Playback report',timedtext:'Caption request'}[endpoint]??endpoint);
let latest=null,loading=false,initialized=false,manual=false,previewKey='';
function schedule() {
  if(!latest) return;
  const s=latest,now=Date.now();
  if(s.active) { $('next-attempt').textContent=`Uploading ${s.active.count} events now…`;return; }
  if(!s.config) { $('next-attempt').textContent='Pair this collector first';return; }
  if(s.sync.paused) { $('next-attempt').textContent='Authentication paused — replace this device’s key or retry manually';return; }
  let next=s.nextCheck;
  if(next && s.sync.nextAttempt>next) next+=Math.ceil((s.sync.nextAttempt-next)/30000)*30000;
  $('next-attempt').textContent=next?`${s.count?'Upload attempt':'Queue check'} ${next>now?`in ${Math.ceil((next-now)/1000)}s`:'due when Chrome runs the alarm'}${s.sync.nextAttempt>now?' · retry backoff':''}`:'Waiting for Chrome’s upload alarm';
}
function render(s) {
  latest=s;
  $('status').textContent=!s.config?'Not paired — connect below':s.active?'Uploading · waiting for the server’s receipt':s.sync.paused?'Authentication paused · pending data is retained':s.sync.error?'Upload failed · events are still safe locally':s.count?'Collecting · events waiting to upload':s.blockedCount?'Upload queue empty · held events need attention':'Queue empty · new activity will appear here';
  $('queue-count').textContent=s.count;
  $('watch-seconds').textContent=duration(s.nextBatch.watchSeconds);
  $('last-capture').textContent=s.capture.error?`Capture error: ${s.capture.error}`:timestamp(s.capture.at);
  $('last-attempt').textContent=s.sync.lastAttempt?`${timestamp(s.sync.lastAttempt)} · ${s.sync.lastBatch?.count??'?'} events`:'No upload attempted yet';
  $('last-ack').textContent=s.sync.lastSuccess?`${timestamp(s.sync.lastSuccess)}${s.sync.lastAcknowledged?` · ${s.sync.lastAcknowledged.count} events · ${duration(s.sync.lastAcknowledged.watchSeconds)} watch time`:''}`:'No server acknowledgement yet';
  $('oldest').textContent=s.nextBatch.oldest?timestamp(s.nextBatch.oldest):'Queue empty';
  $('sync-error').hidden=!s.sync.error;
  $('sync-error').textContent=s.sync.error?`${s.sync.error} · ${s.sync.failures??0} consecutive failed attempt(s). ${s.sync.paused?'Replace the device key in Server & pairing. ':''}Upload now retries immediately.`:'';
  $('held').hidden=!s.blockedCount;$('held-count').textContent=`${s.blockedCount} held event(s)`;
  $('held-list').replaceChildren(...s.blocked.map(row=>{const p=document.createElement('p');p.textContent=`${row.event.kind} · ${row.event.title||row.event.videoId||row.eventId} · ${row.reason}`;return p;}));
  $('sync').disabled=manual || !!s.active || !s.config || !s.count;
  const b=s.nextBatch;
   $('batch-summary').textContent=b.count?`${b.count} of ${s.count} queued records: ${b.kinds.viewing??0} cumulative viewings, ${b.kinds.watch} legacy segments, ${b.kinds.search} searches. Watch time shown is cumulative, not additional time on each upload.`:'Nothing queued. Play a video in a refreshed YouTube tab to see capture activity.';
  $('batch-evidence').textContent=b.count?`${b.evidenceCount} title/description/language snapshots · ${(b.bytes/1024).toFixed(1)} KB request. ${s.evidenceCount} snapshots stored across the local queue.`:'';
  const key=JSON.stringify(b.events);
  if(key!==previewKey) {
    previewKey=key;
    const opened=new Set([...$('events').querySelectorAll('details[open]')].map(el=>el.dataset.id));
    $('events').replaceChildren(...b.events.map(event=>{
      const details=document.createElement('details'),summary=document.createElement('summary'),info=document.createElement('small');
      details.className='event';details.dataset.id=event.eventId;
       summary.textContent=['watch','viewing'].includes(event.kind)?`Watch · ${duration(event.seconds)} · ${event.title||event.videoId}${event.kind==='viewing'?` · revision ${event.revision}`:''}`:event.kind==='search'?`Search · ${event.query}`:`${reportName(event.endpoint)} · ${event.videoId??'no video ID'}`;
       info.textContent=`${timestamp(event.t)}${['watch','viewing'].includes(event.kind)?` · ${event.playbackContext==='foreground'?'On-tab':event.playbackContext==='background'?'Background':'Context unspecified'} · ${event.lang} · ${event.source}`:' · adds 0s watch time'}`;
      summary.append(info);details.append(summary);
      const inspect=()=>{
        if(!details.open || details.querySelector('pre')) return;
        const pre=document.createElement('pre');
        if(event.kind==='network') {
          const explanation=document.createElement('p');explanation.className='note';
          explanation.textContent=event.endpoint==='qoe'?'YouTube quality diagnostics: bh = buffer samples, bwe = estimated bandwidth, cmt = media-position samples, fmt/afmt = format codes. vis contains internal visibility codes we have not decoded. This is not elapsed watch time; no title/description snapshot is expected.':'Supplemental YouTube evidence, not our watch counter. Reported media ranges can include replays and different playback speeds. No title/description snapshot is expected here.';
          details.append(explanation);
        }
        pre.textContent=JSON.stringify({...event,...(event.evidenceId?{savedEvidence:JSON.parse(b.evidence[event.evidenceId])}:{})},null,2);
        details.append(pre);
      };
      details.addEventListener('toggle',inspect);details.open=opened.has(event.eventId);inspect();return details;
    }));
  }
  if(s.config) { $('paired-server').textContent=`${s.config.server} · device ${s.config.deviceId}`; $('dashboard').href=s.config.server; }
  if(!initialized) { $('connection').open=!s.config;initialized=true; }
  schedule();
}
const failure=e=>{$('notice').textContent=e.message;};
async function refresh() {
  if(loading) return;loading=true;
  try {render(await message({tag:'Status'}));} catch(error) {failure(error);} finally {loading=false;}
}
$('sync').addEventListener('click',async()=>{
  manual=true;$('sync').disabled=true;$('notice').textContent='Requesting upload…';
    try {const result=await message({tag:'Drain'});render(result);$('notice').textContent=result.sync.error?'Upload did not complete; events remain queued.':result.count?'More events remain for the next drain.':result.blockedCount?'Upload queue drained. Rejected events remain in Held data.':'Server acknowledged the events. Queue is empty.';}
  catch(error) {failure(error);} finally {manual=false;void refresh();}
});
void refresh();setInterval(refresh,2000);setInterval(schedule,1000);
$('retry-held').addEventListener('click',()=>message({tag:'RetryHeld'}).then(s=>{render(s);$('notice').textContent='Held events returned to the queue. Upload now to retry.';},failure));
$('export-held').addEventListener('click',async()=>{
  try {
    const result=await message({tag:'ExportHeld'});
    const url=URL.createObjectURL(new Blob([JSON.stringify({exportedAt:new Date().toISOString(),device:latest.config,events:result.events},null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='youtube-observer-held-events.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch(error) {failure(error);}
});

import { nextBatch, acknowledge, readSetting, writeSetting, summarize, hold } from './outbox.js';

export function createDrainer(db,request=fetch,clock=Date.now,random=Math.random) {
  let running=null,active=null;
  function drain(force=false) {
    if(running) return running;
    running=(async()=>{
      const previous=await readSetting(db,'sync') ?? {};
      if(!force && (previous.paused || previous.nextAttempt>clock())) return;
      let httpStatus=null,retryAfter=0;
      try {
        // Bounded work per alarm; a large offline queue resumes on the next alarm.
        for(let turn=0;turn<10;turn++) {
          const {config,batch}=await nextBatch(db);
          if(!config || !batch.events.length) return;
          const lastAttempt=clock(),lastBatch=summarize(batch.events);
          active={startedAt:lastAttempt,...lastBatch};
          const state=await readSetting(db,'sync') ?? {};
          await writeSetting(db,'sync',{...state,lastAttempt,lastBatch});
          const response=await request(`${config.server}/api/ingest`,{
            method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.token}`},
            body:JSON.stringify(batch),signal:AbortSignal.timeout(20000),credentials:'omit',redirect:'error',
          });
          if(!response.ok) {
            httpStatus=response.status;
            const detail=await response.json().catch(()=>null);
            const error=`Server returned ${response.status}${typeof detail?.error==='string'?`: ${detail.error.slice(0,300)}`:''}`;
            if([409,413,422].includes(response.status)) {
              if(batch.events.length>1) await writeSetting(db,'sync',{...state,lastAttempt,lastBatch,error,batchLimit:Math.max(1,Math.floor(batch.events.length/2)),nextAttempt:0,paused:false});
              else await hold(db,batch.events[0],error,clock());
              active=null;continue;
            }
            const header=response.headers?.get('Retry-After');
            if(header) retryAfter=/^\d+$/.test(header)?Number(header)*1000:Math.max(0,Date.parse(header)-clock())||0;
            throw Error(error);
          }
          const ack=await response.json();
          const sent=new Set(batch.events.map(e=>e.eventId));
          if(ack.deviceId!==config.deviceId || !Array.isArray(ack.accepted) || !ack.accepted.length || new Set(ack.accepted).size!==ack.accepted.length || ack.accepted.some(id=>!sent.has(id))) throw Error('Invalid server acknowledgement');
          const accepted=new Set(ack.accepted);
          await acknowledge(db,batch.events,ack.accepted,{lastAttempt,lastBatch,lastSuccess:clock(),lastAcknowledged:summarize(batch.events.filter(e=>accepted.has(e.eventId))),failures:0,nextAttempt:0,error:'',paused:false,batchLimit:100});
          active=null;
        }
      } catch(error) {
        const state=await readSetting(db,'sync') ?? {};
        const failures=(state.failures??0)+1;
        const delay=Math.min(1800000,30000*2**Math.min(failures-1,6)*(1+0.2*random()));
        await writeSetting(db,'sync',{...state,failures,error:error.message,paused:[401,403].includes(httpStatus),nextAttempt:clock()+Math.max(delay,retryAfter)});
      }
    })().finally(()=>{running=null;active=null;});
    return running;
  }
  drain.activity=()=>active;
  return drain;
}

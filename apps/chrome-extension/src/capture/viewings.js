// Frequent measurements become a few cumulative business records. Each checkpoint
// replaces the same revisioned record; retries never add its seconds a second time.
export const BUCKET_MS=15*60*1000;
export function mergeRanges(ranges){
  const result=[];
  for(const [a,b] of ranges.toSorted((x,y)=>x[0]-y[0]||x[1]-y[1])){
    const last=result.at(-1);
    if(last&&a<=last[1])last[1]=Math.max(last[1],b);else result.push([a,b]);
  }
  return result;
}
export function createViewings(uuid=()=>crypto.randomUUID()){
  let video=null,viewingId=null;
  const records=new Map();
  return {
    reset(){video=null;viewingId=null;records.clear();},
    add(segment){
      if(video!==segment.videoId){video=segment.videoId;viewingId=uuid();records.clear();}
      const {kind,t,seconds,coverage,eventId,...metadata}=segment;
      const end=t+seconds*1000,output=[];
      let cursor=t,remaining=seconds;
      while(cursor<end){
        const bucket=Math.floor(cursor/BUCKET_MS)*BUCKET_MS,next=Math.min(end,bucket+BUCKET_MS);
        const part=next===end?remaining:(next-cursor)/1000;
        const ranges=coverage?[[coverage[0]+(coverage[1]-coverage[0])*(cursor-t)/(seconds*1000),coverage[0]+(coverage[1]-coverage[0])*(next-t)/(seconds*1000)]]:[];
        const key=JSON.stringify([bucket,metadata]);
        let previous=records.get(key);
        // Keep every disjoint media range, but seal a record before its payload grows large.
        if(previous&&mergeRanges([...previous.coverage,...ranges]).length>500)previous=null;
        const record={...metadata,kind:'viewing',eventId:previous?.eventId??uuid(),viewingId,bucket,revision:(previous?.revision??0)+1,t:previous?.t??cursor,lastWatched:next,seconds:(previous?.seconds??0)+part,coverage:mergeRanges([...(previous?.coverage??[]),...ranges])};
        records.set(key,record);output.push(record);
        for(const [oldKey,old] of records)if(old.bucket<bucket-BUCKET_MS)records.delete(oldKey);
        remaining-=part;cursor=next;
      }
      return output;
    },
  };
}

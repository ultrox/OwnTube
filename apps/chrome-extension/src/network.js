export const NETWORK='youtube-observer/network/v1';
export const fields=['st','et','cmt','len','au','state','el','is_ad','final','volume','muted','rate','fs','fmt','afmt','vps','vis','bh','bwm','bwe','df','lang','kind','tlang'];
const videoId=value=>typeof value==='string' && /^[\w-]{11}$/.test(value);
export function sanitizeReport(input,base,correlate) {
  const url=new URL(input,base);
  if(!['www.youtube.com','youtube.com','m.youtube.com'].includes(url.hostname)) return null;
  const match=url.pathname.match(/^\/api\/(?:stats\/(watchtime|playback|qoe)|(timedtext))$/);
  if(!match) return null;
  const query=url.searchParams;
  const id=query.get('docid')??query.get('v');
  return {kind:'network',eventId:crypto.randomUUID(),t:Date.now(),endpoint:match[1]??match[2],
    videoId:videoId(id)?id:null,sessionId:query.get('cpn')?correlate(query.get('cpn')):null,
    fields:Object.fromEntries(fields.filter(k=>query.has(k)).map(k=>[k,query.get(k).slice(0,2000)]))};
}
export function validNetwork(e) {
  return e?.kind==='network' && typeof e.eventId==='string' && /^[\w-]{1,100}$/.test(e.eventId) && Number.isSafeInteger(e.t) && e.t>=0 && e.t<=Date.now()+60000 &&
    ['watchtime','playback','qoe','timedtext'].includes(e.endpoint) && (e.videoId===null || videoId(e.videoId)) &&
    (e.sessionId===null || (typeof e.sessionId==='string' && /^[\w-]{1,100}$/.test(e.sessionId))) &&
    e.fields && typeof e.fields==='object' && !Array.isArray(e.fields) && Object.entries(e.fields).every(([k,v])=>fields.includes(k) && typeof v==='string' && v.length<=2000);
}

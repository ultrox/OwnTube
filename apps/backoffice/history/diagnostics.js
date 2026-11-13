let report;
const el=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
const ms=value=>value==null?'—':`${value.toFixed(1)} ms`;
function table(target,headers,rows){
  const table=document.createElement('table'),head=document.createElement('tr');
  headers.forEach(h=>head.append(el('th',h)));table.append(head);
  for(const cells of rows){const row=document.createElement('tr');for(const cell of cells)row.append(typeof cell==='object'?cell:el('td',String(cell)));table.append(row);}
  document.getElementById(target).replaceChildren(table);
}
function distribution(target,entries,budgets={}){
  table(target,['Operation','Samples','p50','p95','p99','Total since start','Failures since start'],Object.entries(entries).map(([name,v])=>{
    const p95=el('td',ms(v.p95Ms));if(v.p95Ms!=null&&budgets[name])p95.className=v.p95Ms>budgets[name]?'over':'good';
    return [name,v.samples,ms(v.p50Ms),p95,ms(v.p99Ms),v.totalSinceStart,v.failuresSinceStart];
  }));
}
async function refresh(){
  const button=document.getElementById('refresh');button.disabled=true;
  try{
    const response=await fetch('/api/diagnostics',{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(response.status===401)throw Error('Sign in on the dashboard, then refresh this page.');
    if(!response.ok)throw Error(`Diagnostics failed (${response.status}).`);
    report=await response.json();
    document.getElementById('status').textContent=`Measured ${new Date(report.measuredAt).toLocaleTimeString()} · release ${report.release} · uptime ${report.uptimeSeconds}s`;
    const summary=document.getElementById('summary');summary.replaceChildren();
    for(const path of ['/api/session','/api/dashboard','/api/languages']){
      const card=el('div',path);card.className='card';card.append(el('strong',ms(report.requests[path]?.p95Ms)));card.append(el('small','p95 server time'));summary.append(card);
    }
    distribution('requests',report.requests,report.budgetsMs);distribution('stages',report.stages);distribution('browser',report.browser);
    document.getElementById('pipeline').textContent=JSON.stringify(report.pipeline,null,2);
    table('recent',['Time','Operation','Status','Server','Work','Request ID'],report.recent.map(r=>[new Date(r.at).toLocaleTimeString(),r.route,r.status,ms(r.serverMs),JSON.stringify(r.work),r.requestId]));
    document.getElementById('notes').textContent=report.notes.join(' ');
  }catch(error){document.getElementById('status').textContent=error.message;}
  finally{button.disabled=false;}
}
document.getElementById('refresh').addEventListener('click',refresh);
document.getElementById('copy').addEventListener('click',async()=>{
  if(!report)return;
  try{await navigator.clipboard.writeText(JSON.stringify(report,null,2));document.getElementById('status').textContent='Diagnostics copied.';}
  catch{document.getElementById('status').textContent='Clipboard unavailable. The same report is available at /api/diagnostics.';}
});
void refresh();

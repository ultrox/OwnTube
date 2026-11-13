let light = false;
try { light = localStorage.getItem('observer-theme') === 'light'; } catch {}
const app = Elm.Main.init({ node: document.getElementById('app'), flags: light });
app.ports.saveTheme.subscribe(light => {
  try { localStorage.setItem('observer-theme', light ? 'light' : 'dark'); } catch {}
});

// Bounded operational samples only: no video titles, filters, keys, or full URLs.
const sendMetric=(name,durationMs,ok)=>{
  if(!Number.isFinite(durationMs)||durationMs<0||durationMs>120000)return;
  void fetch('/api/metrics/client',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,durationMs,ok}),signal:AbortSignal.timeout(5000)}).catch(()=>{});
};
const starts=new Map();
app.ports.metrics.subscribe(({name,generation,phase,ok})=>{
  const key=`${name}:${generation}`;
  if(phase==='start'){
    starts.set(key,performance.now());
    if(starts.size>32)starts.delete(starts.keys().next().value);
  }else if(starts.has(key)){
    const start=starts.get(key);starts.delete(key);
    // Elm's DOM update and a paint opportunity happen before the ready measurement.
    requestAnimationFrame(()=>requestAnimationFrame(()=>sendMetric(`${name}.ready`,performance.now()-start,ok)));
  }
});
if(typeof PerformanceObserver!=='undefined'){
  const names={'/api/session':'session.network','/api/dashboard':'dashboard.network','/api/languages':'languages.network','/api/language-videos':'review.network'};
  try{
    new PerformanceObserver(list=>{
      for(const entry of list.getEntries()){
        const url=new URL(entry.name),name=names[url.pathname];
        if(url.origin===location.origin&&name)sendMetric(name,entry.duration,entry.responseStatus>=200&&entry.responseStatus<400);
      }
    }).observe({type:'resource',buffered:true});
  }catch{}
}

// Elm owns the content; JavaScript handles the native top layer and focus lifecycle.
let pending;
app.ports.evidenceDialog.subscribe(open => {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    const dialog = document.getElementById('evidence-dialog');
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });
});
const dialog = document.getElementById('evidence-dialog');
const dismiss = () => dialog.dispatchEvent(new Event('evidence-dismiss'));
dialog.addEventListener('cancel', event => {
  event.preventDefault();
  dismiss();
});
let backdropPress = false;
const outside = event => {
  const rect = dialog.getBoundingClientRect();
  return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
};
dialog.addEventListener('pointerdown', event => { backdropPress = outside(event); });
dialog.addEventListener('click', event => {
  if (backdropPress && outside(event)) dismiss();
  backdropPress = false;
});

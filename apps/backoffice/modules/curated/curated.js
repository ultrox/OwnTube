import { clone, key, compose, move, insert, insertMany, editRow } from './model.js';
import { germanMix, originalRows, originalIndex } from './german.js';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = v => v ? new Date(v).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
const title = v => v.charAt(0).toUpperCase() + v.slice(1);
const state = { feeds:[], categories:[], doc:null, edits:null, dirty:false, busy:false, published:false, drag:null, addRow:null, signedOut:false, mixDraft:null, polling:false, flipped:new Set() };
let noticeTimer;
function notice(message) {
  $('#notice').textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('#notice').textContent = ''; }, 8000);
}
async function request(path, method='GET', data) {
  const response = await fetch(path, {
    method, credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(30000),
    headers: {'Content-Type':'application/json'}, ...(data !== undefined ? {body:JSON.stringify(data)} : {}),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) { state.signedOut=true; render(); }
    throw new Error(value.error || `Request failed (${response.status})`);
  }
  return value;
}
function loginView() {
  $('#app').innerHTML = `<section class="login"><p class="eyebrow">OWN YOUR FEED</p><h1>Curated</h1><p>Sign in to edit the cached feed served to your TV.</p>
    <form id="login"><label>Owner key<input name="token" type="password" required autocomplete="current-password"></label><button class="primary">Sign in</button></form></section>`;
}
function baseRows() { return state.doc ? compose(state.doc.sourceRows,state.edits) : []; }
function rows() { return !state.doc ? [] : state.published ? state.doc.publishedRows : germanMix(baseRows(),state.edits,state.doc.german).rows; }
function editorRows() {
  if(!state.doc)return [];
  const base=baseRows(),mixed=germanMix(base,state.edits,state.doc.german);
  return originalRows(mixed.rows,base,mixed.selected);
}
function moveDisplayed(ri, from, to) {
  const base=baseRows(),mixed=germanMix(base,state.edits,state.doc.german);
  const row=originalRows(mixed.rows,base,mixed.selected)[ri];
  const a=originalIndex(mixed.rows[ri],row,from,mixed.selected),b=originalIndex(mixed.rows[ri],row,to,mixed.selected);
  if(a>=0&&b>=0&&a!==b)move(state.edits,row,a,b);
}
function mixHeadline(g) {
  return g.running&&!g.checkedAt ? `Measuring German mix… · target ${g.settings.targetPercent}%`
    : `${Number(g.achievedPercent).toFixed(1)}% German mix (title estimate) · target ${g.settings.targetPercent}%`;
}
function mixProgress(g) {
  const p=g.progress;
   if(!g.running)return g.settings.enabled?'Selected originals are matched across Home. Alternatives with German original-audio metadata publish automatically.':'Automatic matching is paused.';
  if(!p)return 'Matching is running. Results publish at the end of each batch; the previous publication stays available.';
  const phases={starting:'Checking cached titles',translate:'Batch-translating selected titles',search:'Searching YouTube',complete:'Preparing publication'};
  return `${p.candidates} matches found · ${g.fillPending?`Filling toward ${g.settings.targetPercent}% (up to 150 searches this cycle)`:`${g.settings.searchBudget} new searches maximum per six-hour cycle`}. ${phases[p.phase]||'Matching'}${p.title?`: ${p.title}`:''}.`;
}
function mixUsage(report) {
  if(!report?.totalUsage)return '';
  const u=report.totalUsage;
  return `${u.apiCalls} translation calls · ${u.inputTokens} input + ${u.outputTokens} output tokens · ${u.estimatedCostUsd==null?'cost unavailable':`$${Number(u.estimatedCostUsd).toFixed(6)} estimated total (peak rates)`}.`;
}
// The key is write-only: the server reports where it comes from, never its value.
function deepseekKey(g) {
  const busy=state.busy?'disabled':'';
  const form=label=>`<form id="deepseek-key" class="key-form"><label>${label}<input name="key" type="password" required minlength="20" maxlength="200" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore data-protonpass-ignore placeholder="sk-…" ${busy}></label><button class="primary" ${busy}>Check & save key</button></form>`;
  if(g.keySource==='server')return '<p class="key-status">DeepSeek key: set in the server configuration.</p>';
  if(g.keySource==='saved')return `<div class="key-status"><p>DeepSeek key: saved here.</p><details><summary>Replace or remove the key</summary>${form('New DeepSeek API key')}<button type="button" data-action="deepseek-remove" ${busy}>Remove saved key</button></details></div>`;
  return `<div class="key-status"><p class="banner">Add your DeepSeek API key to start matching. It is checked with DeepSeek, stored only on the server and never shown again.</p>${form('DeepSeek API key')}</div>`;
}
function germanPanel(d) {
  if(d.category!=='home')return '';
  const g=d.german,s=state.mixDraft||g.settings,disabled=state.busy||state.dirty?'disabled':'';
  const original=id=>d.sourceRows.flatMap(r=>r.items).find(c=>c.videoId===id)?.title||id;
  const replacementIds=new Set(g.selected.map(m=>m.replacement.videoId));
  const frontMatches=d.publishedRows.flatMap(r=>r.items.slice(0,10)).filter(c=>replacementIds.has(c.videoId)).length;
  return `<section class="german-panel"><header><div><p class="eyebrow">YOUR INTERESTS, IN GERMAN</p><h2>Automatic German mix</h2></div>
    <strong data-mix-headline>${esc(mixHeadline(g))}</strong></header>
    <p data-mix-progress role="status" aria-live="polite">${esc(mixProgress(g))}</p>
    <p class="explain">At each chosen position, search using that original video’s translated title. Its German alternative takes that position; the original stays in this row’s tail, below the first ten. Other rows stay unchanged. At the row cap, an ordinary tail card gives way (it remains in the source snapshot). Pins, manual cards and matching positions are protected; rows without a safe tail slot stay unchanged. Alternatives require German original-audio metadata, not just a localized title. Existing German-title originals remain a title estimate.</p>
    ${deepseekKey(g)}
    ${g.error&&!/^(Add a DeepSeek API key|Set DEEPSEEK_API_KEY)/.test(g.error)?`<p class="banner error">${esc(g.error)}</p>`:''}
    <form id="german-settings"><fieldset ${disabled}><div class="german-controls">
      <label><span>Automatic publication</span><input name="enabled" type="checkbox" ${s.enabled?'checked':''}></label>
      <label>Whole-Home target (%)<input name="targetPercent" type="number" min="0" max="100" required value="${s.targetPercent}"></label>
      <label>Default replacement positions<input name="replacementPositions" data-slot-input type="text" required value="${esc((s.replacementPositions??[2,6,9]).join(', ')||'off')}" placeholder="2, 6, 9"></label>
      <label>Maximum cards per replacement creator<input name="creatorLimit" type="number" min="1" max="20" required value="${s.creatorLimit}"></label>
      <label>New searches per six-hour cycle<input name="searchBudget" type="number" min="1" max="50" required value="${s.searchBudget??12}"></label>
      <button class="primary" type="submit">Apply mix rules</button>
      <button type="button" data-action="german-run" ${g.running||!s.enabled||g.retryAt>Date.now()?'disabled':''}>Find matches now</button>
      <button type="button" data-action="german-fill" title="Fill toward the saved target in batches, with up to 150 searches this cycle. Then return to the maintenance budget." ${g.running||!s.enabled||g.retryAt>Date.now()?'disabled':''}>Fill target now</button>
      <button type="button" data-action="german-undo" ${!g.undoAvailable?'disabled':''}>Undo mix & pause</button>
    </div><details><summary>Rows, creators and pinned originals</summary>
      <p>Positions are counted from 1. Change a row’s positions beside that row; blank inherits defaults and “off” disables replacements. Protected or non-video positions are skipped. Excluded rows still count toward the whole-Home target. Trusted creators get preference among the first five search hits.</p>
      <div class="german-rows">${d.sourceRows.map(r=>`<label><input type="checkbox" name="excludedRows" value="${esc(r.id)}" ${s.excludedRows.includes(r.id)?'checked':''}>Keep ${esc(r.title||'Untitled row')} unchanged</label>`).join('')}</div>
      <label>Trusted creator channel IDs (one per line)<textarea name="trustedChannels" rows="3">${esc(s.trustedChannels.join('\n'))}</textarea></label>
      <label>Blocked creator channel IDs (one per line)<textarea name="blockedChannels" rows="3">${esc(s.blockedChannels.join('\n'))}</textarea></label>
      <label>Pinned original video IDs (one per line)<textarea name="pinnedOriginals" rows="3">${esc(s.pinnedOriginals.join('\n'))}</textarea></label>
    </details></fieldset></form>
    ${state.dirty?'<p>Save your feed draft before changing automatic mix rules.</p>':''}
    ${state.mixDraft?'<p class="banner">Unapplied mix rules. Apply them to change automatic publication.</p>':''}
    <p class="explain">${g.replacements} alternatives with German audio metadata · ${frontMatches} among the first ten cards of their row · ${g.native} originals with German-title estimates · ${g.total} video cards. Last check: ${time(g.checkedAt)}.
      ${g.report?.evidenceMode==='title-search-audio'?`${g.report.searchesThisCycle} searches used this cycle${g.report.searchesThisCycle>g.report.searchBudget?' including fill work':''}; ${g.report.fillTarget?'fill allowance':'maintenance limit'} ${g.report.searchBudget} (shared across Home feeds). ${g.report.cached} cached results reused. ${g.report.audioChecksThisCycle} audio metadata checks this cycle (limit ${g.report.audioBudget}). Next cycle: ${time(g.report.nextCycleAt)}. ${esc(mixUsage(g.report))}`:''}
      ${g.retryAt>Date.now()?`Next attempt after ${time(g.retryAt)}.`:''}</p>
    <details><summary>What changed and why (${g.selected.length})</summary><div class="german-matches">${g.selected.map(m=>`<article>
      <p>${esc(original(m.original))} → <a href="https://www.youtube.com/watch?v=${esc(m.replacement.videoId)}" target="_blank" rel="noopener">${esc(m.replacement.title)}</a></p>
      <p>${esc(m.reason)}</p><small>${m.evidence.basis==='title-search-audio'?`Query: ${esc(m.evidence.query)} · search rank ${m.evidence.searchRank} · original audio: ${esc(m.evidence.audioLanguage)} · checked ${time(m.evidence.audioCheckedAt)}`:'Legacy evidence · awaiting audio validation'} · ${m.originalDuration?(m.originalDuration/60).toFixed(0):'?'} → ${(m.duration/60).toFixed(0)} min · ${esc(m.replacement.subtitle)}</small>
      <button type="button" data-pin-original="${esc(m.original)}" ${disabled}>Keep original instead</button>
    </article>`).join('')}</div></details></section>`;
}
// Patch existing nodes rather than replacing the app. Unchanged thumbnails,
// open details, focus and horizontal scrollers survive status updates.
function syncNode(current, next) {
  if(current.nodeType!==next.nodeType||current.nodeName!==next.nodeName) {current.replaceWith(next);return;}
  if(current.nodeType===Node.TEXT_NODE) {if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;return;}
  if(current.nodeType!==Node.ELEMENT_NODE)return;
  const value=next.value, checked=next.checked;
  for(const attr of [...current.attributes])if(!next.hasAttribute(attr.name)&&!(current.tagName==='DETAILS'&&attr.name==='open'))current.removeAttribute(attr.name);
  for(const attr of next.attributes)if(current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value);
  const old=[...current.childNodes], fresh=[...next.childNodes];
  for(let i=0;i<Math.max(old.length,fresh.length);i++){
    if(!fresh[i])old[i].remove();
    else if(!old[i])current.append(fresh[i]);
    else syncNode(old[i],fresh[i]);
  }
  if(current instanceof HTMLInputElement){if(current.value!==value)current.value=value;current.checked=checked;}
  if(current instanceof HTMLTextAreaElement&&current.value!==value)current.value=value;
  if(current instanceof HTMLSelectElement&&current.value!==value)current.value=value;
}
function feedCard(row, ri, card, ci, original, match, retained) {
  const d=state.doc;
  const flipKey=match?JSON.stringify([d.id,row.id,match.original,card.videoId]):'';
  const flipped=!!match&&state.flipped.has(flipKey);
  const shown=flipped?original:card;
  const other=flipped?card:original;
  const native=!match&&d.german.nativeOriginals.includes(card.videoId);
  const originalPosition=match?row.items.findIndex(c=>c.videoId===match.original)+1:0;
  const locked=state.busy||flipped;
  return `<article class="card${match?' replacement-card':''}${flipped?' showing-original':''}" draggable="${!state.published&&!locked}" data-ri="${ri}" data-ci="${ci}" data-card-video="${esc(shown.videoId||'')}" aria-label="${esc(shown.title)}${match?flipped?' · Original recommendation':' · German replacement':''}">
    <div class="image">${shown.thumbnail&&shown.thumbnail.startsWith('https://')?`<img src="${esc(shown.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:'<span>No thumbnail</span>'}<span class="position">${ci+1}</span>${shown.badge?`<span class="badge">${esc(shown.badge)}</span>`:''}
      ${match?`<span class="replacement-label">${flipped?'Original recommendation':'German replacement'}</span>`:retained?'<span class="replacement-label native-label">Original kept lower in this row</span>':native?'<span class="replacement-label native-label">YouTube original · German title</span>':''}</div>
    <h3>${esc(shown.title)}</h3><p>${esc(shown.subtitle)}</p>
    ${match?`<div class="replacement-compare"><button class="comparison-preview" type="button" data-flip-replacement="${esc(flipKey)}" data-focus="flip-${ri}-${ci}" aria-pressed="${flipped}" ${state.busy?'disabled':''}>${other.thumbnail?.startsWith('https://')?`<img src="${esc(other.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:''}<span><small>↔ ${flipped?'Flip to replacement':'Replaced this · flip to original'}</small><strong>${esc(other.title)}</strong></span></button><small>${originalPosition?`Original kept at #${originalPosition} · `:''}${flipped?'Preview only · replacement still selected':'Flip compares only; TV unchanged'}</small></div>`:''}
    ${d.category==='home'&&!state.published&&original?.videoId?`<button type="button" data-pin-original="${esc(original.videoId)}" ${state.busy||state.dirty?'disabled':''}>${d.german.settings.pinnedOriginals.includes(original.videoId)?'Unpin original':match?'Use original on TV':'Keep this original'}</button>`:''}
    ${state.published?'':`<footer><button data-action="left" data-ri="${ri}" data-ci="${ci}" data-focus="left-${ri}-${ci}" aria-label="Move ${esc(card.title)} left" ${ci===0||locked?'disabled':''}>←</button><button data-action="right" data-ri="${ri}" data-ci="${ci}" data-focus="right-${ri}-${ci}" aria-label="Move ${esc(card.title)} right" ${ci===row.items.length-1||locked?'disabled':''}>→</button><button data-action="remove" data-ri="${ri}" data-ci="${ci}" ${locked?'disabled':''}>Remove</button>${card.channelId?`<button data-action="block-channel" data-ri="${ri}" data-ci="${ci}" title="Remove this channel across this category" ${locked?'disabled':''}>Block channel</button>`:''}</footer>`}
  </article>`;
}
function rowPlacement(row, originals, matches) {
  const d=state.doc;
  if(d.category!=='home')return '';
  const s=state.mixDraft||d.german.settings,override=s.rowPositions?.[row.id],positions=override??s.replacementPositions??[2,6,9];
  const eligible=c=>c.videoId&&!c.playlistId&&!c.isLive&&!c.isUpcoming;
  const count=row.items.filter(c=>matches.has(c.videoId)).length;
  if(!originals?.items.some(eligible))return '<div class="row-placement"><span>Show/channel/playlist tiles · no eligible individual videos to replace.</span></div>';
  const protectedIds=new Set([...s.pinnedOriginals,...(d.german.nativeOriginals||[]),...Object.values(state.edits.rows).flatMap(r=>r.added.map(c=>c.videoId))]);
  const unavailable=positions.filter(p=>!originals.items[p-1]||!eligible(originals.items[p-1])||protectedIds.has(originals.items[p-1].videoId));
  const cap=(state.published?d.publishedEdits:state.edits).rows[row.id]?.limit??(state.published?d.publishedEdits:state.edits).cardLimit??48;
  const space=originals.items.length<10?' · Too short to retain originals below #10':originals.items.length>=cap?' · At cap: originals use unprotected tail slots':'';
  const disabled=state.busy||state.dirty?'disabled':'';
  const missing=positions.filter(p=>!unavailable.includes(p)&&!matches.has(row.items[p-1]?.videoId));
  const reasons=missing.map(p=>{
    const decision=d.german.report?.decisions?.[originals.items[p-1]?.videoId];
    const label={'no-results':'Search returned no videos','no-eligible-match':'No result passed audio and eligibility checks',waiting:'Waiting for search budget',selected:'Match unavailable here under placement, duplicate or creator rules'}[decision?.status];
    return label?`<small>#${p}: ${label}${decision.query?` · Query: ${esc(decision.query)}`:''}</small>`:'';
  }).join('');
  return `<div class="row-placement"><label>Replacement positions<input form="german-settings" name="rowPositions:${esc(row.id)}" data-slot-input data-row-positions="${esc(row.id)}" value="${esc(override===undefined?'':override.length?override.join(', '):'off')}" placeholder="${esc((s.replacementPositions??[2,6,9]).join(', ')||'off')}" ${disabled}></label><button type="submit" form="german-settings" ${disabled}>Apply positions</button><span>${count} replacement${count===1?'':'s'} · ${s.excludedRows.includes(row.id)?'Row excluded':positions.length?`Match originals at: ${positions.join(', ')}`:'Mix off'}${unavailable.length?` · Protected or unavailable: ${unavailable.join(', ')}`:''}${space}${missing.length?` · No selected audio-verified match: ${missing.join(', ')}`:''}${reasons}<small>Blank = defaults · off = none. Match these exact originals; keep them lower in this row.</small></span></div>`;
}
function render() {
  if (state.signedOut) return loginView();
  const scroll = new Map([...document.querySelectorAll('.cards')].map(el => [el.dataset.row, el.scrollLeft]));
  const focus = document.activeElement?.dataset.focus;
   const d=state.doc, dirty=state.dirty || d?.dirty;
  const matches=new Map((!d?[]:state.published?d.german.selected:germanMix(baseRows(),state.edits,d.german).selected).map(m=>[m.replacement.videoId,m]));
   const originalSource=d&&state.published?compose(d.sourceRows,d.publishedEdits):baseRows();
  const next=document.createElement('main');
  next.id='app';
  next.innerHTML = `<section class="heading"><div><p class="eyebrow">YOUR TV, AS YOU ARRANGE IT</p><h1>Curated</h1><p>The cached feed. Add, remove and reorder inside its real rows.</p></div>
    <div class="heading-actions"><button data-action="catalog" ${!d||state.busy||state.published?'disabled':''}>Browse HackerTube</button><button data-action="reload" ${state.busy?'disabled':''}>Reload</button></div></section>
    <section class="controls">
      <label>TV · account · category<select id="feed" ${state.busy?'disabled':''}><option value="">Choose a cached feed</option>${state.feeds.map(f => `<option value="${esc(f.id)}" ${f.id===d?.id?'selected':''}>${esc(f.label)} · ${esc(title(f.category))} · ${f.id.slice(0,6)}</option>`).join('')}</select></label>
      <div class="tabs" role="group" aria-label="Feed version"><button data-action="draft" aria-pressed="${!state.published}">Edit draft${dirty?' •':''}</button><button data-action="published" aria-pressed="${state.published}">Published${d?.publishedVersion?' v'+d.publishedVersion:''}</button></div>
      <label>Default cards per row<input id="category-limit" data-focus="category-limit" type="number" min="1" max="48" step="1" required title="Default cap for this category. Individual rows can override it." value="${(state.published?d?.publishedEdits:state.edits)?.cardLimit ?? 48}" ${!d||state.busy||state.published?'disabled':''}></label>
      <div class="actions"><button data-action="discard" ${!d||state.busy||state.published?'disabled':''}>Reset draft to published</button>
        <button data-action="save" ${!state.dirty||state.busy||state.published?'disabled':''}>Save draft</button>
        <button data-action="publish" class="primary" ${!dirty||state.busy||state.published||!d?.publishedVersion?'disabled':''}>Publish to TV</button></div>
    </section>
    <nav class="categories" aria-label="Categories">${state.categories.map(c => {
      const available=state.feeds.find(f=>f.category===c && (!d||(f.device===d.device&&f.audience===d.audience)));
      return `<button data-category="${esc(c)}" ${state.busy?'disabled':''} aria-current="${d?.category===c?'page':'false'}">${esc(title(c))}${available?'':' · not cached'}</button>`;
    }).join('')}</nav>
    ${!d ? `<section class="empty"><h2>Open a category on the TV to cache it</h2><p>Enable Server Home in OwnTube settings. Its real rows will appear here after the first cache build.</p></section>` : `
    <section class="status">
      <div><span>YOUTUBE SNAPSHOT</span><strong>${time(d.cachedAt)}</strong></div>
      <div><span>NEXT REFRESH DUE</span><strong>${d.nextRefreshAt?time(d.nextRefreshAt):'On next TV request'}</strong></div>
      <div><span>PUBLISHED</span><strong>${d.publishedVersion?'Version '+d.publishedVersion:'Preparing…'}</strong></div>
      <div><span>LAST REQUESTED BY TV</span><strong>${d.servedVersion?'Version '+d.servedVersion:'Not yet served'}</strong><small>${time(d.servedAt)}</small></div>
      <button data-action="refresh" ${state.busy?'disabled':''}>Queue YouTube refresh</button>
    </section>
    <p class="explain">YouTube refreshes every six hours while the TV is connected. Your edits survive refreshes. Publishing takes effect when the TV reopens this category; existing scrolling stays on its original version.</p>
    ${d.refreshing?'<p class="banner">Building a new snapshot in the background. The published feed stays available.</p>':''}
    ${d.error?`<p class="banner error">${esc(d.error)}${d.cachedAt?' · Serving the last good snapshot.':''}</p>`:''}
    ${state.dirty?'<p class="banner">Unsaved draft changes. The TV still receives the published version.</p>':d.dirty?'<p class="banner">Saved draft changes are ready to publish.</p>':''}
    ${d.limited?'<p class="explain">Bounded snapshot: up to 32 rows and 48 cards per row. This editor shows every card in the version served to the TV.</p>':''}
    ${germanPanel(d)}
    <section class="feed-rows">${rows().map((row,ri)=>`<article class="feed-row" data-row-index="${ri}">
      <header><div><span class="row-number">${String(ri+1).padStart(2,'0')}</span><h2>${esc(row.title||'Untitled row')}</h2><small>${row.items.length} cards</small></div>
        ${state.published?`<small>Limit: ${d.publishedEdits.rows[row.id]?.limit ?? d.publishedEdits.cardLimit ?? 48} cards</small>`:`<div class="row-controls"><label>Row override<input type="number" min="1" max="48" step="1" placeholder="${state.edits.cardLimit ?? 48}" aria-label="Card limit for ${esc(row.title)}" title="1–48 cards; leave blank to use the category default. Applied after ordering and removals." data-limit-row="${ri}" data-focus="limit-${ri}" value="${state.edits.rows[row.id]?.limit ?? ''}" ${state.busy?'disabled':''}></label><button data-action="add" data-row="${ri}" ${state.busy?'disabled':''}>＋ Add video here</button></div>`}</header>
       ${rowPlacement(row,originalSource.find(r=>r.id===row.id),matches)}
       <div class="cards" data-row="${esc(row.id)}">${row.items.map((card,ci)=>{
         const match=matches.get(card.videoId);
         const original=match?(match.originalCard||d.sourceRows.find(r=>r.id===row.id)?.items.find(c=>c.videoId===match.original)
           ||d.sourceRows.flatMap(r=>r.items).find(c=>c.videoId===match.original)
            ||{videoId:match.original,title:`Original video · ${match.original}`,subtitle:'Original title unavailable in this snapshot',thumbnail:`https://i.ytimg.com/vi/${encodeURIComponent(match.original)}/hqdefault.jpg`}):card;
          const retained=[...matches.values()].find(m=>m.original===card.videoId&&row.items.some(c=>c.videoId===m.replacement.videoId));
          return feedCard(row,ri,card,ci,original,match,retained);
       }).join('')||'<p class="empty-row">This row is empty. Add a video here.</p>'}</div>
    </article>`).join('')||'<p class="empty">Preparing the first snapshot…</p>'}</section>
    ${!state.published&&(state.edits.removed.length||state.edits.blockedChannels.length)?`<details class="removals"><summary>Persistent removals (${state.edits.removed.length}) · blocked channels (${state.edits.blockedChannels.length})</summary>
      ${state.edits.removed.map(k=>`<button data-restore="${esc(k)}">Restore ${esc(k)}</button>`).join('')}
      ${state.edits.blockedChannels.map(k=>`<button data-unblock="${esc(k)}">Unblock ${esc(k)}</button>`).join('')}</details>`:''}`}`;
  syncNode($('#app'),next);
  for (const el of document.querySelectorAll('.cards')) el.scrollLeft=scroll.get(el.dataset.row)||0;
  if (focus) [...document.querySelectorAll('[data-focus]')].find(el=>el.dataset.focus===focus)?.focus({preventScroll:true});
}
async function load(id=state.doc?.id) {
  const listing=await request('/api/curation');
  state.feeds=listing.feeds; state.categories=listing.categories;
  id=id||new URLSearchParams(location.search).get('feed')||listing.feeds.find(f=>f.category==='home')?.id||listing.feeds[0]?.id;
  if (id && listing.feeds.some(f=>f.id===id)) {
    state.doc=await request(`/api/curation/${encodeURIComponent(id)}`);
    state.edits=clone(state.doc.edits); state.dirty=false;
    history.replaceState(null,'',`?feed=${encodeURIComponent(id)}`);
  }
  render();
}
async function run(fn) {
  if (state.busy) return;
  state.busy=true; render();
  try { await fn(); } catch(e) { notice(e.message); }
  finally { state.busy=false; render(); }
}
function changed() { state.dirty=true; render(); }
function canLeave() {
  if(!state.dirty&&!state.mixDraft)return true;
  if(!window.confirm('Discard unsaved changes in this draft or mix rules?'))return false;
  state.mixDraft=null;
  return true;
}
async function poll() {
  const interacting=()=>state.busy||state.dirty||state.mixDraft||state.drag||state.signedOut
    ||!!document.querySelector('dialog[open]')||document.activeElement?.matches('input,textarea,select,[contenteditable=true]');
  if(state.polling||interacting()||!state.doc||!(state.doc.refreshing||state.doc.german?.running||state.doc.german?.settings.enabled||!state.doc.publishedVersion))return;
  const previous=state.doc;
  state.polling=true;
  try {
    const latest=await request(`/api/curation/${encodeURIComponent(previous.id)}`);
    // An owner action or navigation that started during the request wins.
    if(state.doc!==previous||interacting())return;
    state.doc=latest;
    const withoutProgress=doc=>({...doc,german:doc.german?{...doc.german,progress:null}:undefined});
    if(JSON.stringify(withoutProgress(previous))!==JSON.stringify(withoutProgress(latest))){
      state.edits=clone(latest.edits);
      render();
    } else {
      const headline=$('[data-mix-headline]'), progress=$('[data-mix-progress]');
      if(headline&&headline.textContent!==mixHeadline(latest.german))headline.textContent=mixHeadline(latest.german);
      if(progress&&progress.textContent!==mixProgress(latest.german))progress.textContent=mixProgress(latest.german);
    }
  } catch(e) {notice(e.message);}
  finally {state.polling=false;}
}

const library = { videos:[], next:null, busy:false, sequence:0 };
function catalogUrl(offset=0,n=24) {
  return '/api/catalog/hackertube/videos?'+new URLSearchParams({
    category:$('#catalog-category').value, q:$('#catalog-search').value.trim(), offset, n,
  });
}
function renderLibrary() {
  for(const input of document.querySelectorAll('#catalog-filter input,#catalog-filter select,#catalog-filter button,.catalog-destination input,.catalog-destination select'))input.disabled=library.busy;
  $('#catalog-results').innerHTML=library.videos.map((v,i)=>`<article class="catalog-card">
    <img src="${esc(v.card.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">
    <div><h3>${esc(v.card.title)}</h3><p>${esc(v.channel)} · ${v.recommenders} recommenders · score ${v.score}</p>
    <p>${esc(v.summary)}</p><p class="catalog-why">${esc(v.why)}</p>
    <button type="button" data-catalog-video="${i}" ${library.busy?'disabled':''}>Add to selected row</button></div></article>`).join('');
  $('#catalog-more').hidden=library.next===null;
  $('#catalog-more').disabled=library.busy;
  $('#catalog [data-action=catalog-batch]').disabled=library.busy||!library.videos.length;
}
async function loadLibrary(more=false) {
  const sequence=++library.sequence;
  const offset=more?library.next:0;
  library.busy=true;
  if(!more){library.videos=[];library.next=null;}
  renderLibrary();
  $('#catalog-status').textContent='Loading local catalog…';
  try {
    const result=await request(catalogUrl(offset));
    if(sequence!==library.sequence)return;
    library.videos=more?library.videos.concat(result.videos):result.videos;
    library.next=result.next;
    $('#catalog-status').textContent=`${result.total.toLocaleString()} matching videos · highest recommendation score first`;
  } catch(e) {if(sequence===library.sequence)$('#catalog-status').textContent=e.message;}
  finally {if(sequence===library.sequence){library.busy=false;renderLibrary();}}
}
function libraryDestination() {
  const row=editorRows().find(r=>r.id===$('#catalog-row').value);
  if(!row)throw new Error('Choose a destination row.');
  const position=$('#catalog-position');
  position.max=row.items.length+1;
  if(!position.reportValidity())throw new Error('Choose a valid position in this row.');
  return {row,position:Number(position.value)-1};
}
function addLibraryCards(cards,destination=libraryDestination()) {
  const {row,position}=destination;
  const existing=state.edits.rows[row.id]?.added||[];
  if(new Set(existing.concat(cards).map(key)).size>50)throw new Error('This row can hold up to 50 manually added videos. Choose fewer picks.');
  insertMany(state.edits,row,cards,position);
  $('#catalog').close();
  changed();
  notice(`${cards.length} pick${cards.length===1?'':'s'} added to ${row.title}. Publish when ready; your card caps still apply.`);
}
async function openLibrary() {
  const sequence=++library.sequence;
  $('#catalog').showModal();
  $('#catalog-info').textContent='Loading source…';
  $('#catalog-row').innerHTML=rows().map(r=>`<option value="${esc(r.id)}">${esc(r.title)}</option>`).join('');
  $('#catalog-position').value='1';
  $('#catalog-position').max=(rows()[0]?.items.length||0)+1;
  library.busy=true;library.videos=[];library.next=null;renderLibrary();
  try {
    const source=await request('/api/catalog/hackertube');
    if(sequence!==library.sequence||!$('#catalog').open)return;
    $('#catalog-info').textContent=source.videoCount
      ? `${source.videoCount.toLocaleString()} videos · ${source.areas.reduce((n,a)=>n+a.categories.length,0)} topics · export ${source.exported||'undated'}. At least one recommendation; news excluded.`
      : 'No dataset imported yet. Import the official HackerTube archive on the server.';
    $('#catalog-category').innerHTML='<option value="">All topics</option>'+source.areas.map(a=>`<optgroup label="${esc(a.name)}">${a.categories.map(c=>`<option value="${esc(c.id)}" ${c.count?'':'disabled'}>${esc(c.name)} (${c.count})</option>`).join('')}</optgroup>`).join('');
    await loadLibrary();
  } catch(e) {if(sequence===library.sequence){library.busy=false;$('#catalog-status').textContent=e.message;renderLibrary();}}
}
$('#catalog').addEventListener('close',()=>{library.sequence++;library.busy=false;});
document.addEventListener('click', async event => {
  const el=event.target.closest('button'); if(!el||el.disabled)return;
  const action=el.dataset.action;
  if(action==='close-add') { $('#add').close(); return; }
  if(action==='close-catalog') { $('#catalog').close(); return; }
  if (state.busy) return;
  if(el.dataset.flipReplacement) {
    const id=el.dataset.flipReplacement;
    if(state.flipped.has(id))state.flipped.delete(id);else state.flipped.add(id);
    render();return;
  }
  if(action==='catalog') {await openLibrary();return;}
  if(action==='catalog-more') {if(!library.busy&&library.next!==null)await loadLibrary(true);return;}
  if(el.dataset.catalogVideo!==undefined) {
    if(!library.busy)try {addLibraryCards([library.videos[Number(el.dataset.catalogVideo)].card]);}catch(e){$('#catalog-status').textContent=e.message;}
    return;
  }
  if(action==='catalog-batch') {
    if(library.busy||!$('#catalog-count').reportValidity())return;
    let destination;
    try {destination=libraryDestination();}catch(e){$('#catalog-status').textContent=e.message;return;}
    const sequence=++library.sequence;
    library.busy=true;renderLibrary();
    const feedId=state.doc.id;
    try {
      const result=await request(catalogUrl(0,Number($('#catalog-count').value)));
      if(sequence!==library.sequence||!$('#catalog').open||state.doc.id!==feedId)return;
      if(!result.videos.length)throw new Error('No videos match these filters.');
      addLibraryCards(result.videos.map(v=>v.card),destination);
    } catch(e){if(sequence===library.sequence)$('#catalog-status').textContent=e.message;}
    finally {if(sequence===library.sequence){library.busy=false;renderLibrary();}}
    return;
  }
  if(el.dataset.category) {
    const f=state.feeds.find(f=>f.category===el.dataset.category&&(!state.doc||(f.device===state.doc.device&&f.audience===state.doc.audience)));
    if(!f) return notice(`Open ${title(el.dataset.category)} on the TV, then reload to see its cached rows.`);
    if(canLeave()) await run(()=>load(f.id));
    return;
  }
  if(el.dataset.restore) {state.edits.removed=state.edits.removed.filter(k=>k!==el.dataset.restore);changed();return;}
  if(el.dataset.unblock) {state.edits.blockedChannels=state.edits.blockedChannels.filter(k=>k!==el.dataset.unblock);changed();return;}
  if(el.dataset.pinOriginal) {
    if(state.dirty)return notice('Save your feed draft first.');
    await run(async()=>{
      const d=state.doc,settings=clone(d.german.settings);
      if(settings.pinnedOriginals.includes(el.dataset.pinOriginal))settings.pinnedOriginals=settings.pinnedOriginals.filter(v=>v!==el.dataset.pinOriginal);
      else settings.pinnedOriginals.push(el.dataset.pinOriginal);
      await request(`/api/curation/${d.id}/german`,'PUT',{revision:d.revision,generation:d.generation,settings});
      await load(d.id);
    });return;
  }
   const displayed=rows()[Number(el.dataset.ri)]?.items[Number(el.dataset.ci)];
  switch(action) {
    case 'reload': if(canLeave()) await run(()=>load()); break;
    case 'draft': state.published=false;render();break;
    case 'published': state.published=true;render();break;
    case 'discard': state.edits=clone(state.doc.publishedEdits);changed();break;
    case 'left': case 'right': moveDisplayed(Number(el.dataset.ri),Number(el.dataset.ci),Number(el.dataset.ci)+(action==='left'?-1:1));changed();break;
    case 'remove': if(!state.edits.removed.includes(key(displayed)))state.edits.removed.push(key(displayed));changed();break;
    case 'block-channel': if(displayed.channelId&&!state.edits.blockedChannels.includes(displayed.channelId))state.edits.blockedChannels.push(displayed.channelId);changed();break;
    case 'german-run': case 'german-fill': case 'german-undo':
      if(state.dirty)return notice('Save your feed draft first.');
      await run(async()=>{
        const d=state.doc;
        await request(`/api/curation/${d.id}/german/${action.slice('german-'.length)}`,'POST',{revision:d.revision,generation:d.generation});
        await load(d.id);
      });break;
    case 'deepseek-remove':
      if(!confirm('Remove the saved DeepSeek key? Automatic German matching stops until a key is added again.'))return;
      await run(async()=>{await request('/api/curation/deepseek-key','DELETE');await load(state.doc.id);notice('Saved DeepSeek key removed.');});
      break;
    case 'save': case 'publish': await run(async()=>{
      const d=state.doc;
      await request(`/api/curation/${d.id}${action==='publish'?'/publish':''}`,action==='publish'?'POST':'PUT',{revision:d.revision,generation:d.generation,edits:state.edits});
      await load(d.id);
      notice(action==='publish'?`Published version ${state.doc.publishedVersion}. Reopen the category on the TV.`:'Draft saved. The TV feed is unchanged.');
    });break;
    case 'refresh': await run(async()=>{
      const r=await request(`/api/curation/${state.doc.id}/refresh`,'POST',{});
      notice(r.message);
      // Keep unsaved changes intact; no implicit reload.
    });break;
    case 'add':
      state.addRow=editorRows()[Number(el.dataset.row)];
      $('#add-form').reset();$('#add-error').textContent='';
      $('#destination').textContent=`Into ${state.addRow.title} · ${title(state.doc.category)}`;
      $('#add-form [name=position]').max=state.addRow.items.length+1;
      $('#add').showModal();$('#add-form [name=video]').focus();break;
  }
});
document.addEventListener('change',event=>{
  if(event.target.id==='catalog-category') {loadLibrary();return;}
  if(event.target.id==='catalog-row') {
    const row=rows().find(r=>r.id===event.target.value);
    $('#catalog-position').max=(row?.items.length||0)+1;
    $('#catalog-position').value='1';
    return;
  }
  if(event.target.id==='category-limit') {
    if(state.busy || state.published || !event.target.reportValidity()) return;
    state.edits.cardLimit=Number(event.target.value);
    changed();
  }
  if(event.target.matches('[data-limit-row]')) {
    if(state.busy || state.published) return;
    const input=event.target;
    if(!input.reportValidity()) return;
    const row=rows()[Number(input.dataset.limitRow)];
    const edit=editRow(state.edits,row);
    if(input.value==='') delete edit.limit; else edit.limit=Number(input.value);
    changed();
  }
  if(event.target.id==='feed') {
    if(canLeave()) run(()=>load(event.target.value)); else render();
  }
});
function mixSettings(form) {
  const data=new FormData(form), split=name=>String(data.get(name)||'').split(/[\s,]+/).filter(Boolean);
  const parse=value=>String(value).trim().toLowerCase()==='off'?[]:String(value).split(/[\s,]+/).filter(Boolean).map(Number).sort((a,b)=>a-b);
  const rowPositions={...(state.mixDraft||state.doc.german.settings).rowPositions};
  for(const [name,value] of data)if(name.startsWith('rowPositions:')){
    const id=name.slice('rowPositions:'.length);
    if(String(value).trim()==='')delete rowPositions[id];else rowPositions[id]=parse(value);
  }
  return {enabled:data.has('enabled'),targetPercent:Number(data.get('targetPercent')),creatorLimit:Number(data.get('creatorLimit')),searchBudget:Number(data.get('searchBudget')),
    replacementPositions:parse(data.get('replacementPositions')),rowPositions,
    excludedRows:data.getAll('excludedRows'),trustedChannels:split('trustedChannels'),blockedChannels:split('blockedChannels'),pinnedOriginals:split('pinnedOriginals')};
}
document.addEventListener('input',event=>{
  if(event.target.form?.id==='german-settings'){
    if(event.target.hasAttribute('data-slot-input'))validatePositions(event.target);
    state.mixDraft=mixSettings(event.target.form);
  }
});
function validatePositions(input) {
  const text=input.value.trim(),values=text.split(/[\s,]+/).filter(Boolean);
  const valid=text.toLowerCase()==='off'||(!text&&!input.required)
    ||values.length>0&&values.length<=10&&values.every(v=>/^\d+$/.test(v)&&Number(v)>=1&&Number(v)<=48)&&new Set(values.map(Number)).size===values.length;
  input.setCustomValidity(valid?'':'Use up to 10 distinct positions from 1–48, separated by commas, or “off”.');
}
document.addEventListener('submit',async event=>{
  if(event.target.id==='german-settings') {
    event.preventDefault();
    const form=event.target;
    for(const input of form.elements)if(input.hasAttribute('data-slot-input'))validatePositions(input);
    if(state.busy||state.dirty||!form.reportValidity())return;
    const settings=mixSettings(form);
    await run(async()=>{
      const d=state.doc;
      const result=await request(`/api/curation/${d.id}/german`,'PUT',{revision:d.revision,generation:d.generation,settings});
      state.mixDraft=null;
      await load(d.id);notice(result.changed===false?'These mix rules are already saved.':'Mix rules applied. Title-search matches publish automatically.');
    });return;
  }
  if(event.target.id==='deepseek-key') {
    event.preventDefault();
    const form=event.target;
    if(state.busy||!form.reportValidity())return;
    const key=new FormData(form).get('key');
    form.reset();
    await run(async()=>{
      await request('/api/curation/deepseek-key','PUT',{key});
      await load(state.doc.id);
      notice(state.doc.german.settings.enabled?'Key accepted by DeepSeek and saved. Matching starts now.':'Key accepted by DeepSeek and saved. Turn on Automatic publication and apply to start matching.');
    });
    return;
  }
  if(event.target.id==='catalog-filter') {event.preventDefault();await loadLibrary();return;}
  if(event.target.id==='login') {
    event.preventDefault();const token=new FormData(event.target).get('token');
    await run(async()=>{await request('/api/login','POST',{token});state.signedOut=false;await load();});
  }
  if(event.target.id==='add-form') {
    event.preventDefault();
    const form=event.target, button=form.querySelector('[type=submit]');
    if(button.disabled)return;
    button.disabled=true;$('#add-error').textContent='';
    try {
      const data=new FormData(form), card=await request('/api/curation/resolve','POST',{video:data.get('video')});
      insert(state.edits,state.addRow,card,Number(data.get('position'))-1);
      $('#add').close();changed();
    } catch(e) {$('#add-error').textContent=e.message;}
    finally {button.disabled=false;}
  }
});
document.addEventListener('dragstart',event=>{
  const card=event.target.closest('.card');
  if(!card||state.published||state.busy)return;
  state.drag={row:Number(card.dataset.ri),index:Number(card.dataset.ci)};
  event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',card.dataset.ci);
});
document.addEventListener('dragover',event=>{
  const card=event.target.closest('.card');
  if(card&&state.drag?.row===Number(card.dataset.ri))event.preventDefault();
});
document.addEventListener('drop',event=>{
  const card=event.target.closest('.card'),drag=state.drag;
  if(!card||!drag||drag.row!==Number(card.dataset.ri))return;
  event.preventDefault();
  moveDisplayed(drag.row,drag.index,Number(card.dataset.ci));state.drag=null;changed();
});
document.addEventListener('dragend',()=>{state.drag=null;});
window.addEventListener('beforeunload',event=>{if(state.dirty||state.mixDraft){event.preventDefault();event.returnValue='';}});
setInterval(poll,4000);
await run(async()=>{await request('/api/session');await load();});

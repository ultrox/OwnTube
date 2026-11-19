// Keep policy in step with cache/german.rs; only server-validated evidence enters
// this preview. Publication is always revalidated on the server.
export function germanMix(source, edits, german, now=Date.now()) {
  const rows=structuredClone(source), s=german?.settings;
  if(!s?.enabled)return {rows,selected:[]};
  const native=german.nativeOriginals||[], matches=german.matches||[];
  const cards=rows.flatMap(r=>r.items), total=cards.filter(c=>c.videoId).length;
  const existing=cards.filter(c=>native.includes(c.videoId)).length;
  const target=Math.floor((total*s.targetPercent+50)/100);
  const used=new Set(cards.map(c=>c.videoId).filter(Boolean)), replaced=new Set(), creators=new Map();
  for(const c of cards)if(c.channelId)creators.set(c.channelId,(creators.get(c.channelId)||0)+1);
  const valid=m=>Number.isFinite(m.originalDuration)&&m.originalDuration>=0&&Number.isFinite(m.duration)&&m.duration>0
    &&(!m.replacement.isShorts||m.duration<=180)
    &&(m.originalDuration===0||m.duration/m.originalDuration>=.5&&m.duration/m.originalDuration<=2)
    &&m.evidence.basis==='title-search-audio'&&m.evidence.sourceLanguage==='en'
    &&m.evidence.audioLanguage==='de'&&m.evidence.originalProduction===true
    &&m.evidence.audioCheckedAt>now-30*86400000&&m.evidence.audioCheckedAt<=now+60000
    &&m.evidence.query?.length>=3&&new TextEncoder().encode(m.evidence.query).length<=800
    &&m.evidence.searchRank>=1&&m.evidence.searchRank<=5
    &&!m.evidence.transcriptExcerpt&&!m.evidence.asrLanguage
    &&m.evidence.checkedAt>now-30*86400000&&m.evidence.checkedAt<=now+60000;
  const ordered=matches.filter(valid);
  const selected=[],retained=new Set();
  const manual=new Set(Object.values(edits.rows||{}).flatMap(r=>r.added).map(c=>c.videoId));
  const movable=c=>c.videoId&&!manual.has(c.videoId)&&!s.pinnedOriginals.includes(c.videoId)&&!native.includes(c.videoId)
    &&!c.playlistId&&!c.isLive&&!c.isUpcoming;
  const positions=new Map(rows.map(row=>{
    const slots=(s.rowPositions?.[row.id]??s.replacementPositions??[2,6,9]).map(p=>p-1)
      .filter(i=>row.items.length>=Math.max(10,i+2)&&row.items[i]&&movable(row.items[i]));
    return [row.id,slots];
  }));
  const anchors=new Set(rows.flatMap(r=>positions.get(r.id).map(i=>r.items[i].videoId)));
  const tailSlot=(r,i)=>{
    if(r.items.length<(edits.rows?.[r.id]?.limit??edits.cardLimit??48))return r.items.length;
    const configured=s.rowPositions?.[r.id]??s.replacementPositions??[2,6,9];
    return r.items.findLastIndex((c,j)=>j>=Math.max(10,i+2)&&!configured.includes(j+1)
      &&movable(c)&&!retained.has(c.videoId)&&!replaced.has(c.videoId)&&!anchors.has(c.videoId));
  };
  for(const m of ordered){
    if(existing+selected.length>=target)break;
    const c=m.replacement, channel=c.channelId;
    if(used.has(c.videoId)||replaced.has(m.original)||manual.has(m.original)||s.pinnedOriginals.includes(m.original)||native.includes(m.original)
      ||s.blockedChannels.includes(channel)||edits.blockedChannels.includes(channel)||edits.removed.includes(`video:${c.videoId}`)
      ||(creators.get(channel)||0)>=s.creatorLimit)continue;
    const eligible=c=>c.videoId===m.original&&!c.playlistId&&!c.isLive&&!c.isUpcoming&&!!c.isShorts===!!m.replacement.isShorts;
    const row=rows.find(r=>!s.excludedRows.includes(r.id)
      &&positions.get(r.id).some(i=>eligible(r.items[i])&&tailSlot(r,i)>=0));
    if(!row)continue;
    const i=positions.get(row.id).find(i=>eligible(row.items[i])&&tailSlot(row,i)>=0), old=row.items[i],tail=tailSlot(row,i);
    row.items[i]=structuredClone(c);
    if(tail===row.items.length)row.items.push(old);
    else {
      const displaced=row.items[tail];
      if(displaced.channelId)creators.set(displaced.channelId,creators.get(displaced.channelId)-1);
      row.items[tail]=old;
    }
    retained.add(c.videoId);
    creators.set(channel,(creators.get(channel)||0)+1);
    used.add(c.videoId);replaced.add(m.original);selected.push({...m,originalCard:structuredClone(old)});
  }
  return {rows,selected};
}

// Keep a unique editorial order: the appended retained original is an overlay,
// not a second occurrence of the source card in saved ordering.
export function originalRows(displayed, source, selected) {
  const replacements=new Map(selected.map(m=>[m.replacement.videoId,m.original]));
  return displayed.map(row=>{
    const originals=new Map((source.find(r=>r.id===row.id)?.items||[]).filter(c=>c.videoId).map(c=>[c.videoId,c]));
    const retained=new Set(row.items.filter(c=>replacements.has(c.videoId)).map(c=>replacements.get(c.videoId)));
    // Restore displaced tail cards too: editor order always addresses the full
    // capped base row, never the automatic overlay.
    return {...row,items:structuredClone(source.find(r=>r.id===row.id)?.items||row.items
      .filter(c=>!retained.has(c.videoId)).map(c=>originals.get(replacements.get(c.videoId))||c))};
  });
}

export function originalIndex(displayed, editorial, index, selected) {
  const card=displayed.items[index];
  if(!card)return -1;
  const original=selected.find(m=>m.replacement.videoId===card.videoId)?.original;
  return editorial.items.findIndex(c=>original?c.videoId===original
    :card.videoId?c.videoId===card.videoId:card.playlistId?c.playlistId===card.playlistId:c.channelId===card.channelId);
}

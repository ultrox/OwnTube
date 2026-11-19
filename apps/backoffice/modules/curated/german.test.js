import test from 'node:test';
import assert from 'node:assert/strict';
import { germanMix, originalRows, originalIndex } from './german.js';
import { move, compose } from './model.js';

const card=i=>({videoId:String(i).padStart(11,'0')});
const row=(id='row',n=20)=>({id,items:Array.from({length:n},(_,i)=>card(i))});
const settings=()=>({enabled:true,targetPercent:30,creatorLimit:3,replacementPositions:[2,6,9],
  excludedRows:[],trustedChannels:[],blockedChannels:[],pinnedOriginals:[]});
const edits=()=>({rows:{},removed:[],blockedChannels:[]});
const match=i=>({original:card(i).videoId,replacement:{...card(100+i),channelId:`UC${i}`},originalDuration:600,duration:650,
  evidence:{basis:'title-search-audio',sourceLanguage:'en',audioLanguage:'de',originalProduction:true,
    audioCheckedAt:Date.now(),query:'Werkstatt bauen',searchRank:1,checkedAt:Date.now()}});

test('exact originals are matched in place and retained only in the changed row',()=>{
  const rows=[row(),row('other')],g={settings:settings(),matches:[14,1,5,8].map(match)};
  const result=germanMix(rows,edits(),g);
  assert.deepEqual(result.selected.map(m=>m.original),[1,5,8].map(i=>card(i).videoId));
  assert.deepEqual(result.rows[1],rows[1]);
  for(const i of [1,5,8]){
    assert.deepEqual(result.rows[0].items[i],match(i).replacement);
    assert.equal(result.rows[0].items.filter(c=>c.videoId===card(i).videoId).length,1);
    assert.ok(result.rows[0].items.findIndex(c=>c.videoId===card(i).videoId)>=10);
  }
  assert.deepEqual(result.rows[0].items.slice(20),[1,5,8].map(card));
  assert.deepEqual(result.selected[0].originalCard,rows[0].items[1]);
});

test('row overrides, exclusions, native title estimates, pins and creator caps win',()=>{
  const rows=[row()],g={settings:settings(),matches:Array.from({length:20},(_,i)=>match(i))},e=edits();
  g.settings.rowPositions={row:[4,8]};
  assert.deepEqual(germanMix(rows,e,g).selected.map(m=>m.original),[3,7].map(i=>card(i).videoId));
  g.settings.pinnedOriginals=[card(3).videoId];
  assert.equal(germanMix(rows,e,g).selected.length,1);
  g.nativeOriginals=[card(7).videoId];
  assert.equal(germanMix(rows,e,g).selected.length,0);
  g.nativeOriginals=[];g.settings.pinnedOriginals=[];
  g.settings.rowPositions.row=[];
  assert.equal(germanMix(rows,e,g).selected.length,0);
  delete g.settings.rowPositions;
  g.settings.excludedRows=['row'];
  assert.equal(germanMix(rows,e,g).selected.length,0);
  g.settings.excludedRows=[];
  g.matches.forEach(m=>m.replacement.channelId='same');
  g.settings.creatorLimit=1;
  assert.equal(germanMix(rows,e,g).selected.length,1);
  g.settings.blockedChannels=['same'];
  assert.equal(germanMix(rows,e,g).selected.length,0);
});

test('legacy title-only, English, unknown, dubbed and expired audio cannot pass',()=>{
  for(const change of [{basis:'title-search'},{audioLanguage:'en'},{audioLanguage:''},{originalProduction:false},
    {audioCheckedAt:Date.now()-31*86400000},{audioCheckedAt:Date.now()+120000},{transcriptExcerpt:'no transcripts'}]){
    const m=match(1);Object.assign(m.evidence,change);
    assert.equal(germanMix([row()],edits(),{settings:settings(),matches:[m]}).selected.length,0);
  }
});

test('caps and short rows preserve originals; creator counts include retained cards',()=>{
  const g={settings:settings(),matches:[1,5,8].map(match)},e=edits();
  assert.equal(germanMix([row('row',9)],e,g).selected.length,0);
  const full=germanMix([row('row',48)],e,g);
  assert.equal(full.selected.length,3);
  assert.equal(full.rows[0].items.length,48);
  assert.deepEqual(full.rows[0].items.slice(-3),[8,5,1].map(card));
  e.cardLimit=21;
  assert.equal(germanMix([row()],e,g).rows[0].items.length,21);
  e.cardLimit=20;g.settings.pinnedOriginals=Array.from({length:10},(_,i)=>card(10+i).videoId);
  assert.equal(germanMix([row()],e,g).selected.length,0);
  g.settings.pinnedOriginals=[];
  const r=row();r.items[1].channelId='UC5';g.settings.creatorLimit=1;
  delete e.cardLimit;
  assert.deepEqual(germanMix([r],e,g).selected.map(m=>m.original),[1,8].map(i=>card(i).videoId));
});

test('editor maps both views to unique originals and honors moves, removals and pins',()=>{
  const rows=[row()],e=edits(),g={settings:settings(),matches:[match(1)]},mixed=germanMix(rows,e,g);
  const editorial=originalRows(mixed.rows,rows,mixed.selected)[0];
  assert.deepEqual(editorial,rows[0]);
  assert.equal(originalIndex(mixed.rows[0],editorial,1,mixed.selected),1);
  assert.equal(originalIndex(mixed.rows[0],editorial,20,mixed.selected),1);
  move(e,editorial,1,2);
  assert.equal(new Set(e.rows.row.order).size,e.rows.row.order.length);
  assert.ok(!e.rows.row.order.includes('video:00000000101'));
  assert.equal(germanMix(compose(rows,e),e,g).selected.length,0);
  e.rows={};e.removed=['video:00000000101'];
  assert.deepEqual(germanMix(rows,e,g).rows,rows);
  e.removed=[];g.settings.pinnedOriginals=[card(1).videoId];
  assert.deepEqual(germanMix(rows,e,g).rows,rows);
});

test('search order, duration, playlist, Shorts and duplicate policies remain enforced',()=>{
  const r=row(),a=match(1),b=match(1);b.replacement=card(222);b.replacement.channelId='other';
  const g={settings:settings(),matches:[a,b]},e=edits();
  assert.equal(germanMix([r],e,g).selected[0].replacement.videoId,a.replacement.videoId);
  a.evidence.checkedAt=Date.now()-31*86400000;
  assert.equal(germanMix([r],e,g).selected[0].replacement.videoId,b.replacement.videoId);
  b.duration=1800;assert.equal(germanMix([r],e,g).selected.length,0);
  b.duration=600;r.items[1].playlistId='playlist';
  assert.equal(germanMix([r],e,g).selected.length,0);
  delete r.items[1].playlistId;r.items[1].isShorts=true;b.replacement.isShorts=true;
  assert.equal(germanMix([r],e,g).selected.length,0);
  delete r.items[1].isShorts;delete b.replacement.isShorts;r.items.push(b.replacement);
  assert.equal(germanMix([r],e,g).selected.length,0);
});

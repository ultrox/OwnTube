import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose, move, insert, insertMany } from './model.js';

test('caps follow removals and ordering, and clearing the cap restores hidden cards', () => {
  const source = [{ id:'shorts', title:'Shorts', items:Array.from({length:48},(_,i)=>({videoId:String(i)})) }];
  const edits = {removed:['video:0'], blockedChannels:[], rows:{shorts:{
    title:'Shorts', added:[], order:['video:0','video:47','video:46','video:45','video:44','video:43','video:42','video:41'], limit:6,
  }}};
  let row = compose(source,edits)[0];
  assert.deepEqual(row.items.map(c=>c.videoId), ['47','46','45','44','43','42']);
  move(edits,row,0,1);
  insert(edits,compose(source,edits)[0],{videoId:'new'},0);
  assert.deepEqual(compose(source,edits)[0].items.map(c=>c.videoId), ['new','46','47','45','44','43']);
  delete edits.rows.shorts.limit;
  row = compose(source,edits)[0];
  assert.equal(row.items.length,48);
  assert.deepEqual(row.items.slice(0,8).map(c=>c.videoId), ['new','46','47','45','44','43','42','41']);
  assert.equal(source[0].items.length,48);
});

test('category defaults apply independently and row overrides win', () => {
  const source = ['recommended','shorts'].map(id=>({id,title:id,items:Array.from({length:48},(_,i)=>({videoId:String(i)}))}));
  const edits = {cardLimit:24,removed:[],blockedChannels:[],rows:{shorts:{title:'shorts',added:[],order:[],limit:6}}};
  assert.deepEqual(compose(source,edits).map(r=>r.items.length),[24,6]);
  edits.cardLimit=12;
  assert.deepEqual(compose(source,edits).map(r=>r.items.length),[12,6]);
  delete edits.rows.shorts.limit;
  assert.deepEqual(compose(source,edits).map(r=>r.items.length),[12,12]);
  delete edits.cardLimit;
  assert.deepEqual(compose(source,edits).map(r=>r.items.length),[48,48]);
});

test('catalog batches insert in ranked order inside an existing row without duplicating videos', () => {
  const source=[{id:'row',title:'Recommended',items:['a','b','c'].map(videoId=>({videoId}))}];
  const edits={removed:['video:new'],blockedChannels:[],rows:{}};
  insertMany(edits,source[0],[{videoId:'new'},{videoId:'b'},{videoId:'new'}],1);
  assert.deepEqual(compose(source,edits)[0].items.map(c=>c.videoId),['a','new','b','c']);
  insertMany(edits,compose(source,edits)[0],[{videoId:'new'},{videoId:'b'}],0);
  assert.deepEqual(compose(source,edits)[0].items.map(c=>c.videoId),['new','b','a','c']);
  assert.equal(edits.rows.row.added.length,2);
  assert.equal(source[0].items.length,3);
});

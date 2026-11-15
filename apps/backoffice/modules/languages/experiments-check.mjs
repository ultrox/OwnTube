import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addDays } from './comparison-model.js';

export async function experimentChecks({ p, ok, LIVE, MODULE, OUT, control, person, other }) {
  console.log('Named experiments');
  const listPage = `${MODULE}#view=compare&person=${person}`;
  const listReady = () => p.waitFor(() => document.querySelector('.ex-list')?.getAttribute('aria-busy') === 'false');
  const detailReady = () => p.waitFor(() => document.querySelector('[data-compare-results]')?.getAttribute('aria-busy') === 'false');
  const request = (method, id = '', body, owner = person) => p.eval(async (method, id, body, person) => {
    const r = await fetch('/api/modules/languages/experiments' + (id ? '/' + encodeURIComponent(id) : '') + '?' + new URLSearchParams({ person }),
      { method, headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}) });
    return { status:r.status, data:await r.json() };
  }, method, id, body, owner);
  const submitName = async (name, lead = 'de') => {
    await p.eval(name => { const input = document.querySelector('[data-experiment-dialog] input'); input.value = name; input.dispatchEvent(new Event('input',{bubbles:true})); }, name);
    if (await p.eval(() => !!document.querySelector('[data-experiment-dialog] select'))) await p.select('[data-experiment-dialog] select', lead);
    await p.click('[data-experiment-dialog] [type="submit"]');
    assert.ok(await p.waitFor(() => !document.querySelector('[data-experiment-dialog]')), 'name dialog completes successfully');
  };
  const currentId = () => p.eval(() => new URLSearchParams(location.hash.slice(1)).get('experiment'));
  await p.go(listPage); await listReady();
  ok(await p.eval(() => !!document.querySelector('[data-experiments="create"]') && !document.querySelector('[data-picker-grid]')
    && document.querySelector('#f-device').disabled), 'person opens an experiment list, with device filtering reserved for results');
  const beforeOther = (await request('GET','',null,other)).data;
  await p.click('[data-experiments="create"]');
  ok(await p.eval(() => document.querySelector('[name="leadLanguage"]').required
    && !document.querySelector('[name="leadLanguage"]').validity.valid), 'creation requires an explicit lead language');
  for (const theme of ['light', 'dark']) {
    await p.send('Emulation.setEmulatedMedia', { features: [{ name:'prefers-color-scheme', value:theme }] });
    for (const width of [1320, 390]) {
      await p.size(width,1000);
      ok(await p.eval(() => {
        const r = document.querySelector('[data-experiment-dialog]').getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }), `creation settings fit ${theme} ${width}px`);
      const {data} = await p.send('Page.captureScreenshot', { format:'png' });
      fs.writeFileSync(path.join(OUT, `create-experiment-${theme}-${width}.png`), Buffer.from(data,'base64'));
    }
  }
  await p.send('Emulation.setEmulatedMedia', { features:[] }); await p.size(1320,1000);
  await submitName('German with SLN'); await detailReady();
  const first = await currentId(); assert.ok(first);
  ok(await p.eval(() => document.querySelector('[data-experiment-person]').textContent === 'German with SLN' && !document.querySelector('#cx-editor').hidden), 'creating a named experiment opens its calendar');
  ok((await request('GET', first)).data.config.leadLanguage === 'de'
    && await p.eval(() => document.querySelector('#cx-lead-language').value === 'de'
      && !document.querySelector('[data-compare="save-lead"]')), 'creation saves the lead as a core setting before any periods exist');
  await p.click('[data-compare="add"]');
  await p.eval(() => { const input = document.querySelector('.cp-card input'); input.value = 'Unsaved first'; input.dispatchEvent(new Event('input',{bubbles:true})); });
  await p.click('[data-experiments="back"]'); await listReady();
  ok(await p.eval(() => document.querySelector('.ex-list').textContent.includes('Unsaved changes on this page')), 'experiment list identifies a retained local draft');
  await p.click('[data-experiments="create"]');
  await submitName('Second experiment', 'ja'); await detailReady();
  const second = await currentId();
  ok(first !== second && await p.eval(() => !document.querySelector('.cp-card') && document.querySelector('#cx-lead-language').value === 'ja'), 'a second experiment has its own empty plan and lead');
  await p.click('[data-experiments="back"]'); await listReady();
  await p.click(`[data-experiments="open"][data-id="${first}"]`); await detailReady();
  ok(await p.eval(() => document.querySelector('.cp-card input')?.value === 'Unsaved first'), 'reopening the first experiment restores only its draft');
  await p.click('[data-compare="discard"]'); await detailReady();
  const initial = (await request('GET',first)).data;
  await request('POST',first,{...initial.config, periods:[{label:'Off',start:addDays(initial.today,1),end:addDays(initial.today,7)}],selectedLanguages:['de']});
  await p.click('[data-compare="reload"]'); await detailReady();
  await p.click('[data-experiments="back"]'); await listReady();
  await p.click(`[data-experiments="rename"][data-id="${first}"]`);
  await submitName('<img src=x onerror="window.__experimentXss=1">'); await listReady();
  await p.waitFor(() => !document.querySelector('[data-experiment-dialog]'));
  ok(await p.eval(() => !window.__experimentXss && !document.querySelector('.ex-card img')
    && document.querySelector('.ex-list').textContent.includes('<img src=x')), 'experiment names render as text in the list');
  await p.click(`[data-experiments="duplicate"][data-id="${first}"]`);
  await submitName('German trial copy'); await detailReady();
  const copy = await currentId(), copyData = (await request('GET',copy)).data;
  ok(copyData.config.periods.length === 1 && copyData.config.selectedLanguages.join() === 'de'
    && copyData.config.baseRevision === 0 && copyData.config.concludedAt === null && copyData.config.leadLanguage === 'de', 'duplicate creates an independent unconcluded saved plan with its lead');
  const changed = await request('POST',copy,{...copyData.config,periods:copyData.config.periods.map(x=>({...x,label:'Copy only'}))});
  ok(changed.status === 200 && (await request('GET',first)).data.config.periods[0].label === 'Off', 'editing a copy preserves the original experiment');
  ok((await request('GET',first,null,other)).status === 404, 'a bookmarked experiment cannot be opened under another person');
  await p.select('#f-person',other); await listReady();
  ok(await p.eval(() => !location.hash.includes('experiment=') && !document.querySelector('.ex-list').textContent.includes('German trial copy')), 'switching person opens their own list');
  assert.deepEqual((await request('GET','',null,other)).data,beforeOther);
  await p.select('#f-person',person); await listReady();
  await p.click(`[data-experiments="open"][data-id="${copy}"]`); await detailReady();
  await p.eval(() => history.back()); await listReady();
  await p.eval(() => history.forward()); await detailReady();
  ok(await currentId() === copy, 'browser back and forward restore list and experiment detail');
  await p.click('[data-experiments="back"]'); await listReady();
  await p.click(`[data-experiments="delete"][data-id="${copy}"]`);
  await p.key('Escape',27);
  ok((await request('GET',copy)).status === 200, 'canceling deletion keeps the experiment');
  await p.click(`[data-experiments="delete"][data-id="${copy}"]`);
  await p.click('[data-experiment-dialog] [type="submit"]');
  await p.waitFor(id => !document.querySelector(`[data-experiment-id="${id}"]`) && !document.querySelector('[data-experiment-dialog]'), copy);
  ok((await request('GET',copy)).status === 404 && (await request('GET',first)).status === 200, 'deletion removes only the selected experiment');
  await p.go(`${listPage}&experiment=${encodeURIComponent(copy)}`);
  ok(await p.waitFor(() => document.querySelector('.compare')?.textContent.includes('no longer available'))
    && await p.eval(() => !!document.querySelector('[data-experiments="back"]')), 'deleted bookmarks explain what happened and offer the list');
  await p.click('[data-experiments="back"]'); await listReady();
  const firstMeta = (await request('GET',first)).data.experiment;
  await p.click(`[data-experiments="delete"][data-id="${first}"]`);
  await request('PATCH',first,{name:'Changed elsewhere',baseRevision:firstMeta.revision});
  await p.click('[data-experiment-dialog] [type="submit"]');
  ok(await p.waitFor(() => document.querySelector('[data-experiment-dialog] [role="alert"]')?.textContent.includes('another browser'))
    && (await request('GET',first)).status === 200, 'stale deletion is rejected without removing a changed experiment');
  await p.key('Escape',27); await listReady();
  for (const theme of ['light','dark']) {
    await p.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
    for (const width of [1320,390]) {
      await p.size(width,1000);
      ok(await p.eval(() => document.documentElement.scrollWidth <= innerWidth), `experiment list fits ${theme} ${width}px`);
      const metrics = await p.send('Page.getLayoutMetrics');
      const {data} = await p.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width,height:metrics.cssContentSize.height,scale:1}});
      fs.writeFileSync(path.join(OUT,`experiments-${theme}-${width}.png`),Buffer.from(data,'base64'));
    }
  }
  await p.send('Emulation.setEmulatedMedia',{features:[]}); await p.size(1320,1000);
  if (!LIVE) {
    await control({fail:'experiments500'}); await p.click('[data-experiments="refresh"]');
    ok(await p.waitFor(() => document.querySelector('.ex-list [role="alert"]')?.textContent.includes('could not be loaded')), 'list failures explain the error and retain retry');
    await control({fail:null}); await p.click('[data-experiments="refresh"]'); await listReady();
    await p.click(`[data-experiments="open"][data-id="${first}"]`); await detailReady();
    await p.click('[data-compare="edit"]');
    const editLabel = label => p.eval(label => {
      const input = document.querySelector('.cp-card input');
      input.value = label; input.dispatchEvent(new Event('input', { bubbles: true }));
    }, label);
    await editLabel('Save while on list');
    await control({saveDelay:1500}); await p.click('[data-compare="save"]');
    await p.click('[data-experiments="back"]'); await listReady();
    await p.waitFor(async (person, id) => (await fetch('/api/modules/languages/experiments/' + id + '?person=' + person).then(r => r.json())).config.periods[0]?.label === 'Save while on list', person, first);
    ok(await p.eval(() => !!document.querySelector('.ex-list') && !location.hash.includes('experiment=')), 'a completed in-flight save keeps the experiment list open');
    await p.click(`[data-experiments="open"][data-id="${first}"]`); await detailReady();
    await p.click('[data-compare="edit"]'); await editLabel('Save while on sibling');
    await p.click('[data-compare="save"]');
    await p.click('[data-experiments="back"]'); await listReady();
    await p.click(`[data-experiments="open"][data-id="${second}"]`); await detailReady();
    await p.waitFor(async (person, id) => (await fetch('/api/modules/languages/experiments/' + id + '?person=' + person).then(r => r.json())).config.periods[0]?.label === 'Save while on sibling', person, first);
    ok(await currentId() === second && await p.eval(() => !document.querySelector('.cp-card') && document.querySelector('[data-experiment-person]').textContent === 'Second experiment'),
      'an in-flight save cannot replace a sibling experiment for the same person');
    await control({saveDelay:0});
    await p.click('[data-experiments="back"]'); await listReady();
  }
  for (const id of [first,second]) {
    const data = (await request('GET',id)).data;
    await request('DELETE',id,{baseRevision:data.config.baseRevision});
  }
}

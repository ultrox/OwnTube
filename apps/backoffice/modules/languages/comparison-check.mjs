import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  moveStory, movePhrase, shareStory, pointsText, percentText, rangeText, changeText, subLine,
  scaleBlocks, waffleCounts, timeAxis, observation, leadLanguage, normalizeConfig, planPeriods,
  addDays, periodDays, periodFacts,
} from './comparison-model.js';

export function pureChecks() {
  assert.equal(moveStory(null, 5).state, 'incomplete');
  assert.equal(moveStory(5, undefined).state, 'incomplete');
  assert.equal(moveStory(0, 0).state, 'none');
  assert.equal(moveStory(10, 10).figure, '10 min');
  assert.equal(moveStory(10.01, 10.04).exact, false);
  assert.equal(moveStory(0, .04).figure, 'under 0.1 min');
  assert.equal(moveStory(.04, 10).state, 'from-zero');
  assert.match(movePhrase(moveStory(.04, 10), 'German', 'On'), /from almost none/);
  assert.equal(moveStory(10, .04).figure, 'almost none');
  assert.equal(moveStory(10, 0).figure, '0 min');
  assert.equal(moveStory(10, 19.9).figure, '+99.0%');
  assert.equal(moveStory(10, 20).figure, '2.0×');
  assert.equal(moveStory(10, 100).figure, '10×');
  assert.equal(moveStory(100, 10).figure, '-90.0%');
  assert.equal(moveStory(.1, .3).delta, .2);
  assert.equal(moveStory(10.7, 66.8).figure, '6.2×');
  assert.equal(changeText(moveStory(10.7, 66.8)), '+56.1 a day · 6.2 times (+524%)');
  assert.equal(changeText(moveStory(0, 66.8)), '+66.8 a day (from none)');
  assert.equal(changeText(moveStory(10, 5)), '-5.0 a day (-50.0%)');
  assert.equal(shareStory(6.7, 26.3).points, 19.6);
  assert.equal(pointsText(shareStory(26.3, 6.7).points), '-19.6 points');
  assert.equal(shareStory(null, 1).points, null);
  assert.equal(percentText(1300), '+1,300%');
  assert.match(subLine(moveStory(10, 30), 'German', [.1, .2], [100, 150]), /even though total viewing rose too/);
  assert.match(subLine(moveStory(30, 10), 'German', [.2, .1], [100, 150]), /while total viewing rose/);
  assert.match(subLine(moveStory(30, 10), 'German', [.2, .1], [150, 100]), /while total viewing fell/);
  assert.doesNotMatch(subLine(moveStory(0, 10), 'German', [null, .1], [0, 100]), /increase|every 100/);
  assert.match(subLine(moveStory(10, 10), 'German', [.1, .1], [100, 100]), /stayed at 10/);
  const blocks = scaleBlocks(10.7, 66.8);
  assert.equal(blocks.full, 6); assert.equal(blocks.blocks.length, 7);
  assert.equal(blocks.smaller, 0);
  assert.equal(scaleBlocks(130, 10).blocks.length, 0);
  assert.equal(scaleBlocks(0, 10).widths[0], 0);
  assert.deepEqual(waffleCounts([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(waffleCounts([.01, 99.99]), [0, 100]);
  assert.equal(waffleCounts([0, 0]), null);
  for (let n = 1; n <= 128; n++) assert.equal(waffleCounts(Array.from({ length: n }, (_, i) => i + 1)).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(timeAxis(50), { max: 60, ticks: [0, 15, 30, 45, 60] });
  assert.equal(timeAxis(254).max, 300);
  assert.equal(timeAxis(500).ticks[1], 120);
  assert.equal(rangeText({ start: '2026-11-07', end: '2026-11-11' }), '7 to 11 Nov 2026');
  assert.equal(rangeText({ start: '2026-10-28', end: '2026-11-03' }), '28 Oct to 3 Nov 2026');
  assert.equal(rangeText({ start: '2025-12-20', end: '2026-01-05' }), '20 Dec 2025 to 5 Jan 2026');
  const complete = (n, label = 'Off') => ({ label, calendarDays: n, plannedDays: n, status: 'complete', includesToday: false });
  assert.equal(observation([complete(5), complete(5)]).stamp, 'Even windows');
  assert.equal(observation([complete(5), complete(2, 'On')]).missing, 3);
  assert.equal(observation([complete(5), { ...complete(5), includesToday: true, status: 'running' }]).line, 'Same length, but today is still running.');
  assert.equal(observation([complete(5), { ...complete(2), plannedDays: 10, status: 'running', end: '2026-11-20' }]).title, '2 of 10 days so far.');
  assert.equal(observation([complete(5), { ...complete(0), plannedDays: 10, status: 'upcoming', end: '2026-11-20' }]).early, true);
  const item = (langs, all = 6000) => ({ calendarDays: 1, allSeconds: all, languages: Object.entries(langs).map(([lang, seconds]) => ({ lang, seconds })) });
  assert.equal(leadLanguage(['en', 'de'], [item({ en: 3000, de: 600 }), item({ en: 3300, de: 2400 })]), 'de');
  assert.equal(leadLanguage(['en', 'de'], [item({ en: 0, de: 0 }, 0), item({ en: 0, de: 0 }, 0)]), 'de');
  assert.equal(leadLanguage(['en', 'de'], [item({ en: 0, de: 0 }, 0), item({ en: 1200, de: 600 })]), 'en');
  const base = { baseRevision: 0, selectedLanguages: [], concludedAt: null, periods: [] };
  const plan = planPeriods('2026-11-14', 10);
  assert.deepEqual(plan.map(p => [p.start, p.end]), [['2026-11-14', '2026-11-23'], ['2026-11-24', '2026-12-03'], ['2026-12-04', '2026-12-13']]);
  assert.equal(periodDays({ start: '2026-03-28', end: '2026-03-30' }).length, 3);
  assert.equal(periodFacts(periodDays(plan[0]), '2026-11-13').calendarDays, 0);
  assert.equal(normalizeConfig({ ...base, periods: plan }, '2026-11-13').periods.length, 3);
  const merged = normalizeConfig({ ...base, periods: [{ label: ' Off ', start: '2026-11-01', end: '2026-11-03' }, { label: 'Off', start: '2026-11-04', end: '2026-11-05' }] }, '2026-11-13');
  assert.equal(merged.periods.length, 1); assert.equal(merged.periods[0].end, '2026-11-05');
  assert.throws(() => normalizeConfig({ ...base, periods: [{ ...plan[0] }, { ...plan[0], label: 'Other' }] }, '2026-11-13'), /one period only/);
  assert.throws(() => normalizeConfig({ ...base, groups: [] }, '2026-11-13'), /v2/);
  assert.throws(() => normalizeConfig({ ...base, periods: plan, concludedAt: '2026-11-13' }, '2026-11-13'), /complete/);
  assert.throws(() => normalizeConfig({ ...base, periods: [{ ...plan[0], end: '2028-01-01' }] }, '2026-11-13'), /366/);
  assert.throws(() => normalizeConfig({ ...base, periods: Array(129).fill(plan[0]) }, '2026-11-13'), /128/);
  assert.throws(() => normalizeConfig({ ...base, periods: [{ ...plan[0], start: '2000-01-01' }] }, '2026-11-13'), /3,660/);
  assert.throws(() => normalizeConfig({ ...base, baseRevision: 0 }, '2026-11-13', { ...base, baseRevision: 1 }), /another browser/);
  const concluded = { ...base, concludedAt: '2026-11-13', periods: [{ end: '2026-11-10', label: 'Done', start: '2026-11-01' }] };
  assert.equal(normalizeConfig({ ...concluded, concludedAt: null }, '2026-11-13', concluded).concludedAt, null);
  assert.throws(() => normalizeConfig({ ...concluded, periods: [{ ...concluded.periods[0], label: 'Changed' }] }, '2026-11-13', concluded), /Reopen/);
}

// Fictional aggregates deliberately differ from the artboard's illustrative measurements.
export function fixture(kind) {
  const today = '2026-11-13';
  let selected = kind === 'one-language' ? ['de'] : kind === 'three-languages' ? ['de', 'en', 'ja'] : ['de', 'en'];
  let ranges = [['Off', '2026-11-01', '2026-11-05'], ['On', '2026-11-06', '2026-11-10']];
  if (kind === 'unequal') ranges[1] = ['On', '2026-11-12', today];
  if (['upcoming', 'running'].includes(kind)) ranges = [['Off, before', '2026-11-01', '2026-11-05'], ['On', '2026-11-06', kind === 'running' ? '2026-11-15' : '2026-11-10'], ['Off, after', '2026-11-16', '2026-11-20']];
  if (kind === 'long') ranges = [['Off', '2026-07-01', '2026-08-31'], ['On', '2026-09-01', '2026-11-13']];
  if (kind === 'long-labels') ranges[0][0] = '<img src=x onerror="window.__cmpXss=1">_Long_unbroken_period_name_for_wrapping';
  const periods = ranges.map(([label, start, end], i) => {
    const facts = periodFacts(periodDays({ start, end }), today);
    let rates = [i === 0 ? 12 : 72, i === 0 ? 100 : 120, i === 0 ? 8 : 14];
    if (kind === 'decrease') rates[0] = i === 0 ? 72 : 12;
    if (kind === 'trace') rates[0] = i === 0 ? .02 : 12;
    if (kind === 'zero' || (kind === 'no-share' && i === 0)) rates = [0, 0, 0];
    if (kind === 'same') rates = [12, 100, 8];
    const all = facts.calendarDays * 60 * (rates.reduce((a, b) => a + b, 0) + (kind === 'no-share' && i === 0 ? 0 : 10));
    const languages = selected.map(code => {
      const seconds = rates[['de', 'en', 'ja'].indexOf(code)] * 60 * facts.calendarDays;
      return { lang: code, seconds, minutesPerDay: facts.calendarDays ? seconds / 60 / facts.calendarDays : null, share: all ? seconds / all : null };
    });
    const seconds = languages.reduce((n, l) => n + l.seconds, 0);
    return { label, start, end, ...facts, activeDays: seconds ? facts.calendarDays : 0, seconds, allSeconds: all, minutesPerDay: facts.calendarDays ? seconds / 60 / facts.calendarDays : null,
      share: all ? seconds / all : null, foregroundSeconds: seconds * .8, backgroundSeconds: seconds * .1, unspecifiedSeconds: seconds * .1, reviewSeconds: seconds * .05, languages };
  });
  return { config: { baseRevision: 99, selectedLanguages: selected, periods: periods.map(({ label, start, end }) => ({ label, start, end })), concludedAt: kind === 'concluded' ? today : null },
    periods, groups: periods.map((p, i) => ({ ...p, periods: [i] })), availableLanguages: ['de', 'en', 'ja'], today, timezone: 'Europe/Zurich', asOf: Date.parse(`${today}T14:02:00Z`) };
}

export async function browserChecks({ p, ok, LIVE, MODULE, OUT, control }) {
  console.log('Comparison v2');
  pureChecks(); ok(true, 'directional arithmetic, trace, waffles, axes, lead, observations and calendar normalization');
  const catalog = await p.eval(() => fetch('/api/modules/languages').then(r => r.json()));
  const recordingStarts = await p.eval(async people => Promise.all(people.map(async person => {
    const data = await fetch('/api/modules/languages/comparison/days?' + new URLSearchParams({ person: person.id, from: '2026-11-01', to: '2026-11-15' })).then(r => r.json());
    return { id: person.id, first: data.firstRecordedDate || '9999' };
  })), catalog.people);
  const person = recordingStarts.sort((a, b) => a.first.localeCompare(b.first))[0].id;
  const other = catalog.people.find(p => p.id !== person)?.id;
  assert.ok(other, 'Person isolation checks require two fixture people');
  const { experimentChecks } = await import('./experiments-check.mjs');
  if (!process.argv.includes('--calendar-only')) await experimentChecks({ p, ok, LIVE, MODULE, OUT, control, person, other });
  if (process.argv.includes('--experiments-only')) return;
  const ids = await p.eval(async owners => {
    const result = {};
    for (const person of owners) {
      const r = await fetch('/api/modules/languages/experiments?' + new URLSearchParams({ person }), { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Comparison regression'}) }).then(r => r.json());
      result[person] = r.id;
    }
    return result;
  }, [person, other]);
  const page = `${MODULE}#view=compare&person=${encodeURIComponent(person)}&experiment=${encodeURIComponent(ids[person])}`;
  const api = (body, scope = { person }) => p.eval(async (body, scope, ids) => {
    const route = scope.person ? '/api/modules/languages/experiments/' + encodeURIComponent(ids[scope.person]) : '/api/modules/languages/comparison';
    const r = await fetch(route + '?' + new URLSearchParams(scope), body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: r.status, data: await r.json() };
  }, body, scope, ids);
  if (process.argv.includes('--calendar-only')) {
    const { calendarChecks } = await import('./calendar-check.mjs');
    return calendarChecks({ p, ok, LIVE, page, api, control, OUT });
  }
  const settled = () => p.waitFor(() => document.querySelector('[data-compare-results]')?.getAttribute('aria-busy') === 'false' && !document.querySelector('[data-compare="reload"]').disabled);
  const open = async owner => {
    await p.waitFor(() => document.querySelector('.ex-list')?.getAttribute('aria-busy') === 'false');
    await p.click(`[data-experiments="open"][data-id="${ids[owner]}"]`); await settled();
  };
  const field = (key, value) => p.eval((key, value) => {
    const input = document.querySelector(`[data-key="${key}"]`); input.focus(); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
  }, key, value);
  const shared = (await api(null, {})).data.config;
  await p.go(`${MODULE}#view=compare`);
  ok(await p.waitFor(() => document.querySelector('.compare')?.textContent.includes('Choose a person for the experiment'))
    && await p.eval(() => document.querySelector('#f-device').disabled && !document.querySelector('[data-compare="fill"]')), 'experiments require a person; everyone keeps the previous shared comparison read-only');
  const initial = (await api()).data;
  ok((await api(initial.config, {})).status === 422, 'unscoped saves cannot overwrite the shared comparison');
  ok(Array.isArray(initial.config.periods) && !initial.config.groups, 'read contract exposes ordered periods, including migrated v1');
   ok((await api({ baseRevision: initial.config.baseRevision, groups: [] })).status === 422, 'v1 POST is explicitly rejected');
  if (initial.config.concludedAt) await api({ ...initial.config, concludedAt: null });
  const current = (await api()).data;
  await api({ ...current.config, periods: [], selectedLanguages: [] });
  await p.go(page);
  await settled();
  await p.waitFor(() => !document.querySelector('.cp-data-note')?.textContent.includes('Loading'));
  ok(await p.eval((person, devices) => [...document.querySelectorAll('#f-device option')].every(o => !o.value || devices.some(d => d.id === o.value && d.personId === person)), person, catalog.devices), 'person picker limits devices to that person');
  ok(await p.eval(() => !document.querySelector('#cx-editor').hidden && document.querySelector('[data-compare="save"]').closest('[hidden]') && document.querySelector('#f-days').parentElement.hidden), 'empty state opens planner, no spurious save, independent dates');
  await p.click('[data-compare="cal-fill"]');
  await p.click(`[data-date="${addDays(initial.today, 1)}"]`);
  ok(await p.eval(() => document.querySelectorAll('.cx-period-row').length === 3 && !document.querySelector('[data-compare-draft-note]').hidden && document.querySelector('[data-compare="add"]').nextElementSibling.dataset.compare === 'add-language'), 'planner makes three editable periods, marks draft and keeps add controls adjacent');
  await p.click('[data-compare="cal-fill"]');
  await p.click(`[data-date="${addDays(initial.today, 1)}"]`);
  ok(await p.eval(() => !!document.querySelector('dialog[open]')), 'replacing draft periods asks in a native dialog');
  await p.key('Escape', 27);
  await p.click('[data-compare="save"]'); await settled();
  let saved = (await api()).data;
  ok(saved.periods.length === 3 && saved.periods.every(p => p.calendarDays === 0 && p.minutesPerDay === null) && saved.availableLanguages.length > 0, 'future-only saved plan has no denominators and offers recent recorded languages');
  await p.click('[data-compare="edit"]');
  await p.click('#cx-editor [data-compare="add-language"]');
  ok(await p.eval(codes => [...document.querySelectorAll('[data-picker-code]')].every(b => codes.includes(b.dataset.pickerCode)), saved.availableLanguages), 'picker only offers recorded scoped languages and saved selections');
  await p.click('#language-search'); await p.type('Esperanto');
  ok(await p.eval(() => document.querySelectorAll('[data-picker-code]').length === 0), 'typed search cannot introduce an unrecorded language');
  await p.key('Escape', 27);
  const today = saved.today;
  for (const [i, label, start, end] of [[0, 'Off', -8, -5], [1, 'On', -4, -1], [2, 'Off', 1, 4]]) {
    await field(`compare:${i}:label`, label); await field(`compare:${i}:start`, addDays(today, start)); await field(`compare:${i}:end`, addDays(today, end));
  }
  const before = await p.eval(() => document.querySelector('[data-compare-results]').textContent);
  ok(before.includes('Nothing to compare yet.'), 'editing draft leaves the saved future-only result intact');
  await p.click('[data-compare="save"]'); await settled();
  saved = (await api()).data;
  ok(saved.groups.length === 2 && saved.groups[0].periods.join() === '0,2' && saved.groups[0].calendarDays === 4 && saved.groups[0].plannedDays === 8, 'same labels pool without adding future days to the denominator');
  ok(await p.eval(() => document.querySelector('[data-compare="mode"][data-value="pooled"]').getAttribute('aria-pressed') === 'true'), 'repeated labels default to pooled mode');
  await p.click('[data-compare="mode"][data-value="sequence"]');
  ok(await p.eval(() => document.activeElement?.dataset.key === 'compare:mode:sequence'), 'mode switch retains keyboard focus on the selected mode');
  await p.click('.cx-move[data-value="2"]');
  ok(await p.eval(() => document.activeElement?.dataset.key === 'compare:move:2'), 'featured move retains keyboard focus');
  ok(await p.eval(() => location.hash.includes('mode=sequence') && location.hash.includes('move=2') && document.querySelector('.cx-notice').textContent.includes('Nothing to compare yet')), 'mode and adjacent featured move are bookmarkable');
  await p.click('[data-compare="edit"]');
  await field('compare:0:label', 'Draft survives scope');
  const device = await p.eval(() => document.querySelector('#f-device option[value]:not([value=""])').value);
  await p.select('#f-device', device); await settled();
  ok(await p.eval(() => document.querySelector('[data-key="compare:0:label"]').value === 'Draft survives scope' && location.hash.includes('mode=sequence') && location.hash.includes('move=2')), 'scope changes retain draft and comparison hash state');
  await p.select('#f-person', other); await open(other);
  ok(await p.eval(() => document.querySelector('#f-device').value === '' && !location.hash.includes('device=')
    && !document.querySelector('.compare').textContent.includes('Draft survives scope')), 'switching person clears incompatible device and never carries over their draft');
  await p.select('#f-person', person); await open(person);
  ok(await p.eval(() => document.querySelector('[data-key="compare:0:label"]').value === 'Draft survives scope'), 'returning to a person restores that person’s unsaved draft');
  await p.select('#f-device', device); await settled();
  await p.select('#f-person', '');
  ok(await p.waitFor(() => document.querySelector('.compare')?.textContent.includes('Choose a person for the experiment'))
    && await p.eval(() => document.querySelector('#f-device').value === '' && !location.hash.includes('person=')), 'Everyone clears the device and returns to the shared reference without reselecting its owner');
  await p.select('#f-person', person); await open(person);
  await p.click('[data-compare="discard"]'); await settled();
  await p.select('#f-device', ''); await settled();
  await field('compare:0:label', 'Unsaved local name');
  const remote = (await api()).data.config;
  await api({ ...remote, selectedLanguages: ['de'] });
  await p.click('[data-compare="save"]');
  ok(await p.waitFor(() => document.querySelector('[data-compare-error]').textContent.includes('another browser')) && await p.eval(() => document.querySelector('[data-key="compare:0:label"]').value === 'Unsaved local name'), '409 preserves draft and announces a reload path');
  await p.click('[data-compare="discard"]'); await settled();
  await field('compare:1:start', addDays(today, -6));
  ok(await p.eval(() => document.querySelector('[data-compare="save"]').disabled && document.querySelector('[data-compare-error]').textContent.includes('one period only')), 'cross-label overlap is inline and blocks saving');
  await p.click('[data-compare="discard"]'); await settled();
  await p.click('[data-compare="remove"][data-period="2"]');
  await p.click('[data-compare="save"]'); await settled();
  await p.click('[data-compare="edit"]');
  await p.click('[data-compare="conclude"]'); await settled();
  saved = (await api()).data;
  ok(!!saved.config.concludedAt && saved.periods.every(p => p.status === 'complete'), 'complete experiment can be concluded');
  await p.click('[data-compare="edit"]');
  ok(await p.eval(() => [...document.querySelectorAll('[data-compare-field]')].every(e => e.readOnly)), 'concluded period fields are read-only');
  ok((await api({ ...saved.config, periods: saved.config.periods.map((p, i) => ({ ...p, label: i ? p.label : 'Changed' })) })).status === 422, 'server enforces concluded period lock');
  ok((await api({ ...saved.config, selectedLanguages: ['de', 'en'] })).status === 200, 'language selection remains editable after conclusion');
   await p.click('[data-compare="reload"]'); await settled();
   await p.click('[data-compare="lead"][data-value="de"]');
   await p.click('[data-compare="save-lead"]'); await settled();
   const leadSaved = (await api()).data.config;
   ok(leadSaved.leadLanguage === 'de' && leadSaved.concludedAt === saved.config.concludedAt
     && JSON.stringify(leadSaved.periods) === JSON.stringify(saved.config.periods), 'lead saves on a concluded experiment without changing its plan or conclusion');
   await p.go(page); await settled();
   ok(await p.eval(() => !location.hash.includes('lead=') && document.querySelector('[data-lead]').dataset.lead === 'de'
     && document.querySelector('[data-compare="save-lead"]').disabled), 'saved lead survives a fresh page without a lead bookmark');
   await p.click('[data-compare="lead"][data-value="all"]');
   await p.click('[data-compare="save-lead"]'); await settled();
   await p.go(page); await settled();
   ok((await api()).data.config.leadLanguage === 'all'
     && await p.eval(() => document.querySelector('[data-lead]').dataset.lead === 'all'), 'combined lead is saved and restored');
   await p.click('[data-compare="edit"]');
   await p.click('[data-compare="reopen"]');
  await p.click('dialog[open] [value="yes"]'); await settled();
   ok((await api()).data.config.concludedAt === null, 'explicit confirmed reopen unlocks periods');
   await p.click('[data-compare="edit"]');
   await field('compare:0:label', 'Unsaved while saving lead');
   const beforeLead = (await api()).data.config;
   await p.click('[data-compare="lead"][data-value="de"]');
   await p.click('[data-compare="save-lead"]'); await settled();
   ok((await api()).data.config.periods[0].label === beforeLead.periods[0].label
     && await p.eval(() => document.querySelector('[data-key="compare:0:label"]').value === 'Unsaved while saving lead'
       && !document.querySelector('[data-compare-draft-note]').hidden), 'saving the lead preserves a separate unsaved period draft');
   await p.click('[data-compare="save"]'); await settled();
   ok((await api()).data.config.periods[0].label === 'Unsaved while saving lead'
     && (await api()).data.config.leadLanguage === 'de', 'period draft saves with the updated revision and keeps the saved lead');
   const beforeConflict = (await api()).data.config;
   await api({ ...beforeConflict, leadLanguage:'en' });
   await p.click('[data-compare="lead"][data-value="all"]');
   await p.click('[data-compare="save-lead"]');
   ok(await p.waitFor(() => document.querySelector('[data-compare-error]').textContent.includes('another browser'))
     && (await api()).data.config.leadLanguage === 'en', 'stale lead save cannot overwrite another browser’s choice');
   await p.go(page); await settled();
  const savedPerson = (await api()).data.config;
  let otherConfig = (await api(null, { person: other })).data.config;
  if (otherConfig.concludedAt) otherConfig = (await api({ ...otherConfig, concludedAt: null }, { person: other })).data;
  otherConfig = (await api({ ...otherConfig, periods: [{ label: 'Other person plan', start: addDays(today, 1), end: addDays(today, 3) }], selectedLanguages: ['ja'] }, { person: other })).data;
  ok(JSON.stringify((await api()).data.config) === JSON.stringify(savedPerson), 'saving another person’s plan preserves this person’s periods, languages, revision and conclusion');
  ok(JSON.stringify((await api(null, {})).data.config) === JSON.stringify(shared), 'person experiments leave the previous shared comparison untouched');
  const foreignDevice = catalog.devices.find(d => d.personId === other).id;
  ok((await api(null, { person, device: foreignDevice })).status === 422, 'API rejects a device belonging to a different person');
  await p.go(`${page}&device=${encodeURIComponent(foreignDevice)}`); await settled();
  ok(await p.eval(() => document.querySelector('#f-device').value === '' && !location.hash.includes('device=')), 'incompatible bookmarked person/device selection is repaired before loading the experiment');
  if (!LIVE) {
    await p.click('[data-compare="edit"]');
    await field('compare:0:label', 'Save stays with owner');
    await control({ saveDelay: 800 });
    await p.click('[data-compare="save"]');
    await p.select('#f-person', other); await open(other);
    ok(await p.eval(() => document.querySelector('.compare').textContent.includes('Other person plan')
      && !document.querySelector('.compare').textContent.includes('Save stays with owner')), 'switching people during a save shows only the new person’s experiment');
    await p.waitFor(async (person, id) => (await fetch('/api/modules/languages/experiments/' + encodeURIComponent(id) + '?person=' + person).then(r => r.json())).config.periods[0]?.label === 'Save stays with owner', person, ids[person]);
    await control({ saveDelay: 0 });
    ok(JSON.stringify((await api(null, { person: other })).data.config) === JSON.stringify(otherConfig), 'an in-flight save cannot overwrite the newly selected person');
    await p.select('#f-person', person); await open(person);
    ok(await p.eval(() => document.querySelector('.compare').textContent.includes('Save stays with owner')), 'completed save is visible on returning to its owner');
  }
  if (!LIVE) {
    await control({ comparison: fixture('equal') });
    await p.go(`${page}&lead=de`); await settled();
    await p.click('[data-compare="lead"][data-value="en"]');
    ok(await p.eval(() => document.querySelector('[data-lead]').dataset.lead === 'en'
      && location.hash.includes('lead=en') && document.activeElement?.dataset.key === 'compare:lead:en'
      && document.querySelector('.cx-language-row[data-lang="en"] .cx-swatch').classList.contains('cx-color-0')), 'lead switch updates the subject, accent, hash and focus together');
    await p.click('[data-compare="lead"][data-value="all"]');
    ok(await p.eval(() => document.querySelector('[data-lead]').dataset.lead === 'all'
      && [...document.querySelectorAll('.cx-contribution-bar > span')].map(el => el.className).join() === 'cx-color-1,cx-color-2'
      && document.querySelector('.cx-stack i').classList.contains('cx-color-0')), 'combined lead uses an accent combined stack and valid individual contribution colors');
    await p.click('[data-compare="reverse"]');
    ok(await p.eval(() => location.hash.includes('dir=rev')
      && document.querySelector('[data-story]').dataset.story === 'decrease'
      && document.activeElement?.dataset.key === 'compare:reverse'), 'reverse reads the directional decrease and retains focus');
    for (const kind of ['equal', 'unequal', 'upcoming', 'running', 'concluded', 'one-language', 'three-languages', 'no-share', 'decrease', 'same', 'zero', 'trace', 'long', 'long-labels']) {
      await control({ comparison: fixture(kind) });
      await p.go(`${page}&lead=de`); await settled();
      for (const scheme of ['light', 'dark']) {
        await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        for (const width of [1320, 859, 390]) {
          await p.size(width, 1000);
          const facts = await p.eval(() => ({
            fits: document.documentElement.scrollWidth <= innerWidth,
            copy: !/[–—]/.test(document.querySelector('.compare').textContent),
            share: [...document.querySelectorAll('[data-share-figure]')].every(e => !/points|%/.test(e.textContent)),
            charts: [...document.querySelectorAll('.compare [role="img"]')].every(e => e.getAttribute('aria-label')?.length > 12),
            waffles: [...document.querySelectorAll('.cx-waffle')].every(e => e.children.length === 100),
            xss: window.__cmpXss === undefined && !document.querySelector('.compare img'),
          }));
          ok(Object.values(facts).every(Boolean), `${kind}, ${scheme}, ${width}px: fits, clear units, accessible charts, 100 squares, escaped labels ${JSON.stringify(facts)}`);
          if (width !== 859 || kind === 'equal') {
            const metrics = await p.send('Page.getLayoutMetrics');
            const { data } = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: metrics.cssContentSize.height, scale: 1 } });
            fs.writeFileSync(path.join(OUT, `comparison-${kind}-${scheme}-${width}.png`), Buffer.from(data, 'base64'));
          }
        }
      }
    }
    await control({ comparison: null });
    await p.go(page); await settled();
    await p.click('[data-compare="edit"]');
    for (const scheme of ['light', 'dark']) {
      await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      for (const width of [1320, 390]) {
        await p.size(width, 1000);
        ok(await p.eval(() => document.documentElement.scrollWidth <= innerWidth), `planner fits ${scheme} ${width}px`);
        await p.shot(`comparison-planner-${scheme}-${width}`);
      }
    }
    await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    ok(await p.eval(() => getComputedStyle(document.querySelector('.cx-waffle i')).borderTopWidth === '1px'), 'forced colors retain chart cell boundaries');
  await p.send('Emulation.setEmulatedMedia', { features: [] });
  }
  const { calendarChecks } = await import('./calendar-check.mjs');
  await calendarChecks({ p, ok, LIVE, page, api, control, OUT });
}

if (process.argv.includes('--pure')) { pureChecks(); console.log('Comparison pure checks passed.'); }

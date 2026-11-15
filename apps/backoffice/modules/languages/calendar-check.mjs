import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clipRange, pickDecision, patterns, draftStats, homeWindow } from './calendar-model.js';
import { addDays, periodDays } from './comparison-model.js';

export function calendarPureChecks() {
  const periods = [{ label: 'A', start: '2026-11-10', end: '2026-11-12' }, { label: 'B', start: '', end: '' }];
  const base = { periods, active: 1, min: '2026-11-01', max: '2026-12-01', preset: 10, pattern: 'off-on-off', anchor: null, fill: false };
  const pick = (day, extra = {}) => pickDecision({ ...base, ...extra }, day);
  assert.deepEqual(clipRange('2026-11-08', '2026-11-15', periods, 1, base.min, base.max), { start: '2026-11-08', end: '2026-11-09', clipped: true });
  assert.deepEqual(clipRange('2026-11-15', '2026-11-08', periods, 1, base.min, base.max), { start: '2026-11-13', end: '2026-11-15', clipped: true });
  assert.equal(pick('2026-10-31').kind, 'none');
  assert.equal(pick('2026-11-11').kind, 'select');
  assert.equal(pick('2026-11-11', { active: 0 }).kind, 'place');
  assert.equal(pick('2026-11-03', { active: -1 }).kind, 'place');
  assert.equal(pick('2026-11-03', { preset: 0 }).kind, 'anchor');
  assert.deepEqual(pick('2026-11-01', { anchor: '2026-11-03' }).ranges[0], { start: '2026-11-01', end: '2026-11-03', clipped: false });
  assert.deepEqual(clipRange('2026-11-03', '2026-10-28', [], 0, base.min, base.max), { start: '2026-11-01', end: '2026-11-03', clipped: true });
  assert.equal(pick('2026-11-29').ranges[0].end, base.max);
  for (const pattern of patterns) {
    const result = pick('2026-11-01', { fill: true, pattern: pattern.key, preset: 0 });
    assert.deepEqual(result.ranges.map(p => p.label), pattern.labels);
    assert.equal(result.ranges[0].end, '2026-11-10');
    assert.equal(result.ranges[1].start, '2026-11-11');
    assert.equal(pick('2026-11-29', { fill: true, pattern: pattern.key }).clipped, true);
  }
  const range = { start: '2026-11-01', end: '2026-11-04' };
  const cache = new Map([
    ['2026-11-01', { allSeconds: 120, languages: [{ lang: 'de', seconds: 60 }, { lang: 'en', seconds: 60 }] }],
    ['2026-11-02', { allSeconds: 0, languages: [] }],
    ['2026-11-03', { allSeconds: 30, languages: [{ lang: 'de', seconds: 30 }] }],
  ]);
  const stats = draftStats(range, cache, '2026-11-03', ['de']);
  assert.equal(stats.calendarDays, 3);
  assert.equal(stats.plannedDays, 4);
  assert.equal(stats.minutesPerDay, .5);
  assert.equal(stats.allSeconds, 150);
  assert.equal(stats.share, .6);
  assert.equal(draftStats(range, new Map(), '2026-11-03').pending, true);
  assert.equal(homeWindow('2026-11-15'), '2026-10-26');
}

export async function calendarChecks({ p, ok, LIVE, page, api, control, OUT }) {
  calendarPureChecks(); ok(true, 'calendar decisions clip both directions, templates, bounds, zero days and partial-day denominators');
  let saved = (await api()).data;
  if (saved.config.concludedAt) await api({ ...saved.config, concludedAt: null });
  saved = (await api()).data;
  const today = saved.today, date = n => addDays(today, n);
  await api({ ...saved.config, selectedLanguages: ['de', 'en'], periods: [] });
  if (!LIVE) {
    const first = date(-20);
    const days = periodDays({ start: first, end: today }).map((d, i) => ({
      date: d, allSeconds: i === 2 ? 0 : 600 + i * 60, reviewSeconds: 0,
      languages: i === 2 ? [] : [{ lang: 'de', seconds: 120 + i * 30 }, { lang: 'en', seconds: 480 + i * 30 }],
    }));
    await control({ comparisonDays: { days, firstRecordedDate: first, today, timezone: 'Europe/Zurich', asOf: Date.now() } });
  }
  await p.go(page);
  await p.waitFor(() => document.querySelectorAll('.cp-day').length === 42 && !document.querySelector('.cp-data-note').textContent.includes('Loading'));
  ok(await p.eval(() => document.querySelectorAll('.cp-weekdays span').length === 8 && !document.querySelector('[data-picker-dates]').open), 'six whole weeks are the main picker; typed dates are a collapsed fallback');
  const keyboardStart = date(1);
  await p.click('[data-compare="cal-length"][data-value="0"]');
  await p.eval(date => document.querySelector(`[data-date="${date}"]`).focus(), keyboardStart);
  await p.key('Enter', 13);
  await p.key('ArrowRight', 39); await p.key('ArrowRight', 39);
  ok(await p.eval(() => document.querySelectorAll('.cp-lane.is-preview').length === 3), 'keyboard preview spans the anchor to the focused day');
  await p.key('Enter', 13);
  ok(await p.eval((a, b) => document.querySelector('[data-key="compare:0:start"]').value === a
    && document.querySelector('[data-key="compare:0:end"]').value === b, date(1), date(3)), 'keyboard-only two-click placement matches its preview');
  await p.click('[data-compare="add"]');
  await p.click('[data-compare="cal-length"][data-value="10"]');
  await p.eval(date => document.querySelector(`[data-date="${date}"]`).focus(), today);
  ok(await p.eval(() => document.querySelectorAll('.cp-lane.is-preview').length === 1), 'preview clips before another period');
  await p.key('Enter', 13);
  ok(await p.eval(today => document.querySelector('[data-key="compare:1:start"]').value === today
    && document.querySelector('[data-key="compare:1:end"]').value === today, today), 'placement uses the same clipped range');
  await p.click('[data-compare="cal-fill"]');
  await p.click(`[data-date="${date(-7)}"]`);
  ok(await p.eval(() => !!document.querySelector('dialog[open]')), 'template replacement asks before discarding placed draft periods');
  await p.click('dialog[open] [value="yes"]');
  ok(await p.eval(() => [...document.querySelectorAll('.cp-card-top input')].map(i => i.value).join('|') === 'Off, before|On|Off, after'), 'generic template labels keep first and last groups distinct');
  await p.click('[data-key="compare:picker-save"]');
  await p.waitFor(() => document.querySelector('#cx-editor').hidden && !document.querySelector('[data-compare="reload"]').disabled);
  saved = (await api()).data;
  const daily = await p.eval(async (from, to) => {
    const person = new URLSearchParams(location.hash.slice(1)).get('person');
    return fetch('/api/modules/languages/comparison/days?' + new URLSearchParams({ from, to, person })).then(r => r.json());
  }, saved.periods[0].start, today);
  if (LIVE) {
    const days = new Map(daily.days.map(d => [d.date, d]));
    for (const d of periodDays(saved.periods[0], today)) if (!days.has(d)) days.set(d, null);
    const stats = draftStats(saved.periods[0], days, today, saved.config.selectedLanguages);
    ok(Math.abs(stats.allSeconds - saved.periods[0].allSeconds) < 1e-7 && Math.abs(stats.minutesPerDay - saved.periods[0].minutesPerDay) < 1e-7, 'daily draft statistics reconcile with real saved period totals');
  }
  await p.click('[data-compare="edit"]');
  if (!LIVE) {
    const screenshot = async name => {
      for (const theme of ['light', 'dark']) {
        await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        for (const width of [1320, 390]) {
          await p.size(width, 1000);
          const bounds = await p.eval(() => {
            const r = document.querySelector('#cx-editor').getBoundingClientRect();
            return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height };
          });
          const { data } = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...bounds, scale: 1 } });
          fs.writeFileSync(path.join(OUT, `picker-${name}-${theme}-${width}.png`), Buffer.from(data, 'base64'));
          ok(await p.eval(() => document.documentElement.scrollWidth <= innerWidth
            && [...document.querySelectorAll('.cp-day')].every(b => b.getBoundingClientRect().height === 50 && b.getBoundingClientRect().width >= 44)), `picker ${name}, ${theme}, ${width}px fits with accessible day targets`);
        }
      }
    };
    await screenshot('default');
    await p.click('[data-compare="add"]');
    await screenshot('unplaced');
    await p.click('[data-compare="cal-length"][data-value="0"]');
    await p.click(`[data-date="${date(-10)}"]`);
    await p.eval(date => document.querySelector(`[data-date="${date}"]`).focus(), date(-8));
    ok(await p.eval(() => document.querySelectorAll('.cp-lane.is-preview').length === 3), 'focused range preview survives pointer position and asynchronous rendering');
    await screenshot('anchor');
    await p.eval(date => document.querySelector(`[data-date="${date}"]`).focus(), date(-6));
    ok(await p.eval(() => document.querySelector('[data-picker-readout]').textContent.includes('Stops at another period')), 'clipped preview explains the boundary');
    await screenshot('clipped');
    await p.key('Escape', 27);
    await p.click('[data-compare="cal-fill"]');
    await p.eval(date => document.querySelector(`[data-date="${date}"]`).focus(), date(-12));
    await screenshot('template');
    await p.key('Escape', 27);
    await p.click('[data-compare="cal-bars"][data-value="lead"]');
    await screenshot('lead');
    ok(await p.eval(() => location.hash.includes('bars=lead') && [...document.querySelectorAll('.cp-bars i')].every(i => i.classList.contains('cx-color-0'))), 'lead-only bars share one baseline and are bookmarkable');
    await p.send('Emulation.setEmulatedMedia', { features: [] });
    await control({ comparisonDays: null });
    const current = (await api()).data.config;
    await api({ ...current, periods: [] });
    await p.go(page);
    await p.waitFor(() => !document.querySelector('.cp-data-note')?.textContent.includes('Loading'));
    await p.size(390, 1000, true);
    const tap = async day => {
      const point = await p.eval(day => {
        const el = document.querySelector(`[data-date="${day}"]`);
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, day);
      await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await p.waitFor(() => !!document.querySelector('.cp-lane.is-preview') || !!document.querySelector('.cp-card'));
    };
    await tap(date(1));
    ok(await p.eval(() => !document.querySelector('.cp-card') && document.querySelector('[data-picker-readout]').textContent.includes('Tap the same day')), 'first touch previews without changing the draft');
    await tap(date(1));
    ok(await p.waitFor(() => document.querySelectorAll('.cp-card').length === 1), 'second touch on the same day confirms placement');
    await p.click('[data-compare="cal-length"][data-value="0"]');
    await tap(date(2));
    await tap(date(4));
    ok(await p.eval(start => document.querySelector('[data-key="compare:0:start"]').value === start, date(1)), 'free touch keeps the old period while endpoint preview is pending');
    await tap(date(4));
    ok(await p.waitFor((start, end) => document.querySelector('[data-key="compare:0:start"]').value === start
      && document.querySelector('[data-key="compare:0:end"]').value === end, date(2), date(4)), 'free touch uses start, end, confirm end');
    await p.size(1320, 1000);
    await control({ fail: 'days500' });
    await p.click('[data-compare="reload"]');
    ok(await p.waitFor(() => document.querySelector('.cp-calendar .problem')?.textContent.includes('Daily viewing is unavailable')), 'daily fetch failure is explicit and retryable');
    ok(await p.eval(() => !document.querySelector('.cp-bars i') && document.querySelector('.cp-rate').textContent.includes('No data yet')), 'failed daily reads never leave stale scope bars or invented totals');
    await control({ fail: null, daysDelay: 800 });
    await p.click('[data-compare="cal-retry"]');
    await p.click('[data-compare="cal-length"][data-value="7"]');
    await p.click(`[data-date="${date(6)}"]`);
    ok(await p.eval(day => document.querySelector('[data-key="compare:0:start"]').value === day, date(6)), 'calendar stays interactive while daily viewing loads');
    await p.waitFor(() => !document.querySelector('.cp-data-note').textContent.includes('Loading'));
    await control({ daysDelay: 0 });
  }
}

if (process.argv.includes('--pure')) { calendarPureChecks(); console.log('Calendar pure checks passed.'); }

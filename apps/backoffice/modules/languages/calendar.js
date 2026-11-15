import { addDays, length, periodDays, rangeText, dayText, rateText, minutesText, moveStory, movePhrase, languageValue } from './comparison-model.js';
import { patterns, monday, homeWindow, placed, ownerOf, pickDecision, draftStats } from './calendar-model.js';
import { swatch } from './comparison-view.js';

export function createCalendar({ state, scope, api, render, dirty, confirm, announce, expired, esc: e, langName, context }) {
  const init = () => {
    const s = state();
    return s.picker ||= { win: homeWindow(s.data.today), active: 0, anchor: null, hover: null, preset: 10,
      pattern: patterns[0].key, fill: false, touch: null, details: false, daily: new Map(), scope: '', request: 0, loaded: false, pending: false, error: '', first: null };
  };
  const maxDate = () => addDays(state().data.today, 366);
  const minDate = () => {
    const p = init();
    return p.loaded ? p.first || state().data.today : '2000-01-01';
  };
  const locked = () => state().busy || state().loading || !!state().data.config.concludedAt;
  const btn = (action, text, attrs = '') => `<button type="button" class="btn" data-compare="cal-${action}" data-key="compare:cal-${action}:${e(attrs.match(/data-value="([^"]*)"/)?.[1] || '')}" ${attrs}>${text}</button>`;
  const dateName = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const decision = day => pickDecision({ ...init(), periods: state().draft.periods, min: minDate(), max: maxDate() }, day);
  function palette() {
    const s = state(), c = context(), selected = s.draft.selectedLanguages;
    if (new URLSearchParams(location.hash.slice(1)).get('lead') === 'all') {
      return { codes: ['all'], lead: 'all', name: selected.length ? selected.map(langName).join(' and ') : 'All viewing' };
    }
    const available = [...new Set([...s.data.availableLanguages, ...[...init().daily.values()].flatMap(d => d?.languages.map(l => l.lang) || [])])].sort();
    const codes = selected.length ? [...selected] : available;
    const lead = c.lead !== 'all' && codes.includes(c.lead) ? c.lead : codes[0] || 'all';
    codes.sort((a, b) => (a === lead ? -1 : b === lead ? 1 : a.localeCompare(b)));
    return { codes, lead, name: lead === 'all' ? 'All viewing' : langName(lead) };
  }
  const color = i => Math.min(i, 4);
  function parts(row, codes) {
    const selected = state().draft.selectedLanguages;
    const values = codes.map(code => code === 'all'
      ? row?.languages.reduce((sum, l) => sum + (!selected.length || selected.includes(l.lang) ? l.seconds : 0), 0) || 0
      : row?.languages.find(l => l.lang === code)?.seconds || 0);
    return [...values, Math.max(0, (row?.allSeconds || 0) - values.reduce((a, b) => a + b, 0))];
  }
  function ordered() {
    return state().draft.periods.map((p, index) => ({ ...p, index })).sort((a, b) =>
      (placed(a) ? a.start : '9999').localeCompare(placed(b) ? b.start : '9999') || a.index - b.index);
  }
  function groupLook(period) {
    return [...new Set(ordered().map(p => p.label.trim()))].indexOf(period.label.trim()) % 3;
  }
  function scale(c) {
    const p = init(), leadOnly = new URLSearchParams(location.hash.slice(1)).get('bars') === 'lead';
    let largest = 0;
    for (const [date, row] of p.daily) {
      if (date < addDays(p.win, -21) || date > addDays(p.win, 62)) continue;
      largest = Math.max(largest, leadOnly ? parts(row, c.codes)[0] : row?.allSeconds || 0);
    }
    const unit = leadOnly ? 1800 : 3600;
    return { max: Math.max(unit, Math.ceil(largest / unit) * unit), leadOnly };
  }
  function dayMarkup(date, c, scaleInfo, preview) {
    const s = state(), p = init(), row = p.daily.get(date), today = s.data.today;
    const number = Number(date.slice(-2)), month = Number(date.slice(5, 7)), future = date > today;
    const untracked = p.loaded && (p.first ? date < p.first : date < today);
    const unavailable = date < minDate() || date > maxDate();
    const own = ownerOf(s.draft.periods, date), period = s.draft.periods[own];
    const order = ordered().findIndex(x => x.index === own) + 1;
    const seg = preview?.ranges.find(r => date >= r.start && date <= r.end);
    const label = number === 1 || date === p.win ? `${number} ${new Date(`${date}T12:00Z`).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' })}` : number;
    const values = parts(row, c.codes);
    const bars = values.map((v, i) => v > 0 && (!scaleInfo.leadOnly || c.codes[i] === c.lead)
      ? `<i class="cx-color-${i === c.codes.length ? 4 : color(i)}" style="height:${Math.max(1, v / scaleInfo.max * 22)}px"></i>` : '').join('');
    let lane = '', laneClass = '', opacity = 1;
    if (seg) {
      laneClass = 'is-preview';
      if (date === seg.start || date === monday(date)) lane = `<span>${dayText(length(seg))}</span>`;
    } else if (period) {
      laneClass = `cp-look-${groupLook(period)} is-member${date === period.start ? ' is-start' : ''}${date === period.end ? ' is-end' : ''}`;
      opacity = own === p.active && p.anchor ? .35 : future ? .6 : 1;
      if (date === period.start || date === monday(date)) lane = `<span>${order}<span class="cp-tag-label"> · ${e(period.label)}</span></span>`;
    }
    const status = untracked ? 'before the first recording' : future ? 'not recorded yet' : !p.daily.has(date) ? 'viewing data loading'
      : row?.allSeconds ? `${minutesText(row.allSeconds / 60)} watched, ${row.languages.map(l => `${langName(l.lang)} ${rateText(l.seconds / 60)} minutes`).join(', ')}` : 'nothing watched';
    return {
      disabled: unavailable, aria: `${dateName(date)}, ${status}${date === today ? ', today, still running' : ''}${period ? `, in period ${order}, ${period.label}` : ''}`,
      html: `<span class="cp-plot${month % 2 ? ' is-alternate' : ''}${untracked ? ' is-untracked' : ''}${date === today ? ' is-today' : ''}${seg ? ' is-preview' : ''}${date === p.anchor ? ' is-anchor' : ''}">
        <span class="cp-number">${e(label)}</span>${date === today ? '<b class="cp-today">today</b>' : ''}
        <span class="cp-bars" aria-hidden="true" style="opacity:${date === today ? .55 : 1}">${bars}</span></span>
        <span class="cp-lane ${laneClass}" aria-hidden="true" style="opacity:${opacity}">${lane}</span>`,
    };
  }
  function readout(c, preview) {
    const s = state(), p = init(), pattern = patterns.find(t => t.key === p.pattern);
    let primary = 'Hover a day to see what was watched.';
    let secondary = p.fill ? `${pattern.text}, ${p.preset || 10} days each. Click the first day of the experiment.`
      : p.anchor ? 'Now click the last day.' : p.preset ? `Click a day to place ${p.preset} days from it.` : 'Click the first day, then the last day.';
    if (preview?.ranges.length) {
      const range = { start: preview.ranges[0].start, end: preview.ranges.at(-1).end };
      const stats = draftStats(range, p.daily, s.data.today, s.draft.selectedLanguages);
      primary = preview.kind === 'template' ? `${pattern.text} · ${preview.ranges.length} periods · ${rangeText(range)}`
        : `${rangeText(range)} · ${dayText(length(range))}${stats?.pending ? ' · loading viewing' : stats?.calendarDays
          ? ` · ${c.name} ${rateText(languageValue(stats, c.lead).rate)} min a day · ${minutesText(stats.allSeconds / 60 / stats.calendarDays)} watched a day` : ' · nothing recorded yet'}`;
      secondary = preview.clipped ? 'Stops at another period or the recording or date limit. Click to place it.'
        : preview.kind === 'template' ? 'Click to replace the periods with this plan.'
          : stats?.calendarDays && stats.calendarDays < stats.plannedDays ? `${stats.calendarDays} of ${stats.plannedDays} days recorded so far. Click to place it.`
            : p.anchor ? 'Click to set the last day.' : 'Click to place it.';
    } else if (p.hover) {
      const date = p.hover, row = p.daily.get(date), own = ownerOf(s.draft.periods, date);
      primary = `${dateName(date)} · ${date < minDate() ? p.first ? `before the first recording on ${rangeText({ start: p.first, end: p.first })}` : 'no recordings in this scope'
        : date > s.data.today ? 'not recorded yet' : !p.daily.has(date) ? 'loading viewing'
          : row?.allSeconds ? `${minutesText(row.allSeconds / 60)} watched · ${parts(row, c.codes).map((v, i) => `${i === c.codes.length ? 'Other' : c.codes[i] === 'all' ? c.name : langName(c.codes[i])} ${rateText(v / 60)} min${i === 0 ? ` (${Math.round(v / row.allSeconds * 100)}%)` : ''}`).join(' · ')}` : 'nothing watched'}${date === s.data.today ? ' · today, still running' : ''}`;
      if (own >= 0 && own !== p.active) secondary = `In period ${ordered().findIndex(x => x.index === own) + 1} · ${s.draft.periods[own].label}. Click to paint that period instead.`;
    }
    if (locked()) secondary = s.data.config.concludedAt ? 'Reopen the experiment to edit periods.' : 'Updating the saved comparison.';
    if (p.touch) secondary = 'Tap the same day again to confirm.';
    if (p.notice && !p.hover) secondary = p.notice;
    return `<div><b>${e(primary)}</b><small title="${e(secondary)}">${e(secondary)}</small></div>${p.anchor || p.fill || p.touch ? btn('cancel', 'Cancel') : ''}`;
  }
  function updatePreview() {
    const root = document.querySelector('[data-picker-grid]');
    if (!root) return;
    const p = init(), c = palette(), sc = scale(c), preview = p.hover && !locked() ? decision(p.hover) : null;
    root.querySelectorAll('[data-date]').forEach(node => {
      const cell = dayMarkup(node.dataset.date, c, sc, preview);
      node.innerHTML = cell.html;
      node.setAttribute('aria-label', cell.aria);
      node.setAttribute('aria-disabled', String(cell.disabled || locked()));
    });
    document.querySelector('[data-picker-readout]').innerHTML = readout(c, preview);
  }
  async function fetchDays({ reset = false } = {}) {
    const s = state();
    if (!s.data || !s.draft || !scope().person) return;
    const p = init(), selected = scope(), key = JSON.stringify(selected);
    if (reset || p.scope !== key) {
      p.request++; p.daily.clear(); p.loaded = false; p.error = ''; p.pending = false; p.scope = key;
      p.anchor = null; p.hover = null; p.touch = null;
    }
    if (p.pending) { p.again = true; return; }
    const wanted = new Set(periodDays({ start: addDays(p.win, -21) < '2000-01-01' ? '2000-01-01' : addDays(p.win, -21), end: addDays(p.win, 62) }));
    for (const period of s.draft.periods) {
      try { if (placed(period) && length(period) <= 3660) periodDays(period, s.data.today).forEach(d => wanted.add(d)); } catch { /* Invalid typed dates stay editable. */ }
    }
    const missing = [...wanted].filter(d => !p.daily.has(d)).sort();
    if (!missing.length) return;
    const request = ++p.request;
    p.pending = true; p.error = ''; render();
    try {
      for (let i = 0; i < missing.length;) {
        const from = missing[i];
        let to = from;
        while (++i < missing.length && length({ start: from, end: missing[i] }) <= 120) to = missing[i];
        const data = await api().comparisonDays({ ...selected, from, to });
        if (request !== p.request || p.scope !== key) return;
        p.first = data.firstRecordedDate; p.loaded = true;
        for (const date of periodDays({ start: from, end: to })) p.daily.set(date, null);
        for (const day of data.days) p.daily.set(day.date, day);
      }
    } catch (error) {
      if (request !== p.request) return;
      if (error.status === 401) { expired(); return; }
      p.error = error.message;
    } finally {
      if (request === p.request) {
        p.pending = false;
        if (s === state() && key === JSON.stringify(scope())) {
          render();
          if (p.again && !p.error) { p.again = false; fetchDays(); }
        }
      }
    }
  }
  function rail(c) {
    const s = state(), p = init(), rows = ordered();
    let previous = null;
    return `<h3>Periods <small>${rows.filter(placed).length} placed of ${rows.length}</small></h3>${rows.map((period, n) => {
      const stats = draftStats(period, p.daily, s.data.today, s.draft.selectedLanguages);
      const value = stats && !stats.pending ? languageValue(stats, c.lead) : null;
      const story = moveStory(previous?.rate, value?.rate), move = n > 0 && placed(period) && placed(rows[n - 1])
        ? `<div class="cp-move"><b>${story.state === 'incomplete' ? '?' : e(story.figure)}</b> <span>${story.state === 'incomplete' ? 'not measured yet'
          : `${e(movePhrase(story, c.name, period.label))} · ${rateText(previous.rate)} to ${rateText(value.rate)} min a day`}</span></div>` : '';
      previous = value;
      const status = !stats ? '' : stats.status === 'upcoming' ? 'planned' : stats.status === 'complete' ? 'complete' : `day ${stats.calendarDays} of ${stats.plannedDays}`;
      return `${move}<article class="cp-card${p.active === period.index ? ' is-active' : ''}" data-picker-period="${period.index}">
        <div class="cp-card-top cp-badge-${groupLook(period)}">${btn('active', `<span>${n + 1}</span>`, `data-value="${period.index}" aria-label="Paint period ${n + 1} on the calendar" aria-pressed="${p.active === period.index}" ${locked() ? 'disabled' : ''}`)}
        <input class="input" aria-label="Group name of period ${n + 1}" maxlength="80" value="${e(period.label)}" data-compare-field="label" data-period="${period.index}" data-key="compare:rail:${period.index}:label" ${locked() ? 'readonly' : ''}>
        <button type="button" class="btn" data-compare="remove" data-period="${period.index}" data-key="compare:remove:${period.index}" aria-label="Remove period ${n + 1}" ${locked() ? 'disabled' : ''}>×</button></div>
        <div class="cp-dates">${placed(period) ? `${e(rangeText(period))} · ${dayText(length(period))} · ${status}` : 'Not placed yet. Click a day on the calendar.'}</div>
        <div class="cp-rate">${stats?.pending ? '<span>Loading viewing…</span>' : value?.rate != null ? `<span><b>${rateText(value.rate)}</b> ${e(c.name)} min a day</span><span>${value.share == null ? 'No share' : `${Math.round(value.share * 100)} of 100`} · ${minutesText(stats.allSeconds / 60 / stats.calendarDays)} a day</span>` : '<span>No data yet</span>'}</div>
        <div class="cp-share" aria-hidden="true">${stats && !stats.pending ? parts(stats, c.codes).map((v, i) => `<i class="cx-color-${i === c.codes.length ? 4 : color(i)}" style="flex:${v}"></i>`).join('') : ''}</div></article>`;
    }).join('')}`;
  }
  function html(invalid = false) {
    const s = state(), p = init(), c = palette(), sc = scale(c), preview = p.hover && !locked() ? decision(p.hover) : null;
    const disabled = locked() ? 'disabled' : '';
    const legend = `<div class="cp-legend">${c.codes.map((code, i) => `<span>${swatch(color(i))}${e(code === 'all' ? c.name : langName(code))}</span>`).join('')}<span>${swatch(4)}Other</span></div>`;
    const earliest = p.loaded && p.first ? addDays(p.first, -21) : '2000-01-01';
    return `<div class="cp-header"><h2>Pick the periods</h2>${legend}<div class="cx-actions">
      <button class="btn" data-compare="discard" data-key="compare:picker-discard" ${s.busy ? 'disabled' : ''}>Discard changes</button>
      <button class="btn btn--primary" data-compare="save" data-key="compare:picker-save" ${invalid || !s.dirty || s.busy || s.loading || s.conflict ? 'disabled' : ''}>Save periods</button></div></div>
      <div class="cp-template"><div><span class="cx-eyebrow">Template</span><div class="cx-segmented" role="group" aria-label="Experiment pattern">${patterns.map(t => btn('pattern', e(t.text), `data-value="${t.key}" aria-pressed="${t.key === p.pattern}" ${disabled}`)).join('')}</div></div>
      <div><span class="cx-eyebrow">Length</span><div class="cx-segmented" role="group" aria-label="Period length">${[0, 7, 10, 14].map(n => btn('length', n ? `${n} days` : 'Free', `data-value="${n}" aria-pressed="${p.preset === n}" ${disabled}`)).join('')}</div></div>
      ${btn('fill', p.fill ? 'Now click the first day' : 'Prefill from a day I click', `aria-pressed="${p.fill}" ${disabled}`)}</div>
      <div class="cp-columns"><section class="cp-calendar" aria-label="Calendar picker">
      <div class="cp-toolbar"><div>${btn('nav', '‹', `data-value="-21" aria-label="Three weeks earlier" ${addDays(p.win, 20) < earliest || p.win <= '2000-01-03' ? 'disabled' : ''}`)}
      ${btn('today', 'Today')}${btn('nav', '›', `data-value="21" aria-label="Three weeks later" ${addDays(p.win, 21) > maxDate() ? 'disabled' : ''}`)}
      <b>${e(rangeText({ start: p.win, end: addDays(p.win, 41) }))}</b></div>
      <div class="cx-segmented" role="group" aria-label="What the bars show">${btn('bars', 'All viewing', `data-value="all" aria-pressed="${!sc.leadOnly}"`)}${btn('bars', `${e(c.name)} only`, `data-value="lead" aria-pressed="${sc.leadOnly}"`)}</div></div>
      ${legend}<div class="cp-week cp-weekdays" aria-hidden="true"><span></span>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<span>${d}</span>`).join('')}</div>
      <div data-picker-grid aria-label="Six weeks of viewing">${Array.from({ length: 6 }, (_, week) => {
        const start = addDays(p.win, week * 7), month = new Date(`${start}T12:00Z`).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
        return `<div class="cp-week"><span class="cp-month" aria-hidden="true">${week === 0 || start.slice(5, 7) !== addDays(start, -7).slice(5, 7) ? month : ''}</span>${Array.from({ length: 7 }, (_, n) => {
          const date = addDays(start, n), cell = dayMarkup(date, c, sc, preview);
          return `<button type="button" class="cp-day" data-compare="cal-day" data-date="${date}" data-key="compare:day:${date}" aria-label="${e(cell.aria)}" aria-disabled="${cell.disabled || locked()}">${cell.html}</button>`;
        }).join('')}</div>`;
      }).join('')}</div><div class="cp-readout" data-picker-readout>${readout(c, preview)}</div>
      <p class="cp-data-note">${p.pending ? 'Loading daily viewing…' : 'Daily viewing is a draft preview. Saved results update after saving.'}</p>
      ${p.error ? `<p class="problem" role="alert">${e(p.error)} ${btn('retry', 'Retry daily viewing')}</p>` : ''}</section>
      <aside class="cp-rail" aria-label="Draft periods">${rail(c)}<div class="cx-actions">
      <button type="button" class="btn" data-compare="add" data-key="compare:add" ${locked() || s.draft.periods.length >= 128 ? 'disabled' : ''}>+ Add period</button>
      <button type="button" class="btn" data-compare="add-language" data-key="compare:picker-language" ${s.busy ? 'disabled' : ''}>+ Add language</button></div></aside></div>`;
  }
  function cancel() { const p = init(); p.anchor = null; p.fill = false; p.touch = null; p.hover = null; }
  function changed() { dirty(); fetchDays(); }
  async function click(el, event) {
    const s = state(), p = init(), action = el.dataset.compare.slice(4), value = el.dataset.value;
    if (action === 'retry') return fetchDays();
    if (action === 'cancel') { cancel(); render(); return; }
    if (action === 'bars') {
      const hash = new URLSearchParams(location.hash.slice(1));
      if (value === 'lead') hash.set('bars', value); else hash.delete('bars');
      history.pushState(null, '', `${location.pathname}${location.search}#${hash}`); render(); return;
    }
    if (action === 'nav' || action === 'today') {
      cancel(); p.win = action === 'today' ? homeWindow(s.data.today) : addDays(p.win, Number(value));
      render(); fetchDays(); return;
    }
    if (locked()) return;
    if (action === 'pattern' || action === 'length') {
      p.anchor = null; p.touch = null; p.hover = null;
      if (action === 'pattern') p.pattern = value; else p.preset = Number(value);
      render(); return;
    }
    if (action === 'fill') { const fill = !p.fill; cancel(); p.fill = fill; render(); return; }
    if (action === 'active') {
      cancel(); p.active = Number(value);
      const period = s.draft.periods[p.active];
      if (placed(period) && (period.start < p.win || period.start > addDays(p.win, 41))) {
        p.win = monday(period.start);
        if (p.win < '2000-01-01') p.win = '2000-01-03';
      }
      render(); fetchDays(); return;
    }
    if (action !== 'day') return;
    const day = el.dataset.date, next = decision(day);
    if (next.kind === 'none') return;
    const touch = event?.pointerType === 'touch' || (event?.detail > 0 && p.pointerTouch);
    if (touch && ['place', 'template'].includes(next.kind) && p.touch !== day) {
      p.touch = day; p.hover = day; updatePreview(); return;
    }
    p.touch = null;
    if (next.kind === 'select') { cancel(); p.active = next.active; render(); return; }
    if (next.kind === 'template') {
      if (s.draft.periods.some(placed) && !await confirm(`Replace the ${s.draft.periods.length} periods in this draft?`, 'Replace periods', el.dataset.key)) return;
      if (s !== state() || locked()) return;
      s.draft.periods = next.ranges.map(({ label, start, end }) => ({ label, start, end }));
      cancel(); p.active = 0;
      if (next.ranges.at(-1).end > addDays(p.win, 41)) p.win = monday(day);
      p.notice = next.clipped ? 'Template clipped at the date limit.' : '';
      changed(); announce(`Template placed: ${rangeText({ start: day, end: next.ranges.at(-1).end })}${next.clipped ? '. Clipped at the date limit.' : '.'}`); return;
    }
    if (!s.draft.periods[p.active]) {
      if (s.draft.periods.length >= 128) return;
      p.active = s.draft.periods.length;
      s.draft.periods.push({ label: `Period ${p.active + 1}`, start: '', end: '' });
    }
    if (next.kind === 'anchor') { p.anchor = day; p.hover = day; dirty(); return; }
    const range = next.ranges[0], period = s.draft.periods[p.active];
    Object.assign(period, { start: range.start, end: range.end });
    const n = ordered().findIndex(x => x.index === p.active) + 1;
    cancel(); p.notice = next.clipped ? 'Placement stopped at another period or the recording or date limit.' : '';
    const unplaced = s.draft.periods.findIndex(x => !placed(x));
    if (unplaced >= 0) p.active = unplaced;
    changed(); announce(`Period ${n} placed: ${rangeText(range)}, ${dayText(length(range))}.${next.clipped ? ' Clipped at the boundary.' : ''}`);
  }
  function hover(el) {
    if (!el?.dataset.date || !state().data) return;
    const p = init();
    if (p.hover === el.dataset.date) return;
    p.hover = el.dataset.date; p.notice = ''; updatePreview();
  }
  function keydown(event) {
    if (event.key === 'Escape' && event.target.closest?.('#cx-editor')) {
      event.preventDefault(); cancel(); updatePreview(); return;
    }
    const el = event.target.closest?.('[data-date]');
    if (!el) return;
    init().keyboard = true;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); return; }
    if (event.key === 'Escape') { event.preventDefault(); cancel(); updatePreview(); return; }
    const date = el.dataset.date;
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, PageUp: -21, PageDown: 21,
      Home: -((new Date(`${date}T12:00Z`).getUTCDay() + 6) % 7), End: 6 - ((new Date(`${date}T12:00Z`).getUTCDay() + 6) % 7) }[event.key];
    if (offset == null) return;
    event.preventDefault();
    const next = addDays(date, offset), p = init();
    if (next < '2000-01-03' || next > maxDate()) return;
    if (event.key.startsWith('Page')) { cancel(); p.win = addDays(p.win, offset); }
    else if (next < p.win) p.win = addDays(p.win, -21);
    else if (next > addDays(p.win, 41)) p.win = addDays(p.win, 21);
    p.hover = next; render(); fetchDays();
    document.querySelector(`[data-date="${next}"]`)?.focus({ preventScroll: true });
  }
  document.addEventListener('pointermove', event => {
    const el = event.target.closest?.('[data-date]');
    if (el && event.pointerType !== 'touch') { init().keyboard = false; hover(el); }
  });
  document.addEventListener('pointerdown', event => {
    if (event.target.closest?.('[data-date]')) init().pointerTouch = event.pointerType === 'touch';
  });
  document.addEventListener('focusin', event => {
    const el = event.target.closest?.('[data-date]');
    if (el) { init().keyboard = true; hover(el); }
  });
  document.addEventListener('keydown', keydown);
  document.addEventListener('pointerout', event => {
    if (event.target.closest?.('[data-picker-grid]') && !event.relatedTarget?.closest?.('[data-picker-grid]')) {
      const p = init();
      if (!p.touch) { p.hover = p.keyboard ? document.activeElement?.dataset.date || null : null; updatePreview(); }
    }
  });
  document.addEventListener('toggle', event => {
    if (event.target.matches?.('[data-picker-dates]')) init().details = event.target.open;
  }, true);
  return { html, fetchDays, init, cancel, click, updatePreview };
}

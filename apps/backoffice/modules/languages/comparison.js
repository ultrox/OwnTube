import { addDays, length, dayText, rangeText, periodDays, planPeriods, normalizeConfig } from './comparison-model.js';
import { comparisonView, mark, swatch } from './comparison-view.js';
export * from './comparison-model.js';

export function createComparison({ api, scope, render, expired, esc, spent, langName, pickLanguage, announce = () => {}, demo = false }) {
  const s = { data: null, draft: null, dirty: false, busy: false, loading: false, failed: false, error: '', request: 0, editing: null, planner: null, conflict: false };
  const view = comparisonView({ esc, spent, langName });
  const e = esc;
  const DRAFT = 'The results still show the saved comparison until you save.';
  const focus = key => document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  const button = (action, text, attrs = '') => `<button type="button" class="btn" data-compare="${action}" data-key="compare:${action}${attrs.match(/data-value="([^"]*)"/)?.[1] ? `:${attrs.match(/data-value="([^"]*)"/)[1]}` : ''}" ${attrs}>${text}</button>`;
  const dirty = () => { s.dirty = JSON.stringify(s.draft) !== JSON.stringify(s.data.config); s.error = ''; render(); };
  function validation() {
    try { normalizeConfig(s.draft, s.data.today, s.data.config); return ''; } catch (error) { return error.message; }
  }
  async function load({ replace = false } = {}) {
    const request = ++s.request;
    s.loading = true; s.error = ''; render();
    try {
      const data = await api().comparison(scope());
      if (request !== s.request) return;
      s.data = data; s.failed = false;
      if (!s.draft || replace || !s.dirty) { s.draft = structuredClone(data.config); s.dirty = false; s.conflict = false; }
      if (s.editing == null) s.editing = !s.draft.periods.length;
      s.planner ||= { start: addDays(data.today, 1), days: 10, count: 3 };
    } catch (error) {
      if (request !== s.request) return;
      if (error.status === 401) { expired(); return; }
      s.error = error.message; s.failed = true;
    } finally {
      if (request === s.request) { s.loading = false; render(); }
    }
  }
  async function save(message = 'Comparison saved.') {
    if (s.busy || s.loading || !s.draft) return;
    const invalid = validation();
    if (invalid) { s.error = invalid; render(); announce(invalid); return; }
    s.busy = true; s.error = ''; render();
    try {
      s.draft = await api().saveComparison(structuredClone(s.draft));
      s.dirty = false; s.conflict = false;
      s.editing = !s.draft.periods.length;
      await load();
      announce(message);
    } catch (error) {
      if (error.status === 401) { expired(); return; }
      s.error = error.message; s.conflict = error.status === 409; announce(error.message);
    } finally { s.busy = false; render(); focus(s.editing ? 'compare:save' : 'compare:edit'); }
  }
  function confirm(text, label, opener) {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'dialog language-picker';
      dialog.setAttribute('aria-labelledby', 'cx-confirm-title');
      dialog.innerHTML = `<h2 id="cx-confirm-title">${e(text)}</h2><form method="dialog" class="cx-actions"><button class="btn" value="cancel" autofocus>Cancel</button><button class="btn btn--primary" value="yes">${e(label)}</button></form>`;
      document.body.append(dialog);
      dialog.addEventListener('close', () => {
        const yes = dialog.returnValue === 'yes';
        dialog.remove(); focus(opener); resolve(yes);
      }, { once: true });
      dialog.showModal();
    });
  }
  function pills() {
    const codes = s.draft.selectedLanguages;
    const c = view.context(s.data);
    return codes.length ? codes.map(code => `<button type="button" class="btn cx-pill" data-compare="remove-language" data-lang="${e(code)}" data-key="compare:language:${e(code)}" aria-label="Remove ${e(langName(code))} from the comparison" ${s.busy ? 'disabled' : ''}>${swatch(c.codes.indexOf(code) < 0 ? 4 : c.codes.indexOf(code))}${e(langName(code))}<span aria-hidden="true">×</span></button>`).join('') : '<span>All languages</span>';
  }
  function setup(c) {
    return `<div class="cx-setup">
      ${c.repeated ? `<div class="cx-segmented" role="group" aria-label="Comparison mode">${['pooled', 'sequence'].map(mode => button('mode', mode === 'pooled' ? 'Pooled groups' : 'In sequence', `data-value="${mode}" aria-pressed="${c.mode === mode}"`)).join('')}</div>` :
        c.items.length <= 2 ? c.items.map((p, i) => `<span class="cx-setup-period">${mark(i)}<b>${e(p.label)}</b><small>${e(view.dateLabel(p, s.data))} · ${dayText(p.plannedDays)}</small></span>`).join('') : '<b>Periods in sequence</b>'}
      <div class="cx-pills">${pills()}${button('add-language', '+ Language')}</div>
      ${s.data.config.concludedAt ? `<span class="cx-stamp">Concluded ${e(rangeText({ start: s.data.config.concludedAt, end: s.data.config.concludedAt }))}</span>` : ''}
      ${button('edit', s.editing ? 'Done editing' : 'Edit names and dates', `aria-expanded="${!!s.editing}" aria-controls="cx-editor"`)}
      ${button('reload', 'Refresh', s.loading || s.busy ? 'disabled' : '')}
      ${demo ? '<small>Demo · resets on reload</small>' : ''}</div>`;
  }
  function draftBanner() {
    return `<div class="cx-draft cmp-draft" data-compare-draft-note ${s.dirty ? '' : 'hidden'}><div><b class="cx-stamp">Unsaved changes</b><p>${DRAFT}</p></div><div class="cx-actions">${button('discard', 'Discard', s.busy ? 'disabled' : '')}${button('save', s.busy ? 'Saving…' : s.editing ? 'Save periods' : 'Save and compare', s.busy || s.loading || !!validation() || s.conflict ? 'disabled' : '')}</div></div>`;
  }
  function calendar() {
    let periods;
    try { periods = normalizeConfig({ ...s.draft, concludedAt: null }, s.data.today).periods; } catch { return ''; }
    if (!periods.length) return '';
    const counts = periods.map(length), total = counts.reduce((n, v) => n + v, 0);
    return `<section class="cx-calendar"><h3>The plan on a calendar</h3><div class="cx-calendar-blocks">${periods.map((p, i) => `<div><b>${mark(i)}${i + 1} · ${e(p.label)}</b><p class="cx-note">${e(rangeText(p))}</p>
      <div role="img" aria-label="${e(`${p.label}: ${rangeText(p)}, ${dayText(counts[i])}`)}" class="cx-plan-days cx-plan-days--${i % 3}">${counts[i] <= 31 ? periodDays(p).map(d => `<i>${Number(d.slice(-2))}</i>`).join('') : `<b class="cx-plan-bar" style="width:${counts[i] / Math.max(...counts) * 100}%">${dayText(counts[i])}</b>`}</div></div>`).join('<span aria-hidden="true">→</span>')}</div>
      <p>${periods.slice(1).map((p, i) => `<b>${e(rangeText({ start: p.start, end: p.start }))}</b> · move ${i + 1}: ${e(p.label)} starts`).join('<br>')}</p><p class="cx-note">${dayText(total)} in total${counts.every(n => n === counts[0]) ? `, ${periods.length} equal periods` : ''}</p></section>`;
  }
  function conclude() {
    const periods = s.data.periods, last = periods.at(-1), first = periods[0], concluded = s.data.config.concludedAt;
    if (!first) return '';
    const complete = periods.every(p => p.status === 'complete');
    return `<div class="cx-conclude"><div><b>Experiment runs ${e(rangeText({ start: first.start, end: last.end }))}</b><p class="cx-note">${concluded ? 'Periods are locked. Numbers stay live as language classifications are reviewed.' : 'Until every period is complete, results are marked as an early read. Concluding locks the periods.'}</p>${s.dirty ? '<p class="cx-note">Save or discard your changes first.</p>' : ''}</div>
      ${button(concluded ? 'reopen' : 'conclude', concluded ? 'Reopen experiment' : complete ? 'Conclude experiment' : `Conclude experiment · available ${e(rangeText({ start: addDays(last.end, 1), end: addDays(last.end, 1) }))}`, s.dirty || s.busy || (!concluded && !complete) ? 'disabled' : '')}</div>`;
  }
  function editor() {
    const locked = !!s.data.config.concludedAt, disabled = locked || s.busy ? 'disabled' : '';
    const max = addDays(s.data.today, 366);
    return `<div id="cx-editor" class="cx-editor" ${s.editing ? '' : 'hidden'}>
      <fieldset class="cx-planner" ${disabled}><legend>Plan an experiment</legend><div class="cx-planner-fields">
      <label>First day<input class="input" type="date" min="2000-01-01" max="${max}" value="${e(s.planner.start)}" data-plan-field="start" data-key="compare:plan:start"></label>
      <label>Days per period<input class="input" type="number" min="1" max="1830" value="${s.planner.days}" data-plan-field="days" data-key="compare:plan:days"></label>
      <div><span class="label">Pattern</span><div class="cx-segmented" role="group" aria-label="Experiment pattern">${[2, 3].map(n => button('pattern', n === 2 ? 'Off, on' : 'Off, on, off', `data-value="${n}" aria-pressed="${s.planner.count === n}"`)).join('')}</div></div>
      ${button('fill', 'Fill periods')}</div><p class="cx-note">Fills the periods below back to back. Each one stays editable.</p></fieldset>
      <div data-plan-calendar>${calendar()}</div><div class="cx-period-list"><div class="cx-period-head"><span>No.</span><span>Group</span><span>From</span><span>To (inclusive)</span><span>Length</span><span></span></div>
      ${s.draft.periods.map((p, i) => `<fieldset class="cx-period-row" ${s.busy ? 'disabled' : ''}><legend class="vh">Period ${i + 1}</legend><span class="cx-period-index">${i + 1}</span>
        <label>${mark(i)}<span class="cx-mobile-label">Group</span><input class="input" maxlength="80" value="${e(p.label)}" data-compare-field="label" data-period="${i}" data-key="compare:${i}:label" aria-label="Group name of period ${i + 1}" ${locked ? 'readonly' : ''}></label>
        ${['start', 'end'].map(field => `<label><span class="cx-mobile-label">${field === 'start' ? 'From' : 'To (inclusive)'}</span><input class="input" type="date" min="2000-01-01" max="${max}" value="${e(p[field])}" data-compare-field="${field}" data-period="${i}" data-key="compare:${i}:${field}" aria-label="${field === 'start' ? 'First' : 'Last'} day of period ${i + 1}" ${locked ? 'readonly' : ''}></label>`).join('')}
        <span data-period-length="${i}">${safeLength(p)}</span><button class="btn" type="button" data-compare="remove" data-period="${i}" data-key="compare:remove:${i}" aria-label="Remove period ${i + 1}" ${disabled}>×</button></fieldset>`).join('')}</div>
      <div class="cx-actions">${button('add', '+ Add period', locked || s.draft.periods.length >= 128 || s.busy ? 'disabled' : '')}${button('add-language', '+ Add language', s.busy ? 'disabled' : '')}<div class="cx-pills">${pills()}</div><span>Languages apply to every period.</span></div>
      <p class="cx-note">Periods that share a group name are pooled in the grouped view. A date can belong to one period only. Both dates are included · ${e(s.data.timezone)}.</p>
      ${conclude()}</div>`;
  }
  function safeLength(p) { try { return dayText(length(p)); } catch { return 'Choose dates'; } }
  function html() {
    if (!s.draft) return `<section class="compare"><h2>Compare periods</h2>${s.error ? `<p role="alert">${e(s.error)}</p>${button('reload', 'Try again')}` : '<p>Loading saved periods…</p>'}</section>`;
    const c = view.context(s.data);
    return `<section class="compare cx"><h2 class="vh">Compare periods</h2>${setup(c)}${draftBanner()}
      <p class="problem" data-compare-error role="alert" ${s.error || (s.dirty && validation()) ? '' : 'hidden'}>${e(s.error || (s.dirty && validation()) || '')}</p>
      ${s.conflict ? button('discard', 'Reload saved periods') : ''}${editor()}
      ${s.loading ? '<p role="status">Updating comparison…</p>' : ''}<div data-compare-results aria-busy="${s.loading}" class="${s.loading ? 'is-updating' : ''}">${s.failed ? '' : view.results(s.data, c)}</div></section>`;
  }
  function hash(key, value) {
    const h = new URLSearchParams(location.hash.slice(1));
    if (value == null) h.delete(key); else h.set(key, value);
    if (key === 'mode') { h.delete('move'); h.delete('dir'); }
    history.pushState(null, '', `${location.pathname}${location.search}#${h}`);
    render();
  }
  async function click(el) {
    if (s.busy || s.loading) return;
    const action = el.dataset.compare, key = el.dataset.key || `compare:${action}`;
    if (['mode', 'move', 'lead'].includes(action)) return hash(action, el.dataset.value);
    if (action === 'reverse') return hash('dir', new URLSearchParams(location.hash.slice(1)).get('dir') === 'rev' ? null : 'rev');
    if (action === 'reload') return load();
    if (action === 'discard') { await load({ replace: true }); announce('Draft discarded. Saved comparison loaded.'); focus('compare:edit'); return; }
    if (action === 'save') return save();
    if (action === 'edit') { s.editing = !s.editing; render(); return; }
    if (action === 'pattern') { s.planner.count = Number(el.dataset.value); render(); return; }
    if (action === 'fill') {
      try {
        const periods = planPeriods(s.planner.start, Number(s.planner.days), s.planner.count);
        normalizeConfig({ ...s.draft, periods }, s.data.today);
        if (s.draft.periods.length && !await confirm(`Replace the ${s.draft.periods.length} periods in this draft?`, 'Replace periods', key)) return;
        s.draft.periods = periods; dirty(); focus('compare:0:label');
      } catch (error) { s.error = error.message; render(); announce(error.message); }
      return;
    }
    if (action === 'conclude' || action === 'reopen') {
      if (s.dirty) return;
      if (action === 'reopen' && !await confirm('Reopen this experiment to edit its periods?', 'Reopen experiment', key)) return;
      s.draft.concludedAt = action === 'conclude' ? s.data.today : null;
      s.dirty = true;
      return save(action === 'conclude' ? 'Experiment concluded. Periods are locked; numbers stay live.' : 'Experiment reopened.');
    }
    if (action === 'add-language') {
      const draft = s.draft;
      return pickLanguage({
        heading: 'Add a comparison language', title: 'Languages apply to every period.',
        availableCodes: [...new Set([...s.data.availableLanguages, ...draft.selectedLanguages])],
        note: 'Recorded languages in these periods and scope, plus your saved selection. Future-only plans use the last 30 days. Save and compare to apply your choice.',
        returnFocus: el, save: (_id, lang) => {
          if (draft !== s.draft || s.busy) return;
          draft.selectedLanguages = [...new Set([...draft.selectedLanguages, lang])]; dirty(); focus(key);
        },
      });
    }
    if (action === 'remove-language') { s.draft.selectedLanguages = s.draft.selectedLanguages.filter(l => l !== el.dataset.lang); dirty(); focus('compare:add-language'); return; }
    if (s.data.config.concludedAt) return;
    if (action === 'add') { s.draft.periods.push({ label: '', start: '', end: '' }); s.editing = true; dirty(); focus(`compare:${s.draft.periods.length - 1}:label`); }
    if (action === 'remove') { s.draft.periods.splice(Number(el.dataset.period), 1); dirty(); focus('compare:add'); }
  }
  function input(el) {
    if (s.busy || !s.draft) return;
    if (el.dataset.planField) { s.planner[el.dataset.planField] = el.value; return; }
    if (s.data.config.concludedAt) return;
    const p = s.draft.periods[Number(el.dataset.period)];
    if (!p) return;
    p[el.dataset.compareField] = el.value;
    // Preserve the native date editor and text selection while updating derived UI.
    s.dirty = JSON.stringify(s.draft) !== JSON.stringify(s.data.config); s.error = '';
    document.querySelector('[data-compare-draft-note]').hidden = !s.dirty;
    const error = validation(), node = document.querySelector('[data-compare-error]');
    node.textContent = error; node.hidden = !error;
    document.querySelectorAll('[data-compare="save"]').forEach(b => { b.disabled = !!error || s.conflict; });
    document.querySelectorAll('[data-compare="conclude"],[data-compare="reopen"]').forEach(b => { b.disabled = true; });
    el.setAttribute('aria-invalid', String(!!error));
    document.querySelector(`[data-period-length="${el.dataset.period}"]`).textContent = safeLength(p);
    document.querySelector('[data-plan-calendar]').innerHTML = calendar();
  }
  return { html, load, click, input, reset() { ++s.request; Object.assign(s, { data: null, draft: null, dirty: false, busy: false, loading: false, failed: false, error: '', editing: null, planner: null, conflict: false }); } };
}

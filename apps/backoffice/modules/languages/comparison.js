import { addDays, length, dayText, rangeText, normalizeConfig } from './comparison-model.js';
import { comparisonView, mark, swatch } from './comparison-view.js';
import { createCalendar } from './calendar.js';
import { clipRange, placed } from './calendar-model.js';
import { spokenLanguageCodes } from './language-picker.js';
export * from './comparison-model.js';

export function createComparison({ api, scope, personName, experimentId = () => '', render, expired, esc, spent, langName, pickLanguage, announce = () => {}, demo = false }) {
  const fresh = () => ({ data: null, draft: null, dirty: false, busy: false, loading: false, failed: false, error: '', request: 0, editing: null, conflict: false, leadPending: null, leadStatus: '' });
  const people = new Map();
  let person = '', identity = '', s = fresh();
  people.set(person, s);
  const view = comparisonView({ esc, spent, langName });
  const e = esc;
  const DRAFT = 'The results still show the saved comparison until you save.';
  const focus = key => document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  const button = (action, text, attrs = '') => `<button type="button" class="btn" data-compare="${action}" data-key="compare:${action}${attrs.match(/data-value="([^"]*)"/)?.[1] ? `:${attrs.match(/data-value="([^"]*)"/)[1]}` : ''}" ${attrs}>${text}</button>`;
  const dirty = () => { s.dirty = JSON.stringify(s.draft) !== JSON.stringify(s.data.config); s.error = ''; render(); };
  const picker = createCalendar({ state: () => s, scope, api, render, dirty, confirm, announce, expired, esc, langName, context: () => view.context(s.data) });
  function validation() {
    if (s.picker?.loaded) {
      const first = s.picker.first || s.data.today;
      if (s.draft.periods.some(p => p.start && p.start < first && !s.data.config.periods.some(old => old.start === p.start && old.end === p.end))) {
        return `Choose new periods on or after ${rangeText({ start: first, end: first })}, the first selectable day in this scope.`;
      }
    }
    try { normalizeConfig(s.draft, s.data.today, s.data.config); return ''; } catch (error) { return error.message; }
  }
  async function load({ replace = false } = {}) {
    const selected = scope();
    const nextIdentity = `${selected.person}:${experimentId()}`;
    if (identity !== nextIdentity) {
      ++s.request;
      person = selected.person;
      identity = nextIdentity;
      if (!people.has(identity)) people.set(identity, fresh());
      s = people.get(identity);
    }
    if (s.busy) { render(); return; }
    if (s.picker && s.picker.scope !== JSON.stringify(selected)) {
      ++s.picker.request; s.picker.daily.clear(); s.picker.loaded = false; s.picker.pending = false;
      s.picker.anchor = null; s.picker.hover = null; s.picker.touch = null;
    }
    const target = s, request = ++s.request;
    s.loading = true; s.error = ''; render();
    try {
      const data = await api().comparison(selected);
      if (target !== s || request !== s.request) return;
      s.data = data; s.failed = false;
      if (replace) { s.leadPending = null; s.leadStatus = ''; }
      if (!s.draft || replace || !s.dirty) { s.draft = structuredClone(data.config); s.dirty = false; s.conflict = false; }
      if (s.editing == null) s.editing = !s.draft.periods.length;
    } catch (error) {
      if (target !== s || request !== s.request) return;
      if (error.status === 401) { expired(); return; }
      s.error = error.message; s.failed = true;
    } finally {
      if (target === s && request === s.request) { s.loading = false; render(); if (!s.failed) picker.fetchDays({ reset: true }); }
    }
  }
  async function save(message = 'Comparison saved.') {
    if (s.busy || s.loading || !s.draft || !person) return;
    const invalid = validation();
    if (invalid) { s.error = invalid; render(); announce(invalid); return; }
    const target = s, owner = person;
    s.busy = true; s.error = ''; render();
    try {
      target.draft = await api().saveComparison(structuredClone(target.draft), { person: owner });
      target.dirty = false; target.conflict = false;
      target.editing = !target.draft.periods.length;
      target.busy = false;
      if (target !== s) return;
      await load();
      announce(message);
    } catch (error) {
      if (error.status === 401) { expired(); return; }
      target.error = error.message; target.conflict = error.status === 409;
      if (target === s) announce(error.message);
    } finally {
      target.busy = false;
      if (target === s) { render(); focus(s.editing ? 'compare:save' : 'compare:edit'); }
    }
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
  async function saveLead(lead) {
    if (!experimentId() || s.conflict || s.busy || s.loading) return;
    const target = s, owner = person;
    target.leadPending = lead; target.leadStatus = 'saving';
    target.busy = true; target.error = ''; render();
    try {
      const saved = await api().saveComparison({ ...target.data.config, leadLanguage: lead || null }, { person: owner });
      target.data.config = saved;
      target.draft.baseRevision = saved.baseRevision;
      if (saved.leadLanguage) target.draft.leadLanguage = saved.leadLanguage;
      else delete target.draft.leadLanguage;
      target.dirty = JSON.stringify(target.draft) !== JSON.stringify(saved);
      target.leadPending = null; target.leadStatus = 'saved';
      target.busy = false;
      if (target !== s) return;
      const h = new URLSearchParams(location.hash.slice(1));
      h.delete('lead');
      history.replaceState(null, '', `${location.pathname}${location.search}#${h}`);
      await load();
      announce('Lead saved for this experiment.');
    } catch (error) {
      if (error.status === 401) { expired(); return; }
      target.error = error.message; target.conflict = error.status === 409;
      target.leadStatus = 'error';
      if (target === s) announce(error.message);
    } finally {
      target.busy = false;
      if (target === s) { render(); focus('compare:lead-language'); }
    }
  }
  function pills() {
    const codes = s.draft.selectedLanguages;
    const c = view.context(s.data);
    return codes.length ? codes.map(code => `<button type="button" class="btn cx-pill" data-compare="remove-language" data-lang="${e(code)}" data-key="compare:language:${e(code)}" aria-label="Remove ${e(langName(code))} from the comparison" ${s.busy ? 'disabled' : ''}>${swatch(c.codes.indexOf(code) < 0 ? 4 : c.codes.indexOf(code))}${e(langName(code))}<span aria-hidden="true">×</span></button>`).join('') : '<span>All languages</span>';
  }
  function setup(c) {
    const lead = s.leadPending ?? s.data.config.leadLanguage ?? '';
    const codes = [...new Set(s.data.config.selectedLanguages.length ? s.data.config.selectedLanguages
      : [...spokenLanguageCodes, ...s.data.availableLanguages, ...(lead && lead !== 'all' ? [lead] : [])])]
      .sort((a, b) => langName(a).localeCompare(langName(b)));
    return `<section class="cx-settings" aria-labelledby="cx-settings-title"><h3 class="cx-eyebrow" id="cx-settings-title">Experiment settings</h3>
      <div class="cx-settings-fields"><div class="cx-lead-setting"><label class="label" for="cx-lead-language">Lead language</label>
        <select class="select" id="cx-lead-language" data-compare-field="leadLanguage" data-key="compare:lead-language" aria-describedby="cx-lead-status" ${s.busy || s.loading || s.conflict ? 'disabled' : ''}>
          <option value="" ${!lead ? 'selected' : ''}>Automatic</option>
          ${codes.map(code => `<option value="${e(code)}" ${lead === code ? 'selected' : ''}>${e(langName(code))}</option>`).join('')}
          <option value="all" ${lead === 'all' ? 'selected' : ''}>${s.data.config.selectedLanguages.length ? 'Combined selected languages' : 'All languages combined'}</option>
        </select><small class="cx-note" id="cx-lead-status" role="status">${s.leadStatus === 'saving' ? 'Saving…' : s.leadStatus === 'saved' ? 'Saved' : s.leadStatus === 'error' ? 'Not saved' : 'Changes save automatically'}</small>
        ${s.leadStatus === 'error' && !s.conflict ? button('retry-lead', 'Try again') : ''}
      </div><div class="cx-language-setting"><span class="label">Compared languages</span><div class="cx-pills">${pills()}${button('add-language', '+ Language')}</div></div></div>
      <div class="cx-setup">
      ${c.repeated ? `<div class="cx-segmented" role="group" aria-label="Comparison mode">${['pooled', 'sequence'].map(mode => button('mode', mode === 'pooled' ? 'Pooled groups' : 'In sequence', `data-value="${mode}" aria-pressed="${c.mode === mode}"`)).join('')}</div>` :
        c.items.length <= 2 ? c.items.map((p, i) => `<span class="cx-setup-period">${mark(i)}<b>${e(p.label)}</b><small>${e(view.dateLabel(p, s.data))} · ${dayText(p.plannedDays)}</small></span>`).join('') : '<b>Periods in sequence</b>'}
      ${s.data.config.concludedAt ? `<span class="cx-stamp">Concluded ${e(rangeText({ start: s.data.config.concludedAt, end: s.data.config.concludedAt }))}</span>` : ''}
      ${button('edit', s.editing ? 'Done editing' : 'Edit names and dates', `aria-expanded="${!!s.editing}" aria-controls="cx-editor"`)}
      ${button('reload', 'Refresh', s.loading || s.busy ? 'disabled' : '')}
      ${demo ? '<small>Demo · resets on reload</small>' : ''}</div></section>`;
  }
  function draftBanner() {
    return `<div class="cx-draft cmp-draft" data-compare-draft-note ${s.dirty ? '' : 'hidden'}><div><b class="cx-stamp">Unsaved changes</b><p>${DRAFT}</p></div><div class="cx-actions">${button('discard', 'Discard', s.busy ? 'disabled' : '')}${button('save', s.busy ? 'Saving…' : s.editing ? 'Save periods' : 'Save and compare', s.busy || s.loading || !!validation() || s.conflict ? 'disabled' : '')}</div></div>`;
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
    return `<div id="cx-editor" class="cx-editor cp" ${s.editing ? '' : 'hidden'}>
      ${picker.html(!!validation())}
      <details data-picker-dates ${picker.init().details ? 'open' : ''}><summary>Type dates instead</summary>
      <div class="cx-period-list"><div class="cx-period-head"><span>No.</span><span>Group</span><span>From</span><span>To (inclusive)</span><span>Length</span><span></span></div>
      ${s.draft.periods.map((p, i) => `<fieldset class="cx-period-row" ${s.busy ? 'disabled' : ''}><legend class="vh">Period ${i + 1}</legend><span class="cx-period-index">${i + 1}</span>
        <label>${mark(i)}<span class="cx-mobile-label">Group</span><input class="input" maxlength="80" value="${e(p.label)}" data-compare-field="label" data-period="${i}" data-key="compare:${i}:label" aria-label="Group name of period ${i + 1}" ${locked ? 'readonly' : ''}></label>
        ${['start', 'end'].map(field => `<label><span class="cx-mobile-label">${field === 'start' ? 'From' : 'To (inclusive)'}</span><input class="input" type="date" min="2000-01-01" max="${max}" value="${e(p[field])}" data-compare-field="${field}" data-period="${i}" data-key="compare:${i}:${field}" aria-label="${field === 'start' ? 'First' : 'Last'} day of period ${i + 1}" ${locked ? 'readonly' : ''}></label>`).join('')}
        <span data-period-length="${i}">${safeLength(p)}</span><button class="btn" type="button" data-compare="remove" data-period="${i}" data-key="compare:typed-remove:${i}" aria-label="Remove period ${i + 1}" ${disabled}>×</button></fieldset>`).join('')}</div></details>
      <p class="cx-note">Periods that share a group name are pooled in the grouped view. A date can belong to one period only. Both dates are included · ${e(s.data.timezone)}.</p>
      ${conclude()}</div>`;
  }
  function safeLength(p) { try { return dayText(length(p)); } catch { return 'Choose dates'; } }
  function html() {
    if (identity !== `${scope().person}:${experimentId()}`) return '<section class="compare"><p>Loading experiment…</p></section>';
    if (!s.draft) return `<section class="compare"><h2>Compare periods</h2>${s.error ? `<p role="alert">${e(s.error)}</p>${button('reload', 'Try again')}` : '<p>Loading saved periods…</p>'}</section>`;
    const c = view.context(s.data);
    if (!person) return `<section class="compare cx"><h2>Choose a person for the experiment</h2><p>Each person has their own periods, languages and conclusion. Choose a person above to plan or open their experiment.</p>
      ${s.data.periods.length ? `<h3>Previous shared comparison</h3><p class="cx-note">Kept for reference. This comparison has not been assigned to a person.</p>${view.results(s.data, c)}` : ''}</section>`;
    return `<section class="compare cx"><h2 data-experiment-person>${e(s.data.experiment?.name || `Experiment for ${personName()}`)}</h2><p class="cx-note">For ${e(personName())}. The device filter only changes the results.</p>${setup(c)}${draftBanner()}
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
  async function click(el, event) {
    if (s.busy || s.loading) return;
    const action = el.dataset.compare, key = el.dataset.key || `compare:${action}`;
    if (['mode', 'move'].includes(action)) return hash(action, el.dataset.value);
    if (action === 'reverse') return hash('dir', new URLSearchParams(location.hash.slice(1)).get('dir') === 'rev' ? null : 'rev');
    if (action === 'reload') return load();
    if (!person) return;
    if (action === 'retry-lead') return saveLead(s.leadPending);
    if (action.startsWith('cal-')) return picker.click(el, event);
    if (action === 'discard') { await load({ replace: true }); announce('Draft discarded. Saved comparison loaded.'); focus('compare:edit'); return; }
    if (action === 'save') return save();
    if (action === 'edit') { s.editing = !s.editing; render(); return; }
    if (action === 'conclude' || action === 'reopen') {
      if (s.dirty) return;
      const target = s;
      if (action === 'reopen' && !await confirm('Reopen this experiment to edit its periods?', 'Reopen experiment', key)) return;
      if (target !== s) return;
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
    if (action === 'add') { picker.cancel(); picker.init().active = s.draft.periods.length; s.draft.periods.push({ label: `Period ${s.draft.periods.length + 1}`, start: '', end: '' }); s.editing = true; dirty(); focus(`compare:rail:${s.draft.periods.length - 1}:label`); }
    if (action === 'remove') {
      const index = Number(el.dataset.period), p = picker.init();
      s.draft.periods.splice(index, 1); picker.cancel();
      p.active = p.active > index ? p.active - 1 : Math.min(p.active, s.draft.periods.length - 1);
      dirty(); focus('compare:add');
    }
  }
  function input(el, commit = false) {
    if (s.busy || s.loading || !s.draft || !person) return;
    if (el.dataset.compareField === 'leadLanguage') {
      if (commit) return saveLead(el.value);
      return;
    }
    if (s.data.config.concludedAt) return;
    const p = s.draft.periods[Number(el.dataset.period)];
    if (!p) return;
    p[el.dataset.compareField] = el.value;
    if (commit && el.dataset.compareField !== 'label' && placed(p)) {
      const calendar = picker.init();
      const min = calendar.loaded ? calendar.first || s.data.today : '2000-01-01';
      const range = clipRange(p.start, p.end, s.draft.periods, Number(el.dataset.period), min, addDays(s.data.today, 366));
      if (range) {
        Object.assign(p, { start: range.start, end: range.end });
        if (range.clipped) announce('Typed period clipped at another period or the date limit.');
      }
    }
    if (commit) { dirty(); picker.fetchDays(); return; }
    // Keep the active native editor intact until its change event commits.
    s.dirty = JSON.stringify(s.draft) !== JSON.stringify(s.data.config); s.error = '';
    const error = validation(), node = document.querySelector('[data-compare-error]');
    node.textContent = error; node.hidden = !error;
    document.querySelector('[data-compare-draft-note]').hidden = !s.dirty;
    document.querySelectorAll('[data-compare="save"]').forEach(b => { b.disabled = !s.dirty || !!error || s.conflict; });
    document.querySelectorAll('[data-compare="conclude"],[data-compare="reopen"]').forEach(b => { b.disabled = true; });
    el.setAttribute('aria-invalid', String(!!error));
    document.querySelector(`[data-period-length="${el.dataset.period}"]`).textContent = safeLength(p);
    document.querySelectorAll(`[data-compare-field="${el.dataset.compareField}"][data-period="${el.dataset.period}"]`).forEach(other => {
      if (other !== el) other.value = el.value;
    });
    picker.updatePreview();
  }
  return { html, load, click, input,
    deactivate() { ++s.request; identity = ''; person = ''; s = fresh(); },
    hasDraft(owner, id) { return !!people.get(`${owner}:${id}`)?.dirty; },
    forget(owner, id) { people.delete(`${owner}:${id}`); if (identity === `${owner}:${id}`) { ++s.request; identity = ''; s = fresh(); } },
    reset() { ++s.request; people.clear(); person = ''; identity = ''; s = fresh(); people.set(person, s); } };
}

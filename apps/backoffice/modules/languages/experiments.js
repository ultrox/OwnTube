import { createComparison } from './comparison.js';
import { rangeText } from './comparison-model.js';

const statusText = { planned: 'Planned', running: 'Running', ready: 'Ready to conclude', concluded: 'Concluded' };

export function createExperiments(options) {
  const { api, scope, render, esc: e, personName, expired, announce } = options;
  const lists = new Map();
  let person = '', selected = '', request = 0;
  const fresh = () => ({ items: null, loading: false, error: '' });
  let list = fresh();
  const detail = createComparison({ ...options, experimentId: () => selected, api: () => {
    const source = api(), id = selected;
    return { ...source,
      comparison: params => id ? source.experiment(id, params) : source.comparison(params),
      saveComparison: (body, params) => source.saveExperiment(id, body, params),
    };
  } });
  const button = (action, label, id = '', attrs = '') => `<button type="button" class="btn${action === 'create' ? ' btn--primary' : ''}" data-experiments="${action}" data-id="${e(id)}" data-key="experiments:${action}:${e(id)}" ${attrs}>${e(label)}</button>`;
  function navigate(id = '') {
    const hash = new URLSearchParams(location.hash.slice(1));
    if (id) hash.set('experiment', id); else hash.delete('experiment');
    for (const key of ['mode', 'move', 'lead', 'dir', 'bars']) hash.delete(key);
    history.pushState(null, '', `${location.pathname}${location.search}#${hash}`);
    load();
  }
  async function load() {
    const owner = scope().person;
    if (owner !== person) {
      document.querySelector('[data-experiment-dialog]')?.close();
      person = owner;
      if (!lists.has(person)) lists.set(person, fresh());
      list = lists.get(person);
    }
    selected = person ? new URLSearchParams(location.hash.slice(1)).get('experiment') || '' : '';
    const mine = ++request, target = list;
    if (!person || selected) { render(); return detail.load(); }
    detail.deactivate();
    target.loading = true; target.error = ''; render();
    try {
      const data = await api().experiments({ person: owner });
      if (mine !== request) return;
      target.items = data.experiments;
    } catch (error) {
      if (mine !== request) return;
      if (error.status === 401) return expired();
      target.error = error.message;
    } finally {
      if (mine === request) { target.loading = false; render(); }
    }
  }
  function html() {
    if (person !== scope().person) return '<section class="compare"><p>Loading experiments…</p></section>';
    if (!person) return detail.html();
    if (selected) return `<div class="ex-breadcrumb">${button('back', `All experiments for ${personName()}`)}</div>${detail.html()}`;
    return `<section class="compare cx ex-list" aria-busy="${list.loading}">
      <header class="ex-heading"><div><h2>Experiments for ${e(personName())}</h2><p>Create a plan, follow its results, and keep each experiment separate.</p></div>
      ${button('create', 'Create experiment')}</header>
      ${list.error ? `<p class="problem" role="alert">${e(list.error)}</p>` : ''}
      ${button('refresh', 'Refresh', '', list.loading ? 'disabled' : '')}
      ${list.loading ? '<p role="status">Loading experiments…</p>' : ''}
      ${list.items?.length === 0 ? '<div class="ex-empty"><h3>Your first experiment starts here</h3><p>Give it a name, choose languages, and pick periods on the calendar.</p></div>' : ''}
      <div class="ex-cards">${(list.items || []).map(item => `<article class="ex-card" data-experiment-id="${e(item.id)}">
        <div class="ex-card-heading"><h3>${e(item.name)}</h3><span class="cx-stamp">${statusText[item.status]}</span></div>
        <p>${item.start ? e(rangeText(item)) : 'No periods yet'} · ${item.periodCount} period${item.periodCount === 1 ? '' : 's'}</p>
        <p class="cx-note">${item.selectedLanguages.length ? item.selectedLanguages.map(code => e(options.langName(code))).join(', ') : 'All languages'}${detail.hasDraft(person, item.id) ? ' · Unsaved changes on this page' : ''}</p>
        <div class="cx-actions">${button('open', 'View experiment', item.id)}${button('rename', 'Rename', item.id)}${button('duplicate', 'Duplicate', item.id)}${button('delete', 'Delete', item.id)}</div>
      </article>`).join('')}</div></section>`;
  }
  function manage(action, id, opener) {
    const owner = person, target = list, item = target.items?.find(item => item.id === id);
    if (action !== 'create' && !item) return;
    const label = { create: 'Create experiment', rename: 'Rename experiment', duplicate: 'Duplicate experiment', delete: 'Delete experiment' }[action];
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog language-picker';
    dialog.dataset.experimentDialog = '';
    dialog.setAttribute('aria-labelledby', 'experiment-dialog-title');
    dialog.innerHTML = `<h2 id="experiment-dialog-title">${label}</h2>
      <form><p>${action === 'delete' ? `Delete “${e(item.name)}”? Its plan and any local draft will be removed. Viewing history and language reviews are kept.` : action === 'duplicate' ? 'Copies the saved periods and languages into a new, unconcluded experiment.' : `For ${e(personName())}.`}</p>
      ${action === 'delete' ? '' : `<label>Experiment name<input class="input" name="name" maxlength="120" required value="${e(action === 'rename' ? item.name : action === 'duplicate' ? `${item.name.slice(0, 115)} copy` : '')}" placeholder="For example: German with SLN" autocomplete="off"></label>`}
      <p class="problem" role="alert" hidden></p><div class="cx-actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn btn--primary">${label}</button></div></form>`;
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { dialog.remove(); document.querySelector(`[data-key="${CSS.escape(opener)}"]`)?.focus(); }, { once: true });
    dialog.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      if (dialog.dataset.busy || owner !== person) return;
      const name = dialog.querySelector('input')?.value.trim();
      const errorNode = dialog.querySelector('[role="alert"]');
      if (action !== 'delete' && !name) { errorNode.textContent = 'Give this experiment a name.'; errorNode.hidden = false; return; }
      dialog.dataset.busy = 'true';
      dialog.querySelector('[type="submit"]').disabled = true;
      errorNode.hidden = true;
      try {
        let result;
        if (action === 'create' || action === 'duplicate') result = await api().createExperiment({
          name, ...(item ? { sourceId: id, baseRevision: item.revision } : {}),
        }, { person: owner });
        if (action === 'rename') await api().renameExperiment(id, { name, baseRevision: item.revision }, { person: owner });
        if (action === 'delete') {
          await api().deleteExperiment(id, { baseRevision: item.revision }, { person: owner });
          detail.forget(owner, id);
        }
        target.items = null;
        dialog.close();
        if (owner !== person) return;
        announce(action === 'delete' ? 'Experiment deleted. Viewing history kept.' : `${label} saved.`);
        if (result) navigate(result.id); else load();
      } catch (error) {
        if (error.status === 401) { dialog.close(); expired(); return; }
        errorNode.textContent = error.message; errorNode.hidden = false;
        if (error.status === 409 || error.status === 404) {
          if (owner === person) load();
          dialog.querySelector('[type="submit"]').textContent = 'Close and try again';
          dialog.querySelector('form').onsubmit = event => { event.preventDefault(); dialog.close(); };
        }
      } finally {
        delete dialog.dataset.busy;
        dialog.querySelector('[type="submit"]').disabled = false;
      }
    };
    document.body.append(dialog); dialog.showModal();
    (dialog.querySelector('input') || dialog.querySelector('[data-cancel]')).focus();
  }
  function click(el, event) {
    if (!el.dataset.experiments) return detail.click(el, event);
    const action = el.dataset.experiments;
    if (action === 'back') return navigate();
    if (action === 'open') return navigate(el.dataset.id);
    if (action === 'refresh') return load();
    return manage(action, el.dataset.id, el.dataset.key);
  }
  return { html, load, click, input: detail.input,
    locationChanged() { if ((new URLSearchParams(location.hash.slice(1)).get('experiment') || '') !== selected) load(); else render(); },
    reset() { ++request; lists.clear(); detail.reset(); person = ''; selected = ''; list = fresh(); } };
}

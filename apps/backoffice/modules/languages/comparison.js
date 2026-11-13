// Saved comparison editor. Drafts survive scope changes; results always describe saved ranges.
export function createComparison({ api, scope, render, expired, esc, spent, langName, pickLanguage, demo = false }) {
  const s = { data: null, draft: null, dirty: false, busy: false, loading: false, error: '', request: 0 };
  const number = (n) => n == null ? '—' : n.toLocaleString('en', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const delta = (n, unit) => n == null ? '—' : `${n > 0 ? '+' : ''}${number(n)} ${unit}`;
  const dirty = () => { s.dirty = true; s.error = ''; render(); };
  async function load({ replace = false } = {}) {
    const request = ++s.request;
    s.loading = true; s.error = ''; render();
    try {
      const data = await api().comparison(scope());
      if (request !== s.request) return;
      s.data = data;
      if (!s.draft || replace || !s.dirty) { s.draft = structuredClone(data.config); s.dirty = false; }
    } catch (error) {
      if (request !== s.request) return;
      if (error.status === 401) { expired(); return; }
      s.error = error.message;
    } finally {
      if (request === s.request) { s.loading = false; render(); }
    }
  }
  async function save() {
    if (s.busy || !s.draft) return;
    s.busy = true; s.error = ''; render();
    try {
      s.draft = await api().saveComparison(s.draft);
      s.dirty = false;
      await load();
    } catch (error) {
      if (error.status === 401) { expired(); return; }
      s.error = error.message;
    } finally { s.busy = false; render(); }
  }
  function html() {
    const d = s.data;
    if (!s.draft) return `<section class="compare"><h2>Compare periods</h2>${s.error ? `<p role="alert">${esc(s.error)}</p><button class="btn" data-compare="reload">Try again</button>` : '<p>Loading saved periods…</p>'}</section>`;
    const disabled = s.busy || s.loading ? 'disabled' : '';
    const selected = s.draft.selectedLanguages || [];
    const editor = s.draft.groups.map((g, i) => `<fieldset class="compare__group" ${disabled}>
      <legend>0${i + 1} · ${esc(g.label)}</legend>
      <label class="label" for="group-${i}">Group name</label>
      <input class="input compare__name" id="group-${i}" maxlength="80" value="${esc(g.label)}" data-compare-field="label" data-group="${i}" data-key="compare:name:${i}">
      ${g.ranges.map((r, j) => `<div class="compare__range">
        <label><span class="label">From</span><input class="input" type="date" min="2000-01-01" max="${esc(d?.today)}" value="${esc(r.start)}" data-compare-field="start" data-group="${i}" data-range="${j}" data-key="compare:${i}:${j}:start" aria-label="${esc(g.label)} period ${j + 1} start"></label>
        <label><span class="label">Through</span><input class="input" type="date" min="2000-01-01" max="${esc(d?.today)}" value="${esc(r.end)}" data-compare-field="end" data-group="${i}" data-range="${j}" data-key="compare:${i}:${j}:end" aria-label="${esc(g.label)} period ${j + 1} end"></label>
        <button type="button" class="btn btn--sm btn--quiet" data-compare="remove" data-group="${i}" data-range="${j}" aria-label="Remove ${esc(g.label)} period ${j + 1}">×</button>
      </div>`).join('')}
      <div class="compare__chips">
        <button type="button" class="btn btn--sm" data-compare="add" data-group="${i}" data-key="compare:add:${i}" ${g.ranges.length >= 64 ? 'disabled' : ''}>+ Add period</button>
        <button type="button" class="btn btn--sm" data-compare="add-language" data-key="compare:add-language${i ? ':1' : ''}" ${selected.length >= 128 ? 'disabled' : ''}>+ Add language</button>
      </div>
    </fieldset>`).join('');
    return `<section class="compare" aria-labelledby="compare-h">
      <h2 id="compare-h">Did your listening change?</h2>
      <p class="lede">Combine the periods when you used Search Like a Native, then compare them with the times you didn’t.</p>
      <div class="compare__groups">${editor}</div>
      <p class="note">Both dates are included · ${esc(d?.timezone || '')}. Overlapping dates within a group count once. A date cannot belong to both groups.</p>
      <fieldset class="compare__languages" ${disabled}>
        <legend>Languages to compare · shared by both groups</legend>
        <div class="compare__chips">
          ${selected.length ? selected.map((lang) => `<button type="button" class="btn btn--sm" data-compare="remove-language" data-lang="${esc(lang)}" aria-label="Remove ${esc(langName(lang))}" data-key="compare:language:${esc(lang)}">${esc(langName(lang))} <span aria-hidden="true">×</span></button>`).join('') : '<span class="why">All languages</span>'}
          ${selected.length ? '<button type="button" class="btn btn--sm btn--quiet" data-compare="all-languages">Use all languages</button>' : ''}
        </div>
        <p class="note">Add language offers only languages recorded in the saved periods and selected device/person scope. Save & compare applies your selection to both period groups.</p>
      </fieldset>
      <div class="compare__actions"><button type="button" class="btn btn--primary" data-compare="save" ${disabled}>${s.busy ? 'Saving…' : 'Save & compare'}</button>
        <button type="button" class="btn btn--quiet" data-compare="reload" ${disabled}>${s.dirty ? 'Discard edits & reload saved' : 'Refresh saved comparison'}</button>
        <span class="why" role="status">${s.dirty ? 'Unsaved changes' : demo ? 'Demo · resets on reload' : 'Saved on your server'}</span></div>
      ${s.error ? `<p class="problem" role="alert">${esc(s.error)}</p>` : ''}
      ${s.loading ? '<p role="status">Updating comparison…</p>' : ''}
      ${s.dirty ? '<p class="note" data-compare-draft-note>Results below use the last saved periods and languages. Save to compare your changes.</p>' : ''}
      ${d && !s.loading && !s.error ? results(d) : ''}
    </section>`;
  }
  function results(d) {
    const groups = d.groups;
    const labels = d.config.groups.map((g) => g.label);
    const selected = d.config.selectedLanguages || [];
    const ready = groups.every((g) => g.calendarDays > 0);
    const cards = groups.map((g, i) => `<div class="compare__summary">
      <h3>${esc(labels[i])}</h3>
      ${selected.length ? `<p class="note">Combined · ${selected.map((l) => esc(langName(l))).join(' + ')}</p>` : ''}
      <p class="compare__figure">${number(g.minutesPerDay)} <span>min / day</span></p>
      <p>${esc(spent(g.seconds))} watched${selected.length ? ' in selected languages' : ''} · ${g.calendarDays} calendar days · ${g.activeDays} recorded active days${g.includesToday ? ' · Today is partial' : ''}</p>
      ${selected.length ? `<p class="note">${number(g.share == null ? null : g.share * 100)}% of ${esc(spent(g.allSeconds))} watched across all languages</p>` : ''}
      <p class="note">${esc(spent(g.foregroundSeconds))} foreground · ${esc(spent(g.backgroundSeconds))} background · ${esc(spent(g.unspecifiedSeconds))} unspecified</p>
      <p class="note">${esc(spent(g.reviewSeconds))} needs language review</p>
      ${g.calendarDays && !g.seconds ? `<p class="note">No playback recorded${selected.length ? ' in the selected languages' : ''} in these periods.</p>` : ''}
    </div>`).join('');
    const langs = [...new Set(groups.flatMap((g) => g.languages.map((l) => l.lang)))];
    const seconds = (g, lang) => g.languages.find((l) => l.lang === lang)?.seconds || 0;
    langs.sort((a, b) => Number(['und', 'mul', 'zxx'].includes(a)) - Number(['und', 'mul', 'zxx'].includes(b))
      || groups.reduce((n, g) => n + seconds(g, b) - seconds(g, a), 0) || a.localeCompare(b));
    const row = (label, values, combined = false) => `<tr ${combined ? 'data-combined class="compare__combined"' : ''}><th scope="row">${label}</th>
      ${values.map((v) => `<td><strong>${number(v.daily)}</strong><span>${esc(spent(v.time))} total</span><span>${number(v.share)}% share</span></td>`).join('')}
      <td><strong>${delta(ready ? values[0].daily - values[1].daily : null, 'min/day')}</strong><span>${delta(values.every((v) => v.share != null) ? values[0].share - values[1].share : null, 'pp share')}</span></td></tr>`;
    const combined = selected.length ? row('Selected languages combined', groups.map((g) => ({
      time: g.seconds, daily: g.minutesPerDay, share: g.share == null ? null : g.share * 100,
    })), true) : '';
    const rows = langs.map((lang) => {
      const values = groups.map((g) => {
        const time = seconds(g, lang);
        const total = g.allSeconds ?? g.seconds;
        return { time, daily: g.calendarDays ? time / 60 / g.calendarDays : null, share: total ? time / total * 100 : null };
      });
      return row(`${esc(langName(lang))}<code>${esc(lang)}</code>`, values);
    }).join('');
    return `<div class="compare__groups compare__totals">${cards}</div>
      ${!ready ? '<p class="compare__empty">Add at least one period to each group, then save to compare.</p>' : ''}
      ${langs.length ? `<div class="compare__table-wrap" tabindex="0" role="region" aria-label="Language comparison, scroll horizontally on small screens"><table class="compare__table">
        <caption>Language watch time · minutes per calendar day</caption>
        <thead><tr><th scope="col">Audio language</th><th scope="col">${esc(labels[0])}</th><th scope="col">${esc(labels[1])}</th><th scope="col">Difference <span>First group − second</span></th></tr></thead>
        <tbody>${combined}${rows}</tbody></table></div>` : ''}
      <p class="note">Daily averages include every selected calendar day, even days with no playback. Recorded active days only indicate that playback was collected${selected.length ? ' in the selected languages' : ''}. Shares are measured against all watch time, including unknown, mixed and no-speech time. “pp” means percentage points. These are differences between your chosen periods.</p>`;
  }
  function click(el) {
    if (s.busy || s.loading) return;
    const action = el.dataset.compare;
    if (action === 'reload') return load({ replace: true });
    if (action === 'save') return save();
    if (action === 'add-language') {
      const draft = s.draft;
      return pickLanguage({
        heading: 'Add a comparison language', title: 'The same selection applies to both period groups.',
        availableCodes: s.data?.availableLanguages || [],
        note: 'Only languages recorded in the saved periods for this device/person scope. Choose Save & compare to save your selection.',
        returnFocus: el, save: (_id, lang) => {
          if (draft !== s.draft || s.busy || s.loading) return;
          draft.selectedLanguages = [...new Set([...(draft.selectedLanguages || []), lang])];
          dirty();
          document.querySelector(`[data-key="${el.dataset.key}"]`)?.focus();
        },
      });
    }
    if (action === 'remove-language') {
      s.draft.selectedLanguages = (s.draft.selectedLanguages || []).filter((l) => l !== el.dataset.lang); dirty(); return;
    }
    if (action === 'all-languages') { s.draft.selectedLanguages = []; dirty(); return; }
    const g = s.draft?.groups[Number(el.dataset.group)];
    if (!g) return;
    if (action === 'add') { g.ranges.push({ start: '', end: '' }); dirty(); }
    if (action === 'remove') { g.ranges.splice(Number(el.dataset.range), 1); dirty(); }
  }
  function input(el) {
    if (s.busy || !s.draft) return;
    const g = s.draft.groups[Number(el.dataset.group)];
    const field = el.dataset.compareField;
    if (field === 'label') g.label = el.value;
    else g.ranges[Number(el.dataset.range)][field] = el.value;
    // Date inputs must keep their native editor open; reflect the draft marker without rebuilding.
    s.dirty = true;
    const marker = document.querySelector('.compare__actions [role="status"]');
    if (marker) marker.textContent = 'Unsaved changes';
    const reload = document.querySelector('[data-compare="reload"]');
    if (reload) reload.textContent = 'Discard edits & reload saved';
    const totals = document.querySelector('.compare__totals');
    if (totals && !document.querySelector('[data-compare-draft-note]')) {
      const note = document.createElement('p');
      note.className = 'note'; note.dataset.compareDraftNote = '';
      note.textContent = 'Results below use the last saved periods and languages. Save to compare your changes.';
      totals.before(note);
    }
  }
  return { html, load, click, input, reset() { ++s.request; Object.assign(s, { data: null, draft: null, dirty: false, busy: false, loading: false, error: '' }); } };
}

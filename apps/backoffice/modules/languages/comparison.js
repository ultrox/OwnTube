// Saved two-group comparison. A compact setup band holds the draft (it survives scope changes);
// everything below it describes the saved periods: which group averaged more, how long each
// group is, and the same comparison per language.

const round1 = (n) => Math.round(n * 10) / 10;

// Which of two per-day rates is higher, and by how much. Works on the one-decimal figures the
// page prints, so every displayed difference reconciles with the displayed rates. No group is
// assumed to be the baseline: the lower rate is the reference for the relative difference, which
// only exists when that printed lower rate is above zero. `trace` marks a lower rate that prints as
// 0.0 but is not zero, so the page never says "none" about playback that was recorded.
export function rateStory(a, b) {
  if (a == null || b == null) return { state: 'incomplete' };
  const rates = [round1(a), round1(b)];
  if (!a && !b) return { state: 'none', rates };
  const delta = round1(Math.abs(rates[1] - rates[0]));
  if (!delta) return { state: 'same', exact: a === b, rates };
  const leader = rates[1] > rates[0] ? 1 : 0;
  const base = rates[1 - leader];
  return { state: 'lead', leader, delta, base, percent: base > 0 ? (delta / base) * 100 : null, trace: base === 0 && [a, b][1 - leader] > 0, rates };
}

// Which group gave a larger share of its own watch time, in percentage points. Takes two shares
// in percent. Independent of rateStory: a group can average more minutes a day and still hold the
// smaller share. A share without a denominator (null) gives no difference.
export function shareStory(a, b) {
  if (a == null || b == null) return { state: 'incomplete' };
  const shares = [round1(a), round1(b)];
  const points = round1(Math.abs(shares[1] - shares[0]));
  if (!points) return { state: 'same', exact: a === b, shares };
  return { state: 'lead', leader: shares[1] > shares[0] ? 1 : 0, points, shares };
}

// Calendar-day lengths of the two groups: which is shorter and how many more selected days it
// needs to match the longer one.
export function dayGap(a, b) {
  const days = [Number(a) || 0, Number(b) || 0];
  const missing = Math.abs(days[0] - days[1]);
  return { days, equal: missing === 0, shorter: missing ? (days[0] < days[1] ? 0 : 1) : null, missing, longest: Math.max(...days) };
}

// "+57.6%" below 100, whole percent below 1000, then a plain multiple.
export function percentText(percent) {
  if (percent == null) return '';
  if (percent < 100) return `+${percent.toLocaleString('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  if (percent < 1000) return `+${Math.round(percent).toLocaleString('en')}%`;
  return `${Math.round(percent / 100 + 1).toLocaleString('en')}× as much`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateParts = (iso) => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(iso || ''); return m && { y: +m[1], m: +m[2], d: +m[3] }; };
// "7–11 Nov 2026", "28 Oct – 3 Nov 2026", "13 Nov 2026"; both dates are inclusive.
export function rangeText(range) {
  const a = dateParts(range?.start), b = dateParts(range?.end);
  if (!a || !b) return 'Incomplete period';
  const end = `${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  if (a.y !== b.y) return `${a.d} ${MONTHS[a.m - 1]} ${a.y} – ${end}`;
  if (a.m !== b.m) return `${a.d} ${MONTHS[a.m - 1]} – ${end}`;
  return a.d === b.d ? end : `${a.d}–${end}`;
}

const CELL_LIMIT = 31; // up to a month, every day is its own countable cell

export function createComparison({ api, scope, render, expired, esc, spent, langName, pickLanguage, demo = false }) {
  const s = { data: null, draft: null, dirty: false, busy: false, loading: false, failed: false, error: '', request: 0, editing: null };
  const number = (n) => n == null ? '—' : n.toLocaleString('en', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  // A rate as printed: positive playback that rounds to 0.0 reads "<0.1", never "0.0".
  const shown = (raw) => (raw > 0 && round1(raw) === 0 ? '&lt;0.1' : number(raw == null ? null : round1(raw)));
  const focusKey = (key) => { const el = document.querySelector(`[data-key="${key}"]`); if (el && !el.disabled && !el.hidden) el.focus({ preventScroll: true }); return !!el && document.activeElement === el; };
  // A re-render can remove or disable the focused control; put focus on the nearest one that remains.
  const refocus = (...keys) => { if (!document.activeElement || document.activeElement === document.body) keys.some(focusKey); };
  const days = (n, word = 'day') => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;
  const side = (i) => (i ? 'b' : 'a');
  const DRAFT_NOTE = 'The results below still show the last saved periods and languages. Save to compare your changes.';
  const dirty = () => { s.dirty = true; s.error = ''; render(); };
  async function load({ replace = false } = {}) {
    const request = ++s.request;
    s.loading = true; s.error = ''; render();
    try {
      const data = await api().comparison(scope());
      if (request !== s.request) return;
      s.data = data; s.failed = false;
      if (!s.draft || replace || !s.dirty) { s.draft = structuredClone(data.config); s.dirty = false; }
      // Nothing to compare yet: open the editor instead of an empty summary.
      if (s.editing == null) s.editing = s.draft.groups.some((g) => !g.ranges.length);
    } catch (error) {
      if (request !== s.request) return;
      if (error.status === 401) { expired(); return; }
      s.error = error.message; s.failed = true;
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
      // Saved: fold the editor away so the comparison leads, unless a group still needs periods.
      s.editing = s.draft.groups.some((g) => !g.ranges.length);
      await load();
    } catch (error) {
      if (error.status === 401) { expired(); return; }
      s.error = error.message;
    } finally { s.busy = false; render(); refocus('compare:save', 'compare:edit'); }
  }

  const label = (text, i) => esc(String(text ?? '').trim() || `Group ${i + 1}`);
  const name = (text, i) => `<b class="cmp-name cmp--${side(i)}">${label(text, i)}</b>`;
  const key = (i) => `<i class="cmp-key cmp--${side(i)}" aria-hidden="true"></i>`;
  function periodsText(ranges) {
    if (!ranges.length) return 'No periods yet';
    const shown = ranges.slice(0, 2).map(rangeText).join(', ');
    return ranges.length > 2 ? `${shown} + ${ranges.length - 2} more` : shown;
  }

  /* ---------------------------------------------------------------- setup band */

  function setup() {
    const d = s.data;
    const disabled = s.busy || s.loading ? 'disabled' : '';
    const selected = s.draft.selectedLanguages || [];
    const editing = !!s.editing;
    const groups = s.draft.groups.map((g, i) => `<fieldset class="compare__group cmp-group cmp--${side(i)}" ${disabled}>
      <legend>${key(i)}<span class="vh">Group ${i + 1}: </span>${editing ? `Group ${i + 1}` : label(g.label, i)}</legend>
      ${editing ? `<label class="label" for="group-${i}">Name</label>
      <input class="input compare__name" id="group-${i}" maxlength="80" value="${esc(g.label)}" data-compare-field="label" data-group="${i}" data-key="compare:name:${i}">
      ${g.ranges.map((r, j) => `<div class="compare__range">
        <label><span class="label">From</span><input class="input" type="date" min="2000-01-01" max="${esc(d?.today)}" value="${esc(r.start)}" data-compare-field="start" data-group="${i}" data-range="${j}" data-key="compare:${i}:${j}:start" aria-label="${esc(g.label)} period ${j + 1} start"></label>
        <label><span class="label">Through</span><input class="input" type="date" min="2000-01-01" max="${esc(d?.today)}" value="${esc(r.end)}" data-compare-field="end" data-group="${i}" data-range="${j}" data-key="compare:${i}:${j}:end" aria-label="${esc(g.label)} period ${j + 1} end"></label>
        <button type="button" class="btn btn--sm btn--quiet" data-compare="remove" data-group="${i}" data-range="${j}" data-key="compare:remove:${i}:${j}" aria-label="Remove ${esc(g.label)} period ${j + 1}">×</button>
      </div>`).join('')}` : `<ul class="cmp-periods">${g.ranges.length
        ? `${g.ranges.slice(0, 3).map((r) => `<li>${esc(rangeText(r))}</li>`).join('')}${g.ranges.length > 3 ? `<li class="why">+ ${days(g.ranges.length - 3, 'more period')}</li>` : ''}`
        : '<li class="why">No periods yet</li>'}</ul>`}
      <div class="compare__chips">
        <button type="button" class="btn btn--sm" data-compare="add" data-group="${i}" data-key="compare:add:${i}" ${g.ranges.length >= 64 ? 'disabled' : ''}>+ Add period</button>
        <button type="button" class="btn btn--sm" data-compare="add-language" data-key="compare:add-language${i ? ':1' : ''}" ${selected.length >= 128 ? 'disabled' : ''}>+ Add language</button>
      </div>
    </fieldset>`).join('');
    return `<div class="cmp-setup">
      <div class="cmp-setup__head">
        <span class="label">What’s compared</span>
        <button type="button" class="btn btn--sm btn--quiet" data-compare="edit" data-key="compare:edit" aria-expanded="${editing}" aria-controls="cmp-groups">${editing ? 'Done editing' : 'Edit names &amp; dates'}</button>
      </div>
      <div class="cmp-setup__groups" id="cmp-groups">${groups}</div>
      ${editing ? `<p class="why cmp-setup__rule">Both dates are included${d?.timezone ? ` · ${esc(d.timezone)}` : ''}. Overlapping dates within a group count once; a date cannot belong to both groups.</p>` : ''}
      <fieldset class="compare__languages" ${disabled}>
        <legend class="label">Languages · shared by both groups</legend>
        <div class="compare__chips">
          ${selected.length ? selected.map((lang) => `<button type="button" class="btn btn--sm cmp-chip" data-compare="remove-language" data-lang="${esc(lang)}" aria-label="Remove ${esc(langName(lang))}" data-key="compare:language:${esc(lang)}">${esc(langName(lang))} <span aria-hidden="true">×</span></button>`).join('') : '<span class="cmp-all">All languages</span>'}
          ${selected.length ? '<button type="button" class="btn btn--sm btn--quiet" data-compare="all-languages" data-key="compare:all-languages">Use all languages</button>' : ''}
        </div>
      </fieldset>
      <div class="compare__actions" data-dirty="${s.dirty}">
        <button type="button" class="btn btn--primary" data-compare="save" data-key="compare:save" ${disabled} ${s.dirty || s.busy ? '' : 'hidden'}>${s.busy ? 'Saving…' : 'Save & compare'}</button>
        <button type="button" class="btn btn--sm btn--quiet" data-compare="reload" data-key="compare:reload" ${disabled}>${s.dirty ? 'Discard edits' : 'Refresh'}</button>
        <span class="cmp-state" role="status">${s.dirty ? 'Unsaved changes' : demo ? 'Demo · resets on reload' : 'Saved on your server'}</span>
      </div>
      ${s.error ? `<p class="problem" role="alert">${esc(s.error)}</p>` : ''}
    </div>`;
  }

  function html() {
    const d = s.data;
    if (!s.draft) return `<section class="compare"><h2>Compare periods</h2>${s.error ? `<p role="alert">${esc(s.error)}</p><button class="btn" data-compare="reload">Try again</button>` : '<p>Loading saved periods…</p>'}</section>`;
    return `<section class="compare" aria-labelledby="compare-h">
      <h2 id="compare-h" class="vh">Compare periods</h2>
      ${setup()}
      ${s.loading ? '<p class="cmp-updating" role="status">Updating comparison…</p>' : ''}
      ${d && !s.failed ? results(d) : ''}
    </section>`;
  }

  /* ---------------------------------------------------------------- results */

  function results(d) {
    const groups = d.groups;
    const labels = d.config.groups.map((g) => g.label);
    const selected = d.config.selectedLanguages || [];
    const names = selected.map((l) => langName(l));
    const what = !names.length ? 'listening'
      : names.length > 3 ? `the ${names.length} selected languages`
        : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    return `<div class="cmp-results compare__totals ${s.loading ? 'is-updating' : ''}" data-compare-results aria-busy="${s.loading}">
      ${s.dirty ? `<p class="cmp-draft" data-compare-draft-note>${DRAFT_NOTE}</p>` : ''}
      ${hero(d, groups, labels, selected, names, what)}
      ${coverage(d, groups, labels, selected)}
      ${languages(groups, labels, selected)}
      ${fine(groups, labels, selected)}
      <p class="note cmp-foot">Days follow ${esc(d.timezone || 'the server’s time zone')}. Shares are measured against all watch time in a group, including unknown, mixed and no-speech time. These are observed differences between the periods you chose, not proof of a cause.${asOf(d)}</p>
    </div>`;
  }

  function asOf(d) {
    const at = typeof d.asOf === 'number' ? d.asOf : Date.parse(d.asOf);
    if (!Number.isFinite(at)) return '';
    const options = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    let text;
    try { text = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: d.timezone }).format(at); } catch { text = new Intl.DateTimeFormat('en-GB', options).format(at); }
    return ` As of ${esc(text)}.`;
  }

  // The lead: one sentence naming the higher group, then both rates on one scale with the
  // difference marked on the longer bar.
  function hero(d, groups, labels, selected, names, what) {
    const story = rateStory(groups[0].minutesPerDay, groups[1].minutesPerDay);
    let headline, sub = '';
    if (story.state === 'incomplete') {
      const empty = groups.map((g, i) => (g.calendarDays > 0 ? null : i)).filter((i) => i != null);
      headline = empty.length === 2 ? 'Nothing to compare yet.' : `${name(labels[empty[0]], empty[0])} has no periods yet.`;
      sub = '<span class="compare__empty">Add at least one period to each group, then save to compare.</span>';
    } else if (story.state === 'none') {
      headline = `No ${selected.length ? `${esc(what)} ` : ''}playback was recorded in either group.`;
      sub = !selected.length ? 'Both groups have selected days, but nothing was collected on them in this device/person scope.'
        : `Both groups have selected days, but no ${esc(what)} playback was recorded on them in this device/person scope.${groups.some((g) => g.allSeconds > 0) ? ' Other languages were recorded there.' : ''}`;
    } else if (story.state === 'same') {
      headline = `${name(labels[0], 0)} and ${name(labels[1], 1)} averaged ${story.exact ? 'exactly' : 'about'} the same amount of ${esc(what)} a day.`;
      sub = `${shown(groups[0].minutesPerDay)} vs ${shown(groups[1].minutesPerDay)} min per calendar day.`;
    } else {
      const lead = story.leader, other = 1 - lead;
      headline = `${name(labels[lead], lead)} averaged <span class="cmp-num">${number(story.delta)} more ${story.delta === 1 ? 'minute' : 'minutes'}</span> of ${esc(what)} a day than ${name(labels[other], other)}.`;
      const pair = `${shown(groups[lead].minutesPerDay)} vs ${shown(groups[other].minutesPerDay)} min per calendar day.`;
      sub = story.percent != null ? `<strong class="cmp-pct cmp--${side(lead)}">${percentText(story.percent)}</strong> relative to ${label(labels[other], other)}’s daily average · ${pair}`
        : story.trace ? `${label(labels[other], other)} averaged under 0.1 min a day, too little for a meaningful percentage · ${pair}`
          : `${label(labels[other], other)} recorded none, so there is no percentage to give · ${pair}`;
    }
    // Share of all watch time is its own comparison: its higher group need not be the one above.
    let share = null, shareLine = '';
    if (selected.length && story.state !== 'incomplete') {
      share = shareStory(...groups.map((g) => (g.share == null ? null : g.share * 100)));
      const each = groups.map((g, i) => `${label(labels[i], i)} ${g.share == null ? 'no watch time at all' : `${number(g.share * 100)}%`}`).join(' · ');
      const verdict = share.state === 'lead' ? `${name(labels[share.leader], share.leader)} is higher by <b class="cmp-pts">${number(share.points)} percentage points</b>.`
        : share.state === 'same' ? `${share.exact ? 'The same' : 'About the same'} share in both groups.`
          : 'No share difference to give: a group with no watch time has no share.';
      shareLine = `<p class="cmp-share"><span class="cmp-share__what">Share of all watch time</span> ${each} · ${verdict}</p>`;
    }
    const rates = groups.map((g) => (g.minutesPerDay == null ? null : round1(g.minutesPerDay)));
    const top = Math.max(0, ...rates.map((r) => r || 0));
    const rows = groups.map((g, i) => {
      const rate = rates[i];
      const some = g.minutesPerDay > 0; // a true zero draws no bar; a trace keeps a thin marker
      const width = rate && top ? (rate / top) * 100 : 0;
      const leads = story.state === 'lead' && story.leader === i;
      const baseWidth = leads ? (story.base / top) * 100 : width;
      const facts = [];
      if (g.calendarDays) {
        facts.push(`${esc(spent(g.seconds))} total`);
        if (selected.length && g.share != null) facts.push(`${number(g.share * 100)}% of all`);
      }
      return `<div class="cmp-duel__row cmp--${side(i)}${leads ? ' is-lead' : ''}" data-group-result="${i}" data-rate="${rate ?? ''}">
        <div class="cmp-duel__who">
          <span class="cmp-duel__name">${key(i)}${label(labels[i], i)}</span>
          <span class="cmp-duel__when">${esc(periodsText(d.config.groups[i].ranges))}${g.calendarDays ? ` · ${days(g.calendarDays)}${g.includesToday ? ', today partial' : ''}` : ''}</span>
        </div>
        <div class="cmp-duel__track" aria-hidden="true">${!some ? '' : `<span class="cmp-duel__bar" style="width:${baseWidth.toFixed(2)}%"></span>${leads ? `<span class="cmp-duel__extra" data-delta="+${number(story.delta)} min / day" style="width:${(width - baseWidth).toFixed(2)}%"></span>` : ''}`}</div>
        <div class="cmp-duel__fig">
          ${rate == null ? '<span class="cmp-duel__n cmp-duel__n--none">no average</span>' : `<span class="cmp-duel__n">${shown(g.minutesPerDay)}<span class="u"> min / day</span></span>`}
          <span class="cmp-duel__total">${facts.join(' · ') || 'No days selected'}</span>
        </div>
      </div>`;
    }).join('');
    return `<header class="cmp-hero" ${selected.length ? 'data-combined' : ''} data-story="${story.state}" data-leader="${story.leader ?? ''}" data-delta="${story.delta ?? ''}" data-percent="${story.percent == null ? '' : story.percent.toFixed(4)}" data-trace="${!!story.trace}" data-share-story="${share?.state ?? ''}" data-share-leader="${share?.leader ?? ''}" data-share-points="${share?.points ?? ''}">
      <p class="label cmp-kicker">${selected.length ? `${esc(names.join(' + '))}${names.length > 1 ? ' combined' : ''}` : 'All languages'} · average per calendar day</p>
      <h3 class="cmp-headline">${headline}</h3>
      <p class="cmp-sub">${sub}</p>
      ${shareLine}
      <div class="cmp-duel">${rows}</div>
    </header>`;
  }

  // How long each group is. Cells count selected calendar days; dashed cells are the days the
  // shorter group lacks. Nothing here claims which dates had playback: the response has totals.
  function coverage(d, groups, labels, selected) {
    const gap = dayGap(groups[0].calendarDays, groups[1].calendarDays);
    if (!gap.longest) return '';
    const cells = gap.longest <= CELL_LIMIT;
    let headline;
    if (gap.equal) headline = `Equal length: both groups cover <b>${days(gap.longest, 'calendar day')}</b>.`;
    else {
      const short = gap.shorter, long = 1 - short;
      headline = `${name(labels[short], short)} ${gap.days[short] ? `is ${days(gap.missing)} shorter and` : 'has no days yet and'} needs <b class="cmp-need">${days(gap.missing, 'more day')}</b> to match ${name(labels[long], long)}’s ${gap.days[long].toLocaleString('en')}.`;
    }
    const rows = groups.map((g, i) => {
      const n = g.calendarDays, missing = gap.shorter === i ? gap.missing : 0;
      const sentence = `${days(n, 'selected calendar day')}${g.includesToday ? ', including today, which is not over yet' : ''}${missing ? `; ${days(missing, 'more day')} needed to match the other group` : ''}`;
      let picture;
      if (cells) {
        picture = `${Array.from({ length: n }, (_, j) => `<i class="cmp-day${g.includesToday && j === n - 1 ? ' cmp-day--today' : ''}"></i>`).join('')}${'<i class="cmp-day cmp-day--need"></i>'.repeat(missing)}`;
      } else {
        const have = (n / gap.longest) * 100;
        picture = `${n ? `<span class="cmp-span__have" style="width:${have.toFixed(2)}%">${g.includesToday ? '<i class="cmp-span__today"></i>' : ''}</span>` : ''}${missing ? `<span class="cmp-span__need" style="width:${(100 - have).toFixed(2)}%"></span>` : ''}`;
      }
      return `<div class="cmp-cover__row cmp--${side(i)}" data-cover="${i}" data-days="${n}" data-missing="${missing}" data-active="${g.activeDays}" data-today="${!!g.includesToday}">
        <span class="cmp-cover__name">${key(i)}${label(labels[i], i)}</span>
        <span class="${cells ? 'cmp-days' : 'cmp-span'}" role="img" aria-label="${esc(sentence)}">${picture}</span>
        <span class="cmp-cover__facts"><b>${days(n, 'calendar day')}</b>${n ? ` · playback recorded on ${g.activeDays.toLocaleString('en')}` : ''}${missing ? ` · <span class="cmp-need">${missing.toLocaleString('en')} short</span>` : ''}</span>
      </div>`;
    }).join('');
    const today = groups.some((g) => g.includesToday);
    return `<section class="cmp-cover" aria-labelledby="cmp-cover-h" data-equal="${gap.equal}" data-missing="${gap.missing}">
      <p class="label">Are the periods comparable?</p>
      <h3 class="cmp-h" id="cmp-cover-h">${headline}</h3>
      <div class="cmp-cover__rows">${rows}</div>
      <p class="cmp-legend" aria-hidden="true">
        <span><i class="cmp-day"></i>${cells ? 'one selected calendar day' : 'selected calendar days'}</span>
        ${today ? '<span><i class="cmp-day cmp-day--today"></i>today, not over yet</span>' : ''}
        ${gap.equal ? '' : '<span><i class="cmp-day cmp-day--need"></i>needed to match</span>'}
      </p>
      <p class="note">Averages divide by every selected calendar day, including days with no playback, so the difference in length is already accounted for. “Playback recorded” counts the days on which ${selected.length ? 'the selected languages were' : 'anything was'} collected. ${gap.equal ? `With equal lengths, a single day weighs the same in both groups${today ? '; today’s total can still grow' : ''}.` : `The shorter group rests on fewer days, so each of its days weighs more${today ? ', and today’s total can still grow' : ''}; matching lengths would make the groups even, not certain.`}</p>
    </section>`;
  }

  // The same comparison for each language, on one shared scale.
  function languages(groups, labels, selected) {
    const langs = [...new Set(groups.flatMap((g) => g.languages.map((l) => l.lang)))];
    // One selected language is already the whole lead above.
    if (!langs.length || selected.length === 1) return '';
    const seconds = (g, lang) => g.languages.find((l) => l.lang === lang)?.seconds || 0;
    langs.sort((a, b) => Number(['und', 'mul', 'zxx'].includes(a)) - Number(['und', 'mul', 'zxx'].includes(b))
      || groups.reduce((n, g) => n + seconds(g, b) - seconds(g, a), 0) || a.localeCompare(b));
    const table = langs.map((lang) => ({ lang, values: groups.map((g) => {
      const time = seconds(g, lang);
      const total = g.allSeconds ?? g.seconds;
      return { time, daily: g.calendarDays ? time / 60 / g.calendarDays : null, share: total ? (time / total) * 100 : null };
    }) }));
    const top = Math.max(0, ...table.flatMap((r) => r.values.map((v) => round1(v.daily || 0))));
    const rows = table.map(({ lang, values }) => {
      const story = rateStory(values[0].daily, values[1].daily);
      const bars = values.map((v, i) => {
        const rate = v.daily == null ? null : round1(v.daily);
        return `<div role="cell" class="cmp-row__bar cmp--${side(i)}"><span class="vh">${label(labels[i], i)}: </span>
          <span class="cmp-row__track" aria-hidden="true">${v.daily > 0 ? `<span style="width:${rate && top ? ((rate / top) * 100).toFixed(2) : 0}%"></span>` : ''}</span>
          <span class="cmp-row__n">${shown(v.daily)}<span class="vh"> min per day</span></span>
          <span class="cmp-row__meta">${rate == null ? 'no days selected' : `${esc(spent(v.time))}${v.share == null ? '' : ` · ${number(v.share)}%`}`}</span></div>`;
      }).join('');
      let diff;
      if (story.state === 'lead') {
        diff = `<span class="cmp-row__lead" title="${label(labels[story.leader], story.leader)}">${name(labels[story.leader], story.leader)}<span class="vh"> higher by</span></span>
          <span class="cmp-row__delta">+${number(story.delta)}<span class="u"> min / day</span></span>
          <span class="cmp-row__pct">${story.percent != null ? `${percentText(story.percent)}${story.percent < 1000 ? ' daily' : ''}` : story.trace ? 'the other under 0.1 min / day' : 'the other recorded none'}</span>`;
      } else {
        diff = `<span class="cmp-row__even">${story.state === 'same' ? (story.exact ? 'No difference' : 'About the same') : story.state === 'none' ? 'No playback' : '—'}</span>`;
      }
      // Share of all watch time, in percentage points; its higher group is named on its own.
      const share = story.state === 'incomplete' || story.state === 'none' ? { state: 'incomplete' } : shareStory(values[0].share, values[1].share);
      if (share.state === 'lead') {
        diff += `<span class="cmp-row__share" title="Share of all watch time: ${label(labels[share.leader], share.leader)} higher by ${number(share.points)} percentage points">share +${number(share.points)} pts<span class="vh"> higher in</span> · ${name(labels[share.leader], share.leader)}</span>`;
      } else if (share.state === 'same') {
        diff += `<span class="cmp-row__share">share ${share.exact ? 'the same' : 'about the same'}</span>`;
      }
      return `<div role="row" class="cmp-row" data-lang="${esc(lang)}" data-story="${story.state}" data-leader="${story.leader ?? ''}" data-delta="${story.delta ?? ''}" data-trace="${!!story.trace}" data-share-story="${share.state}" data-share-leader="${share.leader ?? ''}" data-share-points="${share.points ?? ''}">
        <div role="rowheader" class="cmp-row__name">${esc(langName(lang))}<code>${esc(lang)}</code></div>
        ${bars}
        <div role="cell" class="cmp-row__diff">${diff}</div>
      </div>`;
    }).join('');
    return `<section class="cmp-langs" aria-labelledby="cmp-langs-h">
      <div class="cmp-section-head">
        <h3 class="cmp-h" id="cmp-langs-h">${selected.length ? 'Each selected language' : 'By language'}</h3>
        <p class="cmp-legend">${labels.map((l, i) => `<span title="${label(l, i)}">${key(i)}<span class="cmp-clip">${label(l, i)}</span></span>`).join('')}<span class="cmp-legend__scale">min per calendar day · one scale, 0–${number(top)}</span></p>
      </div>
      <div class="cmp-table compare__table" role="table" aria-labelledby="cmp-langs-h">
        <div role="rowgroup" class="vh"><div role="row"><span role="columnheader">Audio language</span>${labels.map((l, i) => `<span role="columnheader">${label(l, i)}</span>`).join('')}<span role="columnheader">Higher group and difference</span></div></div>
        <div role="rowgroup">${rows}</div>
      </div>
      <p class="note">Beside each bar: total time and its share of all watch time in that group. “Daily” percentages compare the two daily averages, relative to the lower one. “Share … pts” is the difference between the two shares in percentage points, and can favour the other group.</p>
    </section>`;
  }

  // Totals behind the averages, as a plain ruled table.
  function fine(groups, labels, selected) {
    if (!groups.some((g) => g.calendarDays > 0)) return '';
    const row = (title, cell) => `<tr><th scope="row">${title}</th>${groups.map((g) => `<td>${g.calendarDays ? cell(g) : '—'}</td>`).join('')}</tr>`;
    const shareRow = () => {
      const share = groups.every((g) => g.calendarDays) ? shareStory(...groups.map((g) => (g.share == null ? null : g.share * 100))) : { state: 'incomplete' };
      const text = share.state === 'lead' ? `${label(labels[share.leader], share.leader)} higher by ${number(share.points)} percentage points`
        : share.state === 'same' ? (share.exact ? 'the same' : 'about the same') : '—';
      return `<tr><th scope="row">Share difference</th><td colspan="2" class="cmp-fine__span">${text}</td></tr>`;
    };
    return `<section class="cmp-fine" aria-labelledby="cmp-fine-h">
      <h3 class="cmp-h" id="cmp-fine-h">Behind the averages</h3>
      <div class="cmp-fine__wrap"><table>
        <thead><tr><td></td>${labels.map((l, i) => `<th scope="col">${key(i)}${label(l, i)}</th>`).join('')}</tr></thead>
        <tbody>
          ${row('Selected calendar days', (g) => `${g.calendarDays.toLocaleString('en')}${g.includesToday ? ' <span class="why">incl. today (partial)</span>' : ''}`)}
          ${row(`Days with ${selected.length ? 'selected-language ' : ''}playback recorded`, (g) => g.activeDays.toLocaleString('en'))}
          ${row(`Watched${selected.length ? ' in selected languages' : ''}`, (g) => esc(spent(g.seconds)))}
          ${selected.length ? row('All watch time', (g) => esc(spent(g.allSeconds))) + row('Share of all watch time', (g) => (g.share == null ? '—' : `${number(g.share * 100)}%`)) + shareRow() : ''}
          ${row('Foreground', (g) => esc(spent(g.foregroundSeconds)))}
          ${row('Background', (g) => esc(spent(g.backgroundSeconds)))}
          ${row('Context not recorded', (g) => esc(spent(g.unspecifiedSeconds)))}
          ${row('Needs language review', (g) => esc(spent(g.reviewSeconds)))}
        </tbody></table></div>
    </section>`;
  }

  /* ---------------------------------------------------------------- events */

  function click(el) {
    if (s.busy || s.loading) return;
    const action = el.dataset.compare;
    if (action === 'reload') return load({ replace: true }).then(() => refocus('compare:reload'));
    if (action === 'save') return save();
    if (action === 'edit') { s.editing = !s.editing; render(); return; }
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
      s.draft.selectedLanguages = (s.draft.selectedLanguages || []).filter((l) => l !== el.dataset.lang); dirty(); refocus('compare:add-language'); return;
    }
    if (action === 'all-languages') { s.draft.selectedLanguages = []; dirty(); refocus('compare:add-language'); return; }
    const g = s.draft?.groups[Number(el.dataset.group)];
    if (!g) return;
    if (action === 'add') {
      g.ranges.push({ start: '', end: '' }); s.editing = true; dirty();
      document.querySelector(`[data-key="compare:${el.dataset.group}:${g.ranges.length - 1}:start"]`)?.focus();
    }
    if (action === 'remove') { g.ranges.splice(Number(el.dataset.range), 1); dirty(); refocus(`compare:add:${el.dataset.group}`); }
  }
  function input(el) {
    if (s.busy || !s.draft) return;
    const g = s.draft.groups[Number(el.dataset.group)];
    const field = el.dataset.compareField;
    if (field === 'label') g.label = el.value;
    else g.ranges[Number(el.dataset.range)][field] = el.value;
    // Date inputs must keep their native editor open; reflect the draft state without rebuilding.
    s.dirty = true;
    const actions = document.querySelector('.compare__actions');
    if (actions) {
      actions.dataset.dirty = 'true';
      actions.querySelector('[role="status"]').textContent = 'Unsaved changes';
      actions.querySelector('[data-compare="save"]').hidden = false;
      actions.querySelector('[data-compare="reload"]').textContent = 'Discard edits';
    }
    const totals = document.querySelector('.compare__totals');
    if (totals && !document.querySelector('[data-compare-draft-note]')) {
      const note = document.createElement('p');
      note.className = 'cmp-draft'; note.dataset.compareDraftNote = '';
      note.textContent = DRAFT_NOTE;
      totals.prepend(note);
    }
  }
  return { html, load, click, input, reset() { ++s.request; Object.assign(s, { data: null, draft: null, dirty: false, busy: false, loading: false, failed: false, error: '', editing: null }); } };
}

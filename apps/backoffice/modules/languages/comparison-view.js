import {
  round1, decimal, rateText, dayText, rangeText, minutesText, moveStory, movePhrase,
  shareStory, pointsText, changeText, subLine, scaleBlocks, waffleCounts, timeAxis,
  observation, languageValue, leadLanguage, periodDays,
} from './comparison-model.js';

export const mark = i => `<i class="cx-mark cx-mark--${i % 5}" aria-hidden="true"></i>`;
export const swatch = i => `<i class="cx-swatch cx-color-${Math.min(i, 4)}" aria-hidden="true"></i>`;
export function comparisonView({ esc, langName, spent }) {
  const e = esc;
  const pct = n => n == null ? 'No share' : `${rateText(n * 100)}%`;
  const of100 = n => n > 0 && Math.round(n * 100) === 0 ? 'under 1' : Math.round(n * 100);
  const totalRate = p => p.calendarDays ? p.allSeconds / 60 / p.calendarDays : null;
  const button = (action, text, attrs = '') => `<button type="button" class="btn" data-compare="${action}" ${attrs.includes('data-key=') ? '' : `data-key="compare:${action}:${attrs.match(/data-value="([^"]*)"/)?.[1] || ''}"`} ${attrs}>${text}</button>`;
  const dates = (p, d) => p.periods ? p.periods.flatMap(i => periodDays(d.periods[i])) : periodDays(p);
  const dateLabel = (p, d) => p.periods ? p.periods.map(i => rangeText(d.periods[i])).join(', ') : rangeText(p);
  const itemName = (p, i) => `${mark(p.index ?? i)}${e(p.label)}`;
  function context(d) {
    const h = new URLSearchParams(location.hash.slice(1));
    const repeated = d.groups.length < d.periods.length;
    const mode = ['sequence', 'pooled'].includes(h.get('mode')) ? h.get('mode') : repeated ? 'pooled' : 'sequence';
    const items = (mode === 'pooled' ? d.groups : d.periods).map((p, index) => ({
      ...p, index, end: p.end || d.periods[p.periods.at(-1)].end,
    }));
    const move = Math.max(1, Math.min(items.length - 1, Number.parseInt(h.get('move'), 10) || 1));
    const pair = items.slice(move - 1, move + 1);
    if (h.get('dir') === 'rev') pair.reverse();
    const selected = d.config.selectedLanguages;
    const available = selected.length ? [...selected] : [...new Set(pair.flatMap(p => p.languages.map(l => l.lang)))];
    const code = [h.get('lead'), d.config.leadLanguage].find(code => code === 'all' || available.includes(code));
    const lead = code === 'all' || available.includes(code) ? code : pair.length === 2 ? leadLanguage(available, pair) : available[0] || 'all';
    available.sort((a, b) => (a === lead ? -1 : b === lead ? 1 : 0)
      || (languageValue(pair.at(-1) || { languages: [] }, b).seconds - languageValue(pair.at(-1) || { languages: [] }, a).seconds)
      || a.localeCompare(b));
    const codes = selected.length ? available : available.slice(0, 8);
    const what = lead === 'all' ? selected.length ? selected.map(langName).join(' and ') : 'all watch time' : langName(lead);
    // Combined leading uses one accent segment, so its wedge and bars share the same geometry.
    const segments = lead === 'all' ? ['all', 'other'] : [...codes, 'other'];
    return { items, pair, move, mode, repeated, selected, codes, lead, what, segments };
  }
  const segmentValue = (p, code, c) => code === 'other'
    ? Math.max(0, p.allSeconds - (c.lead === 'all' ? p.seconds : c.codes.reduce((n, l) => n + languageValue(p, l).seconds, 0)))
    : languageValue(p, code).seconds;
  const segmentName = (code, c) => code === 'other' ? 'Other' : code === 'all' ? c.what : langName(code);
  const color = (code, c) => code === 'other' ? 4 : code === 'all' ? 0 : Math.min(c.codes.indexOf(code) + (c.lead === 'all' ? 1 : 0), 4);
  const legend = c => c.segments.map(code => `<span>${swatch(color(code, c))}${e(segmentName(code, c))}</span>`).join('');
  function strip(p, c) {
    return c.segments.map(code => `<i class="cx-color-${color(code, c)}" style="flex:${segmentValue(p, code, c)}" title="${e(segmentName(code, c))}: ${pct(p.allSeconds ? segmentValue(p, code, c) / p.allSeconds : null)}"></i>`).join('');
  }
  function scale(pair, values, c) {
    const geometry = scaleBlocks(...values.map(v => v.rate));
    const label = pair.map((p, i) => `${p.label}: ${rateText(values[i].rate)} minutes of ${c.what} per calendar day`).join('. ');
    return `<div class="cx-scale" role="img" aria-label="${e(label)}">${pair.map((p, i) => {
      const raw = values[i].rate;
      const blocks = geometry.blocks.length
        ? geometry.blocks.map((n, j) => `<i style="flex:${n}" class="${i !== geometry.smaller || j === 0 ? 'is-filled' : ''}"></i>`).join('')
        : `<i class="is-filled" style="width:${geometry.widths[i]}%;${raw > 0 ? 'min-width:2px' : ''}"></i>`;
      return `<div class="cx-scale-label">${itemName(p, i)} <strong>${raw === 0 ? 'none' : e(minutesText(raw))}</strong> <span>of ${e(c.what)} a day</span></div>
        <div class="cx-scale-track ${raw === 0 ? 'is-zero' : ''}" aria-hidden="true">${blocks}</div>`;
    }).join('')}</div><p class="cx-note">Drawn to scale.${geometry.blocks.length ? ` Each block is one ${e(pair[geometry.smaller].label)} day of ${e(c.what)}; a ${e(pair[1 - geometry.smaller].label)} day holds ${geometry.full} of them${geometry.remainder >= .15 ? ' and a bit' : ''}.` : ''}</p>`;
  }
  function coverage(d, c) {
    const o = observation(c.pair);
    let hasToday = false, hasPlanned = false, hasGeneric = false;
    const rows = c.pair.map((p, i) => {
      const all = dates(p, d), future = all.filter(day => day > d.today);
      const missing = future.length || (o.shorter === i ? o.missing : 0);
      const span = Math.max(p.plannedDays, o.longest);
      hasToday ||= p.includesToday; hasPlanned ||= !!future.length; hasGeneric ||= !!missing && !future.length;
      const label = `${p.label}: ${dayText(p.calendarDays)} elapsed of ${p.plannedDays} planned${p.includesToday ? ', today still running' : ''}${missing ? `, ${missing} ${future.length ? 'planned days to go' : 'more days to match'}` : ''}`;
      let chart;
      if (span <= 31) {
        const elapsed = all.filter(day => day <= d.today);
        chart = `<div class="cx-days">${elapsed.map(day => `<i class="cx-day${day === d.today ? ' cx-day--today' : ''}"><span>${Number(day.slice(-2))}</span></i>`).join('')}
          ${missing ? `<span class="cx-slots" style="width:${missing * 54 - 6}px">${Array.from({ length: missing }, (_, j) => `<i class="cx-day cx-day--slot">${future.length ? Number(future[j].slice(-2)) : `+${j + 1}`}</i>`).join('')}<b>${missing} ${future.length ? 'planned days to go' : 'more to match'}</b></span>` : ''}</div>`;
      } else {
        chart = `<div class="cx-daybar"><i style="width:${p.calendarDays / span * 100}%">${p.includesToday ? `<i class="cx-daybar-today" style="width:${100 / Math.max(1, p.calendarDays)}%"></i>` : ''}</i>${missing ? `<b style="width:${missing / span * 100}%"></b>` : ''}</div>
          ${missing ? `<p>${missing} ${future.length ? 'planned days to go' : 'more to match'}</p>` : ''}`;
      }
      return `<div class="cx-observation-row"><b>${itemName(p, i)}</b><p class="cx-note">${e(dateLabel(p, d))}</p>
        <div role="img" aria-label="${e(label)}">${chart}</div><p class="cx-note">${dayText(p.calendarDays)} · ${e(spent(p.allSeconds))} recorded${p.activeDays < p.calendarDays ? ` · ${p.activeDays} with playback` : ''}</p></div>`;
    }).join('');
    return `<aside class="cx-observation" data-observation="${o.early ? 'early' : 'even'}"><div class="cx-eyebrow">Observation <span class="cx-stamp">${o.stamp}</span></div>
      <h2>${o.title}</h2><p>${e(o.line)}</p>${rows}<footer class="cx-note">Full day${hasToday ? ' · Today, still running' : ''}${hasPlanned ? ' · Planned day, not recorded yet' : ''}${hasGeneric ? ' · Day to add for an equal window, not a forecast' : ''}
      ${!o.early ? `<p>Like for like on length.${o.days[0] + o.days[1] < 28 ? ` ${o.days[0] + o.days[1]} days is still a short record.` : ''}</p>` : ''}</footer></aside>`;
  }
  function hero(d, c) {
    const values = c.pair.map(p => languageValue(p, c.lead)), story = moveStory(...values.map(v => v.rate));
    const leadControls = c.codes.length > 1 ? `<div class="cx-lead"><span class="cx-eyebrow">Lead with</span><div class="cx-segmented" role="group" aria-label="Lead language">${c.codes.map(code => button('lead', e(langName(code)), `data-value="${e(code)}" aria-pressed="${c.lead === code}"`)).join('')}${button('lead', c.selected.length === 2 ? e(c.selected.map(langName).join(' + ')) : 'All selected', `data-value="all" aria-pressed="${c.lead === 'all'}"`)}</div>
      ${c.canSaveLead ? button('save-lead', c.lead === d.config.leadLanguage ? 'Lead saved' : 'Save lead', `data-key="compare:save-lead" ${c.lead === d.config.leadLanguage || c.leadDisabled ? 'disabled' : ''}`) : ''}</div>` : '';
    const empty = c.pair.find(p => !p.calendarDays);
    return `<div class="cx-hero"><header data-story="${story.state}" data-lead="${e(c.lead)}">
      <p class="cx-eyebrow">${swatch(0)}${e(c.what)} · From ${e(c.pair[0].label)} to ${e(c.pair[1].label)}</p>
      ${empty ? `<h1 class="cx-notice">${e(empty.label)} starts ${e(rangeText({ start: dates(empty, d)[0], end: dates(empty, d)[0] }))}. Nothing to compare yet.</h1>` :
        `<h1 class="cx-headline"><span class="cx-figure${story.figure.length > 4 ? ' cx-figure--wide' : ''}">${e(story.figure)}</span><span>${e(movePhrase(story, c.what, c.pair[1].label))}</span></h1>
        ${scale(c.pair, values, c)}
        <p class="cx-subline">${e(subLine(story, c.what, values.map(v => v.share), c.pair.map(totalRate)))}</p>`}
      ${leadControls}</header>${coverage(d, c)}</div>`;
  }
  function lenses(c) {
    const values = c.pair.map(p => languageValue(p, c.lead)), story = moveStory(...values.map(v => v.rate));
    if (story.state === 'incomplete') return '';
    const axis = timeAxis(Math.max(...c.pair.map(totalRate))), share = shareStory(...values.map(v => v.share == null ? null : v.share * 100));
    const sentence = c.pair.map((p, i) => `${p.label}: ${rateText(values[i].rate)} minutes of ${c.what} out of ${rateText(totalRate(p))} minutes per calendar day`).join('. ');
    const bar = (p, i) => `<div class="cx-chart-label">${itemName(p, i)} · ${e(c.what)} ${rateText(values[i].rate)} min of an average day</div>
      <div class="cx-time-track"><div class="cx-stack" style="width:${totalRate(p) / axis.max * 100}%">${strip(p, c)}</div><b>${minutesText(totalRate(p))}</b></div>`;
    const grids = share.state === 'incomplete'
      ? `<p>${e(c.pair.find(p => !p.allSeconds).label)} has no recorded watch time, so there is no share to compare.</p>`
      : `<div class="cx-waffles">${c.pair.map((p, i) => {
        const counts = waffleCounts(c.segments.map(code => segmentValue(p, code, c)));
        return `${i ? '<span aria-hidden="true">→</span>' : ''}<div><div class="cx-waffle" role="img" aria-label="${e(`${p.label}: ${rateText(values[i].share * 100)}% ${c.what}. ${c.segments.map((code, j) => `${segmentName(code, c)} ${counts[j]} squares`).join(', ')}`)}">${counts.flatMap((n, j) => Array.from({ length: n }, () => `<i class="cx-color-${color(c.segments[j], c)}"></i>`)).join('')}</div>
          <p>${itemName(p, i)}<br><b>${of100(values[i].share)} of 100</b> ${e(c.what)}</p></div>`;
      }).join('')}</div>`;
    const falling = c.codes.filter(code => code !== c.lead).map(code => ({ code, values: c.pair.map(p => languageValue(p, code)) }))
      .filter(x => x.values.every(v => v.share != null)).sort((a, b) => (a.values[1].share - a.values[0].share) - (b.values[1].share - b.values[0].share))[0];
    const gained = share.points == null ? '' : `${e(c.what)} ${share.points >= 0 ? 'gained' : 'lost'} about ${Math.abs(Math.round(share.points))} squares.`;
    return `<div class="cx-lenses"><section class="cx-lens" data-lens="time"><div class="cx-eyebrow"><span>Time · Minutes per calendar day</span><span>Change in percent</span></div>
      <h2>Is there more ${e(c.what)} in a day?</h2><div class="cx-lens-number"><strong>${story.delta > 0 ? '+' : ''}${decimal(story.delta)}</strong><span>minutes a day<br>${e(changeText(story))}</span></div>
      <div role="img" aria-label="${e(sentence)}">${bar(c.pair[0], 0)}<div class="cx-wedge" aria-hidden="true" style="clip-path:polygon(0 0,${values[0].rate / axis.max * 100}% 0,${values[1].rate / axis.max * 100}% 100%,0 100%)"></div>${bar(c.pair[1], 1)}
      <div class="cx-axis">${axis.ticks.map(t => `<span style="left:${t / axis.max * 100}%">${t < 60 ? `${t}m` : `${t / 60}h`}</span>`).join('')}</div></div>
      <div class="cx-legend">${c.segments.map(code => `<span>${swatch(color(code, c))}${e(segmentName(code, c))} ${c.pair.map(p => rateText(segmentValue(p, code, c) / 60 / p.calendarDays)).join(' → ')}</span>`).join('')}</div>
      <p class="cx-note">Bar length is minutes watched per calendar day.${totalRate(c.pair[0]) > 0 && Math.abs(totalRate(c.pair[1]) / totalRate(c.pair[0]) - 1) >= .1 ? ` Total viewing ${totalRate(c.pair[1]) > totalRate(c.pair[0]) ? 'rose' : 'fell'} as well, which is why share is read separately.` : ''}</p></section>
      <section class="cx-lens" data-lens="share"><div class="cx-eyebrow"><span>Share · Out of every 100 minutes watched</span><span>Change in points</span></div>
      <h2>Is ${e(c.what)} a bigger part of what I watch?</h2>${share.points == null ? '' : `<div class="cx-lens-number"><strong data-share-figure>${values.map(v => of100(v.share)).join(' → ')}</strong><span>of every 100 minutes watched<br><b>${pointsText(share.points).replace(' points', ' percentage points')}</b> (${values.map(v => pct(v.share)).join(' → ')})</span></div>`}
      ${grids}<div class="cx-legend">${legend(c)}</div><p class="cx-note">One square is 1% of watch time, and one point is one square. ${gained}
      ${falling && falling.values[1].share < falling.values[0].share ? `${e(langName(falling.code))} gave up ${Math.round((falling.values[0].share - falling.values[1].share) * 100)}${falling.values[1].rate > falling.values[0].rate ? ' while still growing in minutes' : ''}.` : ''}</p></section></div>`;
  }
  function languageTable(c) {
    const rows = c.codes.map((code, i) => ({ name: langName(code), values: c.pair.map(p => languageValue(p, code)), color: c.lead === 'all' ? Math.min(i + 1, 4) : i, code }));
    if (c.selected.length >= 2) rows.push({ name: c.selected.map(langName).join(' + '), note: 'Selected languages together', values: c.pair.map(p => languageValue(p, 'all')), color: 4, code: 'all' });
    rows.push({ name: 'All watch time', note: 'Every language, for scale', color: 4, code: 'total', values: c.pair.map(p => ({ rate: totalRate(p), share: p.allSeconds ? 1 : null })) });
    const max = Math.max(1, ...rows.flatMap(r => r.values.map(v => v.rate || 0))) / .975;
    return `<section class="cx-languages"><div class="cx-section-title"><h2>Language by language</h2><span>${mark(0)}${e(c.pair[0].label)} ${mark(1)}${e(c.pair[1].label)}</span></div>
      <div class="cx-table-wrap"><div class="cx-language-table" role="table" aria-label="Language by language"><div class="cx-language-row cx-table-head" role="row"><span role="columnheader">Language</span><span role="columnheader">0 to ${decimal(max)} minutes a day</span><span role="columnheader">Minutes a day</span><span role="columnheader">Share of watch time</span></div>
      ${rows.map(r => {
        const story = moveStory(...r.values.map(v => v.rate)), share = shareStory(...r.values.map(v => v.share == null ? null : v.share * 100));
        const positions = r.values.map(v => (v.rate || 0) / max * 100);
        return `<div class="cx-language-row ${r.note ? 'cx-total-row' : ''}${r.code === c.lead ? ' is-lead' : ''}" role="row" data-lang="${e(r.code)}">
          <div role="rowheader">${swatch(r.color)}<b>${e(r.name)}</b>${r.note ? `<small>${r.note}</small>` : ''}</div>
          <div role="cell"><div class="cx-dumbbell cx-line-${Math.min(r.color, 4)}" role="img" aria-label="${e(`${r.name}: ${r.values.map(v => rateText(v.rate)).join(' to ')} minutes per calendar day`)}">
          ${story.state === 'incomplete' ? '' : `<b style="left:${Math.min(...positions)}%;width:${Math.abs(positions[1] - positions[0])}%"></b><i style="left:${positions[0]}%"></i><i style="left:${positions[1]}%"></i>`}</div></div>
          <div role="cell"><span class="cx-mobile-label">Minutes a day</span><b>${r.values.map(v => rateText(v.rate)).join(' → ')}</b><small>${e(changeText(story))}</small></div>
          <div role="cell"><span class="cx-mobile-label">Share of watch time</span><b>${r.values.map(v => pct(v.share)).join(' → ')}</b><small>${r.code === 'total' && share.points != null ? 'The whole' : pointsText(share.points)}</small></div></div>`;
      }).join('')}</div></div>${contribution(c)}</section>`;
  }
  function contribution(c) {
    if (c.selected.length < 2 || c.pair.some(p => !p.calendarDays)) return '';
    const delta = moveStory(...c.pair.map(p => p.minutesPerDay)).delta;
    const changes = c.codes.map(code => ({ code, delta: moveStory(...c.pair.map(p => languageValue(p, code).rate)).delta }));
    if (!delta || changes.some(x => x.delta * delta <= 0)) return '';
    const sum = changes.reduce((n, x) => n + Math.abs(x.delta), 0);
    return `<div class="cx-contribution"><h3>Where the ${delta > 0 ? 'extra ' : ''}${decimal(Math.abs(delta))} ${delta > 0 ? 'minutes a day came from' : 'fewer minutes a day went'}</h3>
      <div class="cx-contribution-bar" role="img" aria-label="${e(changes.map(x => `${langName(x.code)}: ${decimal(x.delta)} minutes a day, ${Math.round(Math.abs(x.delta) / sum * 100)}% of the change`).join('. '))}">
      ${changes.map(x => `<span class="cx-color-${color(x.code, c)}" style="flex:${Math.abs(x.delta)}"><b>${e(langName(x.code))} ${Math.round(Math.abs(x.delta) / sum * 100)}%</b></span>`).join('')}</div>
      <p class="cx-note">${changes.map(x => `${e(langName(x.code))} ${x.delta > 0 ? '+' : ''}${decimal(x.delta)} min`).join(' · ')}</p>
      ${c.lead !== 'all' ? `<p class="cx-note">${e(c.what)} was ${pct(languageValue(c.pair[0], c.lead).share)} of ${e(c.pair[0].label)} viewing and ${Math.round(Math.abs(changes.find(x => x.code === c.lead)?.delta || 0) / sum * 100)}% of the ${delta > 0 ? 'increase' : 'decrease'}.</p>` : ''}</div>`;
  }
  function sequence(d, c) {
    if (c.items.length < 3) return '';
    const values = c.items.map(p => languageValue(p, c.lead)), max = Math.max(1, ...values.map(v => v.rate || 0));
    const moves = c.items.slice(1).map((p, i) => ({ from: c.items[i], to: p, story: moveStory(values[i].rate, values[i + 1].rate) }));
    const headline = moves.map((m, i) => m.to.status === 'upcoming'
      ? `Next: ${m.to.label}, starting ${rangeText({ start: dates(m.to, d)[0], end: dates(m.to, d)[0] })}.`
      : m.story.state === 'incomplete' ? `${m.from.label} to ${m.to.label}: not measured yet.`
        : `${i ? 'Then ' : ''}${m.story.figure} from ${m.from.label} to ${m.to.label}.`).join(' ');
    return `<section class="cx-sequence"><p class="cx-eyebrow">${swatch(0)}${e(c.what)} · Minutes a day · Period by period</p><h2>${e(headline)}</h2>
      <div class="cx-sequence-scroll"><div class="cx-columns">${c.items.map((p, i) => {
        const m = moves[i - 1], v = values[i];
        return `${i ? `<button type="button" class="cx-move" data-compare="move" data-value="${i}" data-key="compare:move:${i}" aria-pressed="${c.move === i}" aria-label="Feature move ${i}: ${e(m.from.label)} to ${e(p.label)}"><span aria-hidden="true">${m.story.delta < 0 ? '↘' : '↗'}</span><strong>${m.story.state === 'incomplete' ? '?' : e(m.story.figure)}</strong><span>${e(changeText(m.story))}</span><small>${e(p.label)} starts<br>${e(rangeText({ start: dates(p, d)[0], end: dates(p, d)[0] }))}</small></button>` : ''}
          <div class="cx-period-column" style="flex-grow:${p.plannedDays}"><div class="cx-period-plot" role="img" aria-label="${e(`${p.label}: ${v.rate == null ? 'Not started, nothing predicted' : `${rateText(v.rate)} minutes of ${c.what} per calendar day`}`)}">
          ${p.status === 'upcoming' ? `<div class="cx-upcoming">${i > 1 && c.items[i - 1].status === 'complete' && c.items[i - 2].status === 'complete' ? `<i class="cx-guide" aria-hidden="true" style="bottom:${values[i - 1].rate / max * 240}px"></i><i class="cx-guide" aria-hidden="true" style="bottom:${values[i - 2].rate / max * 240}px"></i><p><b>Stays near ${minutesText(values[i - 1].rate)}?</b><br>The change held.</p><p><b>Back toward ${minutesText(values[i - 2].rate)}?</b><br>It depended on ${e(c.items[i - 1].label)}.</p>` : '<p>Not started</p>'}</div>`
            : `<strong>${minutesText(v.rate)}</strong><i style="height:${(v.rate || 0) / max * 240}px;${v.rate > 0 ? 'min-height:2px' : ''}"></i>`}</div>
          <b>${mark(p.index ?? i)} ${i + 1} · ${e(p.label)}</b><p class="cx-note">${e(dateLabel(p, d))}<br>${dayText(p.plannedDays)}${p.status === 'running' ? ` · day ${p.calendarDays} of ${p.plannedDays}` : ''}</p>
          <div class="cx-share-strip ${p.status === 'upcoming' ? 'is-upcoming' : ''}" aria-hidden="true">${p.allSeconds ? strip(p, c) : ''}</div><p class="cx-note">${p.status === 'upcoming' ? 'No data yet. Nothing here is predicted.' : v.share == null ? 'No share to compare' : `${e(c.what)}: ${of100(v.share)} of every 100 minutes`}</p></div>`;
      }).join('')}</div></div>
      <p class="cx-note">Bar height is ${e(c.what)} minutes per calendar day. Column width follows the number of days. The thin strip under each period is its share of watch time.</p>
      <details class="cx-moves" open><summary>The moves</summary><div class="cx-moves-table"><table><thead><tr><th>Move</th><th>${e(c.what)}, minutes a day</th><th>${e(c.what)}, share of watch time</th>${c.codes.filter(code => code !== c.lead).slice(0, 2).map(code => `<th>${e(langName(code))}, minutes a day</th>`).join('')}</tr></thead>
      <tbody>${moves.map((m, i) => `<tr><th>${button('move', `${i + 1} → ${i + 2} · ${e(m.to.label)} starts`, `data-value="${i + 1}" aria-pressed="${c.move === i + 1}"`)}<small>${e(m.from.label)} to ${e(m.to.label)}</small></th>
      ${m.story.state === 'incomplete' ? `<td colspan="${2 + Math.min(2, c.codes.filter(code => code !== c.lead).length)}">Waiting for period ${!m.from.calendarDays ? i + 1 : i + 2}. This row fills in once it has recorded days.</td>` : `<td>${[values[i].rate, values[i + 1].rate].map(rateText).join(' → ')}<small>${e(changeText(m.story))}</small></td><td>${[values[i].share, values[i + 1].share].map(pct).join(' → ')}<small>${pointsText(shareStory(...[values[i].share, values[i + 1].share].map(n => n == null ? null : n * 100)).points)}</small></td>${c.codes.filter(code => code !== c.lead).slice(0, 2).map(code => `<td>${[m.from, m.to].map(p => rateText(languageValue(p, code).rate)).join(' → ')}<small>${e(changeText(moveStory(...[m.from, m.to].map(p => languageValue(p, code).rate))))}</small></td>`).join('')}`}</tr>`).join('')}</tbody></table></div></details></section>`;
  }
  function details(d, c) {
    const rows = [
      ['Elapsed calendar days', p => `${p.calendarDays}${p.includesToday ? ' (today partial)' : ''}`],
      ['Planned calendar days', p => p.plannedDays], ['Days with selected playback', p => p.activeDays],
      ['Selected watch time', p => spent(p.seconds)], ['All watch time', p => spent(p.allSeconds)],
      ['Foreground', p => spent(p.foregroundSeconds)], ['Background', p => spent(p.backgroundSeconds)],
      ['Context not recorded', p => spent(p.unspecifiedSeconds)], ['Needs language review', p => spent(p.reviewSeconds)],
    ];
    return `<div class="cx-details"><details data-cx-details="totals"><summary>Underlying totals</summary><div class="cx-totals"><table><thead><tr><th>Measure</th>${c.pair.map(p => `<th>${e(p.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(([name, value]) => `<tr><th>${name}</th>${c.pair.map(p => `<td>${e(value(p))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
      <details data-cx-details="method"><summary>How this is calculated</summary><p>Minutes per calendar day is recorded minutes divided by the unique calendar days selected. Dates are inclusive, and a date that appears twice in one group counts once. Today counts as one day while it is still running. Future days do not enter the average. Share is a language's part of all recorded watch time.</p><p>Days follow ${e(d.timezone)}. Shares include unknown, mixed and no-speech time in their denominator. These are observed differences between the periods you chose, not proof of a cause. Concluding locks periods; numbers stay live as language classifications are reviewed.</p></details>
      <p class="cx-note">As of ${e(new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: d.timezone }).format(new Date(d.asOf)))} · ${e(d.timezone)}</p></div>`;
  }
  function results(d, c) {
    if (!c.items.length) return '<div class="cx-empty"><h2>Plan your first experiment</h2><p>Choose the periods above, then save to compare your language consumption.</p></div>';
    if (c.items.length === 1) {
      const p = c.items[0];
      return `<div class="cx-empty"><h2>Add a second period to compare</h2><h3>${e(p.label)}</h3><p>${rateText(p.minutesPerDay)} minutes a day · ${dayText(p.calendarDays)}</p>${p.languages.map(l => `<p>${e(langName(l.lang))}: ${rateText(l.minutesPerDay)} minutes a day</p>`).join('')}</div>`;
    }
    return `${sequence(d, c)}<div class="cx-featured"><div class="cx-section-title"><span class="cx-eyebrow">Featured move ${c.move} · ${e(c.pair[0].label)} to ${e(c.pair[1].label)}</span>${button('reverse', '⇄ Read backwards', 'data-key="compare:reverse"')}</div>
      ${hero(d, c)}${lenses(c)}${languageTable(c)}${details(d, c)}</div>`;
  }
  return { context, results, dateLabel };
}

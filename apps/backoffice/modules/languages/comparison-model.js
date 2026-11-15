// Calendar arithmetic uses date-only UTC values. The server supplies "today" in its own zone.
const DAY = 86400000;
const fail = message => Object.assign(Error(message), { status: 422 });
export const round1 = n => Math.round((n + Number.EPSILON) * 10) / 10;
export const decimal = n => n == null ? 'not available' : round1(n).toLocaleString('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const rateText = n => n > 0 && round1(n) === 0 ? 'under 0.1' : decimal(n);
export const dayText = n => `${n.toLocaleString('en')} day${n === 1 ? '' : 's'}`;
export function dateNumber(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(iso) || iso < '2000-01-01') throw fail('Use dates in YYYY-MM-DD format, from 2000 onwards');
  const n = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== iso) throw fail('Choose a valid calendar date');
  return n;
}
export const addDays = (iso, n) => new Date(dateNumber(iso) + n * DAY).toISOString().slice(0, 10);
export const length = p => Math.max(0, (dateNumber(p.end) - dateNumber(p.start)) / DAY + 1);
export function periodDays(p, through = p.end) {
  const count = Math.max(0, (Math.min(dateNumber(p.end), dateNumber(through)) - dateNumber(p.start)) / DAY + 1);
  return Array.from({ length: count }, (_, n) => addDays(p.start, n));
}
export function periodFacts(dates, today) {
  const planned = [...new Set(dates)].sort(), elapsed = planned.filter(d => d <= today);
  return {
    plannedDays: planned.length, calendarDays: elapsed.length, includesToday: elapsed.includes(today),
    status: !elapsed.length ? 'upcoming' : planned.at(-1) < today ? 'complete' : 'running',
  };
}
const validLanguage = s => typeof s === 'string' && s.length <= 35
  && /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/.test(s.trim().toLowerCase())
  && !/^(und|mul|zxx)-/.test(s.trim().toLowerCase());
export function normalizeConfig(input, today, old = null) {
  if (input.groups) throw fail('Use comparison v2 periods instead of groups. Reload this page before saving.');
  if (Object.keys(input).some(k => !['baseRevision', 'periods', 'selectedLanguages', 'concludedAt', 'leadLanguage'].includes(k))) throw fail('Unknown comparison field');
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw fail('Invalid comparison revision');
  if (!Array.isArray(input.periods) || input.periods.length > 128) throw fail('Choose up to 128 periods');
  const selection = input.selectedLanguages ?? [];
  if (!Array.isArray(selection) || selection.length > 128 || selection.some(s => !validLanguage(s))) throw fail('Choose up to 128 valid language codes');
  const occupied = new Map(), max = addDays(today, 366);
  const periods = input.periods.map(p => {
    if (!p || Object.keys(p).some(k => !['label', 'start', 'end'].includes(k)) || typeof p.label !== 'string') throw fail('Invalid period');
    const label = p.label.trim();
    if (!label || [...label].length > 80) throw fail('Use a group name up to 80 characters');
    const count = length(p);
    if (!count || p.end > max) throw fail('Periods must end on or after their start, at most 366 days after today');
    if (count > 3660) throw fail('Choose at most 3,660 unique calendar days');
    for (const d of periodDays(p)) {
      if (occupied.has(d) && occupied.get(d) !== label) throw fail('A date can belong to one period only');
      occupied.set(d, label);
    }
    if (occupied.size > 3660) throw fail('Choose at most 3,660 unique calendar days');
    return { label, start: p.start, end: p.end };
  }).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const merged = [];
  for (const p of periods) {
    const last = merged.at(-1);
    if (last?.label === p.label && p.start <= addDays(last.end, 1)) last.end = last.end > p.end ? last.end : p.end;
    else merged.push(p);
  }
  const result = { baseRevision: input.baseRevision, periods: merged, selectedLanguages: [...new Set(selection.map(s => s.trim().toLowerCase()))].sort(), concludedAt: input.concludedAt ?? null };
  if (input.leadLanguage != null) {
    if (input.leadLanguage !== 'all' && !validLanguage(input.leadLanguage)) throw fail('Choose a valid lead language');
    const lead = input.leadLanguage.trim().toLowerCase();
    if (lead === 'all' || !result.selectedLanguages.length || result.selectedLanguages.includes(lead)) result.leadLanguage = lead;
  }
  if (result.concludedAt !== null) {
    dateNumber(result.concludedAt);
    if (!merged.length || merged.some(p => p.end >= today)) throw fail('Every period must be complete before concluding');
    if (result.concludedAt > today || merged.some(p => p.end >= result.concludedAt)) throw fail('Choose a conclusion date after the periods and no later than today');
  }
  if (old) {
    if (old.baseRevision !== result.baseRevision) throw Object.assign(Error('Comparison changed in another browser. Reload saved periods before saving.'), { status: 409 });
    if (old.concludedAt && (old.periods.length !== result.periods.length
      || old.periods.some((p, i) => ['label', 'start', 'end'].some(key => p[key] !== result.periods[i][key])))) throw fail('Reopen the experiment to edit periods');
    if (old.concludedAt && result.concludedAt && old.concludedAt !== result.concludedAt) throw fail('Reopen the experiment before changing its conclusion date');
  }
  return result;
}
export function planPeriods(start, days, count = 3) {
  if (!Number.isInteger(days) || days < 1 || days * count > 3660 || ![2, 3].includes(count)) throw fail('Choose a whole number of days, at least 1');
  return (count === 3 ? ['Off, before', 'On', 'Off, after'] : ['Off', 'On']).map((label, i) => ({
    label, start: addDays(start, i * days), end: addDays(start, (i + 1) * days - 1),
  }));
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function rangeText(p) {
  try { dateNumber(p.start); dateNumber(p.end); } catch { return 'Incomplete period'; }
  const [ay, am, ad] = p.start.split('-').map(Number), [by, bm, bd] = p.end.split('-').map(Number);
  const end = `${bd} ${MONTHS[bm - 1]} ${by}`;
  if (p.start === p.end) return end;
  return `${ad}${ay !== by ? ` ${MONTHS[am - 1]} ${ay}` : am !== bm ? ` ${MONTHS[am - 1]}` : ''} to ${end}`;
}
export const minutesText = n => n == null ? 'no average' : n > 0 && round1(n) === 0 ? 'under 0.1 min'
  : n > 0 && n < 1 ? 'under 1 min' : n < 100 ? `${Math.round(n)} min` : `${Math.floor(Math.round(n) / 60)}h ${Math.round(n) % 60}m`;
export const percentText = n => n == null ? '' : `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('en', { minimumFractionDigits: Math.abs(n) < 100 ? 1 : 0, maximumFractionDigits: Math.abs(n) < 100 ? 1 : 0 })}%`;
export const multiplierText = n => n.toLocaleString('en', { minimumFractionDigits: n < 10 ? 1 : 0, maximumFractionDigits: n < 10 ? 1 : 0 });
export function moveStory(from, to) {
  if (from == null || to == null) return { state: 'incomplete', figure: '', delta: null, percent: null };
  const a = round1(from), b = round1(to), delta = round1(b - a);
  const base = { rates: [a, b], delta, percent: a > 0 ? delta / a * 100 : null, ratio: a > 0 ? b / a : null, trace: [from > 0 && a === 0, to > 0 && b === 0] };
  if (!from && !to) return { ...base, state: 'none', figure: '0 min' };
  if (a === b) return { ...base, state: 'same', exact: from === to, figure: minutesText(to || from) };
  if (!a) return { ...base, state: 'from-zero', figure: minutesText(b) };
  if (!b) return { ...base, state: 'to-zero', figure: base.trace[1] ? 'almost none' : '0 min' };
  return { ...base, state: delta > 0 ? 'increase' : 'decrease', figure: b / a >= 2 ? `${multiplierText(b / a)}×` : percentText(base.percent) };
}
export function movePhrase(story, what, toLabel) {
  switch (story.state) {
    case 'none': return `of ${what} in either period`;
    case 'same': return `of ${what} a day in both. ${story.exact ? 'No change.' : 'About the same.'}`;
    case 'from-zero': return `of ${what} a day with ${toLabel}, from ${story.trace[0] ? 'almost none' : 'none'}`;
    case 'to-zero': return `of ${what} a day with ${toLabel}, down from ${decimal(story.rates[0])} min`;
    case 'increase': return `${story.ratio >= 2 ? 'as much' : 'more'} ${what} every day with ${toLabel}`;
    case 'decrease': return `less ${what} a day with ${toLabel}`;
    default: return 'Nothing to compare yet.';
  }
}
export function shareStory(from, to) {
  if (from == null || to == null) return { state: 'incomplete', points: null };
  const shares = [round1(from), round1(to)], points = round1(shares[1] - shares[0]);
  return { state: points ? 'change' : 'same', points, shares };
}
export const pointsText = points => points == null ? 'No share to compare' : !points ? 'No change' : `${points > 0 ? '+' : '-'}${decimal(Math.abs(points))} points`;
export function changeText(story) {
  if (story.state === 'incomplete') return 'Not measured yet';
  if (story.state === 'none' || story.state === 'same') return story.exact === false ? 'About the same' : 'No change';
  const diff = `${story.delta > 0 ? '+' : '-'}${decimal(Math.abs(story.delta))} a day`;
  if (story.state === 'from-zero') return `${diff} (from ${story.trace[0] ? 'almost none' : 'none'})`;
  if (story.state === 'to-zero' && story.trace[1]) return `${diff} (to almost none)`;
  return `${diff}${story.ratio >= 2 ? ` · ${multiplierText(story.ratio)} times` : ''} (${percentText(story.percent)})`;
}
export function subLine(story, what, shares, totals) {
  if (story.state === 'incomplete') return '';
  const delta = story.delta;
  let text = delta ? `That is ${decimal(Math.abs(delta))} ${delta > 0 ? 'more' : 'fewer'} minutes a day`
    + (['increase', 'decrease'].includes(story.state) ? `, a ${percentText(Math.abs(story.percent)).replace('+', '')} ${delta > 0 ? 'increase' : 'decrease'}` : '') + '.' : '';
  if (shares.every(n => n != null)) {
    const [a, b] = shares.map(n => n > 0 && Math.round(n * 100) === 0 ? 'under 1' : Math.round(n * 100));
    text += ` ${what} ${a === b ? `stayed at ${a}` : `also went from ${a} to ${b}`} of every 100 minutes watched`;
    if (totals[0] > 0 && Math.abs(totals[1] / totals[0] - 1) >= .1) {
      const up = totals[1] > totals[0];
      text += up && delta > 0 ? ', even though total viewing rose too' : `, while total viewing ${up ? 'rose' : 'fell'}`;
    }
    text += '.';
  }
  return text.trim();
}
export function scaleBlocks(from, to) {
  const values = [round1(from || 0), round1(to || 0)], small = Math.min(...values), large = Math.max(...values);
  if (!small || large / small > 12) return { blocks: [], widths: [from, to].map(n => large ? Math.max(0, (round1(n || 0) / large) * 100) : 0) };
  const full = Math.floor(large / small), remainder = round1(large - full * small);
  return { blocks: [...Array(full).fill(small), ...(remainder > 0 ? [remainder] : [])], full, remainder: remainder / small, smaller: values[0] <= values[1] ? 0 : 1 };
}
export function waffleCounts(weights) {
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (!total) return null;
  const exact = weights.map(n => Math.max(0, n) / total * 100), result = exact.map(Math.floor);
  const order = exact.map((n, i) => ({ i, remainder: n - result[i] })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (let n = 0, left = 100 - result.reduce((a, b) => a + b, 0); n < left; n++) result[order[n].i]++;
  return result;
}
export function timeAxis(maxRate) {
  const max = Math.max(60, Math.ceil(maxRate / .85 / 60) * 60);
  const step = max === 60 ? 15 : max > 480 ? 120 : 60;
  return { max, ticks: Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step) };
}
export function dayGap(a, b) {
  const days = [a || 0, b || 0], missing = Math.abs(days[0] - days[1]);
  return { days, missing, equal: !missing, shorter: missing ? (days[0] < days[1] ? 0 : 1) : null, longest: Math.max(...days) };
}
export function observation(items) {
  const gap = dayGap(...items.map(p => p.calendarDays)), incomplete = items.filter(p => p.status !== 'complete');
  const early = !gap.equal || incomplete.length > 0 || items.some(p => p.includesToday);
  let title = `${Math.min(...gap.days)} days against ${gap.longest}.`, line;
  if (incomplete.length === 1 && incomplete[0].plannedDays > incomplete[0].calendarDays) {
    const p = incomplete[0];
    title = `${p.calendarDays} of ${p.plannedDays} days so far.`;
    line = `${p.label} runs until ${rangeText({ start: p.end, end: p.end })}.`;
  } else if (!gap.equal) line = `${items[gap.shorter].label} needs ${dayText(gap.missing)} more to match ${items[1 - gap.shorter].label}.`;
  else if (items.some(p => p.includesToday)) line = 'Same length, but today is still running.';
  else if (incomplete.length) line = 'Planned days are still ahead.';
  else line = 'Same length, and no day still running.';
  return { ...gap, early, stamp: early ? 'Early read' : 'Even windows', title, line };
}
export function languageValue(item, code) {
  if (code === 'all') return { seconds: item.seconds, rate: item.minutesPerDay, share: item.share };
  const row = item.languages.find(l => l.lang === code);
  return { seconds: row?.seconds || 0, rate: item.calendarDays ? (row?.seconds || 0) / 60 / item.calendarDays : null, share: item.allSeconds ? (row?.seconds || 0) / item.allSeconds : null };
}
export function leadLanguage(codes, items) {
  const metrics = code => {
    const values = items.map(i => languageValue(i, code));
    return [values.every(v => v.share != null) ? Math.abs(round1(values[1].share * 100) - round1(values[0].share * 100)) : 0,
      Math.abs(round1(values[1].rate || 0) - round1(values[0].rate || 0))];
  };
  return [...codes].sort((a, b) => {
    const aa = metrics(a), bb = metrics(b);
    return bb[0] - aa[0] || bb[1] - aa[1] || a.localeCompare(b);
  })[0] || 'all';
}

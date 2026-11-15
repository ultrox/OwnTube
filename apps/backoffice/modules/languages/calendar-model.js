import { addDays, dateNumber, length, periodDays, periodFacts } from './comparison-model.js';

export const patterns = [
  { key: 'off-on-off', text: 'Off, on, off', labels: ['Off, before', 'On', 'Off, after'] },
  { key: 'on-off-on', text: 'On, off, on', labels: ['On, first', 'Off', 'On, again'] },
  { key: 'off-on', text: 'Off, on', labels: ['Off', 'On'] },
  { key: 'on-off', text: 'On, off', labels: ['On', 'Off'] },
];
export const monday = date => addDays(date, -((new Date(dateNumber(date)).getUTCDay() + 6) % 7));
export const homeWindow = today => addDays(monday(today), -14);
export const placed = p => !!(p?.start && p?.end && p.start <= p.end);
export const ownerOf = (periods, day, except = -1) => periods.findIndex((p, i) => i !== except && placed(p) && day >= p.start && day <= p.end);
export function clipRange(start, end, periods, active, min, max) {
  const free = day => day >= min && day <= max && ownerOf(periods, day, active) < 0;
  if (!free(start)) return null;
  const direction = end >= start ? 1 : -1;
  let last = start;
  while (last !== end) {
    const next = addDays(last, direction);
    if (!free(next)) break;
    last = next;
  }
  return { start: last < start ? last : start, end: last > start ? last : start, clipped: last !== end };
}

// Both previews and clicks consume this decision, including reverse and clipped selections.
export function pickDecision({ periods, active, anchor, preset, fill, pattern, min, max }, day) {
  if (day < min || day > max) return { kind: 'none', ranges: [] };
  if (fill) {
    const n = preset || 10, labels = patterns.find(p => p.key === pattern)?.labels || patterns[0].labels;
    const ranges = labels.flatMap((label, i) => {
      const start = addDays(day, i * n);
      if (start > max) return [];
      const end = addDays(start, n - 1);
      return [{ label, start, end: end > max ? max : end, clipped: end > max }];
    });
    return { kind: 'template', ranges, clipped: ranges.length < labels.length || ranges.some(r => r.clipped) };
  }
  if (!anchor) {
    const owner = ownerOf(periods, day, active);
    if (owner >= 0) return { kind: 'select', active: owner, ranges: [] };
    if (!preset) return { kind: 'anchor', anchor: day, ranges: [] };
  }
  const range = clipRange(anchor || day, anchor ? day : addDays(day, preset - 1), periods, active, min, max);
  return { kind: range ? 'place' : 'none', ranges: range ? [range] : [], clipped: !!range?.clipped };
}

export function draftStats(period, daily, today, selected = []) {
  if (!placed(period)) return null;
  let dates;
  try {
    if (length(period) > 3660) return null;
    dates = periodDays(period);
  } catch { return null; }
  const facts = periodFacts(dates, today), elapsed = dates.filter(d => d <= today);
  if (elapsed.some(d => !daily.has(d))) return { ...facts, pending: true };
  const languages = new Map(selected.map(code => [code, 0]));
  let allSeconds = 0;
  for (const date of elapsed) {
    const day = daily.get(date);
    if (!day) continue;
    allSeconds += day.allSeconds;
    for (const row of day.languages) {
      if (!selected.length || selected.includes(row.lang)) languages.set(row.lang, (languages.get(row.lang) || 0) + row.seconds);
    }
  }
  const seconds = [...languages.values()].reduce((a, b) => a + b, 0);
  return { ...facts, allSeconds, seconds, minutesPerDay: elapsed.length ? seconds / 60 / elapsed.length : null,
    share: allSeconds ? seconds / allSeconds : null,
    languages: [...languages].map(([lang, seconds]) => ({ lang, seconds })) };
}

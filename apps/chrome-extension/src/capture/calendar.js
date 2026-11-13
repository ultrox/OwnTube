export function localDate(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return localDate(date.getTime()) === value ? date.getTime() : null;
}

export function shiftDate(date, delta) {
  const timestamp = parseDate(date);
  if (timestamp === null) return null;
  const next = new Date(timestamp);
  next.setDate(next.getDate() + delta);
  return localDate(next.getTime());
}

export function datesBetween(start, end) {
  const dates = [];
  for (let date = start; date && date <= end; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

// Display-only calendar slots. Untracked days are distinguished with installedAt
// by the UI; these placeholders never enter storage or the comparison baseline.
export function chartWindow(daily, installed, today, range) {
  const minimumStart = shiftDate(today, range === '7d' ? -6 : -29);
  const start = range === 'all' && installed < minimumStart ? installed : minimumStart;
  return datesBetween(start, today).map(date => ({ date, ...(daily[date] ?? { byLang: {}, videos: 0, searches: 0 }) }));
}

// Split real elapsed intervals at local midnights, including 23/25-hour DST days.
export function splitInterval(t, seconds) {
  const end = t + seconds * 1000;
  const parts = [];
  for (let cursor = t; cursor < end;) {
    const midnight = new Date(cursor);
    midnight.setHours(24, 0, 0, 0);
    const next = Math.min(end, midnight.getTime());
    parts.push({ date: localDate(cursor), seconds: (next - cursor) / 1000 });
    cursor = next;
  }
  return parts;
}

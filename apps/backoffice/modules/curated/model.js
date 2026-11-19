export const key = (c) => c.videoId ? `video:${c.videoId}` : c.playlistId ? `playlist:${c.playlistId}` : `channel:${c.channelId || ''}`;
export const clone = (v) => structuredClone(v);

// Same editorial overlay as the server: explicit order first, new upstream
// recommendations afterwards; explicit removals win over additions.
export function compose(source, edits) {
  const rows = clone(source);
  for (const [id, edit] of Object.entries(edits.rows)) {
    if (edit.added.length && !rows.some(r => r.id === id)) rows.push({ id, title: edit.title, items: [], next: null });
  }
  return rows.map(row => {
    const edit = edits.rows[row.id];
    if (edit) {
      const added = new Set(edit.added.map(key));
      row.items = row.items.filter(c => !added.has(key(c))).concat(edit.added);
      const ranks = new Map(edit.order.map((k, i) => [k, i]));
      row.items.sort((a, b) => (ranks.get(key(a)) ?? Infinity) - (ranks.get(key(b)) ?? Infinity));
    }
    const seen = new Set();
    row.items = row.items.filter(c => {
      const k = key(c);
      if (seen.has(k) || edits.removed.includes(k) || (c.channelId && edits.blockedChannels.includes(c.channelId))) return false;
      seen.add(k);
      return true;
    });
    row.items = row.items.slice(0, edit?.limit ?? edits.cardLimit ?? 48);
    row.next = null;
    return row;
  });
}
export function editRow(edits, row) {
  return edits.rows[row.id] ||= { title: row.title, added: [], order: [] };
}
export function move(edits, row, from, to) {
  const order = row.items.map(key);
  if (from < 0 || to < 0 || from >= order.length || to >= order.length) return;
  order.splice(to, 0, order.splice(from, 1)[0]);
  const edit = editRow(edits, row);
  edit.order = order.concat(edit.order.filter(k => !order.includes(k)));
}
export function insert(edits, row, card, position) {
  insertMany(edits, row, [card], position);
}
export function insertMany(edits, row, cards, position) {
  const unique = [...new Map(cards.map(c => [key(c), c])).values()];
  const keys = unique.map(key), added = new Set(keys), edit = editRow(edits, row);
  edits.removed = edits.removed.filter(v => !added.has(v));
  edit.added = edit.added.filter(c => !added.has(key(c))).concat(unique);
  const order = row.items.map(key).filter(v => !added.has(v));
  order.splice(Math.min(Math.max(position, 0), order.length), 0, ...keys);
  edit.order = order.concat(edit.order.filter(k => !order.includes(k)));
}

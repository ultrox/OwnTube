// ISO 639-1 names via the browser's locale data, plus app-specific and regional codes.
const codes = `aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu bcs mul zxx und pt-BR zh-Hans zh-Hant`.split(' ');

export const spokenLanguageCodes = codes.filter(code => !['und', 'mul', 'zxx'].includes(code)).map(code => code.toLowerCase());

export function openLanguagePicker({ id, title, current, esc, langName, save, returnFocus,
  availableCodes = null,
  heading = 'Choose audio language', note = 'Choosing a language saves immediately for all recorded versions in this row.' }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'dialog language-picker';
  dialog.setAttribute('aria-labelledby', 'language-picker-title');
  const names = [...new Set(availableCodes ?? codes)].map((code) => {
    let native = '';
    try { native = new Intl.DisplayNames([code], { type: 'language' }).of(code); } catch { /* special codes */ }
    return { code, name: langName(code), native };
  }).sort((a, b) => a.name.localeCompare(b.name));
  dialog.innerHTML = `<div class="language-picker__head"><h2 id="language-picker-title">${esc(heading)}</h2><button type="button" class="btn btn--sm" data-picker-close>Close</button></div>
    <p>${esc(title)}</p><p class="note">${esc(note)}</p>
    <label class="label" for="language-search">Search by language or code</label>
    <input id="language-search" class="input" type="search" placeholder="${availableCodes == null ? 'Russian, Japanese, ru, ja…' : 'Search recorded languages…'}" autocomplete="off">
    <div class="language-picker__results" role="group" aria-label="Languages"></div>`;
  const input = dialog.querySelector('input');
  const results = dialog.querySelector('.language-picker__results');
  function search() {
    const q = input.value.trim().toLowerCase();
    const matches = names.filter((l) => `${l.name} ${l.native} ${l.code}`.toLowerCase().includes(q));
    // Permit a regional/three-letter language code the shortlist does not contain.
    if (availableCodes == null && q && q.length <= 35 && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(q) && !/^(und|mul|zxx)-/.test(q) && !names.some((l) => l.code.toLowerCase() === q)) {
      matches.push({ code: q, name: langName(q), native: 'Language code' });
    }
    results.innerHTML = matches.length ? matches.map((l) => `<button type="button" class="language-picker__choice" data-picker-code="${esc(l.code.toLowerCase())}" aria-pressed="${current === l.code.toLowerCase()}"><span>${esc(l.name)}${l.native && l.native !== l.name ? `<small>${esc(l.native)}</small>` : ''}</span><code>${esc(l.code)}</code></button>`).join('') : `<p>${availableCodes == null ? 'No matching language. Try its language code.' : names.length ? 'No matching recorded language in these periods.' : 'No languages recorded in the saved periods for this scope. Save your periods or change device/person to see available languages.'}</p>`;
  }
  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-picker-close]')) dialog.close();
    const button = e.target.closest('[data-picker-code]');
    if (button) { const code = button.dataset.pickerCode; dialog.close(); save(id, code); }
  });
  dialog.addEventListener('close', () => { dialog.remove(); returnFocus?.focus(); }, { once: true });
  dialog.addEventListener('keydown', (e) => {
    // Search inputs otherwise consume Escape to clear their text before the dialog sees it.
    if (e.key === 'Escape') { e.preventDefault(); dialog.close(); }
  });
  input.addEventListener('input', search);
  document.body.append(dialog);
  search();
  dialog.showModal();
  input.focus();
}

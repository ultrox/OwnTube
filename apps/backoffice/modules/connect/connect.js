const $ = id => document.getElementById(id);
let busy = false;
async function request(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(Error(data?.error || `Request failed (${response.status})`), { status: response.status });
  if (!data) throw Error('The server’s answer could not be read.');
  return data;
}
function error(e) {
  $('error').hidden = !e;
  $('error').textContent = e?.message || '';
  if (e?.status === 401) { $('login').hidden = false; $('approve').hidden = true; $('owner-key').focus(); }
}
async function ready() {
  const data = await request('pairing');
  const select = $('person');
  select.replaceChildren(new Option('Choose a person', ''), ...data.people.map(p => new Option(p.name, p.id)), new Option('+ Add a person', '__new__'));
  if (!data.people.length) { select.value = '__new__'; }
  $('new-person').hidden = select.value !== '__new__';
  $('person-name').required = select.value === '__new__';
  $('login').hidden = true; $('approve').hidden = false; $('code').focus();
}
$('person').addEventListener('change', () => {
  $('new-person').hidden = $('person').value !== '__new__';
  $('person-name').required = !$('new-person').hidden;
  if (!$('new-person').hidden) $('person-name').focus();
});
$('login').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  busy = true; const button = $('login').querySelector('button'); button.disabled = true; error(null);
  try { await request('login', { token: $('owner-key').value.trim() }); $('owner-key').value = ''; await ready(); }
  catch (e) { error(e); } finally { busy = false; button.disabled = false; }
});
$('approve').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const person = $('person').value === '__new__' ? $('person-name').value.trim() : $('person').value;
  if (!person) { error(Error('Choose whose browser this is, or add a person.')); return; }
  busy = true; $('approve-button').disabled = true; error(null);
  try {
    const data = await request('pairing/approve', { code: $('code').value.trim(), label: $('label').value.trim(), person });
    $('approve').hidden = true; $('success').hidden = false;
    $('success-title').textContent = `${data.label}${data.person ? ` · ${data.person}` : ''}`;
    $('success-title').tabIndex = -1; $('success-title').focus();
  } catch (e) { error(e); } finally { busy = false; $('approve-button').disabled = false; }
});
$('another').addEventListener('click', async () => {
  $('success').hidden = true; $('code').value = ''; $('label').value = 'Chrome'; $('person-name').value = '';
  try { await ready(); } catch (e) { error(e); }
});
void ready().catch(e => {
  if (e.status === 401) { $('login').hidden = false; $('owner-key').focus(); }
  else error(e);
}).finally(() => { $('loading').hidden = true; });

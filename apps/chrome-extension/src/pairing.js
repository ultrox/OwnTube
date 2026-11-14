import { serverOrigin } from './device-pairing.js';
const $ = id => document.getElementById(id);
let busy = false, pairing = null, timer;
const message = async value => {
  const result = await chrome.runtime.sendMessage(value);
  if (!result?.ok) throw Error(result?.error || 'The extension did not respond. Reopen this tab and try again.');
  return result;
};
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
function countdown() {
  if (pairing?.state !== 'pending') return;
  const seconds = Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000));
  $('expires').textContent = seconds ? `Code expires in ${Math.ceil(seconds / 60)} minute${seconds > 60 ? 's' : ''}.` : 'Checking whether this code was approved…';
}
function show(p) {
  pairing = p;
  $('intro').hidden = !['idle', 'expired'].includes(p.state);
  $('waiting').hidden = p.state !== 'pending';
  $('connected').hidden = p.state !== 'connected';
  $('connect').textContent = p.state === 'expired' ? 'Get a new code' : 'Connect';
  if (p.server) $('server').value = p.server;
  if (p.state === 'pending') {
    $('code').textContent = p.code;
    $('approve-link').href = `${p.server}/connect/`;
    countdown();
  }
  if (p.state === 'connected') {
    $('saved-connection').textContent = `${p.label}${p.person ? ` · ${p.person}` : ''}`;
    $('dashboard').href = p.server;
    notice('Connection saved. This browser is ready.');
  }
  if (p.state === 'expired') notice('That code expired. Get a new code to continue.');
}
async function poll() {
  if (busy || pairing?.state === 'connected') return;
  busy = true;
  try {
    const result = await message({ tag: 'PairStatus' });
    notice('');
    show(result.pairing);
  } catch (error) { notice(`${error.message} We’ll retry automatically.`, true); }
  finally { busy = false; $('connect').disabled = false; $('fields').disabled = false; }
}
$('connect').addEventListener('click', async () => {
  if (busy) return;
  busy = true; $('connect').disabled = true;
  try {
    const server = serverOrigin($('server').value.trim());
    // Ask in this click gesture, in a normal tab that survives Chrome's prompt.
    if (!await chrome.permissions.request({ origins: [`${server}/*`] })) throw Error('Allow access to your OwnTube server to connect.');
    notice('Getting your code…');
    const result = await message({ tag: 'PairStart', server });
    notice(''); show(result.pairing);
  } catch (error) { notice(error.message, true); }
  finally { busy = false; $('connect').disabled = false; }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(pairing.code); notice('Code copied.'); }
  catch { notice('Select the code above to copy it.'); }
});
$('pair').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true; $('fields').disabled = true;
  try {
    const server = serverOrigin($('server').value.trim()), token = $('token').value.trim();
    if (!await chrome.permissions.request({ origins: [`${server}/*`] })) throw Error('Server permission was not granted.');
    const result = await message({ tag: 'Configure', server, token });
    $('token').value = '';
    show({ state: 'connected', server, label: result.config.label || 'This browser', person: result.config.person || '' });
  } catch (error) { notice(error.message, true); }
  finally { busy = false; $('fields').disabled = false; }
});
void poll();
timer = setInterval(() => { countdown(); void poll(); }, 5000);
window.addEventListener('pagehide', () => clearInterval(timer));

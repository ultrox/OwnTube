const $=id=>document.getElementById(id);
const message=async value=>{
  const result=await chrome.runtime.sendMessage(value);
  if(!result?.ok) throw Error(result?.error || 'The collector did not respond. Reload this settings tab and try again.');
  return result;
};
function notice(text,error=false) {
  $('notice').textContent=text;$('notice').className=error?'error':'';
}
function connection(state) {
  $('saved-connection').textContent=state.config
    ?`Saved: ${state.config.server} · device ${state.config.deviceId}. ${state.count} queued, ${state.blockedCount} held.`
    :'Not paired yet.';
  $('dashboard').hidden=!state.config;
  if(state.config) $('dashboard').href=state.config.server;
}
$('pair').addEventListener('submit',async event=>{
  event.preventDefault();
  if($('fields').disabled) return;
  try {
    const url=new URL($('server').value.trim());
    if(url.username || url.password || url.pathname!=='/' || url.search || url.hash || !(url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw Error('Use an HTTPS server origin, or local HTTP.');
    const server=url.origin,token=$('token').value.trim();
    if(!token) throw Error('Paste this browser’s device key from the dashboard.');
    // Request immediately in the submit gesture. This page remains open while Chrome asks.
    const permission=chrome.permissions.request({origins:[`${server}/*`]});
    $('fields').disabled=true;notice('Allow access to your server if Chrome asks…');
    if(!await permission) throw Error('Server permission was not granted. Your saved connection has not changed.');
    notice('Checking the device key and saving…');
    const saved=await message({tag:'Configure',server,token});
    connection(saved);$('server').value=saved.config.server;$('token').value='';
    notice('Connection saved. You can close this tab. Refresh your YouTube tabs to connect capture.');
  } catch(error) {notice(error.message,true);}
  finally {$('fields').disabled=false;}
});
void (async()=>{
  try {
    const state=await message({tag:'Status'});connection(state);
    if(state.config) $('server').value=state.config.server;
    $('fields').disabled=false;
  } catch(error) {notice(error.message,true);}
})();

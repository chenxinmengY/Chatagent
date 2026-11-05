const $ = id => document.getElementById(id);
let busy = false, gatewayEnabled = false, invitation = null;
const errors = { DEVICE_GATEWAY_DISABLED: '设备连接入口尚未启用，目前不能添加设备。', AUTH_REQUIRED: '服务已重新启动，请刷新后重试。', DEVICE_NOT_FOUND: '设备已不存在，请刷新列表。' };
async function api(route, body) {
  const bootResponse = await fetch('/v1/bootstrap', { signal: AbortSignal.timeout(10000) });
  if (!bootResponse.ok) throw Error('OFFLINE');
  const boot = await bootResponse.json();
  $('gateway-note').textContent = boot.deviceRemoteEnabled ? '私人设备入口：' + boot.deviceUrl + '。手机须连接同一私人网络，并通过配对后访问。' : '远程连接尚未启用。当前配对入口仅供本机验证，手机暂时无法连接。';
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'X-Chatagent-Token': boot.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}
function renderInvitation() {
  if (invitation && Date.now() >= invitation.expiresAt) invitation = null;
  $('invitation').hidden = !invitation;
  $('credential').value = invitation?.credential ?? '';
  $('expires').textContent = invitation ? '有效期至 ' + new Date(invitation.expiresAt).toLocaleTimeString() : '';
}
function controls() {
  $('invite').disabled = busy || !gatewayEnabled;
  $('cancel-invite').disabled = busy;
  $('refresh-devices').disabled = busy;
  for (const button of $('device-list').querySelectorAll('button')) button.disabled = busy;
}
async function run(operation) {
  if (busy) return;
  busy = true; controls();
  try { await operation(); }
  catch (error) { $('device-status').textContent = errors[error.message] ?? '操作未确认，请刷新核对。若配对凭据未显示，可重新生成一份，使旧邀请失效。'; }
  finally { busy = false; controls(); }
}
async function refresh() {
  const result = await api('/v1/devices'); gatewayEnabled = result.gatewayEnabled;
  $('device-list').replaceChildren();
  if (!result.devices.length) $('device-list').textContent = '还没有配对设备。';
  for (const device of result.devices) {
    const row = document.createElement('div'); row.className = 'device-row';
    const label = document.createElement('span'); label.textContent = device.name;
    const info = document.createElement('small'); info.textContent = (device.revoked_at === null ? '已配对 · ' : '已撤销 · ') + device.id.slice(0, 8);
    label.append(info); row.append(label);
    if (device.revoked_at === null) {
      const button = document.createElement('button'); button.textContent = '撤销设备';
      button.setAttribute('aria-label', '撤销设备 ' + device.name);
      button.onclick = () => run(async () => { await api('/v1/devices/' + device.id + '/revoke', {}); await refresh(); $('device-status').textContent = '设备已撤销，新的访问将被拒绝。'; });
      row.append(button);
    }
    $('device-list').append(row);
  }
  $('device-status').textContent = gatewayEnabled ? '本机配对验证入口已启用。' : '设备连接入口尚未启用，目前不能添加设备。';
}
$('invite').onclick = () => run(async () => { invitation = null; renderInvitation(); invitation = await api('/v1/pairing/invitations', {}); renderInvitation(); $('device-status').textContent = '已生成新邀请。配对完成后可刷新设备列表。'; });
$('cancel-invite').onclick = () => run(async () => { await api('/v1/pairing/cancel', {}); invitation = null; renderInvitation(); $('device-status').textContent = '本次邀请已取消。'; });
$('refresh-devices').onclick = () => run(refresh);
window.addEventListener('pagehide', () => { invitation = null; renderInvitation(); });
setInterval(renderInvitation, 1000);
void run(refresh);

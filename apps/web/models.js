const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const errors = {
  MODEL_CONFIG_CHANGED: '配置已被另一个窗口修改。请保留当前输入，重新打开页面后合并。',
  MODEL_CONFIG_INVALID: '请检查连接名称、模型名称、超时和输出上限；名称不能重复。',
  MODEL_ENDPOINT_INVALID: '地址需使用 HTTPS；本机服务可使用 localhost 或 127.0.0.1 的 HTTP 地址。不要包含密码、查询参数或锚点。',
  MODEL_BASE_URL_REQUIRED: '请填写 API 基础地址，例如 https://服务地址/v1，不要带 /chat/completions。',
  MODEL_ENDPOINT_KEY_REQUIRED: '服务地址已改变。请重新输入密钥，或勾选清除密钥后保存。',
  MODEL_KEY_INVALID: '密钥包含无效字符或首尾空白，请检查。',
  MODEL_NOT_READY: '请先选择连接，并完成该连接所需的密钥或账号授权。',
  MODEL_OAUTH_REQUIRED: 'Antigravity 使用账号登录授权，不能填写普通 API 密钥。',
  MODEL_OAUTH_INVALID: '账号授权资料格式无效，请重新通过独立授权准备。',
  MODEL_NATIVE_ADAPTER_MISSING: 'Antigravity 独立适配器尚未配置。',
  MODEL_NATIVE_ADAPTER_CHANGED: '本机 Antigravity 适配器版本已改变，需要重新核验后使用。',
  MODEL_NATIVE_ENDPOINT_INVALID: 'Antigravity 使用已核对的 Google 专用服务地址。',
  MODEL_PROXY_INVALID: '备用端本地代理配置无效，请检查连接配置。',
  MODEL_NATIVE_FAILED: 'Antigravity 请求未完成；没有重发生成请求。请检查独立账号授权和网络。',
  MODEL_REHEARSAL_LOCKED: '当前启动配置锁定为演练模式，外部连接测试与真实对话尚未启用。',
  MODEL_CREDENTIAL_STORE_UNAVAILABLE: 'Windows 密钥保护不可用，或密钥来自另一 Windows 用户。请在当前用户下重新填写。',
  MODEL_AUTH_FAILED: '服务拒绝认证，请检查密钥和模型访问权限。',
  MODEL_RATE_LIMITED: '服务暂时限流；没有自动重试。', MODEL_HTTP_FAILED: '服务返回失败；请检查 API 地址与协议。没有自动重试。',
  MODEL_RESPONSE_INVALID: '服务返回内容不符合 Chat Completions 协议，或输出未完整结束。', MODEL_RESPONSE_EMPTY: '服务没有返回有效回复。',
  MODEL_TIMEOUT: '连接测试超时；没有自动重试。', MODEL_CONNECTION_FAILED: '连接失败，请检查地址、网络与证书。', MODEL_TEST_BUSY: '已有连接测试正在进行。'
};
let value, selected, dirty = false, busy = false;
async function api(route, body) {
  const boot = await (await fetch('/v1/bootstrap')).json();
  const response = await fetch(route, { method: body ? 'POST' : 'GET', headers: { 'X-Chatagent-Token': boot.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw Error(errors[result.error] ?? '操作未完成，请保留输入后重试。'); return result;
}
function changed() { dirty = true; $('feedback').textContent = '有未保存的更改 · 保存配置不会自动开始对话'; }
function button(text, action) { const b = el('button', 'soft-button', text); b.onclick = action; return b; }
function field(host, label, current, update, type = 'text', help = '') {
  const wrap = el('label', 'management-field', label), input = el('input'); input.type = type; input.value = current ?? ''; input.setAttribute('aria-label', label);
  if (type === 'password') { input.autocomplete = 'new-password'; input.spellcheck = false; }
  input.oninput = () => { update(type === 'number' ? Number(input.value) : input.value); changed(); }; wrap.append(input); if (help) wrap.append(el('small', '', help)); host.append(wrap); return input;
}
function select(host, label, current, options, update) {
  const wrap = el('label', 'management-field', label), input = el('select'); input.setAttribute('aria-label', label);
  for (const [id, name] of options) input.append(new Option(name, id)); input.value = current;
  input.onchange = () => { update(input.value); changed(); }; wrap.append(input); host.append(wrap); return input;
}
function card(title, description) { const box = el('section', 'management-card'); box.append(el('h2', '', title), el('p', '', description)); return box; }
function render() {
  $('model-state').replaceChildren(); $('profiles').replaceChildren(); $('editor').replaceChildren();
  const state = card(value.networkAllowed ? '对话模式' : '演练模式 · 外部调用已锁定', value.networkAllowed ? '切换在新一轮对话生效。当前回复继续使用开始时的模型；人格、记忆和聊天记录保持。' : '可以准备和保存备用端的独立连接配置。当前聊天仍返回演练回复，不会调用外部模型。');
  state.classList.add('model-status-card');
  const mode = select(state, '运行模式', value.mode, [['rehearsal','本地演练'],['real','真实对话']], v => value.mode = v);
  mode.options[1].disabled = !value.networkAllowed;
  select(state, '选用的模型连接', value.selectedId ?? '', [['','尚未选择'], ...value.profiles.map(p => [p.id, `${p.name} · ${p.model || '模型待填写'}`])], v => value.selectedId = v || null);
  state.append(el('p', 'management-note', '支持 Chat Completions 与 Antigravity 专用连接的文字和工具调用。选中连接不等于启用真实对话；账号授权与连通性需分别核对。')); $('model-state').append(state);
  for (const p of value.profiles) { const b = button(p.name, () => { selected = p.id; render(); }); b.classList.toggle('selected', p.id === selected); b.append(el('small', '', p.id === value.selectedId ? '已选用 · ' + p.model : p.model || '待配置')); $('profiles').append(b); }
  const p = value.profiles.find(p => p.id === selected);
  if (!p) { $('editor').append(card('添加你的模型连接', '点击“添加连接”，填写服务地址、模型名称和密钥。此处只管理备用端的独立配置。')); return; }
  const native = p.protocol === 'antigravity';
  const box = card('连接配置', native ? 'Antigravity 使用 Google 账号授权，和普通 API 密钥不同。只使用备用端的独立授权资料；不修改生产 DSH 的账号池。' : '密钥由 Windows 当前用户加密保存在本地备份中。迁移到另一台电脑或用户后需重新填写；保存后不会回显密钥。');
  box.classList.add('model-editor-card');
  field(box, '连接名称', p.name, v => p.name = v);
  select(box, '接口类型', p.protocol, [['chat-completions','Chat Completions 兼容接口'],['antigravity','Antigravity · Google 账号']], v => { p.protocol = v; p.auth = v === 'antigravity' ? 'oauth' : 'key'; p.baseUrl = v === 'antigravity' ? 'https://cloudcode-pa.googleapis.com' : ''; p.apiKey = ''; p.clearKey = true; p.hasKey = false; render(); });
  const address = field(box, 'API 基础地址', p.baseUrl, v => p.baseUrl = v, 'url', native ? value.nativeEndpointPolicy === 'dsh-default' ? '默认 Google 入口；明确被拒绝时可用同模型备用端点，不自动降级模型。结果不明时不重发。' : 'Google Cloud Code Assist 专用协议，不追加 /chat/completions。' : '例如 https://你的服务地址/v1。完整请求会追加 /chat/completions。'); address.readOnly = native;
  field(box, '模型 ID', p.model, v => p.model = v, 'text', '按服务商实际名称填写，不自动猜测或联网获取列表。');
  if (native) {
    box.append(el('p', 'management-note', p.hasKey ? '账号授权：独立加密副本已保存；是否可用仍需联网验收。' : '账号授权：尚未接入。模型和地址可以先保存，演练模式继续可用。正式连接前需单独登录，或经你允许导入现有授权的独立副本。'));
  } else select(box, '认证方式', p.auth, [['key','API 密钥'],['none','无需密钥（本地或自托管服务）']], v => { p.auth = v; render(); });
  if (p.auth === 'key') {
    const key = field(box, 'API 密钥', p.apiKey ?? '', v => p.apiKey = v, 'password', p.hasKey ? '已保存密钥；留空沿用。更改服务地址后必须重新填写或清除。' : '尚未保存密钥。'); key.placeholder = p.hasKey ? '已保存 · 留空保持' : '输入后加密保存';
    const label = el('label','management-field','清除已保存的密钥'), check = el('input'); check.type = 'checkbox'; check.checked = !!p.clearKey; check.onchange = () => { p.clearKey = check.checked; if (check.checked) p.apiKey = ''; changed(); render(); }; label.append(check); box.append(label);
  }
  const max = field(box, '最大输出 token', p.maxTokens, v => p.maxTokens = v, 'number', '按服务商限制填写；不代表上下文总容量。'); max.min = 1; max.max = 131072;
  const timeout = field(box, '单次请求超时 / 秒', p.timeoutSeconds, v => p.timeoutSeconds = v, 'number'); timeout.min = 5; timeout.max = 90;
  const actions = el('div', 'management-actions');
  actions.append(button('选用此连接', () => { value.selectedId = p.id; changed(); render(); }));
  const test = button('测试连接', async () => {
    if (dirty) { $('error').textContent = '请先保存配置，再测试已保存的连接。'; return; }
    if (!confirm('将向此连接发送固定测试文本“Reply with OK.”，可能产生少量费用；不发送人格、记忆或聊天历史。继续？')) return;
    busy = true; lock(true); $('error').textContent = ''; $('feedback').textContent = '正在测试连接…';
    try { const r = await api('/v1/models/test', { revision: value.revision, id: p.id }); $('feedback').textContent = `连接测试通过：${r.model}。仅验证固定文本往返，尚未验证人格、插件和真实对话。`; } catch (e) { $('error').textContent = e.message; $('feedback').textContent = '测试未通过'; } finally { busy = false; lock(false); }
  }); test.disabled = !value.networkAllowed || native && !p.hasKey; actions.append(test);
  actions.append(button('移除此连接', () => {
    value.profiles = value.profiles.filter(item => item.id !== p.id);
    if (value.selectedId === p.id) { value.selectedId = null; value.mode = 'rehearsal'; }
    selected = value.profiles[0]?.id; changed(); render(); $('feedback').textContent = '已从草稿移除连接 · 保存后生效；重新打开页面可放弃未保存修改。人格、记忆和聊天记录保持。';
  })); box.append(actions);
  box.append(el('p','muted', value.networkAllowed ? '测试只发送固定文本，不自动重试。' : '测试入口已准备；当前演练锁定期间不可联网。未来明确启用真实连接后才能测试。'));
  $('editor').append(box);
}
function lock(locked) { for (const input of document.querySelectorAll('main input, main select, main button')) input.disabled = locked; if (!locked) render(); }
$('add').onclick = () => {
  if (busy) return;
  const p = { id: crypto.randomUUID(), name: `连接 ${value.profiles.length + 1}`, protocol: 'chat-completions', baseUrl: '', model: '', auth: 'key', maxTokens: 4096, timeoutSeconds: 60, hasKey: false };
  value.profiles.push(p); selected = p.id; changed(); render();
};
$('save').onclick = async () => {
  if (busy || !value) return; busy = true; lock(true); $('error').textContent = '';
  try { value = await api('/v1/models', value); dirty = false; $('feedback').textContent = value.mode === 'rehearsal' ? '已保存 · 当前仍为本地演练，不调用外部模型' : '已保存 · 新一轮使用选定模型，当前回复保持原配置'; }
  catch (e) { $('error').textContent = e.message; }
  finally { busy = false; lock(false); }
};
addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
try { value = await api('/v1/models'); if(value.managedBy==='dsh'){$('save').hidden=true;$('add').hidden=true;$('feedback').textContent='模型与工具由 DSH 管理';$('model-state').append(card('使用 DSH 的模型连接','请在 DSH 中调整 Chatagent 专用会话使用的模型、提供商和插件。此处无需再次填写密钥。'));}else{selected = value.selectedId ?? value.profiles[0]?.id; $('save').disabled = false; $('add').disabled = false; $('feedback').textContent = '独立配置 · 保存后新一轮生效'; render();} }
catch (e) { $('error').textContent = e.message; $('feedback').textContent = '读取失败'; }

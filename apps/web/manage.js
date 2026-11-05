const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const btn = (text, action) => { const b = el('button', 'soft-button', text); b.onclick = action; return b; };
let dshTools=[], value, runtime, dirty = false, selectedPersona, selectedMode = 'social', category = '', search = '', busy = false;
const section=new URLSearchParams(location.search).get('section');
let tab = (location.pathname==='/settings'?(section==='reply'?'settings':section):new URLSearchParams(location.search).get('tab')) ?? 'personas';
if (!['personas','sessions','settings'].includes(tab)) tab = 'personas';
const errors = { PREFERENCES_CHANGED: '配置已在另一个窗口修改。请先保留当前编辑内容，再刷新页面合并。', INVALID_CHAT_POLICY: '请检查分条数、时间和上下文阈值是否在标注范围内。', INVALID_PERSONA: '人格内容不能为空，最多 60 KB；分类必须有效。', DUPLICATE_NAME: '名称重复，请换一个名称。', INVALID_MODE_SETTINGS: '会话名称、人格、分组或阈值无效。', INVALID_LIBRARY: '名称不能为空或过长，请检查分类和人格名称。' };
async function api(route, body) {
  const boot = await (await fetch('/v1/bootstrap')).json();
  const response = await fetch(route, { method: body ? 'POST' : 'GET', headers: { 'X-Chatagent-Token': boot.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw Error(errors[result.error] ?? '操作未完成，请保留编辑内容后重试。'); return result;
}
function changed() { dirty = true; $('feedback').textContent = '有未保存的更改 · 保存后用于新一轮对话'; }
function field(parent, label, current, update, { type = 'text', min, max, help = '', multiline = false } = {}) {
  const wrap = el('label', 'management-field', label), input = el(multiline ? 'textarea' : 'input'); if (!multiline) input.type = type;
  if (type === 'checkbox') input.checked = current; else input.value = current ?? '';
  input.setAttribute('aria-label', label);
  if (min !== undefined) input.min = min; if (max !== undefined) input.max = max;
  input.oninput = () => { update(type === 'checkbox' ? input.checked : type === 'number' ? input.value === '' ? null : Number(input.value) : input.value); changed(); };
  wrap.append(input); if (help) wrap.append(el('small', '', help)); parent.append(wrap); return input;
}
function select(parent, label, current, options, update) {
  const wrap = el('label', 'management-field', label), control = el('select');
  control.setAttribute('aria-label', label);
  for (const [id, text] of options) control.append(new Option(text, id ?? '')); control.value = current ?? '';
  control.onchange = () => { update(control.value || null); changed(); }; wrap.append(control); parent.append(wrap); return control;
}
function panel(title, subtitle) { const box = el('section', 'management-card'); box.append(el('h2', '', title)); if (subtitle) box.append(el('p', 'muted', subtitle)); return box; }
function render() {
  $('management').replaceChildren();
  const title = {personas:'人格卡',sessions:'会话管理',settings:'回复与上下文'}[tab];
  document.querySelector('h1').textContent = title; document.title = '小鲸鱼 · ' + title;
  for (const a of document.querySelectorAll('.management-tabs a')) a.classList.toggle('selected', new URL(a.href).searchParams.get('tab') === tab);
  if (tab === 'personas') renderPersonas(); else if (tab === 'sessions') renderSessions(); else renderSettings();
}
function renderPersonas() {
  const host = $('management'), bar = el('div', 'management-actions');
  bar.append(el('span', 'muted', `${value.personas.length} 张人格卡 · 编辑独立副本`), btn('＋ 新建人格', () => { const p = { id: crypto.randomUUID(), name: '新人格 ' + (value.personas.length + 1), text: '', categoryId: null }; value.personas.push(p); selectedPersona = p.id; changed(); render(); }));
  const file = el('input'); file.type = 'file'; file.accept = '.md,.markdown,.txt'; file.hidden = true;
  file.onchange = async () => { try {
    const f = file.files[0]; if (!f) return; if (f.size > 60000) throw Error('人格文件最多 60 KB。');
    const bytes = new Uint8Array(await f.arrayBuffer()), encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    if (!text.trim() || text.includes('\0')) throw Error('请选择有效的文本人格文件。');
    const p = { id: crypto.randomUUID(), name: f.name.replace(/\.(md|markdown|txt)$/i, ''), text, categoryId: null };
    value.personas.push(p); selectedPersona = p.id; changed(); render();
  } catch (error) { $('error').textContent = error.message; } };
  bar.append(btn('导入人格文件', () => file.click()), file); host.append(bar);
  const categories = el('details','management-card persona-categories'), row = el('div', 'management-actions');
  categories.append(el('summary','','分类管理'));
  const filter = select(row, '筛选分类', category, [['', '全部'], ['uncategorized', '未分类'], ...value.categories.map(c => [c.id, c.name])], () => {});
  filter.onchange = () => { category = filter.value; selectedPersona = null; render(); };
  const newCategory = el('input'); newCategory.placeholder = '新分类名称'; newCategory.setAttribute('aria-label','新分类名称');
  row.append(newCategory, btn('新建分类', () => { if (!newCategory.value.trim()) return; value.categories.push({ id: crypto.randomUUID(), name: newCategory.value.trim() }); changed(); render(); })); categories.append(row); host.append(categories);
  const cards = value.personas.filter(p => !category || category === 'uncategorized' ? !category || p.categoryId === null : p.categoryId === category);
  if (!cards.some(p => p.id === selectedPersona)) selectedPersona = cards[0]?.id;
  const layout = el('div', 'management-layout'), list = el('nav', 'persona-list'); list.setAttribute('aria-label','人格列表');
  for (const p of cards) { const b = btn(p.name, () => { selectedPersona = p.id; render(); }); b.classList.toggle('selected', p.id === selectedPersona); b.append(el('small', '', Object.values(value.modes).some(m => m.personaId === p.id) ? '已绑定会话' : '可分配给会话')); list.append(b); }
  const p = value.personas.find(p => p.id === selectedPersona), editor = panel(p?.name ?? '选择或新建人格', '人格原文与记忆分别保存；更换人格不会删除已有记忆或聊天。');
  if (p) {
    field(editor, '人格名称', p.name, v => p.name = v);
    select(editor, '分类', p.categoryId, [[null, '未分类'], ...value.categories.map(c => [c.id, c.name])], v => p.categoryId = v);
    field(editor, '人格内容', p.text, v => p.text = v, { multiline: true, help: '最多 60 KB。保存后新一轮采用新内容，当前回复使用开始时的人格。' });
  }
  layout.append(list, editor); host.append(layout);
}
function renderSettings() {
  const p = value.policy, host = $('management');
  const models = el('a', 'text-link', '打开模型与连接 →'); models.href = '/settings?section=models'; host.append(models);
  if(runtime?.runtime?.kind==='dsh-bridge'){const link=el('a','text-link','在聊天中设置本会话的工具与权限 →');link.href='/?settings=tools';host.append(link);}
  const split = panel('分条发送', '按独立意思自然分段，保留代码、完整列表和连续说明。');
  field(split, '单次回复最多分条数', p.maxMessages, v => p.maxMessages = v, { type: 'number', min: 0, max: 20, help: '0 不限制；1 整条发送；2–20 为上限。按空行分段，不按字数硬切。' });
  split.append(btn('停止尚未发送的分段', async () => { try { const r = await api('/v1/reply-parts/stop', {}); $('feedback').textContent = `已停止 ${r.cancelled} 条待发送分段，当前对话任务继续。`; } catch (e) { $('error').textContent = e.message; } }));
  split.append(el('p', 'muted', '也可以在手机或电脑聊天中发送“停止分段”。提醒与插件主动消息按原文保存。')); host.append(split);
  const pace = panel('回复节奏', '短时间连续发送的文字合并为一轮判断，原始消息分别保留。');
  field(pace, '消息合并等待 / 秒', p.mergeMs / 1000, v => p.mergeMs = v === null ? null : v * 1000, { type: 'number', min: 0, max: 60, help: '从最后一条消息收到时开始等待；不同设备和带附件的消息不合并。' });
  field(pace, '私聊回复最小间隔 / 秒', p.minIntervalMs / 1000, v => p.minIntervalMs = v === null ? null : v * 1000, { type: 'number', min: 0, max: 60 }); host.append(pace);
  const active=panel('基础主动聊天','开启后，在聊天空闲时主动说一句话。可按聊天后一次或定时方式判断是否开口；结果不明不会重跑。');field(active,'启用主动聊天',p.proactiveEnabled,v=>p.proactiveEnabled=v,{type:'checkbox'});select(active,'触发方式',p.proactiveSchedule,[['after-message','每次聊天后一次'],['periodic','定时判断是否搭话']],v=>p.proactiveSchedule=v);select(active,'主动话题',p.proactiveMode,[['mixed','混合'],['greeting','问候'],['news','相关话题'],['meme','趣事']],v=>p.proactiveMode=v);for(const [key,label,min,max] of [['proactiveIdleMinutes','至少空闲 / 分钟',1,10080],['proactiveMinIntervalMinutes','主动消息最小间隔 / 分钟',1,10080],['proactiveJitterMinutes','额外随机延迟 / 分钟',0,60],['proactiveMaxPerDay','每天最多判断次数（0 不限制）',0,24],['quietStart','免打扰开始 / 时',0,23],['quietStartMinute','免打扰开始 / 分',0,59],['quietEnd','免打扰结束 / 时',0,23],['quietEndMinute','免打扰结束 / 分',0,59]])field(active,label,p[key],v=>p[key]=v,{type:'number',min,max});active.append(el('p','management-note','免打扰按北京时间计算；开始与结束相同时全天允许。默认关闭。'));host.append(active);
  const context = panel('上下文上限与自动压缩', '压缩只改变模型看到的上下文，原始记录始终保留。');
  field(context, '启用空闲时自动压缩', p.contextEnabled, v => p.contextEnabled = v, { type: 'checkbox' });
  field(context, '默认上下文阈值 / token', p.contextMaxTokens, v => p.contextMaxTokens = v, { type: 'number', min: 4000, max: 2000000 });
  field(context, '聊天至少空闲 / 秒', p.contextIdleSeconds, v => p.contextIdleSeconds = v, { type: 'number', min: 15, max: 3600, help: '没有待处理消息或分段时检查；失败间隔 5 分钟，同一段上下文最多尝试 3 次。' });
  context.append(el('p','management-note',contextDescription())); host.append(context);
}
function contextDescription() {
  const state = runtime?.context?.state;
  return state === 'dsh-managed' ? '上下文由 DSH 原生会话管理；启用后按这里的空闲时间和阈值请求 DSH 压缩。原始聊天保留。' : state === 'recent_window_managed' ? '当前沿用 WeChatAgent 的近期窗口管理：每轮整理近期上下文，完整原文仍保留。此策略不再重复调用阈值压缩；设置已保留，供原生连续会话使用。' : state === 'ready' ? '原生上下文压缩处理器可用，将按空闲时间和阈值检查。' : '当前为演练模式，尚未接入真实压缩模型；保存设置不会触发外部模型调用。';
}
function renderSessions() {
  const host = $('management'), groups = panel('私人会话分组', '分组用于整理此备用空间的会话，不移动生产 DSH 工作区。'), row = el('div','management-actions');
  const groupName = el('input'); groupName.placeholder = '新分组名称'; groupName.setAttribute('aria-label','新分组名称');
  row.append(groupName,btn('新建分组',()=>{if(!groupName.value.trim())return;value.groups.push({id:crypto.randomUUID(),name:groupName.value.trim()});changed();render();}));
  for (const g of value.groups) row.append(el('span','private-pill',g.name)); groups.append(row); host.append(groups);
  const layout=el('div','management-layout'), list=el('nav','persona-list'); list.setAttribute('aria-label','会话列表');
  const query=el('input');query.placeholder='查找会话';query.setAttribute('aria-label','查找会话');query.value=search;query.onchange=()=>{search=query.value;render();};list.append(query);
  selectedMode='social';
  const chat=value.modes.social;if(!search||chat.name.includes(search)){const b=btn(chat.name,()=>{selectedMode='social';render();});b.classList.add('selected');b.append(el('small','','聊天'));list.append(b);}
  const m=value.modes.social, box=panel(m.name,'在这里管理聊天的人格、资料分组和上下文。');
  field(box,'会话名称',m.name,v=>m.name=v);
  select(box,'工作区分组',m.groupId,[[null,'未分组'],...value.groups.map(g=>[g.id,g.name])],v=>m.groupId=v);
  select(box,'当前人格',m.personaId,[[null,'沿用导入人格'],...value.personas.map(p=>[p.id,p.name])],v=>m.personaId=v);
  field(box,'此会话上下文阈值 / token',m.contextMaxTokens,v=>m.contextMaxTokens=v,{type:'number',min:0,max:2000000,help:'留空继承全局；0 关闭；否则 4,000–2,000,000。'});
  const binding=runtime?.runtime?.modeBindings?.find(b=>b.mode===selectedMode), context=runtime?.context?.modes?.find(m=>m.mode===selectedMode);
  box.append(el('p','muted',binding?'聊天会话已建立':'尚未开始聊天'),el('p','muted',context?.tokens!=null?`当前上下文：${context.tokens} token（${context.tokenSource==='estimated'?'估算':'模型计量'}）`:'上下文用量：尚无可用计量'),el('p','management-note',contextDescription()));
  const jobs=el('details','session-jobs');jobs.append(el('summary','','任务、文件与历史用量'));
  for(const count of runtime?.messages?.filter(r=>r.mode===selectedMode)??[]) jobs.append(el('p','muted',`${count.role==='user'?'你的消息':'小鲸鱼回复'} · ${{completed:'已保存',queued:'待处理',running:'处理中',unknown:'结果待核对',awaiting_confirmation:'待确认',cancelled:'已取消'}[count.state]??count.state}：${count.count} 条`));
  jobs.append(el('p','muted',`当前待发送分段：${runtime?.pendingParts??0} 条`));
  for(const file of runtime?.files?.filter(f=>f.mode===selectedMode)??[]) jobs.append(el('p','muted',`${file.name} · ${file.bytes} 字节（最近 100 条消息中的附件）`));
  const history=el('a','text-link','查看保存的聊天原文');history.href='/archive?kind=history';jobs.append(history);box.append(jobs);layout.append(list,box);host.append(layout);
}
$('save').onclick=async()=>{if(busy||!value)return;busy=true;$('save').disabled=true;$('error').textContent='';try{value=await api('/v1/preferences',value);dirty=false;$('feedback').textContent='已保存。新一轮对话采用新配置，已有记录保持。';render();}catch(e){$('error').textContent=e.message;}finally{busy=false;$('save').disabled=false;}};
for(const a of document.querySelectorAll('.management-tabs a'))a.onclick=e=>{e.preventDefault();tab=new URL(a.href).searchParams.get('tab');history.replaceState(null,'',a.href);dispatchEvent(new Event('chatagent-navigation'));render();};
addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
try{[value,runtime]=await Promise.all([api('/v1/preferences'),api('/v1/conversation-status')]);$('feedback').textContent=runtime?.runtime?.kind==='dsh-bridge'?'设置应用于 Chatagent 专用聊天会话':'设置保存在当前聊天空间';render();}catch(e){$('error').textContent=e.message;$('feedback').textContent='读取失败';$('save').disabled=true;}

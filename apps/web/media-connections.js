const host=document.getElementById('media-connections');
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
const errors={MEDIA_CONFIG_CHANGED:'配置已在其他窗口修改，请刷新后核对。',MEDIA_CONFIG_INVALID:'请检查协议、模型名称、密钥和超时。',MEDIA_CONFIG_BUSY:'正在处理聊天、测试或音视频任务，请稍后保存。',MEDIA_NOT_CONFIGURED:'请填写模型和密钥后再启用接口。',MEDIA_ENDPOINT_KEY_REQUIRED:'地址已改变，请重新填写密钥或清除旧密钥。',MEDIA_RETIRED_ENDPOINT:'此入口使用已停用的 Antigravity 服务，请填写独立 API 地址。',MEDIA_AUTH_FAILED:'认证失败，请检查密钥、账号和模型权限。',MEDIA_RATE_LIMITED:'服务额度不足或限流，没有自动重试。',MEDIA_HTTP_FAILED:'服务返回失败，请检查模型和协议。',MEDIA_RESPONSE_INCOMPLETE:'未取得完整的音频处理结果。',MEDIA_RESPONSE_UNCONFIRMED:'请求结果未确认，没有自动重试。',MODEL_ENDPOINT_INVALID:'地址需使用 HTTPS；本机服务可用 localhost 或 127.0.0.1 的 HTTP 地址。',MODEL_BASE_URL_REQUIRED:'请填写基础地址，不带 /chat/completions。',MODEL_CREDENTIAL_STORE_UNAVAILABLE:'本机密钥加密不可用，请在当前 Windows 用户下重新填写。'};
let value,dirty=false,busy=false;
const feedback=el('p','','management-note');feedback.setAttribute('role','status');
async function api(body,test=false){const boot=await(await fetch('/v1/bootstrap')).json(),r=await fetch('/v1/media-connections'+(test?'/test':''),{method:body?'POST':'GET',headers:{'X-Chatagent-Token':boot.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),v=await r.json();if(!r.ok)throw Error(errors[v.error]??'音频接口未连接，请检查配置后重试。');return v;}
function field(box,label,current,update,type='text'){const wrap=el('label',label,'management-field'),input=el('input');input.type=type;input.value=current??'';input.setAttribute('aria-label',label);if(type==='password'){input.autocomplete='new-password';input.spellcheck=false;}input.oninput=()=>{update(type==='checkbox'?input.checked:type==='number'?Number(input.value):input.value);dirty=true;feedback.textContent='有未保存的音频接口配置';};if(type==='checkbox')input.checked=current;input.disabled=busy;wrap.append(input);box.append(wrap);return input;}
function select(box,label,current,options,update){const wrap=el('label',label,'management-field'),input=el('select');input.setAttribute('aria-label',label);for(const [id,name] of options)input.append(new Option(name,id));input.value=current;input.disabled=busy;input.onchange=()=>{update(input.value);dirty=true;feedback.textContent='有未保存的音频接口配置';render();};wrap.append(input);box.append(wrap);}
function button(text,action){const b=el('button',text,'soft-button');b.disabled=busy;b.onclick=action;return b;}
function render(){host.replaceChildren(el('h2','音频接口'),el('p','这里的接口负责听歌的原音频分析，再交回聊天模型生成回应。普通语音使用本地转写；语音合成与唱歌使用本地服务。'),feedback);
 for(const [id,label] of [['music','听歌']]){const p=value.connections[id],box=el('section','','management-card');box.append(el('h3',label),el('p',p.ready?'接口已配置，实际可用性需通过测试和真实音频核对。':'尚未启用可用接口；不会自动调用被停用的账号。'));
  field(box,label+'：启用接口',p.enabled,v=>p.enabled=v,'checkbox');
  select(box,label+'：协议',p.protocol,[['gemini','Gemini 原音频 API'],['chat-completions','Chat Completions · input_audio']],v=>{p.protocol=v;p.hasKey=false;p.clearKey=true;p.apiKey='';p.baseUrl=v==='gemini'?'https://generativelanguage.googleapis.com/v1beta':'';});
  field(box,label+'：API 基础地址',p.baseUrl,v=>p.baseUrl=v,'url');
  field(box,label+'：模型 ID',p.model,v=>p.model=v).placeholder='填写服务商支持原音频的模型 ID';
  select(box,label+'：认证',p.auth,[['key','API 密钥'],['none','无需密钥（本地或自托管）']],v=>p.auth=v);
  if(p.auth==='key'){const key=field(box,label+'：API 密钥',p.apiKey??'',v=>{p.apiKey=v;if(v)p.clearKey=false;},'password');key.placeholder=p.hasKey?'已加密保存 · 留空沿用':'填写后仅加密保存在本机';field(box,label+'：清除已保存密钥',!!p.clearKey,v=>{p.clearKey=v;if(v){p.apiKey='';render();}},'checkbox');}
  const timeout=field(box,label+'：超时（秒）',p.timeoutSeconds,v=>p.timeoutSeconds=v,'number');timeout.min=5;timeout.max=200;
  box.append(el('p',p.protocol==='gemini'?'基础地址示例：https://generativelanguage.googleapis.com/v1beta。模型必须支持原音频输入。':'基础地址示例：https://你的服务/v1。接口必须支持 input_audio；仅兼容文字聊天的接口无法听歌。','management-note'));
  box.append(button('测试'+label+'接口',async()=>{if(dirty){feedback.textContent='请先保存配置，再测试。';return;}if(!confirm('将向此接口发送 1 秒合成测试音频，可能产生少量费用。仅验证音频请求往返，继续？'))return;busy=true;render();try{const r=await api({revision:value.revision,id},true);feedback.textContent='测试返回完整结果：'+r.model+'。'+(r.audioReceipt?'服务返回了音频用量凭据。':'服务未提供单独音频用量凭据。')+'仍需真实听歌验收。';}catch(e){feedback.textContent=e.message;}finally{busy=false;render();}}));host.append(box);
 }
 host.append(button('保存音频接口',async()=>{busy=true;render();try{value=await api(value);dirty=false;feedback.textContent='音频接口已保存，新任务使用新配置。';}catch(e){feedback.textContent=e.message;}finally{busy=false;render();}}));
}
if(host){try{value=await api();render();}catch{host.append(el('p','当前运行方式未提供独立音频接口配置。'));}}
addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});

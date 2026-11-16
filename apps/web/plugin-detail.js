import {chatFetch,chatId,chatUrl} from './chat-scope.js';
import {beijingDay,recordDay,orderedRecords,mediaRecords,dateCounts,videoGroups} from './plugin-records.js';
const $=id=>document.getElementById(id),id=new URLSearchParams(location.search).get('plugin'),isMedia=id==='media-browser';
let chatChoices=[],data,draft,musicPreferences,musicKind='video',dirty=false,saving=false,loading=false,recordSignature='',selectedDay='',dateLimit=12,requestId;
const messages={PLUGIN_DISABLED:'请先启用插件并保存配置。',PLUGIN_BUSY:'当前有聊天或插件任务正在处理，请稍后再试。',PLUGIN_SETTINGS_CHANGED:'配置已在其他窗口修改，请刷新核对。',PLUGIN_SETTINGS_INVALID:'请检查配置数值和时间段。',PLUGIN_VIDEO_URL_INVALID:'请填写 B 站视频链接或 BV 号。',PLUGIN_VIDEO_TOO_LONG:'目前每次支持不超过 10 分钟的视频。',PLUGIN_BILI_SOURCE_FAILED:'B 站内容暂时无法获取，可能需要登录或稍后重试。',PLUGIN_MODEL_VISION_REQUIRED:'当前 DSH 模型不支持图片，请在 DSH 选择支持图片的模型。',PLUGIN_MEDIA_UNAVAILABLE:'音视频处理环境尚未就绪。',PLUGIN_RUN_FAILED:'这次运行未完成，请核对 DSH 连接或内容来源后重试。',PLUGIN_SELECTION_DECLINED:'她这次没有选中想看的视频。',PLUGIN_BUDGET_EXHAUSTED:'今日自主活动额度已用完或用量尚未确认。',PLUGIN_OUTPUT_INVALID:'模型未返回可保存的正文。',PLUGIN_OUTPUT_INCOMPLETE:'模型回复未完成，本次没有保存。'};
const stateName={running:'正在处理',completed:'已完成',failed:'未完成',cancelled:'已停止',unknown:'结果未知，不会自动重试'};
const scheduleName={'ready':'已满足调度条件，等待下一次检查','disabled':'插件未启用','automatic-disabled':'自主安排已关闭','zero-limit':'轮数或每日时长设为 0','clock-invalid':'系统时间与任务时间不一致','stopped':'已停止，等待新的聊天','waiting-interval':'等待两次开始的最小间隔','outside-window':'当前不在允许开始的时间段','no-chat':'尚无聊天可判断空闲时间','waiting-idle':'时段外尚未达到空闲门槛','unknown-task':'有结果未知的任务，暂停自动运行','busy':'聊天或其他插件正在处理','waiting-time':'尚未到今晚的整理时间','completed-today':'今天的自动日记已完成','attempted-today':'今天已尝试自动写日记；未完成的任务保留记录，不会自动重跑','media-unavailable':'音视频处理环境未就绪','round-limit':'今日自主轮数已用完','time-limit':'今日自主时长已用完','usage-unconfirmed':'模型用量未确认，保留额度并暂停自动浏览','token-limit':'今日自主视频 token 预算已用完','no-history':'今天暂无可整理的聊天'};
scheduleName['attempt-limit']='今日自动尝试次数已达上限，暂停自动浏览；可手动邀请';
Object.assign(messages,{PREFERENCES_CHANGED:'设置已在其他页面修改，请刷新核对。',PLUGIN_OUTPUT_LIMIT:'模型达到输出上限，正文未完成，本次未保存。',PLUGIN_MODEL_FAILED:'模型服务返回失败，本次未保存。',PLUGIN_MODEL_ABORTED:'模型调用被中止，本次未保存。'});
async function api(route,body){const boot=await(await chatFetch('/v1/bootstrap')).json(),r=await chatFetch(route,{method:body?'POST':'GET',headers:{'X-Chatagent-Token':boot.token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),v=await r.json();if(!r.ok)throw Error(messages[v.error]??'操作未完成，请刷新后重试。');return v;}
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
const feedback=text=>{$('plugin-feedback').textContent=text;$('dialog-feedback').textContent=text;};
const changed=()=>{dirty=true;feedback('有未保存的更改');};
const timeText=value=>value==null?'时间未记录':Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'时间未记录';
const musicForm=createMusicConfiguration({api,reload:()=>load(),isBusy:()=>saving});
function control(key,label,type='number',min,max,note){const wrap=el('label',null,type==='checkbox'?'plugin-toggle':'plugin-field');wrap.append(el('span',label));const input=el('input');input.type=type;input.dataset.key=key;if(type==='checkbox')input.checked=draft[key];else input.value=draft[key];if(min!=null){input.min=min;input.max=max;input.step=1;}input.required=type!=='checkbox';input.oninput=()=>{draft[key]=type==='checkbox'?input.checked:type==='number'?Number(input.value):input.value;changed();};wrap.append(input);if(note)wrap.append(el('small',note));return wrap;}
function windowRows(){const host=$('window-rows');host.replaceChildren();draft.windows.forEach((window,i)=>{const row=el('div',null,'activity-window');for(const [key,label] of [['start','开始'],['end','结束']]){const wrap=el('label',label),input=el('input');input.type='time';input.required=true;input.value=window[key];input.oninput=()=>{window[key]=input.value;changed();};wrap.append(input);row.append(wrap);}const remove=el('button','移除','soft-button');remove.type='button';remove.setAttribute('aria-label','移除时间段 '+(i+1));remove.onclick=()=>{draft.windows.splice(i,1);changed();windowRows();};row.append(remove);host.append(row);});$('add-window').disabled=draft.windows.length>=8;}
function fields(){if(isMedia){for(const [host,key,label] of [['media-enabled','enabled','启用刷站插件'],['media-automatic','automatic','允许她自主刷视频'],['media-idle','allowIdleOutsideWindows','时段外空闲后也允许开始'],['media-share','share','完成后分享到聊天']])$(host).replaceChildren(control(key,label,'checkbox'));$('media-fields').replaceChildren(...[
 ['maxPerDay','每天最多轮',0,20],['roundMinutes','每轮最长（分钟）',1,120],['dailyMinutes','每天最多运行（分钟）',0,1440],['tokenLimit','每日自主视频 token 上限（0 为不限）',0,20000000,'0 为不限；设置上限时填写 10000–20000000，包含输入、缓存和输出。'],['idleMinutes','时段外需空闲（分钟）',1,1440],['intervalMinutes','两次开始至少间隔（分钟）',1,1440]
 ].map(([key,label,min,max,note])=>control(key,label,'number',min,max,note)));windowRows();}else $('notebook-fields').replaceChildren(control('enabled','启用鱼的记事本','checkbox'),control('automatic','每天自动整理','checkbox'),control('time','晚间整理时间（北京时间）','time'),control('share','写完后分享到聊天','checkbox'));}
function empty(title,text){const node=el('div',null,'plugin-empty');node.append(el('h2',title),el('p',text));return node;}
function switchView(){const records=isMedia&&location.hash==='#records';$('media-tabs').hidden=!isMedia;$('media-config').hidden=!isMedia||records;$('media-records').hidden=!records;$('notebook-page').hidden=isMedia;document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-selected',String((b.dataset.view==='records')===records)));}
function drawNotebook(rows){const days=dateCounts(rows);if(!selectedDay)selectedDay=days[0]?.[0]??beijingDay(Date.now());$('diary-dates').replaceChildren(...days.slice(0,dateLimit).map(([day,count])=>{const button=el('button',day+(count>1?' · '+count+' 篇':''));button.setAttribute('aria-pressed',String(day===selectedDay));button.onclick=()=>{selectedDay=day;drawNotebook(rows);};return button;}));$('more-dates').hidden=dateLimit>=days.length;
 const host=$('diary-reading');host.replaceChildren();const entries=rows.filter(r=>recordDay(r)===selectedDay);if(!entries.length){host.append(empty('小本本还没有写下今天','写过的日记会按日期保存在这里。'));return;}
 for(const row of entries){const paper=el('article',null,'plugin-card notebook-paper'),at=row.at??row.createdAt;paper.append(el('div',recordDay(row),'dateline'),el('h2',row.personaName?row.personaName+'的小本本':row.title??'她的小本本'),el('div',[at!=null?'写于 '+timeText(at):null,Number.isInteger(row.sourceCount)?row.sourceCount+' 条当天聊天片段':null].filter(Boolean).join(' · ')||'迁入的日记','origin'),el('div',row.text,'prose'),el('footer',row.imported?'来自迁入的聊天档案 · 原文保留':'来自当前 Chatagent 对话'));host.append(paper);}
}
function evidenceText(row){if(row.mediaKind==='music')return '已保存的听歌记录';if(row.evidence)return `读取了 ${row.evidence.frameCount??0} 张抽帧、约 ${Math.round(row.evidence.audioSeconds??0)} 秒语音转写。${row.evidence.limitations??''}`;const p=row.provenance;if(p?.kind==='sampled_frames')return '抽帧记录 · 从第 '+(p.frameOffset+1)+' 帧开始';if(p?.kind==='local_asr')return `语音转写片段 · ${Math.round(p.start)}–${Math.round(p.end)} 秒`;return row.readPages?`历史读取记录 · 已读 ${row.readPages}/${row.totalPages} 页`:'历史观看记录';}
function musicActivity(){
 const music=data.music;if(!isMedia||musicKind!=='music'||!music)return;
 const musicSchedule={'automatic-disabled':'自主听歌已关闭','media-unavailable':'听歌接口尚未就绪','busy':'聊天或其他任务正在处理','zero-limit':'自主听歌轮数或时长为零','round-limit':'今日自主听歌轮数已用完','time-limit':'今日自主听歌时长已用完','attempt-limit':'自动尝试次数已达上限','waiting-schedule':'等待听歌时段或空闲条件','ready':'已满足条件，等待下一次自动检查','running':'正在自主听歌'};
 const state=music.readiness==='not-configured'?'原音频接口尚未配置':music.readiness!=='ready'?'听歌会话授权未就绪':music.running?'正在自主听歌':musicSchedule[music.schedule?.reason]??'听歌接口已配置';
 $('activity-summary').textContent='听歌状态 · '+state;
 const used=music.usage??{},rounds=used.rounds?.find(r=>r.category==='music')?.count??0,minutes=(used.times?.find(r=>r.category==='music')?.milliseconds??0)/60000,attempts=used.attempts?.find(r=>r.category==='music')?.count??0;
 $('plugin-state').textContent=state+`。今日自主听歌 ${rounds} / ${music.settings.dailyRounds} 首，已听 ${minutes.toFixed(1)} / ${music.settings.dailyMinutes} 分钟，共尝试 ${attempts} 次。`+(music.schedule?.reason==='attempt-limit'?'检查接口后可手动邀请听一首；成功后恢复新曲目的自动安排。':'手动邀请与视频自主额度分开；未确认的请求不会自动重发。');
 const outcomeName={selected:'已选曲，尚未取得有效听音结果',no_observation:'未取得有效听音结果',declined:'跳过了本次机会',unknown:'结果未知，不会自动重试'};
 $('plugin-jobs').replaceChildren(...(music.activity??[]).map(r=>el('p',timeText(r.at)+' · '+(r.origin==='invited'?'手动邀请':'自主听歌')+' · '+(r.feeling_recorded?'已听完并保存感受':r.confirmed_ms>0?'已听取，尚未保存感受':r.reason||outcomeName[r.outcome]||outcomeName[r.status]||'本次尚未完成'))));
 $('plugin-stop').disabled=true;
}
function drawMedia(){const music=musicKind==='music';$('media-budget').hidden=music;$('video-invitation').hidden=music;document.querySelectorAll('[data-media-kind]').forEach(b=>{const selected=b.dataset.mediaKind===musicKind;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));});drawVideos(mediaRecords(data,musicKind));if(music)musicActivity();}
function drawVideos(rows){const days=dateCounts(rows);if(!selectedDay)selectedDay=days[0]?.[0]??beijingDay(Date.now());const dates=$('record-dates');dates.replaceChildren(...days.map(([day,count])=>{const option=el('option',day+' · '+count+' 条感受');option.value=day;return option;}));if(!days.some(([d])=>d===selectedDay)){const option=el('option',selectedDay+' · 暂无记录');option.value=selectedDay;dates.prepend(option);}dates.value=selectedDay;$('record-date').value=selectedDay==='日期不详'?'':selectedDay;
 const filtered=rows.filter(r=>recordDay(r)===selectedDay),groups=videoGroups(filtered),music=musicKind==='music';$('record-heading').textContent=selectedDay+(music?' · 听歌记录':' · 观看记录');$('record-count').textContent=groups.length+(music?' 首音乐，':' 个视频，')+filtered.length+' 条感受';const host=$('video-records');host.replaceChildren();if(!groups.length){host.append(empty(music?'这一天还没有听歌记录':'这一天还没有观看记录',music?'已保存的听歌经历与感受会显示在这里。':'自主浏览或邀请她看视频后，感受会保存在这里。'));return;}
 for(const group of groups){const card=el('article',null,'plugin-card'),head=el('div',null,'video-title'),title=el('div'),heading=el('h2');if(/^BV[A-Za-z0-9]{10}$/.test(group.bvid??'')){const link=el('a',group.title);link.href='https://www.bilibili.com/video/'+group.bvid;link.target='_blank';link.rel='noopener noreferrer';heading.append(link);}else heading.textContent=group.title;title.append(heading,el('small',group.bvid??'来源编号未记录'));head.append(title,el('span',group.rows.length+' 条感受'));const details=el('details',null,'video-feelings');details.open=groups.length===1;details.append(el('summary',music?'查看听歌感受':'查看观看感受'));for(const row of group.rows){const feeling=el('div',null,'plugin-feeling');feeling.append(el('time',timeText(row.at??row.createdAt)+(row.imported?' · 迁入记录':'')),el('p',row.text),el('small',evidenceText(row)));details.append(feeling);}card.append(head,details);host.append(card);}
}
function render(){document.title=data.name+' · fish with me';$('plugin-title').textContent=data.name;$('plugin-description').textContent=isMedia?'配置她自主看视频的安排，查看视频与音乐的经历和感受。':'查看当前聊天的小本本，保留每天的心事。';$('updated-at').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN',{hour12:false});const s=data.settings;
 if(isMedia)musicForm.update(data.music,musicPreferences);
 document.querySelectorAll('[data-run]').forEach(b=>b.disabled=saving||!s.enabled||data.running||!data.ready);$('plugin-stop').disabled=saving||!data.running;$('plugin-state').textContent=data.running?'正在运行；收到新的聊天消息会优先处理聊天。':!data.ready?'本机音视频处理环境尚未连接。':s.enabled?'插件已开启，当前空闲。':'插件未开启，已有记录仍可查看。';$('activity-summary').textContent='运行状态 · '+(data.running?'正在运行':s.enabled?'空闲':'未开启');
 const schedule=data.schedule;$('activity-summary').textContent='运行状态 · '+(scheduleName[schedule?.reason]??(data.running?'正在运行':s.enabled?'空闲':'未开启'));$('plugin-state').append(' 自动安排：'+(scheduleName[schedule?.reason]??'等待调度检查')+'。');if(schedule?.lastCheck)$('plugin-state').append(' 最近检查 '+timeText(schedule.lastCheck.at)+'：'+(scheduleName[schedule.lastCheck.reason]??schedule.lastCheck.reason)+'。');
 $('plugin-jobs').replaceChildren(...data.jobs.slice(0,5).map(j=>el('p',timeText(j.at)+' · '+stateName[j.state]+(j.body.scheduled?' · 自主活动':' · 手动邀请')+(j.body.error?' · '+(messages[j.body.error]??'本次未完成，记录已保留'):'')+(j.body.failureCode?'（'+j.body.failureCode+'）':''))));
 if(isMedia){const b=data.budget??{rounds:0,elapsedMs:0,tokens:0,reservedTokens:0};$('media-budget').replaceChildren(el('strong','今日自主活动'),el('span',`已观看 ${b.rounds} / ${s.maxPerDay} 轮`),el('span',`已尝试 ${b.attempts??b.rounds} 次`),el('span',`${(b.elapsedMs/60000).toFixed(1)} / ${s.dailyMinutes} 分钟`),el('span',`${b.tokens.toLocaleString()} / ${s.tokenLimit===0?'不限':s.tokenLimit.toLocaleString()} token`),...(b.reservedTokens?[el('span','预留 '+b.reservedTokens.toLocaleString()+' token，实际用量待确认')]:[]));}else{const choices=chatChoices.length?chatChoices:[{id:chatId,name:data.conversation?.name??'Chatagent'}];$('notebook-chat').replaceChildren(...choices.map(c=>new Option(c.name,c.id)));$('notebook-chat').value=chatId;$('notebook-state').textContent=s.enabled?'插件已开启，按此聊天生效。':'插件未开启，已有小本本可继续阅读。';$('notebook-time').textContent='晚间整理时间（北京时间）：'+s.time+(s.automatic?'':' · 自动整理已关闭');}
 const nextSignature=JSON.stringify([data.records,data.imported]);if(recordSignature!==nextSignature){recordSignature=nextSignature;if(isMedia)drawMedia();else drawNotebook(orderedRecords(data));}if(isMedia&&musicKind==='music')musicActivity();switchView();
}
async function load(){if(loading)return;loading=true;try{const [all,prefs]=await Promise.all([api('/v1/plugins'),isMedia?api('/v1/preferences').catch(()=>null):null]),next=all.find(p=>p.id===id);musicPreferences=prefs;if(!next)throw Error('插件尚未接入，请检查 DSH 桥接。');const reset=!draft||!dirty&&data?.settings.revision!==next.settings.revision;data=next;if(reset){draft=structuredClone(next.settings);fields();}render();}finally{loading=false;}}
const act=fn=>async event=>{event?.preventDefault();if(saving||musicForm.saving)return;saving=true;if(data)render();try{await fn();}catch(e){feedback(e.message);}finally{saving=false;if(data)render();}};
const save=act(async()=>{await api('/v1/plugins/'+id+'/settings',draft);dirty=false;draft=null;await load();feedback('配置已保存。');$('notebook-dialog').close();});$('media-form').onsubmit=save;$('notebook-form').onsubmit=save;
function closeConfig(){if(saving)return;if(dirty&&!confirm('放弃未保存的配置？'))return;dirty=false;draft=structuredClone(data.settings);fields();feedback('');$('notebook-dialog').close();}
const run=act(async()=>{if(dirty)throw Error('请先保存配置。');requestId??=crypto.randomUUID();await api('/v1/plugins/'+id+'/run',{requestId,input:isMedia?$('video-input').value.trim():'',action:'run'});requestId=null;feedback('已开始，完成后会显示在记录里。');await load();});
document.querySelectorAll('[data-run]').forEach(b=>b.onclick=run);document.querySelectorAll('[data-refresh]').forEach(b=>b.onclick=act(async()=>{if((dirty||musicForm.dirty)&&!confirm('刷新会放弃未保存的配置，继续？'))return;dirty=false;draft=null;musicForm.discard();await load();feedback('已刷新。');}));
$('plugin-stop').onclick=act(async()=>{await api('/v1/plugins/'+id+'/stop',{});feedback('已请求停止。');await load();});$('add-window').onclick=()=>{if(draft.windows.length>=8)return;draft.windows.push({start:'12:30',end:'14:30'});changed();windowRows();};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{location.hash=b.dataset.view==='records'?'records':'config';switchView();});addEventListener('hashchange',switchView);
$('record-date').onchange=e=>{if(!e.target.value)return;selectedDay=e.target.value;drawMedia();};$('record-dates').onchange=e=>{selectedDay=e.target.value;drawMedia();};$('record-today').onclick=()=>{selectedDay=beijingDay(Date.now());drawMedia();};$('more-dates').onclick=()=>{dateLimit+=12;drawNotebook(orderedRecords(data));};
document.querySelectorAll('[data-media-kind]').forEach(b=>b.onclick=()=>{musicKind=b.dataset.mediaKind;selectedDay='';if(musicKind==='video')recordSignature='';render();drawMedia();});
$('notebook-config').onclick=()=>{$('dialog-feedback').textContent='';$('notebook-dialog').showModal();};$('close-config').onclick=closeConfig;$('cancel-config').onclick=closeConfig;$('notebook-dialog').oncancel=e=>{e.preventDefault();closeConfig();};addEventListener('beforeunload',e=>{if(dirty||musicForm.dirty){e.preventDefault();e.returnValue='';}});
$('notebook-chat').onchange=e=>{const next=e.target.value;if(dirty&&!confirm('放弃未保存的配置并切换聊天？')){e.target.value=chatId;return;}dirty=false;location.href=chatUrl(location.href,next);};
try{const boot=await(await fetch('/v1/bootstrap')).json(),response=await fetch('/v1/chats',{headers:{'X-Chatagent-Token':boot.token}});if(response.ok)chatChoices=(await response.json()).chats;}catch{}
try{await load();}catch(e){feedback(e.message);}const timer=setInterval(()=>{if(!saving&&!document.hidden)load().catch(()=>{});},5000);addEventListener('pagehide',()=>clearInterval(timer),{once:true});

function createMusicConfiguration({api,reload,isBusy}){
 let source,prefs,draft,dirty=false,saving=false;
 const feedback=text=>$('music-feedback').textContent=text;
 const changed=()=>{dirty=true;feedback('有未保存的听音乐配置');};
 function control(key,label,type,min,max){
  const wrap=el('label',null,type==='checkbox'?'plugin-toggle':'plugin-field'),input=el('input');wrap.append(el('span',label));input.type=type;input.dataset.musicKey=key;
  const target=['enabled','automatic'].includes(key)?draft:draft.settings;
  if(type==='checkbox')input.checked=target[key];else{input.value=target[key];input.required=true;input.min=min;input.max=max;input.step=1;}
  input.oninput=()=>{target[key]=type==='checkbox'?input.checked:Number(input.value);if(key==='automatic')draft.settings.enabled=input.checked;changed();};wrap.append(input);return wrap;
 }
 function windows(){
  $('music-window-rows').replaceChildren(...draft.settings.windows.map((window,i)=>{
   const row=el('div',null,'activity-window');for(const [key,label] of [['start','开始'],['end','结束']]){const wrap=el('label',label),input=el('input');input.type='time';input.required=true;input.value=window[key];input.oninput=()=>{window[key]=input.value;changed();};wrap.append(input);row.append(wrap);}
   const remove=el('button','移除','soft-button');remove.type='button';remove.setAttribute('aria-label','移除音乐时间段 '+(i+1));remove.onclick=()=>{draft.settings.windows.splice(i,1);changed();windows();};row.append(remove);return row;
  }));$('music-add-window').disabled=draft.settings.windows.length>=8;
 }
 function fields(){
  $('music-enabled').replaceChildren(control('enabled','启用听音乐插件','checkbox'));
  $('music-automatic').replaceChildren(control('automatic','允许她自主听歌','checkbox'));
  $('music-fields').replaceChildren(...[['dailyRounds','每天最多轮',0,50],['roundMinutes','每轮最长（分钟）',1,5],['dailyMinutes','每天最多听歌（分钟）',0,1440],['idleMinutes','时段外需空闲（分钟）',1,1440],['gapMinutes','两次开始至少间隔（分钟）',1,1440]].map(([key,label,min,max])=>control(key,label,'number',min,max)));
  $('music-idle').replaceChildren(control('allowIdleOutsideWindows','时段外空闲后也允许开始','checkbox'));windows();
 }
 function update(music,preferences){
  const card=preferences?.capabilities?.find(c=>c.id==='music-listening');
  $('music-controls').disabled=saving||!music||!card;
  $('music-state').textContent=!music?'当前桥接尚未提供音乐配置，请检查插件连接。':!card?'此聊天尚未配置听音乐插件，已有记录仍可查看。':card.values.enabled===false?'听音乐已关闭':music.running?'正在自主听歌':card.values.automatic===true&&music.settings.enabled?'听音乐已启用 · 自动听歌已开启':'听音乐已启用 · 自动听歌已关闭';
  if(music?.readiness==='not-configured')$('music-state').textContent='原音频接口尚未配置，请前往设置→模型与连接。';
  $('music-tool-state').textContent=music?.toolAllowed?'当前聊天已授权听音乐工具。':'当前聊天尚未授权听音乐工具；请在聊天设置中授权后使用或自动听歌。';
  if(music&&card&&!dirty&&!saving){source=structuredClone(music);prefs=structuredClone(preferences);draft={settings:structuredClone(music.settings),enabled:card.values.enabled!==false,automatic:card.values.automatic===true&&music.settings.enabled};fields();}
 }
 $('music-add-window').onclick=()=>{if(!draft||draft.settings.windows.length>=8)return;draft.settings.windows.push({start:'12:30',end:'14:30'});changed();windows();};
 $('music-form').onsubmit=async event=>{
  event.preventDefault();if(saving||isBusy()||!draft)return;saving=true;$('music-controls').disabled=true;let policySaved=false,switchesSaved=false;
  try{
   const card=prefs.capabilities.find(c=>c.id==='music-listening'),switchesChanged=(card.values.enabled!==false)!==draft.enabled||(card.values.automatic===true)!==draft.automatic;
   // Existing preference revisions protect persona and other plugin edits.
   if(switchesChanged){const latest=await api('/v1/preferences');if(latest.revision!==prefs.revision)throw Error('设置已在其他页面修改，请刷新核对后保存。');}
   if(JSON.stringify(draft.settings)!==JSON.stringify(source.settings)){const saved=await api('/v1/plugins/media-browser/settings',{section:'music',settings:draft.settings,revision:source.revision});source={...source,...saved};policySaved=true;}
   if(switchesChanged){const next=structuredClone(prefs),target=next.capabilities.find(c=>c.id==='music-listening');target.values={...target.values,enabled:draft.enabled,automatic:draft.automatic};prefs=await api('/v1/preferences',next);switchesSaved=true;}
   dirty=false;feedback('听音乐配置已保存。');
  }catch(e){feedback((policySaved||switchesSaved?'部分设置已保存，请核对后继续：':'')+e.message);}
  finally{saving=false;$('music-controls').disabled=false;await reload().catch(e=>feedback('回读配置失败：'+e.message));}
 };
 return {update,get dirty(){return dirty;},get saving(){return saving;},discard(){dirty=false;feedback('');}};
}

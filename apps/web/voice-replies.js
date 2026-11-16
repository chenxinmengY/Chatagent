import {chatFetch} from './chat-scope.js';
const $=id=>document.getElementById(id);
const errors={VOICE_REPLY_UNAVAILABLE:'请先连接更新后的电脑端语音组件。',NOT_FOUND:'语音组件需要更新，暂时不能在这里配置。',VOICE_REPLY_WINDOWS_REQUIRED:'请在 Windows 电脑上配置基础语音。',VOICE_REPLY_CHINESE_MISSING:'电脑缺少中文系统声音。请在 Windows 设置中添加中文语音后重试。',VOICE_REPLY_SYSTEM_FAILED:'免费声音生成失败，未更改原配置，请重试。',VOICE_REPLY_AUDIO_INVALID:'测试语音不完整，未保存配置，请重试。',VOICE_REPLY_BUSY:'语音或聊天正在处理，请完成后重试。',VOICE_REPLY_SETTINGS_CHANGED:'聊天设置已变化，请刷新页面后再配置。',VOICE_REPLY_EXISTING_UNAVAILABLE:'没有找到原来的 AI 音色。',BACKUP_IN_PROGRESS:'正在备份，请完成后再配置。',ASR_SETUP_PLATFORM:'自动安装目前支持 Windows 64 位电脑。',ASR_SETUP_DOWNLOAD_FAILED:'语音包没下载好，请检查网络后点“一键配置语音”重试。',ASR_SETUP_DOWNLOAD_SIZE:'语音包下载不完整，请点“一键配置语音”重试。',ASR_SETUP_DOWNLOAD_HASH:'语音包检查没通过，请点“一键配置语音”重新下载。',ASR_SETUP_EXTRACT_FAILED:'语音包未能解压，请检查磁盘空间后重试。',ASR_SETUP_TEST_FAILED:'语音包已准备，但转文字测试未通过。原配置未更改，请重试。',ASR_SETUP_DAMAGED:'已有语音包不完整，请重新准备语音组件。',ASR_SETUP_CANCELLED:'配置已中断，点“一键配置语音”可以继续。',ASR_SETUP_FAILED:'语音包未准备完成，原配置未更改，请重试。'};
let value=null,busy=false,configuring=false,audioUrl=null,timer=null,polling=false,attempt=0;
async function api(route,body){
  const boot=await(await fetch('/v1/bootstrap')).json();
  const response=await chatFetch(route,{method:body===undefined?'GET':'POST',headers:{'X-Chatagent-Token':boot.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok)throw Error(errors[data.error]??'配置暂未完成，请检查电脑端连接后重试。');return data;
}
function progress(){
  const asr=value?.asr,bar=$('speech-progress');bar.hidden=!configuring;
  if(!configuring)return;
  if(asr?.stage==='downloading'&&asr.total){bar.value=Math.min(100,asr.received/asr.total*100);const mb=n=>Math.round(n/1024/1024);$('voice-feedback').textContent=`正在下载语音包：${mb(asr.received)} / ${mb(asr.total)} MB。首次准备稍等一会儿。`;}
  else{bar.removeAttribute('value');const stages={checking:'正在检查已有语音包…',extracting:'下载好了，正在准备语音组件…',verifying:'正在检查语音包是否完整…',testing:'正在试用语音转文字…',ready:'正在完成语音配置…'};if(stages[asr?.stage])$('voice-feedback').textContent=stages[asr.stage];}
}
function render(){
  $('voice-enable').disabled=busy||!value?.systemSupported||value?.basicSpeech!==true;
  const ready=value?.asr?.ready===true&&value?.source==='system'&&value.allowedTools.includes('chatagent_send_voice');
  $('voice-enable').textContent=busy?'正在配置，请稍等…':ready?'重新检查语音配置':'一键配置语音';
  $('voice-preview').disabled=busy||!['system','mansui'].includes(value?.source);
  for(const id of ['voice-enable','speech-setup-intro','speech-setup-note','voice-advanced'])$(id).hidden=!!value?.hasMansui;
  $('voice-existing').hidden=!value?.hasExisting||value.source==='existing';$('voice-existing').disabled=busy;
  $('voice-current').textContent=value?.source==='mansui'?(value.singingVoice==='mansui'?'日常语音和唱歌都使用满穗音色。':'日常语音使用满穗音色。'):!value?'语音组件还未连接。':value.basicSpeech!==true?'请更新电脑端语音组件后再一键配置。':ready?'准备好了：你能发语音，她也能用语音回复。':value.asr.ready?'语音转文字已准备好。'+(value.source==='existing'?'正在使用原来的 AI 音色。':'可以继续开启免费语音回复。'):'点击下面的按钮，一起准备转文字和免费语音回复。';
  progress();
}
function clearAudio(){if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl=null;$('voice-player').pause();$('voice-player').removeAttribute('src');$('voice-player').hidden=true;}
async function poll(){if(polling||!configuring)return;polling=true;const current=attempt;try{const updated=await api('/v1/voice-replies');if(configuring&&attempt===current){value=updated;render();}}catch{}finally{polling=false;}}
async function configure(source){
  if(busy||!value)return;busy=true;configuring=source==='system';attempt++;$('voice-error').textContent='';$('voice-feedback').textContent=source==='system'?'正在检查免费声音和语音转文字…':source==='mansui'?'正在切换到满穗…':'正在恢复原来的音色…';render();
  const sessionId=value.sessionId,revision=value.revision;
  if(source==='system')timer=setInterval(()=>void poll(),1000);
  try{value=await api('/v1/voice-replies/setup',{source,sessionId,revision});clearAudio();$('voice-feedback').textContent=source==='system'?'准备好了！先发一条语音试试，也可以点“试听一句”。':source==='mansui'?'已切换到满穗。':'已恢复原来的 AI 音色。';}
  catch(e){$('voice-error').textContent=e.message;$('voice-feedback').textContent='';}
  finally{clearInterval(timer);timer=null;busy=false;configuring=false;render();}
}
$('voice-enable').onclick=()=>configure('system');$('voice-existing').onclick=()=>configure('existing');
$('voice-preview').onclick=async()=>{
  if(busy||!value)return;busy=true;$('voice-error').textContent='';$('voice-feedback').textContent='正在生成一句试听语音…';render();
  try{const sample=await api('/v1/voice-replies/preview',{sessionId:value.sessionId,revision:value.revision});if(sample.mediaType!=='audio/wav'||typeof sample.data!=='string'||sample.data.length>24*1024*1024)throw Error('试听文件格式不正确。');const bytes=Uint8Array.from(atob(sample.data),c=>c.charCodeAt(0));clearAudio();audioUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));$('voice-player').src=audioUrl;$('voice-player').hidden=false;$('voice-feedback').textContent='生成好了，点播放试听。';}
  catch(e){$('voice-error').textContent=e.message;$('voice-feedback').textContent='';}finally{busy=false;render();}
};
addEventListener('pagehide',()=>{clearInterval(timer);clearAudio();});
try{value=await api('/v1/voice-replies');}catch(e){$('voice-error').textContent=e.message;}render();

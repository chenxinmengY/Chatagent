import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {markPluginTool} from './tool-catalog.mjs';
const run=promisify(execFile);
// Audio comes only from the verified attachment for this request, never from model paths.
export async function connectLocalHearing({agent,root,workspace,asrRoot,attachments,db,transport,profile}){
 if(!workspace||!fs.existsSync(path.join(workspace,'config/short-voice.json')))return null;
 const policy=()=>JSON.parse(fs.readFileSync(path.join(workspace,'config/short-voice.json'))),binding=JSON.parse(fs.readFileSync(path.join(workspace,'chatagent-binding.json')));
 if(binding.sessionId!==agent.session.id)throw Error('HEARING_SESSION_MISMATCH');
 const configured=()=>{const p=policy();return profile?.()?.capabilities?.find(c=>c.id==='short-voice')?.values.enabled!==false&&p.enabled===true&&p.freeTierConfirmed===true&&p.accountScope===binding.account&&p.conversationKey===binding.key;};if(!configured())return null;
 const folder=path.join(workspace,'packages/wechat-short-voice'),{inspectAudio,makeHearingObservation}=await import(pathToFileURL(path.join(folder,'hearing-core.mjs'))),{hearAudio}=await import(pathToFileURL(path.join(folder,'live-hearing.mjs')));
 db.exec("CREATE TABLE IF NOT EXISTS hearing_results(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,state TEXT NOT NULL,body TEXT);UPDATE hearing_results SET state='unknown' WHERE state='running'");
 let current=null,controller=null,closed=false;
 const dispose=agent.ctx.tools.register(markPluginTool({name:'wechat_hearing__listen',description:'听取当前 Chatagent 消息中不超过 60 秒的语音，返回实际音频处理结果。结果可能有误；不能用于确认情绪、身份或音乐。',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_,r)=>[{type:'text',text:JSON.stringify(r)}]},async execute(){
  const slot=current;if(closed||!slot||!configured()||controller?.signal.aborted)throw Error('HEARING_CURRENT_VOICE_UNAVAILABLE');
  const file=attachments.verify(slot.attachment.id);if(file.sha256!==slot.attachment.sha256||file.bytes!==slot.attachment.bytes||file.media_type!==slot.attachment.mediaType)throw Error('HEARING_ATTACHMENT_CHANGED');
  const prior=db.prepare('SELECT * FROM hearing_results WHERE id=?').get(slot.id);if(prior){if(prior.sha256!==file.sha256)throw Error('HEARING_ATTACHMENT_CHANGED');if(prior.state!=='completed')throw Error('HEARING_RESULT_UNKNOWN');return JSON.parse(prior.body);}
  const duration=attachments.audioDuration(slot.attachment.id);if(!duration||duration>60000)throw Error('HEARING_DURATION_LIMIT');
  db.prepare("INSERT INTO hearing_results VALUES(?,?,'running',NULL)").run(slot.id,file.sha256);
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]);let key='';
  try{
   const directory=path.join(root,'hearing',slot.id);fs.mkdirSync(directory,{recursive:true});const wavFile=path.join(directory,'input.wav');
   await run(path.join(asrRoot,'ffmpeg.exe'),['-nostdin','-v','error','-xerror','-i',file.file,'-t','60.1','-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-n',wavFile],{windowsHide:true,signal,timeout:30000,maxBuffer:65536});
   const wav=fs.readFileSync(wavFile),audio={wav,...inspectAudio(wav)};signal.throwIfAborted();
   if(!transport){const child=execFile('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(folder,'credential.ps1'),'-Mode','unprotect'],{windowsHide:true,signal,timeout:10000,maxBuffer:16384,encoding:'utf8'});key=await new Promise((resolve,reject)=>{let out='';child.stdout.on('data',x=>out+=x);child.on('error',()=>reject(Error('HEARING_CREDENTIAL_UNAVAILABLE')));child.on('close',code=>code===0?resolve(out.trim()):reject(Error('HEARING_CREDENTIAL_UNAVAILABLE')));child.stdin.on('error',()=>{});child.stdin.end(fs.readFileSync(path.join(workspace,'state/hearing/credential.dpapi'),'utf8'));});}
   signal.throwIfAborted();if(!configured()||current!==slot)throw Error('HEARING_TURN_REVOKED');
   const result=await (transport??hearAudio)(audio,{key,freeTierConfirmed:true,signal}),observation=makeHearingObservation(result,{sessionId:agent.session.id,accountId:binding.account,conversationKey:binding.key,messageId:slot.id,audioSha256:audio.details.pcmSha256,receivedAt:slot.at});
   signal.throwIfAborted();if(current!==slot)throw Error('HEARING_TURN_REVOKED');db.prepare("UPDATE hearing_results SET state='completed',body=? WHERE id=?").run(JSON.stringify(observation),slot.id);return observation;
  }catch{db.prepare("UPDATE hearing_results SET state='unknown' WHERE id=?").run(slot.id);throw Error('HEARING_RESULT_UNKNOWN');}finally{key='';}
 }},{id:'short-voice',name:'听语音',description:'沿用原来的短语音接口，只读取当前 Chatagent 消息的录音。'}));
 const context=agent.ctx.systemPrompt.context({name:'chatagent:hearing',required:true,order:893,interpolate:false,text:()=>current?'本轮收到 Chatagent 语音。文字部分是本地转写；需要核对原音时可调用 wechat_hearing__listen，只描述工具实际返回的证据。':''});
 return {before(request){this.after();if(!request.proactive&&request.allowedTools?.includes('wechat_hearing__listen')&&!request.disabledTools?.includes('wechat_hearing__listen')&&request.hearingAttachments?.length===1){current={id:request.id,attachment:request.hearingAttachments[0],at:Date.now()};controller=new AbortController();}},after(){controller?.abort();controller=null;current=null;},close(){closed=true;this.after();dispose();context();}};
}

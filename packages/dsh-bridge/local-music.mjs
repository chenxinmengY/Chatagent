import {automaticMusic} from './automatic-music.mjs';
import {connectMusicSettings} from './music-settings.mjs';
import {loadConfiguredMusicHost} from './configured-music.mjs';
import {musicAudio} from './media-audio.mjs';
import {expandMusicCandidates} from './music-candidates.mjs';
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {markPluginTool} from './tool-catalog.mjs';
export async function connectLocalMusic({agent,root,profile,connections}){
 if(!root||!fs.existsSync(path.join(root,'config/music-tool.json')))return null;
 const binding=JSON.parse(fs.readFileSync(path.join(root,'chatagent-binding.json')));if(binding.sessionId!==agent.session.id)throw Error('MUSIC_CHAT_SCOPE_MISMATCH');
 const mapping=JSON.parse(fs.readFileSync(path.join(root,'state/accounts',binding.account,'dsh-sessions.json'))),load=rel=>import(pathToFileURL(path.join(root,'packages/wechat-music',rel)).href);
 const {createMusicTurns}=await load('music-turns.mjs'),{registerMusic}=await load('music-tool.mjs'),{invitation}=await load('intent.mjs');
 let closed=false,inTurn=false,turn,controller,automatic,book,feedback='',invitedResult,invitedAt;
 const settings=await connectMusicSettings(root);
 const ready=()=>connections?.readiness('music')==='ready';
 const host=await loadConfiguredMusicHost(root,{loadedAccount:{id:binding.account},mappings:mapping.conversations,profiles:mapping.profiles,accountReady:()=>!closed&&profile?.()?.capabilities?.find(c=>c.id==='music-listening')?.values.enabled!==false,readWorkMode:()=> 'social',readDshAccess:()=>({tools:['wechat_music__listen']}),transport:async options=>{
  if(!ready())throw Error('MEDIA_NOT_CONFIGURED');const audio=await musicAudio(options.audio,connections.read().connections.music.protocol,{signal:options.signal});
  await connections.infer('music',{...options,audio});options.report.sourceAudioSha256=options.audio.sha256;
 }});if(!host)return null;
 const turns=createMusicTurns({service:host.service,sourceProvider:host.sourceProvider,accountId:()=>binding.account,sessionFor:key=>mapping.conversations[key],allowed:key=>!closed&&key===binding.key,scopeValid:host.scopeValid,historyScopeForSession:host.historyScopeForSession});
 let tool;const dispose=registerMusic({get:key=>key==='tools'?{register:t=>{tool={...t,description:t.description.replace('成功得到观察后，如有自己的感受可调用wechat_media__feeling归档；','成功得到观察后，正常回复会保存到本次听歌记录；'),execute:(args,exec)=>{if(args?.action!=='recall'&&!ready())throw Error('MEDIA_NOT_CONFIGURED');return t.execute(args,exec);}};return agent.ctx.tools.register(markPluginTool(tool,{id:'music-listening',name:'听音乐',description:'使用独立原音频接口听歌，记录保存在 Chatagent。'}));}}:undefined},turns.toolService);
 const context=agent.ctx.systemPrompt.context({name:'chatagent:music',order:891,required:true,interpolate:false,text:()=>feedback+(turn?.context()??'' )});
 return {status:()=>host.status,isRunning:()=>automatic?.isRunning()??false,configuration:()=>({...settings.read(),readiness:!ready()?'not-configured':host.status,running:automatic?.isRunning()??false,phase:automatic?.status().phase??'idle',schedule:automatic?.status().schedule,usage:book?.usage(),activity:book?.activity().filter(r=>r.category==='music').slice(0,5)??[],toolAllowed:profile()?.toolGrants?.[agent.session.id]?.includes('wechat_music__listen')??false}),saveSettings:value=>settings.save(value),async startAutomatic(options){
 const {readMediaSettings,mediaScheduleDue}=await import(pathToFileURL(path.join(root,'packages/media-experiences/settings.mjs')).href),{mediaLedger}=await import(pathToFileURL(path.join(root,'packages/media-experiences/ledger-chatagent.mjs')).href),{musicCandidates}=await import(pathToFileURL(path.join(root,'packages/media-experiences/music-scheduler.mjs')).href);
 book=mediaLedger({root,account:binding.account,key:binding.key,musicRecovery:true});automatic=automaticMusic({root,policy:()=>readMediaSettings(root).music,due:mediaScheduleDue,book,candidates:expandMusicCandidates({ranked:musicCandidates,isMusicCandidate:(await load('content-policy.mjs')).isMusicCandidate}),excluded:()=>host.historyBvids(),...options,ready:()=>ready()&&host.status==='ready',busy:()=>inTurn||options.busy(),listen:async({id,bvid,signal})=>{const messageId='automatic-'+id;const admitted=await turns.admit({sessionId:agent.session.id,conversationKey:binding.key,message:'',messageId,signal,descriptor:{version:1,stop:false,mentions:[bvid],invitation:{bvid,messageId,createdAt:Date.now()}},autonomousOpportunity:{id,origin:'autonomous'}});if(!admitted)throw Error('MUSIC_ADMISSION_REFUSED');try{return await tool.execute({action:'overview'},{agent,signal});}finally{await admitted.cleanup();}}});
 },async before(request){
  inTurn=true;feedback='';invitedResult=null;await automatic?.interrupt();if(request.proactive)return;
  const invited=!!invitation(request.text),permitted=request.allowedTools?.includes('wechat_music__listen')&&!request.disabledTools?.includes('wechat_music__listen');
  if(invited&&(!permitted||!ready()||host.status!=='ready')){feedback='本次听歌邀请没有执行：'+(!permitted?'当前聊天未授权听音乐工具。':!ready()?'原音频接口尚未配置，请在设置→模型与连接配置听歌接口。':'听歌会话授权未就绪。')+'可以自然回应邀请并说明原因，不能描述旋律、节奏、声线或声称听过。';return;}
  if(!permitted)return;controller=new AbortController();
  try{turn=await turns.admit({sessionId:agent.session.id,conversationKey:binding.key,message:request.text,messageId:request.id,signal:controller.signal});if(turn?.invited){invitedAt=Date.now();invitedResult=await tool.execute({action:'overview'},{agent,signal:controller.signal});if(invitedResult.status!=='observed')feedback='本次邀请未获得可确认的听音结果，不能评价旋律或声称已听过。';}}
  catch{feedback='本次听歌邀请的音频处理未完成，没有可确认的听音结果。请如实说明，不能依据标题猜测旋律。';}
 },recordReply(text){
  if(invitedResult?.status!=='observed'||!book||typeof text!=='string'||!text.trim())return;
  const entry=book.experiences('music').find(r=>r.bvid===invitedResult.source.bvid&&!r.feeling&&Date.parse(r.at)>=invitedAt);if(entry){book.setFeeling(entry.id,text.slice(0,1000));if(turn?.binding.opportunityId)book.markFeeling(turn.binding.opportunityId);}
 },cancel(){controller?.abort();},async after(){try{if(turn?.invited&&turn.binding.opportunityId&&book?.round(turn.binding.opportunityId))book.finishRound(turn.binding.opportunityId,invitedResult?.status==='observed'?'completed':'no_observation');controller?.abort();await turn?.cleanup();}finally{turn=null;feedback='';invitedResult=null;inTurn=false;}},async close(){closed=true;await automatic?.close();book?.close();controller?.abort();await turns.close();await host.close();dispose();context();}};
}

import {fileURLToPath} from 'node:url';
import fs from 'node:fs';import path from 'node:path';
import {createCapabilityHost} from '../companion-capabilities/host.mjs';
import {createWorkerClient} from '../companion-capabilities/vendor/singing/worker-client.mjs';
import {createSingingSource} from '../companion-capabilities/vendor/singing/source.mjs';
import {runRvcSong} from '../companion-capabilities/rvc-voice.mjs';
import {fileSha,sha} from '../companion-capabilities/vendor/singing/common.mjs';
import {importSingingResult} from '../companion-capabilities/isolated-singing.mjs';
import {markPluginTool} from './tool-catalog.mjs';
export function singingAttempt(events,requestId){
 const accepted=events.find(event=>event.type==='user/message'&&event.data.source?.rpcId===requestId);if(!accepted)return null;
 const turn=events.findLast(event=>event.type==='turn/start'&&event.seq<accepted.seq)?.data.turn;
 if(turn===undefined)return null;
 const end=events.find(event=>event.type==='turn/end'&&event.data.turn===turn&&event.seq>accepted.seq)?.seq??Infinity;
 const call=events.findLast(event=>{if(event.type!=='tool/call'||event.data.turn!==turn||event.seq<=accepted.seq||event.seq>=end||event.data.name!=='chatagent_singing__control')return false;try{return (typeof event.data.arguments==='string'?JSON.parse(event.data.arguments):event.data.arguments)?.action==='sing';}catch{return false;}});
 if(!call)return null;
 const result=events.findLast(event=>event.type==='tool/result'&&event.data.turn===turn&&event.seq>call.seq&&event.seq<end&&(event.data.message?.toolCallId??event.data.message?.source?.callId)===call.data.callId);
 try{return JSON.parse(result.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join(''));}catch{return null;}
}
export function singingReply(snapshot,text,requestId,attempt){
 const job=snapshot.jobs.findLast(job=>job.request.messageId===requestId);
 if(job&&['error','unknown'].includes(job.status)&&job.failureNotice?.text)return job.failureNotice.text;
 const blocked={needs_invitation:'这次没有启动翻唱任务：还没有识别到有效的点唱邀请。请直接说“想听你唱 BV号”。',needs_selection:'这次还没有开始翻唱，需要先确定有效的BV号和片段范围。',worker_preparing:'唱歌引擎还没准备好，这次没有启动新的翻唱任务。',unavailable:'唱歌引擎当前不可用，这次没有启动翻唱任务。',busy:'已有翻唱任务正在进行，这次没有重复创建任务。'};
 return blocked[attempt?.status]??text;
}
export function connectLocalSinging({agent,root,configFile,binding,rvcProfile}){
 if(!configFile)return null;const config=JSON.parse(fs.readFileSync(configFile));if(!config.enabled)return null;
 const mansuiDigest=rvcProfile?sha(JSON.stringify({profile:fileSha(rvcProfile),converter:fileSha(fileURLToPath(new URL('../companion-capabilities/rvc-voice.py',import.meta.url))),dml:fileSha(fileURLToPath(new URL('../companion-capabilities/rvc_dml.py',import.meta.url))),backingDb:-3})):null;
 const verify=()=>{for(const pin of config.runtimePins??[])if(fileSha(pin.path)!==pin.sha256)throw Error('SINGING_RUNTIME_CHANGED');};verify();
 let client,starting,closed=false,context='',currentRequestId;fs.mkdirSync(root,{recursive:true});
 const worker=rvcProfile?{
  get ready(){return !closed;},
  run(args){if(closed)throw Error('SINGING_CLOSED');return runRvcSong(rvcProfile,root,args);},
  async close(){closed=true;}
 }:{get ready(){return !closed&&(!client||client.ready);},get state(){return client?.state??'idle';},cancel:id=>client?.cancel(id),async run(args){
  if(closed)throw Error('SINGING_CLOSED');verify();if(!client){client=createWorkerClient({...config.worker,directory:path.join(root,'worker-owner')});starting=(async()=>{const until=Date.now()+120000;while(!client.ready){args.signal.throwIfAborted();if(client.state==='unavailable'||Date.now()>until)throw Error('SINGING_WORKER_UNAVAILABLE');await new Promise(r=>setTimeout(r,100));}})();}
  await starting;args.signal.throwIfAborted();const result=await client.run(args);args.signal.throwIfAborted();return importSingingResult({runtimeDirectory:client.runtimeDirectory,outputRoot:root,id:args.id,mode:args.mode??'clip',result});
 },async close(){closed=true;await client?.close();await starting?.catch(()=>{});}};
 let sourceInstance;const sourceValue=()=>sourceInstance??=createSingingSource({...config.source,directory:path.join(root,'source'),inputsDirectory:path.join(root,'inputs')});
 const source={resolve:(...args)=>sourceValue().resolve(...args),prepare:(...args)=>sourceValue().prepare(...args)};
 const host=createCapabilityHost({root,capsule:{account:config.scope.accountId,key:config.scope.conversationKey,personaDigest:config.scope.personaDigest},providers:{singingWorker:worker,singingSource:source,recipeDigest:mansuiDigest??config.recipeDigest,selectSingingVoice:rvcProfile?()=>({voiceId:'mansui',voiceRecipe:mansuiDigest}):undefined},enableBili:false});host.attachDelivery(binding);
 const describe=result=>{const job=result.job&&host.singing.snapshot().jobs.find(job=>job.id===result.job.id);return {...result,currentRequestId,...job?{job:{...result.job,requestId:job.request.messageId,requestedAt:job.request.createdAt},jobIsCurrent:job.request.messageId===currentRequestId}:{}};};
 const dispose=agent.ctx.tools.register(markPluginTool({name:'chatagent_singing__control',description:'在 Chatagent 中唱歌，支持10分钟以内原曲：status 查看进度，sing 接受当前聊天明确邀请后开始，待选歌时补发BV号可接续，stop 停止。submitted只代表已受理，不代表制作成功；答复前查询status，失败时如实说明errorMessage，不再声称正在准备或承诺自动发歌。jobIsCurrent=false表示返回的是此前任务，不能说本轮重试失败；needs_invitation/needs_selection表示本轮没有启动翻唱，不能说获取原曲失败。完成后发送到当前聊天。',parameters:{type:'object',properties:{action:{type:'string',enum:['context','status','sing','stop']}},required:['action'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_,r)=>[{type:'text',text:JSON.stringify(r)}]},async execute({action}){return describe(await host.singingControl(action));}},{id:'singing',name:'唱歌',description:'沿用现有音色与已接受的唱歌参数，投递至 Chatagent。'}));
 const ctx=agent.ctx.systemPrompt.context({name:'chatagent:singing',order:892,required:true,interpolate:false,text:()=>context});
 return {async before(request){if(request.proactive||!request.allowedTools?.includes('chatagent_singing__control'))return;currentRequestId=request.id;const s=await host.beforeTurn({...request,mode:'social'});context=JSON.stringify(describe(s.singing));},finalizeReply:(text,requestId)=>singingReply(host.singing.snapshot(),text,requestId,singingAttempt(agent.session?.snapshotEvents?.()??[],requestId)),after(){host.afterTurn();context='';currentRequestId=undefined;},cancel:()=>host.cancel(),status:()=>host.status(),async close(){await host.close();dispose();ctx();}};
}

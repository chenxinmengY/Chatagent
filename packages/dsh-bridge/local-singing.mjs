import fs from 'node:fs';import path from 'node:path';
import {createCapabilityHost} from '../companion-capabilities/host.mjs';
import {createWorkerClient} from '../companion-capabilities/vendor/singing/worker-client.mjs';
import {createSingingSource} from '../companion-capabilities/vendor/singing/source.mjs';
import {fileSha} from '../companion-capabilities/vendor/singing/common.mjs';
import {importSingingResult} from '../companion-capabilities/isolated-singing.mjs';
import {markPluginTool} from './tool-catalog.mjs';
export function connectLocalSinging({agent,root,configFile,binding}){
 if(!configFile)return null;const config=JSON.parse(fs.readFileSync(configFile));if(!config.enabled)return null;
 const verify=()=>{for(const pin of config.runtimePins??[])if(fileSha(pin.path)!==pin.sha256)throw Error('SINGING_RUNTIME_CHANGED');};verify();
 let client,starting,closed=false,context='';fs.mkdirSync(root,{recursive:true});
 const worker={get ready(){return !closed&&(!client||client.ready);},get state(){return client?.state??'idle';},cancel:id=>client?.cancel(id),async run(args){
  verify();if(closed)throw Error('SINGING_CLOSED');if(!client){client=createWorkerClient({...config.worker,directory:path.join(root,'worker-owner')});starting=(async()=>{const until=Date.now()+120000;while(!client.ready){args.signal.throwIfAborted();if(client.state==='unavailable'||Date.now()>until)throw Error('SINGING_WORKER_UNAVAILABLE');await new Promise(r=>setTimeout(r,100));}})();}
  await starting;args.signal.throwIfAborted();const result=await client.run(args);args.signal.throwIfAborted();return importSingingResult({runtimeDirectory:client.runtimeDirectory,outputRoot:root,id:args.id,mode:args.mode??'clip',result});
 },async close(){closed=true;await client?.close();await starting?.catch(()=>{});}};
 let sourceInstance;const sourceValue=()=>sourceInstance??=createSingingSource({...config.source,directory:path.join(root,'source'),inputsDirectory:path.join(root,'inputs')});
 const source={resolve:(...args)=>sourceValue().resolve(...args),prepare:(...args)=>sourceValue().prepare(...args)};
 const host=createCapabilityHost({root,capsule:{account:config.scope.accountId,key:config.scope.conversationKey,personaDigest:config.scope.personaDigest},providers:{singingWorker:worker,singingSource:source,recipeDigest:config.recipeDigest},enableBili:false});host.attachDelivery(binding);
 const dispose=agent.ctx.tools.register(markPluginTool({name:'chatagent_singing__control',description:'在 Chatagent 中唱歌：status 查看进度，sing 接受当前聊天明确邀请后开始，stop 停止。沿用当前唱歌引擎和音色，完成后发送到当前聊天。',parameters:{type:'object',properties:{action:{type:'string',enum:['context','status','sing','stop']}},required:['action'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_,r)=>[{type:'text',text:JSON.stringify(r)}]},execute:({action})=>host.singingControl(action)},{id:'singing',name:'唱歌',description:'沿用现有音色与已接受的唱歌参数，投递至 Chatagent。'}));
 const ctx=agent.ctx.systemPrompt.context({name:'chatagent:singing',order:892,required:true,interpolate:false,text:()=>context});
 return {async before(request){if(request.proactive||!request.allowedTools?.includes('chatagent_singing__control'))return;const s=await host.beforeTurn({...request,mode:'social'});context=JSON.stringify(s.singing);},after(){host.afterTurn();context='';},cancel:()=>host.cancel(),status:()=>host.status(),async close(){await host.close();dispose();ctx();}};
}

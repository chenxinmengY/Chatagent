import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {mediaLedger,mediaId} from './ledger.mjs';

export const mediaContext=new AsyncLocalStorage();
export const MEDIA_EXPERIENCE_POLICY=Symbol.for('wechatagent.media-experience.v1');
export const usageTotal=usage=>{if(!usage||!Number.isSafeInteger(usage.inputTokens)||!Number.isSafeInteger(usage.outputTokens))return null;const values=[usage.inputTokens,usage.outputTokens,usage.cacheReadTokens??0,usage.cacheWriteTokens??0],total=values.reduce((a,b)=>a+b,0);return values.every(v=>Number.isSafeInteger(v)&&v>=0)&&total>0?total:null;};
export function mediaReservation(options){
 let images=0;const bytes=Buffer.byteLength(JSON.stringify({system:options.system,messages:options.messages??[],tools:options.tools??[]},(key,value)=>{if(value?.type==='image')images++;if(key==='data'&&typeof value==='string'&&value.length>512)return '[binary omitted]';return value;}),'utf8');
 return Math.max(80000,bytes+images*4096+options.maxTokens+8192);
}
export function installMediaRuntime({ctx,root,account,keyFor,pending,accountReady,memoryDirectory=path.join(process.env.DSH_HOME??path.join(os.homedir(),'.dsh'),'fish-memory')}){
 const ledgers=new Map(),bound=new WeakSet();
 const ledger=key=>{if(!accountReady()||!/^wechat:private:[1-9]\d{0,15}$/.test(key))throw Error('MEDIA_SCOPE_REVOKED');if(!ledgers.has(key))ledgers.set(key,mediaLedger({root,account,key}));return ledgers.get(key);};
 ctx.on('llm/stream',(options,next)=>{
  const scope=mediaContext.getStore()??(()=>{const item=pending.get(String(options.sessionId??'')),key=keyFor(String(options.sessionId??''));return item?.mediaRoundId?(item.mediaScope??{key,roundId:item.mediaRoundId}):null;})();
  if(!scope?.roundId)return next();
  return (async function*(){const book=ledger(scope.key),id=crypto.randomUUID();
   // Prepared agent requests are frozen; their output cap is set in agent/request.
   // Direct helper calls (e.g. memory expansion) use mutable explicit options.
   if(!Object.isFrozen(options))options.maxTokens=Math.min(options.maxTokens??8192,8192);
   if(!Number.isSafeInteger(options.maxTokens)||options.maxTokens<1||options.maxTokens>8192)throw Error('MEDIA_OUTPUT_CAP_REQUIRED');
   const reserve=mediaReservation(options);try{book.reserveRequest(id,scope.roundId,reserve);}catch(error){scope.denied=error.message;throw error;}let total=null;
   scope.submitted=(scope.submitted??0)+1;
   try{for await(const chunk of next()){if(chunk.type==='usage'){const measured=usageTotal(chunk.usage);if(measured!==null)total=measured;}yield chunk;}}finally{if(total!==null)book.settleRequest(id,total);}
  })();
 },{global:true});
 const memoryRows=sid=>{if(typeof sid!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(sid))return [];try{const file=path.join(memoryDirectory,sid+'.json'),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)return [];const rows=JSON.parse(fs.readFileSync(file,'utf8')).memories;return Array.isArray(rows)?rows:[];}catch{return [];}};
 function bind(agent,key){if(bound.has(agent))return;bound.add(agent);const music=new Map();
  const canRecord=()=>accountReady()&&keyFor(String(agent.session.id))===key&&!!pending.get(String(agent.session.id))?.musicConfirmed;
  Object.defineProperty(agent.ctx,MEDIA_EXPERIENCE_POLICY,{configurable:true,value:{names:()=>canRecord()?['wechat_media__feeling']:[],check:name=>name==='wechat_media__feeling'&&canRecord(),activityNames:()=>{const item=pending.get(String(agent.session.id));if(!item?.autonomousMusic)return null;if(!item.musicAdmitted)return [];return ['wechat_music__listen',...(item.musicConfirmed?['wechat_media__feeling']:[]),...(item.musicExperienceId?['remember']:[])];}}});
  agent.ctx.on('tools/execute',async(exec,next)=>{
   const item=pending.get(String(exec.agent.session.id));
   if(exec.name==='remember'&&item){const eventId=item.readingMemoryEvent??item.musicExperienceId;const scope={key,roundId:item.mediaRoundId,eventId};return mediaContext.run(scope,()=>next());}
   return next();
  });
  agent.ctx.on('tools/result',(exec,result)=>{
   const sid=String(exec.agent.session.id),item=pending.get(sid);if(!item||!accountReady())return;if(result.isError){if(exec.name==='wechat_music__listen'&&item.musicOpportunityId)ledger(key).setOutcome(item.musicOpportunityId,{status:'request_failed',reason:'听音工具执行失败，未计成功'});return;}
   if(exec.name==='wechat_music__listen'&&result.value?.status==='observed'&&result.value.material?.coverage?.requestCompleted===true&&result.value.material.coverage.performedNow===true){const value=result.value,coverage=value.material.coverage,eventId='music-'+mediaId([account,key,value.source.bvid,coverage.audioSha256,coverage.audioProcessedAt].join('\0'));music.set(sid,{id:eventId,kind:'music',bvid:value.source.bvid,cid:value.source.cid,title:value.source.bvid,at:coverage.audioProcessedAt,feeling:'',start:coverage.start,end:coverage.end,coverage});item.musicConfirmed=music.get(sid);}
   if(exec.name==='remember'&&result.value?.ok===true){const text=exec.arguments?.text?.trim(),eventId=item.readingMemoryEvent??(text&&text===item.musicMemoryCandidate?item.musicExperienceId:null);if(!eventId)return;const rows=memoryRows(sid).filter(r=>typeof r.id==='string'&&typeof text==='string'&&r.text===text);ledger(key).markMemory(eventId,rows.length===1?'verified':'unconfirmed',rows.length===1?rows[0].id:null);}
  });
  agent.ctx.get('tools').register({name:'wechat_media__feeling',description:'只有本轮已成功取得真实音乐观察时，记录你自己的听后感受。没有感受可以留空。归档不会发送微信，也不等于长期记忆。若你认为体验有长期意义，可另行调用已授权remember，text使用返回的memoryCandidate；不重要则无需记。',parameters:{type:'object',properties:{feeling:{type:'string',maxLength:1000}},required:['feeling'],additionalProperties:false},output:{schema:{type:'object',properties:{recorded:{type:'boolean'},memoryCandidate:{type:'string'}},required:['recorded','memoryCandidate'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args,exec){const sid=String(exec.agent.session.id),item=pending.get(sid),entry=item?.musicConfirmed;if(!entry||typeof args.feeling!=='string'||args.feeling.length>1000||!canRecord())throw Error('MUSIC_EXPERIENCE_UNAVAILABLE');exec.signal?.throwIfAborted();const book=ledger(key);if(!book.experiences('music').some(e=>e.id===entry.id))book.addExperience(entry);book.setFeeling(entry.id,args.feeling);if(item.musicOpportunityId)book.markFeeling(item.musicOpportunityId);item.musicExperienceId=entry.id;item.musicMemoryCandidate=args.feeling.trim()?`我听过 ${entry.bvid} 的 ${entry.start}—${entry.end} 秒，感受：${args.feeling}`:'';return {recorded:true,memoryCandidate:item.musicMemoryCandidate};}});
 }
 const close=()=>{for(const book of ledgers.values())book.close();ledgers.clear();};ctx.on('dispose',close);
 return {ledger,bind,close,run:(scope,fn)=>mediaContext.run(scope,fn)};
}

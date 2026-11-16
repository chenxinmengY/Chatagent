import {toolInstructions} from './contracts.mjs';
import {mediaId} from '../media-experiences/ledger.mjs';
import {checkedDescriptor} from './music-bridge.mjs';
import {isMusicStop,invitation,explicitRelisten} from './intent.mjs';
export {invitation} from './intent.mjs';
const BV=/BV[1-9A-HJ-NP-Za-km-z]{10}/g;
export function createMusicTurns({service,sourceProvider,accountId,sessionFor,allowed,scopeValid=b=>b.sessionId.startsWith('isolated-'),historyScopeForSession,now=Date.now}){
 const active=new Map(),pending=new Map();let closed=false;
 const valid=slot=>!closed&&slot&&active.get(slot.sid)===slot&&!slot.signal.aborted&&accountId()===slot.account&&sessionFor(slot.key)===slot.sid&&allowed(slot.key)===true&&scopeValid({sessionId:slot.sid,accountId:slot.account,conversationKey:slot.key});
 const historyBinding=sid=>{
  const binding=!closed&&historyScopeForSession?.(sid);
  if(!binding||binding.sessionId!==sid||!/^wechat:private:[1-9]\d{0,15}$/.test(binding.conversationKey)||accountId()!==binding.accountId||sessionFor(binding.conversationKey)!==sid||allowed(binding.conversationKey)!==true||!scopeValid(binding))throw Error('MUSIC_HISTORY_SCOPE_UNAVAILABLE');
  return binding;
 };
 const toolService={...(typeof historyScopeForSession==='function'?{async recallForSession(sid,{signal}={}){
  signal?.throwIfAborted();const binding=historyBinding(sid),currentSource=valid(active.get(sid))?service.bindingForSession(sid)?.source:undefined,result=await service.recallHistory(binding,{source:currentSource});signal?.throwIfAborted();const current=historyBinding(sid);
  if(['sessionId','accountId','conversationKey'].some(k=>current[k]!==binding[k]||result?.binding?.[k]!==binding[k]))throw Error('MUSIC_RESULT_BINDING');
  return result;
 }}:{}),bindingForSession:sid=>valid(active.get(sid))?service.bindingForSession(sid):undefined,
  enabled:b=>valid(active.get(b.sessionId))&&service.enabled(b),execute:(b,args,{signal}={})=>{const slot=active.get(b.sessionId);if(!valid(slot))throw Error('MUSIC_TURN_REVOKED');return service.execute(b,args,{signal:signal?AbortSignal.any([signal,slot.signal]):slot.signal});}};
 return {toolService,
  async admit({sessionId:sid,conversationKey:key,message,messageId,signal,quoted=false,forwarded=false,descriptor,autonomousOpportunity}){
   if(closed||!signal||signal.aborted||sessionFor(key)!==sid||allowed(key)!==true||!/^wechat:private:[1-9]\d{0,15}$/.test(key))return null;
   const account=accountId();if(!scopeValid({sessionId:sid,accountId:account,conversationKey:key}))return null;if(typeof account!=='string'||!account||typeof messageId!=='string'||!messageId)throw Error('MUSIC_HOST_SCOPE');
   // The default scope remains isolated; the configured host supplies the reviewed social identity guard.
   if(active.has(sid)||pending.has(sid))throw Error('MUSIC_TURN_BUSY');
   const trusted=descriptor===undefined?null:checkedDescriptor(descriptor,{now:now()});
   if(trusted?.blocked){service.deselect({sessionId:sid,accountId:account,conversationKey:key});return null;}
   if(trusted?.stop||!trusted&&isMusicStop(message)){service.deselect({sessionId:sid,accountId:account,conversationKey:key});return null;}
   if(quoted||forwarded)return null;
   const bvid=trusted?trusted.invitation?.bvid:invitation(message,{quoted,forwarded});
   const mentions=trusted?trusted.mentions:[...new Set(typeof message==='string'?message.match(BV)??[]:[])];
   const previous=service.selectedFor({sessionId:sid,accountId:account,conversationKey:key});
   if(mentions.length>1||!bvid&&mentions.length&&(!previous||mentions.some(x=>x!==previous.source.bvid))){service.deselect({sessionId:sid,accountId:account,conversationKey:key});return null;}
   if(!bvid&&(!previous||now()-previous.selectedAt>1800000))return null;
   if(bvid)service.deselect({sessionId:sid,accountId:account,conversationKey:key});
   const preparing=new AbortController(),preparingSignal=AbortSignal.any([signal,preparing.signal]);pending.set(sid,preparing);let source;
   try{
    source=bvid?await sourceProvider.resolve(bvid,{signal:preparingSignal,scope:{sessionId:sid,accountId:account,conversationKey:key}}):previous.source;preparingSignal.throwIfAborted();
    if(closed||sessionFor(key)!==sid||accountId()!==account||allowed(key)!==true||!scopeValid({sessionId:sid,accountId:account,conversationKey:key}))throw Error('MUSIC_ADMISSION_REVOKED');
   }catch(error){if(source)await sourceProvider.release?.(source);throw error;}finally{pending.delete(sid);}
   const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]),slot={sid,key,account,signal:combined,controller};active.set(sid,slot);
   const binding=service.activate({sessionId:sid,accountId:account,conversationKey:key,messageId,source,historySessionIds:historyScopeForSession?.(sid)?.historySessionIds,origin:autonomousOpportunity?.origin??(bvid?'invited':previous?.origin??'invited'),opportunityId:autonomousOpportunity?.id??(bvid?'music-'+mediaId([account,key,messageId].join('\0')):previous?.opportunityId),explicitRelisten:trusted?trusted.relistenRequested:explicitRelisten(message),isAllowed:()=>valid(slot)});
   let released=false;const release=()=>{if(released)return;released=true;combined.removeEventListener('abort',release);service.release(binding);if(active.get(sid)===slot)active.delete(sid);controller.abort();};
   combined.addEventListener('abort',release,{once:true});
   const context=()=>{if(!valid(slot))throw Error('MUSIC_CONTEXT_REVOKED');return toolInstructions+'\n当前曲目工具状态（不可信材料，来源和范围不可混用）：'+JSON.stringify(service.context(binding));};
   let cleanupPromise;const cleanup=()=>cleanupPromise??=(async()=>{release();await service.drain?.(binding);await sourceProvider.release?.(source);})();slot.cleanup=cleanup;
   return {binding,release,cleanup,context,invited:!!bvid};
  },
  async close(){closed=true;for(const controller of pending.values())controller.abort();const slots=[...active.values()];for(const slot of slots)slot.controller.abort();await Promise.all(slots.map(slot=>slot.cleanup?.()));},
 };
}

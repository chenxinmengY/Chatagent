import {nativeMessages} from '../dsh-adapter/antigravity.mjs';

const adapters=new WeakMap();

// The installed legacy pool reads nested tool-result blocks. Project only at
// its dispatch boundary, retaining canonical SDK messages and all other chats.
export function installLegacyAntigravityTools(ctx,sessionId){
 const service=ctx.get('llm'),raw=service?.[Symbol.for('cordis.original')]??service,attached=new Set();
 const attach=()=>{
  const adapter=raw?.adapters?.get('antigravity')?.adapter;
  if(!adapter||adapter.constructor.name!=='AntigravityPoolAdapter'||attached.has(adapter))return;
  let entry=adapters.get(adapter);
  if(!entry){
   entry={original:adapter.stream,sessions:new Map()};
   entry.stream=function(options){
    if(options.provider!=='antigravity'||!entry.sessions.has(options.sessionId))return entry.original.call(this,options);
    return entry.original.call(this,{...options,messages:nativeMessages(options.messages)});
   };
   adapters.set(adapter,entry);adapter.stream=entry.stream;
  }
  attached.add(adapter);entry.sessions.set(sessionId,(entry.sessions.get(sessionId)??0)+1);
 };
 const unlisten=ctx.on('llm/adapters-updated',attach);attach();
 const dispose=()=>{
  unlisten();
  for(const adapter of attached){
   const entry=adapters.get(adapter),count=entry.sessions.get(sessionId)-1;
   if(count)entry.sessions.set(sessionId,count);else entry.sessions.delete(sessionId);
   if(!entry.sessions.size){if(adapter.stream===entry.stream)adapter.stream=entry.original;adapters.delete(adapter);}
  }
 };
 dispose.active=()=>{
  const adapter=raw?.adapters?.get('antigravity')?.adapter,entry=adapter&&adapters.get(adapter);
  return !!entry&&adapter.stream===entry.stream&&entry.sessions.has(sessionId);
 };
 return dispose;
}

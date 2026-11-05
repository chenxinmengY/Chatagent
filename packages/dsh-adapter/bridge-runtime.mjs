import {maintainMode} from './context-maintenance.mjs';
import {hash} from '../migration/portable.mjs';
import {windowPolicy} from '../conversation/window-policy.mjs';
export async function createDshBridgeRuntime({url,token,timeoutMs=120000,historyRecords=[],chatId=null}){
  const endpoint=new URL(url);
  if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/'||typeof token!=='string'||token.length<32)throw Error('BRIDGE_CONNECTION_INVALID');
  let cached,closed=false,contextAttempt=null,delivery,sessionId,archiveCount=-1;
  if(chatId!==null&&!/^[a-f0-9-]{36}$/.test(chatId))throw Error('BRIDGE_CHAT_INVALID');
  async function call(route,body){const r=await fetch(new URL((chatId?'/v1/chats/'+chatId:'')+route,endpoint),{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(10000)});if(sessionId&&r.headers.get('X-Chatagent-Dsh-Session')!==sessionId)throw Error('BRIDGE_SESSION_CHANGED');const value=await r.json();if(!r.ok)throw Error(value.error??'BRIDGE_CALL_FAILED');return value;}
  async function status(){const next=await call('/v1/status');if(next.format!=='chatagent-dsh-bridge-v1')throw Error('BRIDGE_PROTOCOL_UNSUPPORTED');if(sessionId&&sessionId!==next.sessionId)throw Error('BRIDGE_SESSION_CHANGED');sessionId=next.sessionId;cached=next;return cached;}
  await status();
  async function lookup(request){const r=await call('/v1/requests/'+encodeURIComponent(request.id));return r.state==='completed'?r.text:null;}
  return {
    kind:'dsh-bridge',externalRuntime:true,supportsAttachments:cached.mediaInput===true,
    openChat:id=>createDshBridgeRuntime({url,token,timeoutMs,chatId:id}),
    attachDelivery:binding=>{delivery=binding;const row=delivery.store.db.prepare("SELECT value FROM settings WHERE key='dsh_bridge_context_attempt'").get();contextAttempt=row?JSON.parse(row.value):null;},
    attachmentTranscription:id=>call('/v1/transcription',{id,start:false}),
    transcribeAttachment:id=>call('/v1/transcription',{id,start:true}),
    async flushDeliveries(){if(!delivery)return;const count=delivery.store.db.prepare('SELECT COUNT(*) n FROM portable_records').get().n;if(count!==archiveCount&&count){const records=delivery.store.db.prepare('SELECT body FROM portable_records ORDER BY key').all().map(r=>JSON.parse(r.body));await call('/v1/archive',{package:{format:'chatagent-portable-v1',sourceId:'chatagent',scope:'archives',records,digest:hash(records)}});archiveCount=count;}const rows=await call('/v1/deliveries');for(const row of rows){for(const ref of row.attachments){const file=delivery.attachments.verify(ref.id);if(file.sha256!==ref.sha256||file.bytes!==ref.bytes)throw Error('BRIDGE_ATTACHMENT_CHANGED');}delivery.store.publish(row);}if(rows.length)await call('/v1/deliveries/ack',{ids:rows.map(r=>r.deliveryId)});},
    bridgeStatus:status,
    pluginStatus:()=>call('/v1/plugins'),
    pluginDetail:id=>call('/v1/plugins/'+encodeURIComponent(id)+'/timetable'),
    pluginAction:(id,action,body)=>call('/v1/plugins/'+encodeURIComponent(id)+'/'+encodeURIComponent(action),body),
    companionStatus:()=>({kind:'dsh-bridge',historyRecords:cached.migration?.messages??historyRecords.length,memories:cached.migration?.memory?.active??null,deletedMemories:cached.migration?.memory?.deleted??null,plugins:(cached.plugins??[]).map(p=>({id:p.entryId,name:p.meta?.name??p.moduleName,active:p.fiberPhase==='active'})),tools:cached.tools??[],sessionId:cached.sessionId}),
    historyRecords:()=>historyRecords,
    status:()=>({kind:'dsh-bridge',modeBindings:[{mode:'social',session_id:cached.sessionId}]}),
    contextStatus:()=>({state:'dsh-managed',modes:[{mode:'social',tokens:cached.context?.tokens??null,tokenSource:'dsh'}]}),
    workspaceInfo:()=>({sessionsRoot:null,workspaces:[],runtime:'dsh-bridge',sessionId:cached.sessionId}),
    cancelCapabilities:()=>call('/v1/cancel',{}),
    async reply(request){if(closed)throw Error('DSH_RUNTIME_CLOSED');if(request.mode!=='social')throw Error('CHAT_ONLY');await status();const disabledTools=request.policy?.disabledTools??[];let allowedTools=request.policy?.allowedTools;
      // Local archive lookup is part of windowed chat; plugin authorization stays explicit.
      if(allowedTools&&['recent-window-v1','topic-window-v2'].includes(cached.context?.mode)&&!request.proactive&&!disabledTools.includes('chatagent_history_search'))allowedTools=[...new Set([...allowedTools,'chatagent_history_search'])];
      const start=await call('/v1/requests',{id:request.id,text:request.text,attachments:request.attachments??[],persona:request.persona??null,proactive:request.proactive===true,disabledTools,...(cached.context?.mode==='topic-window-v2'?{windowPolicy:windowPolicy(request.policy??{})}:{}),...(allowedTools?{allowedTools}:{})});if(start.state==='completed')return start.text;const deadline=Date.now()+timeoutMs;while(Date.now()<deadline&&!closed){await this.flushDeliveries();const r=await call('/v1/requests/'+encodeURIComponent(request.id));if(r.state==='completed')return r.text;if(r.state==='unknown'||r.state==='not-found')throw Error('DSH_RESULT_UNKNOWN');await new Promise(resolve=>setTimeout(resolve,250));}throw Error('DSH_RESULT_UNKNOWN');},
    lookupResult:lookup,
    proactive(request){return this.reply({...request,mode:'social',proactive:true,text:request.text??'系统定时触发的主动聊天机会，这不是用户新发的消息。根据当前人格和已有对话，自然地关心近况或分享一句话。只生成要发出的文字，不使用工具，不虚构刚发生的事情，不创建提醒。'});},
    async maintainContext(settings){if(!settings.policy.contextEnabled)return;const s=await status();if(s.context?.state!=='ready'||s.context.tokens==null||!s.context.signature)return;contextAttempt=await maintainMode({policy:{enabled:true,maxTokens:settings.modes.social.contextMaxTokens??settings.policy.contextMaxTokens},measurement:{totalTokens:s.context.tokens},signature:s.context.signature,previous:contextAttempt,now:Date.now(),compact:()=>call('/v1/context/compact',{})});delivery?.store.db.prepare("INSERT OR REPLACE INTO settings VALUES('dsh_bridge_context_attempt',?)").run(JSON.stringify(contextAttempt));},
    async close(){closed=true;}
  };
}

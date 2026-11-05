import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {startDshBridgeHost,bridgeReply} from '../packages/dsh-bridge/host.mjs';
import {createDshBridgeRuntime} from '../packages/dsh-adapter/bridge-runtime.mjs';
import {startService} from '../apps/service/server.mjs';
import {hash} from '../packages/migration/portable.mjs';
import {sandbox} from './helpers.mjs';
const token='synthetic-bridge-secret-'.repeat(3);
const events=(id,text)=>[{seq:1,type:'turn/start',data:{turn:'turn-1'}},{seq:2,type:'user/message',data:{source:{kind:'user',rpcId:id},content:[{type:'text',text:'synthetic'}]}},{seq:3,type:'assistant/message',data:{turn:'turn-1',message:{content:[{type:'text',text}]}}},{seq:4,type:'turn/end',data:{turn:'turn-1',reason:{kind:'completed'}}}];
async function fixture(t,options={}){let cleanup;const box=sandbox({after:fn=>cleanup=fn}),closers=[];let saved=[],calls=0,binding,tools=[{name:'synthetic_tool',description:'Synthetic native tool'}],fail=false;
 const driver={configure:v=>binding=v,ensure:async()=>{},status:()=>({connected:true,tools,plugins:[],mediaInput:false,context:{state:'ready',tokens:100,signature:'1'}}),prompt:async r=>{calls++;if(fail)throw Error('synthetic interrupted');saved=events(r.id,'Synthetic native result');},wait:async()=>{},events:()=>saved,flush:async()=>{},cancel:async()=>{},compact:async()=>({state:'completed'}),...options};
 const root=path.join(box.root,'bridge');let host=await startDshBridgeHost({root,token,port:0,driver});t.after(async()=>{for(const close of closers.reverse())await close();await host?.close();cleanup();});
 const call=async(route,body,auth=token)=>{const r=await fetch(host.url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,value:await r.json()};};
 return {box,call,closers,get host(){return host;},get calls(){return calls;},get binding(){return binding;},set fail(v){fail=v;},set tools(v){tools=v;},async restart(){await host.close();host=await startDshBridgeHost({root,token,port:0,driver});}};
}
test('native bridge authenticates, previews migration without prompts and requires exact review',async t=>{const f=await fixture(t);assert.equal((await f.call('/v1/status',undefined,'wrong')).status,401);const records=[{sourceId:'synthetic',scope:'one',id:'a',kind:'message',role:'user',text:'old archive',at:1}],pack={format:'chatagent-portable-v1',sourceId:'synthetic',scope:'one',records,digest:hash(records)};
 const preview=await f.call('/v1/import/preview',{package:pack,persona:'synthetic persona'});assert.equal(preview.value.messages,1);assert.equal(f.calls,0);assert.equal((await f.call('/v1/import/apply',{package:pack,persona:'synthetic persona',preview:'stale'})).value.error,'BRIDGE_PREVIEW_CHANGED');assert.equal((await f.call('/v1/import/apply',{package:pack,persona:'synthetic persona',preview:preview.value.digest})).status,200);assert.equal(f.binding.imported().records[0].text,'old archive');assert.equal(f.calls,0);
});
test('native bridge proves completion, deduplicates across restart and never replays unknown work',async t=>{const f=await fixture(t),runtime=await createDshBridgeRuntime({url:f.host.url,token});t.after(()=>runtime.close());const request={id:'synthetic-request',text:'synthetic',mode:'social'};assert.equal(await runtime.reply(request),'Synthetic native result');assert.equal(await runtime.reply(request),'Synthetic native result');assert.equal(f.calls,1);assert.equal((await f.call('/v1/requests',{id:request.id,text:'changed'})).value.error,'BRIDGE_REQUEST_CONFLICT');await f.restart();assert.equal((await f.call('/v1/requests/synthetic-request')).value.text,'Synthetic native result');assert.equal(f.calls,1);f.fail=true;await f.call('/v1/requests',{id:'interrupted',text:'synthetic'});await new Promise(r=>setTimeout(r,10));await f.restart();assert.equal((await f.call('/v1/requests',{id:'interrupted',text:'synthetic'})).value.state,'unknown');assert.equal(f.calls,2);});
test('native bridge transports plugin deliveries idempotently and reads current tools',async t=>{const f=await fixture(t),runtime=await createDshBridgeRuntime({url:f.host.url,token}),service=await startService({dataRoot:path.join(f.box.root,'chat'),backend:runtime,automaticBackups:false});f.closers.push(async()=>{await service.close();await runtime.close();});f.binding.publish({deliveryId:'synthetic-reminder',text:'Synthetic plugin delivery'});await service.tick();await service.tick();assert.equal(service.store.history().length,1);assert.equal((await f.call('/v1/deliveries')).value.length,0);f.tools=[{name:'newly_configured_tool'}];assert.equal((await runtime.bridgeStatus()).tools[0].name,'newly_configured_tool');const b=await service.backup();assert.deepEqual(b.coverage,['chatagent.local-chat.sqlite']);});
test('native bridge rejects partial, cancelled and tool-only events as final replies',()=>{const list=events('r','answer');assert.equal(bridgeReply(list,'r'),'answer');assert.equal(bridgeReply(list,'other'),null);assert.equal(bridgeReply(list.slice(0,-1),'r'),null);list[3].data.reason.kind='cancelled';assert.equal(bridgeReply(list,'r'),null);list[3].data.reason.kind='completed';list[2].data.message.content=[{type:'tool-call',name:'x'}];assert.equal(bridgeReply(list,'r'),null);});

test('window mode adds only local archive lookup, honoring opt-out and proactive tool restrictions',async t=>{
 const requests=[];let mode='recent-window-v1';
 const f=await fixture(t,{status:()=>({connected:true,tools:[],plugins:[],context:{state:'ready',mode}}),prompt:async r=>requests.push(r)});
 const runtime=await createDshBridgeRuntime({url:f.host.url,token});t.after(()=>runtime.close());
 const policy={allowedTools:['remember'],disabledTools:[]};
 async function submit(id,extra={}){await assert.rejects(runtime.reply({id,text:'synthetic',mode:'social',policy,...extra}),/DSH_RESULT_UNKNOWN/);return requests.at(-1);}
 assert.deepEqual((await submit('window')).allowedTools,['remember','chatagent_history_search']);
 assert.deepEqual(policy.allowedTools,['remember']);
 assert.deepEqual((await submit('disabled',{policy:{allowedTools:['remember'],disabledTools:['chatagent_history_search']}})).allowedTools,['remember']);
 assert.deepEqual((await submit('proactive',{proactive:true,policy:{allowedTools:[]}})).allowedTools,[]);
 mode='legacy';assert.deepEqual((await submit('legacy')).allowedTools,['remember']);
 mode='topic-window-v2';const longer={...policy,recentWindowTokens:16000,recentWindowMessages:120,topicSummaryEnabled:false};assert.deepEqual((await submit('topic-policy',{policy:longer})).windowPolicy,{recentWindowTokens:16000,recentWindowMessages:120,topicSummaryEnabled:false});assert.equal(longer.allowedTools.length,1);
 assert.equal((await f.call('/v1/requests',{id:'bad-window',text:'synthetic',windowPolicy:{recentWindowTokens:0}})).value.error,'BRIDGE_WINDOW_POLICY_INVALID');
});

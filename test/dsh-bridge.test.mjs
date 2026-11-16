import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import {startDshBridgeHost,bridgeReply} from '../packages/dsh-bridge/host.mjs';
import {createDshBridgeRuntime} from '../packages/dsh-adapter/bridge-runtime.mjs';
import {startService} from '../apps/service/server.mjs';
import {hash} from '../packages/migration/portable.mjs';
import {sandbox} from './helpers.mjs';
const token='synthetic-bridge-secret-'.repeat(3);
test('media configuration travels through authenticated bridge and local admin API without model calls',async t=>{
 let value={revision:0,connections:{music:{hasKey:false}}};const f=await fixture(t,{mediaConnections:()=>value,saveMediaConnections:v=>(value=v),probeMediaConnections:async()=>({model:'fixture-audio',wireAudioVerified:true})});
 const runtime=await createDshBridgeRuntime({url:f.host.url,token});f.closers.push(()=>runtime.close());const service=await startService({dataRoot:path.join(f.box.root,'media-admin'),backend:runtime});f.closers.push(()=>service.close());
 const boot=await(await fetch(service.url+'/v1/bootstrap')).json(),call=(route,body,admin=true)=>fetch(service.url+route,{method:body?'POST':'GET',headers:{...(admin?{'X-Chatagent-Token':boot.token}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await call('/v1/media-connections',undefined,false)).status,401);assert.equal((await call('/v1/media-connections')).status,200);const next={revision:1,connections:{music:{hasKey:true}}};assert.deepEqual(await(await call('/v1/media-connections',next)).json(),next);assert.equal((await(await call('/v1/media-connections/test',{id:'music',revision:1})).json()).model,'fixture-audio');assert.equal(f.calls,0);
});
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

test('唱歌异步失败以最终状态保存回复，重读和重启不会恢复错误的准备中提示',async t=>{
 const f=await fixture(t,{finalizeReply:(text,id)=>id==='failed-song'?'原曲获取失败，没有生成MP3':text}),runtime=await createDshBridgeRuntime({url:f.host.url,token});t.after(()=>runtime.close());
 const request={id:'failed-song',text:'synthetic',mode:'social'};
 assert.equal(await runtime.reply(request),'原曲获取失败，没有生成MP3');
 await f.restart();const restarted=await createDshBridgeRuntime({url:f.host.url,token});t.after(()=>restarted.close());
 assert.equal(await restarted.reply(request),'原曲获取失败，没有生成MP3');assert.equal(f.calls,1);
 assert.equal(await restarted.reply({...request,id:'ordinary-chat'}),'Synthetic native result');
});

test('未知回执从原生日志只读恢复时也核对唱歌最终状态',async t=>{
 let saved=[];
 const f=await fixture(t,{prompt:async request=>{saved=events(request.id,'还在准备');throw Error('response lost');},events:()=>saved,finalizeReply:()=> '翻唱失败，已停止'});
 await f.call('/v1/requests',{id:'recover-song',text:'synthetic'});
 await new Promise(r=>setTimeout(r,10));
 assert.equal((await f.call('/v1/requests/recover-song')).value.text,'翻唱失败，已停止');
});

test('reply limit travels with each request, is validated and participates in idempotency',async t=>{
 let received;const f=await fixture(t,{prompt:async request=>{received=request;},events:()=>events(received.id,'Synthetic native result')}),runtime=await createDshBridgeRuntime({url:f.host.url,token});t.after(()=>runtime.close());
 const request={id:'layout-zero',text:'synthetic',mode:'social',policy:{maxMessages:0}};
 assert.equal(await runtime.reply(request),'Synthetic native result');assert.equal(received.maxMessages,0);
 assert.equal((await f.call('/v1/requests',{id:request.id,text:request.text,maxMessages:1})).value.error,'BRIDGE_REQUEST_CONFLICT');
 for(const maxMessages of [-1,21,1.2,'2',null])assert.equal((await f.call('/v1/requests',{id:'invalid-layout',text:'synthetic',maxMessages})).value.error,'BRIDGE_REQUEST_INVALID');
});
test('native bridge failure leaves its original receipt unknown while new queued chat receives one reply',async t=>{
 const f=await fixture(t),runtime=await createDshBridgeRuntime({url:f.host.url,token}),at=Date.now();
 const service=await startService({dataRoot:path.join(f.box.root,'chat'),backend:runtime,now:()=>at});f.closers.push(async()=>{await service.close();await runtime.close();});
 const input=id=>({deviceId:'synthetic-phone',clientMessageId:id,text:id,queuedAt:at});
 f.fail=true;const old=service.store.submit(input('old-failure'));await service.tick();assert.equal(service.store.message(old.id).state,'unknown');const original=service.store.message(old.id);
 f.fail=false;const fresh=service.store.submit(input('new-message'));await service.tick();await service.tick();
 assert.equal(f.calls,2);assert.deepEqual(service.store.message(old.id),original);assert.equal((await f.call('/v1/requests/'+old.id)).value.state,'unknown');
 assert.equal(service.store.message(fresh.id).state,'completed');assert.equal(service.store.history().filter(row=>row.parent===fresh.id).length,1);
});

test('已受理请求遇到回执连接短暂中断仍只读等待，不重发模型请求',async t=>{
 const f=await fixture(t);let dropped=0,submissions=0;
 const proxy=http.createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url.startsWith('/v1/requests/')&&dropped<3){dropped++;req.socket.destroy();return;}
  if(req.method==='POST'&&req.url==='/v1/requests')submissions++;
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const response=await fetch(f.host.url+req.url,{method:req.method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...req.method==='POST'?{body:Buffer.concat(chunks)}:{}});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));});
 const runtime=await createDshBridgeRuntime({url:'http://127.0.0.1:'+proxy.address().port,token});t.after(()=>runtime.close());
 assert.equal(await runtime.reply({id:'transient-receipt',text:'synthetic',mode:'social'}),'Synthetic native result');
 assert.equal(submissions,1);assert.equal(f.calls,1);assert.equal(dropped,3);
});

test('投递附件核对失败不推翻已完成的原生文本回执',async t=>{
 const f=await fixture(t),runtime=await createDshBridgeRuntime({url:f.host.url,token});t.after(()=>runtime.close());
 runtime.flushDeliveries=async()=>{throw Error('BRIDGE_ATTACHMENT_CHANGED');};
 assert.equal(await runtime.reply({id:'delivery-failure',text:'synthetic',mode:'social'}),'Synthetic native result');assert.equal(f.calls,1);
 runtime.flushDeliveries=async()=>{throw Error('BRIDGE_SESSION_CHANGED');};
 await assert.rejects(runtime.reply({id:'session-boundary',text:'synthetic',mode:'social'}),/BRIDGE_SESSION_CHANGED/);assert.equal(f.calls,2);
});

test('原生桥接仍忙时后一句留在队列，空闲后正常受理且各执行一次',async t=>{
 let release,saved=[],calls=0;const gate=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{async prompt(request){calls++;if(request.id==='earlier-native-run')await gate;saved=events(request.id,'Synthetic native result');},events:()=>saved});
 await f.call('/v1/requests',{id:'earlier-native-run',text:'synthetic'});
 const runtime=await createDshBridgeRuntime({url:f.host.url,token}),at=Date.now();
 const service=await startService({dataRoot:path.join(f.box.root,'busy-chat'),backend:runtime,now:()=>at});f.closers.push(async()=>{release();await service.close();await runtime.close();});
 const queued=service.store.submit({deviceId:'synthetic-phone',clientMessageId:'followup',text:'synthetic followup',queuedAt:at});
 await service.tick();assert.equal(service.store.message(queued.id).state,'queued');assert.equal(calls,1);
 release();await new Promise(resolve=>setTimeout(resolve,10));await service.tick();
 assert.equal(service.store.message(queued.id).state,'completed');assert.equal(calls,2);assert.equal(service.store.history().filter(r=>r.parent===queued.id).length,1);
});
test('background media delays proactive chat while allowing the user to interrupt',async t=>{
 let backgroundBusy=true;const f=await fixture(t,{status:()=>({connected:true,backgroundBusy,tools:[],plugins:[]})}),runtime=await createDshBridgeRuntime({url:f.host.url,token});t.after(()=>runtime.close());
 assert.equal(await runtime.canAccept({proactive:true}),false);assert.equal(await runtime.canAccept(),true);
 assert.equal(runtime.backupIdle(),false);
 assert.equal(await runtime.reply({id:'user-priority',text:'synthetic',mode:'social'}),'Synthetic native result');
 backgroundBusy=false;assert.equal(await runtime.canAccept({proactive:true}),true);
 assert.equal(runtime.backupIdle(),true);
});

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

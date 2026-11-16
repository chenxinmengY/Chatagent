import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {ChatStore} from '../packages/conversation/store.mjs';
import {Preferences} from '../packages/conversation/preferences.mjs';
import {createProactiveScheduler} from '../packages/conversation/proactive.mjs';
import {visibleReplyText} from '../packages/conversation/reply-control.mjs';
import {chatRecords} from '../packages/dsh-bridge/chat-window.mjs';
import {startService} from '../apps/service/server.mjs';import {sandbox} from './helpers.mjs';
function openStore(t,now){let cleanup;const box=sandbox({after:fn=>cleanup=fn}),store=new ChatStore(path.join(box.root,'chat.sqlite'),now?{now}:{});t.after(()=>{store.close();cleanup();});return store;}

test('去除独立和句末的静默标记，保留正常英文、解释、引用和代码',()=>{
 const cases=[['合成场景：下一展厅展示航海模型。\nSILENT','合成场景：下一展厅展示航海模型。'],['早呀！ SILENT','早呀！'],['好呀。SILENT SILENT','好呀。'],['SILENT\r\nSILENT',''],['  SILENT  ',''],['前面\nSILENT\n后面','前面\n后面']];
 for(const [input,expected]of cases){assert.equal(visibleReplyText(input),expected);assert.equal(visibleReplyText(expected),expected);}
 for(const text of ['SILENT 是内部标记','The room is SILENT','保持 silent','“SILENT”','`SILENT`','> SILENT','```text\nSILENT\n```','~~~\nSILENT\n~~~','````text\n```\nSILENT\n````','NOSILENT'])assert.equal(visibleReplyText(text),text);
 assert.equal(visibleReplyText('```\nSILENT\n```\nSILENT'),'```\nSILENT\n```');
});

test('先过滤再分段；纯静默及恢复结果完成原请求，不生成空气泡或重试',t=>{
 let at=100000;const store=openStore(t,()=>at);
 const send=id=>store.submit({deviceId:'fixture',clientMessageId:id,text:'看看表情',queuedAt:at});
 const first=send('first');store.claim({policy:{mergeMs:0,minIntervalMs:1000,maxMessages:0}});store.complete(first.id,'第一段\n\n主人发这个，是想让我高兴一下？\nSILENT\n\nSILENT');at+=1000;assert.equal(store.flushReplyParts().text,'主人发这个，是想让我高兴一下？');at+=1000;assert.equal(store.flushReplyParts(),null);assert.equal(store.history().filter(m=>m.role==='assistant').length,2);
 const pure=send('pure');store.claim();assert.equal(store.complete(pure.id,'SILENT'),null);assert.equal(store.message(pure.id).state,'completed');assert.equal(store.claim(),null);
 const lost=send('lost');store.claim();store.unknown(lost.id);assert.equal(store.complete(lost.id,'\nSILENT\n',store.message(lost.id).revision),null);assert.equal(store.message(lost.id).state,'completed');assert.equal(store.claim(),null);
 assert.equal(store.history().filter(m=>m.role==='assistant').length,2);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM reply_parts WHERE state='queued'").get().n,0);
});

test('插件投递去除标记并保持幂等，纯静默不投递，图片附件照常保留',t=>{
 const store=openStore(t);
 assert.equal(store.publish({deliveryId:'silent',text:'SILENT'}),null);assert.equal(store.history().length,0);
 const first=store.publish({deliveryId:'mixed',text:'你好！\nSILENT'});assert.equal(first.text,'你好！');assert.equal(store.publish({deliveryId:'mixed',text:'你好！\nSILENT'}).id,first.id);assert.throws(()=>store.publish({deliveryId:'mixed',text:'其他内容'}),/PLUGIN_DELIVERY_ID_REUSED/);
 const attachments=[{id:'00000000-0000-4000-8000-000000000000',name:'表情.gif',bytes:1,sha256:'a'.repeat(64),mediaType:'image/gif'}],picture=store.publish({deliveryId:'picture',text:'SILENT',attachments});assert.equal(picture.text,'');assert.deepEqual(picture.attachments,attachments);
});

test('旧队列中的静默分段被消费，后续正文继续投递',t=>{
 const store=openStore(t,()=>100000);
 const request=store.submit({deviceId:'fixture',clientMessageId:'old',text:'test',queuedAt:100000});store.claim();store.complete(request.id,'首条');
 store.db.prepare('INSERT INTO reply_parts VALUES(?,?,?,?,?,?,?)').run('old-control',request.id,1,'SILENT','social',1,'queued');store.db.prepare('INSERT INTO reply_parts VALUES(?,?,?,?,?,?,?)').run('old-text',request.id,2,'后续！\nSILENT','social',2,'queued');
 assert.equal(store.flushReplyParts(),null);assert.equal(store.db.prepare("SELECT state FROM reply_parts WHERE id='old-control'").get().state,'completed');store.db.prepare('UPDATE messages SET created_at=1').run();assert.equal(store.flushReplyParts().text,'后续！');
});

for(const schedule of ['periodic','after-message'])test(`${schedule} 主动消息及断线恢复过滤静默，不重复生成`,async t=>{
 let at=Date.parse('2026-11-08T12:00:00+08:00'),calls=0,proof=null;const store=openStore(t,()=>at),preferences=new Preferences(store),p=preferences.read();Object.assign(p.policy,{proactiveEnabled:true,proactiveSchedule:schedule,proactiveMinIntervalMinutes:35,proactiveJitterMinutes:0,proactiveIdleMinutes:10,proactiveMaxPerDay:0});preferences.save(p);
 store.submit({deviceId:'fixture',clientMessageId:'start',text:'你好',queuedAt:at});const backend={async proactive(){calls++;throw Error('lost result');},async lookupResult(){return proof;}};let scheduler=createProactiveScheduler({store,backend,preferences,now:()=>at,random:()=>0});await scheduler.tick();at+=35*60000;await scheduler.tick();assert.equal(calls,1);scheduler=createProactiveScheduler({store,backend,preferences,now:()=>at,random:()=>0});proof='SILENT\nSILENT';await scheduler.tick();await scheduler.tick();assert.equal(calls,1);assert.equal(store.db.prepare("SELECT state FROM proactive_runs ORDER BY rowid DESC LIMIT 1").get().state,'silent');assert.equal(store.history().filter(m=>m.role==='assistant').length,0);
 backend.proactive=async()=>{calls++;return '来看看你！\nSILENT';};store.submit({deviceId:'fixture',clientMessageId:'next',text:'在的',queuedAt:at});at+=35*60000;await scheduler.tick();assert.equal(calls,2);assert.deepEqual(store.history().filter(m=>m.role==='assistant').map(m=>m.text),['来看看你！']);
});

test('模型历史不再回灌内部标记，用户原文及代码示例保留',()=>{
 const events=[];for(const [turn,kind,input,answer]of [[0,'chatagent-proactive','internal','SILENT'],[1,'user','SILENT 是什么意思','明白！\nSILENT'],[2,'user','示例','```\nSILENT\n```']]){const seq=turn*4;events.push({seq,type:'turn/start',data:{turn}},{seq:seq+1,type:'user/message',surfaceOp:'append',data:{source:{kind},content:[{type:'text',text:input}]}},{seq:seq+2,type:'assistant/message',surfaceOp:'append',data:{turn,message:{content:[{type:'text',text:answer}]}}},{seq:seq+3,type:'turn/end',data:{turn,reason:{kind:'completed'}}});}
 const original=structuredClone(events),rows=chatRecords(events,'fixture');assert.deepEqual(rows.map(r=>r.text),['SILENT 是什么意思','明白！','示例','```\nSILENT\n```']);assert.deepEqual(events,original);
});

test('真实服务的历史、增量同步和缓存接口均返回过滤后回复，纯静默不会进入未知重试',async t=>{
 let cleanup,at=Date.parse('2026-11-08T12:00:00+08:00'),calls=0;const box=sandbox({after:fn=>cleanup=fn}),service=await startService({dataRoot:path.join(box.root,'chat'),now:()=>at,backend:{async reply(){calls++;return calls===1?'主人发这个，是想让我高兴一下？\nSILENT':'SILENT';}}});t.after(async()=>{await service.close();cleanup();});
 const p=new Preferences(service.store),settings=p.read();Object.assign(settings.policy,{mergeMs:0,minIntervalMs:1000,maxMessages:0});p.save(settings);
 for(const id of ['mixed','pure']){service.store.submit({deviceId:'fixture',clientMessageId:id,text:'表情',queuedAt:at});await service.tick();at+=2000;}
 const boot=await(await fetch(service.url+'/v1/bootstrap')).json(),get=async route=>{const response=await fetch(service.url+route,{headers:{'X-Chatagent-Token':boot.token}});assert.equal(response.status,200);return response.json();},history=await get('/v1/messages'),sync=await get('/v1/sync?epoch=unknown'),cache=await get('/v1/cache?epoch='+sync.epoch+'&before=999999&since=0');
 for(const messages of [history,sync.messages,cache.messages])assert.deepEqual(messages.filter(m=>m.role==='assistant').map(m=>m.text),['主人发这个，是想让我高兴一下？']);assert.ok(history.filter(m=>m.role==='user').every(m=>m.state==='completed'));await service.tick();assert.equal(calls,2);
});

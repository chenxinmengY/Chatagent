import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {startService} from '../apps/service/server.mjs';
import {startDshBridgeHost} from '../packages/dsh-bridge/host.mjs';
import {createDshBridgeRuntime} from '../packages/dsh-adapter/bridge-runtime.mjs';
import {sandbox} from './helpers.mjs';
const seed={personas:[{id:'persona',name:'测试人格',text:'独立人格原文',categoryId:null}],activePersonaId:'persona'};
async function fixture(t){
 let service;t.after(()=>service?.close());const box=sandbox(t),retired=new Set(),busy=new Set(),root=path.join(box.root,'chat');
 const backend=id=>({kind:'dsh-bridge',externalRuntime:true,status:()=>({modeBindings:[{mode:'social',session_id:'session-'+id}]}),bridgeStatus:async()=>({connected:true,tools:[]}),openChat:async id=>backend(id),reply:async()=> '测试回复',retire:async()=>{if(busy.has(id))throw Error('CHAT_BUSY');retired.add(id);}});
 const start=async()=>service=await startService({dataRoot:root,devicePort:0,backend:backend('default'),preferencesSeed:seed});await start();
 const call=async(route,body,options={})=>{const boot=await(await fetch(service.url+'/v1/bootstrap')).json();const r=await fetch(service.url+route,{method:body?'POST':'GET',headers:{'X-Chatagent-Token':boot.token,'Content-Type':'application/json'},signal:AbortSignal.timeout(5000),...body?{body:JSON.stringify(body)}:{},...options});return {status:r.status,value:await r.json()};};
 return {root,call,retired,busy,get service(){return service;},async restart(){await service.close();await start();}};
}
test('deleting child chats is authenticated, durable, retains history, rejects reuse, and preserves other chats',{timeout:20000},async t=>{
 const f=await fixture(t),a=randomUUID(),b=randomUUID();for(const id of [a,b])assert.equal((await f.call('/v1/chats',{id,name:id===a?'待删除':'保留',personaId:'persona'})).status,200);
 const preferences=(await f.call('/v1/preferences')).value;
 assert.equal((await f.call('/v1/chats/'+a+'/delete',{name:'待删除'},{headers:{'Content-Type':'application/json'}})).status,401);
 assert.equal((await f.call('/v1/chats/'+a+'/delete',{name:'旧名称'})).value.error,'CHAT_CHANGED');
 f.busy.add(a);assert.equal((await f.call('/v1/chats/'+a+'/delete',{name:'待删除'})).value.error,'CHAT_BUSY');assert.equal((await f.call('/v1/chats')).value.chats.length,3);f.busy.delete(a);
 const db=new DatabaseSync(path.join(f.root,'conversations',a,'chat.sqlite'));db.prepare("INSERT INTO settings VALUES('retained-receipt',?)").run('unknown must never replay');db.close();
 assert.equal((await f.call('/v1/chats/'+a+'/delete',{name:'待删除'})).status,200);assert.ok(f.retired.has(a));assert.deepEqual((await f.call('/v1/preferences')).value,preferences);assert.deepEqual((await f.call('/v1/chats')).value.chats.map(r=>r.id),['default',b]);
 assert.equal((await f.call('/v1/chats/'+a+'/v1/messages')).status,410);assert.equal((await f.call('/v1/chats',{id:a,name:'复用',personaId:'persona'})).status,410);assert.equal((await f.call('/v1/chats/'+a+'/delete',{})).status,200);
 const saved=new DatabaseSync(path.join(f.root,'conversations',a,'chat.sqlite'),{readOnly:true});try{assert.equal(saved.prepare("SELECT value FROM settings WHERE key='retained-receipt'").get().value,'unknown must never replay');}finally{saved.close();}
 await f.restart();assert.deepEqual((await f.call('/v1/chats')).value.chats.map(r=>r.id),['default',b]);assert.equal((await f.call('/v1/chats/'+a+'/v1/bootstrap')).status,410);
});
test('initial and last chat can be deleted while global persona management and new chats remain available',{timeout:20000},async t=>{
 const f=await fixture(t);assert.equal((await f.call('/v1/chats/default/delete',{name:'小鲸鱼 · 私聊'})).status,200);assert.ok(f.retired.has('default'));assert.equal((await f.call('/v1/messages')).status,410);assert.equal((await f.call('/v1/preferences')).value.personas.length,1);assert.deepEqual((await f.call('/v1/chats')).value.chats,[]);
 const redirect=await fetch(f.service.url+'/',{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),'/chats');
 const id=randomUUID();assert.equal((await f.call('/v1/chats',{id,name:'全新对话',personaId:'persona'})).status,200);assert.deepEqual((await f.call('/v1/chats')).value.chats.map(r=>r.id),[id]);await f.restart();assert.deepEqual((await f.call('/v1/chats')).value.chats.map(r=>r.id),[id]);assert.equal((await f.call('/v1/conversation-status')).status,200);
});
test('native retirement is idle-only, durable and prevents further model or plugin requests',{timeout:10000},async t=>{
 let host,runtime;t.after(async()=>{await runtime?.close();await host?.close();});const box=sandbox(t),root=path.join(box.root,'bridge'),token='synthetic-retirement-token'.repeat(3);let backgroundBusy=true,retirements=0,syncs=0,failSync=false;
 const driver={configure(){},ensure:async()=>{},status:()=>({connected:true,backgroundBusy,tools:[]}),retire:async()=>{retirements++;},syncRetirement:async()=>{syncs++;if(failSync)throw Error('CHAT_BUSY');}};
 const start=async()=>host=await startDshBridgeHost({root,token,port:0,driver});await start();runtime=await createDshBridgeRuntime({url:host.url,token});await assert.rejects(runtime.retire(),/CHAT_BUSY/);assert.equal(retirements,0);backgroundBusy=false;await runtime.retire();await runtime.retire();assert.equal(retirements,1);assert.equal(syncs,1);assert.equal((await runtime.bridgeStatus()).retired,true);
 failSync=true;await assert.rejects(runtime.retire(),/CHAT_BUSY/);failSync=false;await runtime.retire();assert.equal(syncs,3);assert.equal(retirements,1);
 const post=async route=>{const r=await fetch(host.url+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({id:'no-replay',text:'must not run'})});return r.json();};assert.equal((await post('/v1/requests')).error,'CHAT_DELETED');assert.equal((await post('/v1/plugins/media-browser/run')).error,'CHAT_DELETED');
 const identity=JSON.parse(fs.readFileSync(path.join(root,'identity.json'),'utf8'));await host.close();await start();runtime=await createDshBridgeRuntime({url:host.url,token});assert.equal((await runtime.bridgeStatus()).retired,true);assert.equal((await post('/v1/requests')).error,'CHAT_DELETED');assert.equal(JSON.parse(fs.readFileSync(path.join(root,'identity.json'),'utf8')).sessionId,identity.sessionId);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {sandbox} from './helpers.mjs';
import {ChatStore} from '../packages/conversation/store.mjs';
import {PortableArchive,hash,normalizeImport} from '../packages/migration/portable.mjs';
import {timelinePage} from '../packages/conversation/timeline.mjs';
import {startService} from '../apps/service/server.mjs';
import {fishAdmin} from '../packages/dsh-adapter/fish-admin.mjs';
const record=(id,at=1000)=>({sourceId:'fixture',scope:'person-a',id:String(id),kind:'message',role:'user',text:'原文 '+id,at,mode:'social',attachments:[]});
const pack=records=>({format:'chatagent-portable-v1',sourceId:'fixture',scope:'person-a',records,digest:hash(records)});
test('便携导入预检、冲突、来源隔离、再次导入与重开保持，旧记录不进入执行队列',t=>{
  const box=sandbox(t),file=path.join(box.root,'chat.sqlite');let store=new ChatStore(file);let archive=new PortableArchive(store);
  const data=pack([record(1),record(2)]),preview=archive.preview(data);
  archive.apply(data,hash([preview.report,preview.records]));assert.equal(store.claim(),null);assert.equal(store.history().length,0);
  assert.equal(archive.preview(data).report.duplicates,2);
  const conflict=pack([{...record(1),text:'变化'}]);assert.equal(archive.preview(conflict).report.conflicts,1);assert.throws(()=>archive.apply(conflict,hash([archive.preview(conflict).report,archive.preview(conflict).records])),/IMPORT_CONFLICT/);
  const other=pack([{...record(1),scope:'person-b'}]);assert.equal(archive.preview(other).report.added,1);
  store.close();store=new ChatStore(file);archive=new PortableArchive(store);assert.equal(archive.records().length,2);const exported=archive.export();assert.deepEqual(normalizeImport(exported),archive.records());store.close();
});
test('预检绑定实际内容；校验不符、缺失身份与不支持角色均拒绝',t=>{
  const box=sandbox(t),store=new ChatStore(path.join(box.root,'chat.sqlite'));try{const archive=new PortableArchive(store),first=archive.preview(pack([record(1)]));assert.throws(()=>archive.apply(pack([{...record(1),text:'替换'}]),hash([first.report,first.records])),/PREVIEW_CHANGED/);assert.throws(()=>normalizeImport({...pack([record(1)]),digest:'wrong'}),/DIGEST/);assert.throws(()=>normalizeImport({format:'astrbot-openai-v1',sourceId:'astrbot',scope:'x',messages:[{role:'tool',content:'x'}]}),/ROLE_UNSUPPORTED/);}finally{store.close();}
});
test('统一时间线跨来源按时间翻页无遗漏，同时间游标稳定，日期与附件筛选正确',t=>{
  const box=sandbox(t),store=new ChatStore(path.join(box.root,'chat.sqlite'));try{const archive=new PortableArchive(store),rows=Array.from({length:205},(_,i)=>record(i,1000)),data=pack(rows),p=archive.preview(data);archive.apply(data,hash([p.report,p.records]));let cursor=null,seen=[];do{const page=timelinePage(store,archive,[],new URLSearchParams(cursor?{before:cursor}:{}));seen.push(...page.messages.map(r=>r.id));cursor=page.hasMore?page.nextBefore:null;}while(cursor);assert.equal(seen.length,205);assert.equal(new Set(seen).size,205);assert.equal(timelinePage(store,archive,[],new URLSearchParams({q:'原文 204'})).messages.length,1);assert.throws(()=>timelinePage(store,archive,[],new URLSearchParams({date:'2026-02-30'})),/QUERY_INVALID/);assert.equal(timelinePage(store,archive,[],new URLSearchParams({type:'audio'})).messages.length,0);}finally{store.close();}
});
test('WeChatAgent秒时间与AstrBot显式时间格式转换，未知时间不伪造',()=>{
  const wechat=normalizeImport({format:'wechatagent-history-v1',sourceId:'wechat',scope:'alice',messages:[{seq:7,at:100,body:{text:'旧原文',outgoing:true}}]});assert.equal(wechat[0].at,100000);assert.equal(wechat[0].role,'assistant');
  const astr=normalizeImport({format:'astrbot-openai-v1',sourceId:'astrbot',scope:'alice',messages:[{role:'user',content:'你好'}]});assert.equal(astr[0].at,null);
});
test('真实HTTP导入与导出、管理鉴权和新页面资源可用',async t=>{
  const box=sandbox(t),service=await startService({dataRoot:path.join(box.root,'service')});try{const boot=await(await fetch(service.url+'/v1/bootstrap')).json(),headers={'X-Chatagent-Token':boot.token,'Content-Type':'application/json'},data=pack([record(1)]),post=async(route,body)=>fetch(service.url+route,{method:'POST',headers,body:JSON.stringify(body)});
  const preview=await(await post('/v1/import/preview',{package:data})).json();assert.equal(preview.added,1);const applied=await post('/v1/import/apply',{package:data,preview:preview.preview});assert.equal(applied.status,200);const page=await(await fetch(service.url+'/v1/timeline',{headers})).json();assert.equal(page.messages[0].text,'原文 1');const exported=await(await fetch(service.url+'/v1/export',{headers})).json();assert.equal(normalizeImport(exported).length,1);assert.equal((await fetch(service.url+'/v1/import/records')).status,401);
  for(const route of ['/customize','/customize.js','/appearance.js','/appearance-values.js','/settings','/settings?section=data','/settings?section=reply','/settings?section=profiles','/settings?section=models','/settings?section=devices','/settings?section=workspace','/plugins','/plugins?section=records&kind=diaries','/plugins.js'])assert.equal((await fetch(service.url+route)).status,200);
  assert.equal(service.store.claim(),null);
  }finally{await service.close();}
});
test('鱼的配置并发校验、暂停与原记忆保留',t=>{
  const box=sandbox(t);let state={policy:{baseHalfLifeDays:30,maxItems:6},memories:[{id:'one',text:'保留'}],deleted:[],traces:[]};const memory={loadStore:()=>structuredClone(state),saveStore:(_,next)=>state=structuredClone(next)},admin=fishAdmin(memory,'fixture',box.root),before=admin.read();
  const saved=admin.save({...before,enabled:false,policy:{...before.policy,maxItems:8}});assert.equal(admin.enabled(),false);assert.deepEqual(saved.memories,before.memories);assert.throws(()=>admin.save(before),/MEMORY_CHANGED/);assert.throws(()=>admin.save({...saved,policy:{maxItems:-1}}),/CONFIG_INVALID/);
});

test('AstrBot控制台导出按会话隔离，保留工具及多模态原件，不伪造消息日期',()=>{
  const conversation={cid:'c1',user_id:'platform:user',created_at:'2026-01-01',content:[{role:'user',content:[{type:'image_url',image_url:{url:'https://invalid.example/image'}}]},{role:'tool',content:'旧工具结果'},{role:'assistant',content:'答复'}]};
  const input={format:'astrbot-export-v1',sourceId:'my-astrbot',scope:'selected',conversations:[conversation]},rows=normalizeImport(input);
  assert.equal(rows.length,3);assert.equal(rows[0].scope,'platform:user/c1');assert.equal(rows[0].at,null);assert.equal(rows[1].kind,'context');assert.deepEqual(rows[0].metadata.original,conversation.content[0]);
  assert.throws(()=>normalizeImport({...input,conversations:[conversation,conversation]}),/SELECT_ONE/);
});

test('鱼原生记忆预检后合并、去重和删除状态保留，冲突及过期预检拒绝',t=>{
  const box=sandbox(t);let state={policy:{maxItems:6},memories:[],deleted:[],traces:[]};const admin=fishAdmin({loadStore:()=>structuredClone(state),saveStore:(_,v)=>state=structuredClone(v)},'fixture',box.root);
  const native={id:'native-a',text:'保留原生字段',at:'2026-01-01T00:00:00Z',importance:1,tags:['测试']};
  const row={...record(1),kind:'memory',text:native.text,metadata:{engine:'dsh-fish-memory',engineVersion:'1.5.0',state:'deleted',native}};
  const preview=admin.migrate({records:[row]});assert.equal(preview.added,1);assert.equal(state.deleted.length,0);
  admin.migrate({records:[row],...preview,apply:true});assert.deepEqual(state.deleted,[native]);assert.equal(state.memories.length,0);assert.equal(admin.migrate({records:[row]}).duplicates,1);
  assert.equal(admin.migrate({records:[{...row,metadata:{...row.metadata,state:'active'}}]}).conflicts,1);
  const changed={...row,text:'更改',metadata:{...row.metadata,native:{...native,text:'更改'}}};const conflict=admin.migrate({records:[changed]});assert.equal(conflict.conflicts,1);assert.throws(()=>admin.migrate({...conflict,records:[changed],apply:true}),/CONFLICT/);
  assert.throws(()=>admin.migrate({...preview,records:[row],apply:true}),/MEMORY_CHANGED/);
});

test('附件元数据可筛选并明确缺失，导出不会重复同一条来源记录',t=>{
  const box=sandbox(t),store=new ChatStore(path.join(box.root,'chat.sqlite'));try{
    const archive=new PortableArchive(store),r={...record(1,Date.parse('2026-01-02T05:00:00Z')),attachments:[{name:'voice.wav',sha256:'a'.repeat(64),bytes:10,mediaType:'audio/wav'}]},p=archive.preview(pack([r]));archive.apply(pack([r]),hash([p.report,p.records]));
    const page=timelinePage(store,archive,[],new URLSearchParams({date:'2026-01-02',type:'audio'}));assert.equal(page.messages.length,1);assert.equal(page.messages[0].attachments.length,0);assert.equal(page.messages[0].source.missingAttachments.length,1);assert.equal(archive.export([r]).records.length,1);
  }finally{store.close();}
});

test('同一毫秒产生的当前消息按持久序号排序',t=>{
  const box=sandbox(t),store=new ChatStore(path.join(box.root,'chat.sqlite'),{now:()=>1000});try{
    const one=store.publish({deliveryId:'one',text:'第一条'}),two=store.publish({deliveryId:'two',text:'第二条'});
    assert.deepEqual(timelinePage(store,new PortableArchive(store)).messages.map(r=>r.id),[one.id,two.id]);
  }finally{store.close();}
});

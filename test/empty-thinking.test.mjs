import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {stripEmptyThinking, visibleReplyText} from '../packages/conversation/reply-control.mjs';
import {displayedText} from '../apps/web/message-presentation.js';
import {ChatStore} from '../packages/conversation/store.mjs';
import {startService} from '../apps/service/server.mjs';
import {sandbox} from './helpers.mjs';

test('空 thinking 标签过滤空格、换行、大小写和重复标记，保留正文', () => {
  for (const [input, expected] of [
    ['<thinking> </thinking>\n合成场景：请按展览地图继续参观下一展厅', '合成场景：请按展览地图继续参观下一展厅'],
    ['<THINKING >\r\n\t　</THINKING >\r\n你好', '你好'],
    ['<thinking></thinking>你好<thinking>\n</thinking>', '你好'],
    ['\n<thinking> \t\n</thinking>\n<thinking></thinking>\n', ''],
    ['前文<thinking></thinking>后文', '前文后文']
  ]) {
    assert.equal(stripEmptyThinking(input), expected);
    assert.equal(stripEmptyThinking(expected), expected);
    assert.equal(displayedText({role:'assistant', text:input}), expected);
    assert.equal(displayedText({role:'user', text:input}), input);
  }
  assert.equal(visibleReplyText('<thinking></thinking>\n你好！\nSILENT'), '你好！');
});

test('保留非空 thinking、其他标签以及内联和围栏代码示例', () => {
  for (const text of ['  正常正文\r\n', '<thinking>保留内容</thinking>\n正文', '<think></think>',
    '`<thinking></thinking>`', '``<thinking> </thinking>``',
    '```xml\r\n<thinking> </thinking>\r\n```', '~~~xml\n<thinking>\n</thinking>\n~~~',
    '````xml\n```\n<thinking></thinking>\n````', '```xml\n<thinking></thinking>']) {
    assert.equal(stripEmptyThinking(text), text);
  }
  assert.equal(stripEmptyThinking('`<thinking></thinking>`\n<thinking></thinking>\n正文'), '`<thinking></thinking>`\n\n正文');
});

test('回复分段前过滤空标签；纯空标签不留空气泡，旧插件投递重放保持幂等', t => {
  let cleanup, at=100000;
  const box=sandbox({after:fn=>cleanup=fn}), store=new ChatStore(path.join(box.root,'chat.sqlite'), {now:()=>at});
  t.after(()=>{store.close();cleanup();});
  const request=store.submit({deviceId:'fixture',clientMessageId:'split',text:'你好',queuedAt:at});
  store.claim({policy:{mergeMs:0,minIntervalMs:1000,maxMessages:0}});
  store.complete(request.id, '<thinking> </thinking>\n\n第一段\n\n<thinking>\n</thinking>\n\n第二段');
  at+=10000; assert.equal(store.flushReplyParts().text, '第二段');
  at+=10000; assert.equal(store.flushReplyParts(), null);
  assert.deepEqual(store.history().filter(row=>row.role==='assistant').map(row=>row.text), ['第一段','第二段']);
  const pure=store.submit({deviceId:'fixture',clientMessageId:'pure',text:'test',queuedAt:at});store.claim();
  assert.equal(store.complete(pure.id,'<thinking>\n</thinking>'),null);
  assert.equal(store.message(pure.id).state,'completed'); assert.equal(store.claim(),null);
  assert.equal(store.publish({deliveryId:'empty',text:'<thinking></thinking>'}),null);
  const old=store.publish({deliveryId:'old',text:'旧回复'}), raw='<thinking> </thinking>\n旧回复';
  store.db.prepare('UPDATE messages SET text=? WHERE id=?').run(raw,old.id);
  assert.equal(store.publish({deliveryId:'old',text:raw}).id,old.id);
  assert.equal(store.message(old.id).text,raw);
  assert.throws(()=>store.publish({deliveryId:'old',text:'其他回复'}),/PLUGIN_DELIVERY_ID_REUSED/);
});

test('历史、增量同步、缓存和搜索均过滤旧回复；原始记录保持不变', async t => {
  let cleanup;
  const box=sandbox({after:fn=>cleanup=fn}), raw='<thinking> </thinking>\n历史正文';
  const service=await startService({dataRoot:path.join(box.root,'chat'),backend:{historyRecords:()=>[{sourceId:'fixture',scope:'old',id:'imported',role:'assistant',text:raw,at:1000}]}});
  t.after(async()=>{await service.close();cleanup();});
  const old=service.store.publish({deliveryId:'history',text:'历史正文'});
  service.store.db.prepare('UPDATE messages SET text=? WHERE id=?').run(raw,old.id);
  service.store.event(service.store.message(old.id));
  const user=service.store.submit({deviceId:'fixture',clientMessageId:'literal',text:raw,queuedAt:Date.now()});
  service.store.decide(user.id,user.revision,'cancel');
  const original=service.store.db.prepare('SELECT * FROM messages').all(), changes=service.store.db.prepare('SELECT * FROM changes').all();
  const boot=await(await fetch(service.url+'/v1/bootstrap')).json();
  const get=async route=>{const response=await fetch(service.url+route,{headers:{'X-Chatagent-Token':boot.token}});assert.equal(response.status,200);return response.json();};
  const sync=await get('/v1/sync?epoch=unknown');
  for(const messages of [await get('/v1/messages'),sync.messages,(await get('/v1/cache?epoch='+sync.epoch+'&before=999999&since=0')).messages,(await get('/v1/timeline?q=历史正文')).messages]) {
    assert.ok(messages.some(row=>row.role==='assistant'));
    assert.ok(messages.filter(row=>row.role==='assistant').every(row=>row.text==='历史正文'));
    assert.equal(messages.find(row=>row.id===user.id).text,raw);
  }
  assert.deepEqual(service.store.db.prepare('SELECT * FROM messages').all(),original);
  assert.deepEqual(service.store.db.prepare('SELECT * FROM changes').all(),changes);
  const module=await fetch(service.url+'/packages/conversation/reply-control.mjs');
  assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/javascript/);assert.match(await module.text(),/export function stripEmptyThinking/);
});

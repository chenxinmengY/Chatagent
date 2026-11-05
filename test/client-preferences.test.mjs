import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ChatStore } from '../packages/conversation/store.mjs';
import { Preferences, initialPreferences, splitReply, DEFAULT_POLICY } from '../packages/conversation/preferences.mjs';
import { maintainMode } from '../packages/dsh-adapter/context-maintenance.mjs';
import { startService } from '../apps/service/server.mjs';
import { sandbox } from './helpers.mjs';
const epoch = 1790000000000;
const input = (id, now, text = id, deviceId = 'phone') => ({ deviceId, clientMessageId: id, text, queuedAt: now });

test('preferences validate, preserve revisions and isolate two mode persona bindings', t => {
  const box = sandbox(t), store = new ChatStore(path.join(box.root, 'chat.sqlite'));
  try {
    const prefs = new Preferences(store, { personas: [{ id:'whale',name:'鲸',text:'original',categoryId:null }], activePersonaId:'whale' });
    const before = prefs.read(), next = structuredClone(before); next.personas[0].text = 'edited'; next.modes.assistant.personaId = null; prefs.save(next);
    assert.equal(prefs.forMode('social').persona.text,'edited'); assert.equal(prefs.forMode('assistant').persona,null);
    assert.throws(()=>prefs.save(before), /PREFERENCES_CHANGED/);
    assert.equal(JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key LIKE 'preferences-history-%'").get().value).personas[0].text, 'original');
    assert.throws(()=>initialPreferences({policy:{maxMessages:21}}),/INVALID_CHAT_POLICY/);
    assert.throws(()=>initialPreferences({contextOverride:3999}),/INVALID_MODE_SETTINGS/);
    assert.equal(initialPreferences({contextOverride:0}).modes.social.contextMaxTokens,0);
  } finally { store.close(); }
});
test('trailing debounce merges originals once and snapshots policy', t => {
  const box = sandbox(t); let now=epoch; const store=new ChatStore(path.join(box.root,'chat.sqlite'),{now:()=>now});
  try {
    const policy={...DEFAULT_POLICY,mergeMs:6000,minIntervalMs:1000,maxMessages:2,persona:{text:'snapshot'}};
    const first=store.submit(input('one',now)); now+=2000; const second=store.submit(input('two',now));
    now+=5999; assert.equal(store.claim({policy}),null); now++;
    const run=store.claim({policy}); assert.equal(run.text,'one\n\ntwo'); assert.deepEqual(run.memberIds,[first.id,second.id]); policy.persona.text='later';
    assert.equal(store.workRequest(store.message(first.id)).persona.text,'snapshot');
    store.complete(first.id,'A\n\nB\n\nC'); assert.equal(store.message(second.id).state,'completed');
    assert.deepEqual(store.history().filter(m=>m.role==='assistant').map(m=>m.text),['A']);
    assert.equal(store.flushReplyParts(),null); now+=1000; assert.equal(store.flushReplyParts().text,'B\n\nC'); assert.equal(store.flushReplyParts(),null);
    assert.equal(store.submit(input('one',epoch)).id,first.id);
  } finally { store.close(); }
});
test('merge boundaries exclude other devices and stale messages', t => {
  const box=sandbox(t);let now=epoch;const store=new ChatStore(path.join(box.root,'chat.sqlite'),{now:()=>now});
  try {
    const policy={...DEFAULT_POLICY,mergeMs:1000}; const first=store.submit(input('a',now)); store.submit(input('b',now,'b','other')); now+=1100;
    assert.deepEqual(store.claim({policy}).memberIds,[first.id]); store.complete(first.id,'ok');
    const second=store.claim({policy}); assert.equal(second.text,'b'); store.complete(second.id,'ok');
    const stale=store.submit({...input('old',now),queuedAt:now-31*60000});store.submit(input('new',now));now+=2000;assert.equal(stale.state,'awaiting_confirmation');assert.equal(store.claim({policy}),null);
  }finally{store.close();}
});
test('mode and attachment boundaries never merge across a request', t => {
  const box=sandbox(t);let now=epoch;const store=new ChatStore(path.join(box.root,'chat.sqlite'),{now:()=>now});
  try{
    const policy={...DEFAULT_POLICY,mergeMs:1000};
    const social=store.submit(input('social',now));store.setMode('assistant');const assistant=store.submit(input('assistant',now));now+=1000;
    assert.deepEqual(store.claim({policy}).memberIds,[social.id]);store.complete(social.id,'one');assert.deepEqual(store.claim({policy}).memberIds,[assistant.id]);store.complete(assistant.id,'two');
    const plain=store.submit(input('plain',now));const file=store.submit({...input('file',now),attachments:[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'file.txt',bytes:1,sha256:'a'.repeat(64),mediaType:'text/plain'}]});now+=1000;
    assert.deepEqual(store.claim({policy,allowAttachments:true}).memberIds,[plain.id]);store.complete(plain.id,'ok');assert.equal(store.claim({policy}),null);assert.deepEqual(store.claim({policy,allowAttachments:true}).memberIds,[file.id]);
  }finally{store.close();}
});
test('unknown merged work reconciles its original combined text after reopening', t => {
  const box=sandbox(t), file=path.join(box.root,'chat.sqlite');let now=epoch,store=new ChatStore(file,{now:()=>now});
  try {
    const a=store.submit(input('a',now));const b=store.submit(input('b',now));now+=1000;store.claim({policy:{...DEFAULT_POLICY,mergeMs:1000}});store.close();store=new ChatStore(file,{now:()=>now});store.recoverInterrupted();
    assert.equal(store.message(b.id).state,'unknown'); const run=store.workRequest(store.message(a.id));assert.equal(run.text,'a\n\nb');assert.equal(store.claim(),null);
    store.complete(a.id,'recovered',run.revision);assert.equal(store.message(b.id).state,'completed');assert.equal(store.history().filter(m=>m.role==='assistant').length,1);
  }finally{store.close();}
});
test('stop command cancels pending parts and future parts of an active turn', t => {
  const box=sandbox(t);let now=epoch;const store=new ChatStore(path.join(box.root,'chat.sqlite'),{now:()=>now});
  try{
    const a=store.submit(input('a',now));store.claim({policy:{...DEFAULT_POLICY,maxMessages:0}});
    const stop=store.submit(input('stop',now,'停止分段'));store.stopSplittingCommand(stop.id);store.complete(a.id,'A\n\nB');now+=5000;
    assert.equal(store.flushReplyParts(),null);assert.equal(store.db.prepare("SELECT state FROM reply_parts").get().state,'cancelled');
    assert.equal(store.message(stop.id).state,'completed');
  }finally{store.close();}
});
test('split delivery survives restart but is frozen on snapshot restore', t => {
  const box=sandbox(t),file=path.join(box.root,'chat.sqlite');let now=epoch,store=new ChatStore(file,{now:()=>now});
  try{
    const a=store.submit(input('a',now));store.claim({policy:{...DEFAULT_POLICY,maxMessages:0,minIntervalMs:1000}});store.complete(a.id,'A\n\nB\n\nC');store.close();store=new ChatStore(file,{now:()=>now});now+=1000;
    assert.equal(store.flushReplyParts().text,'B');store.recoverRestoredWork();now+=10000;assert.equal(store.flushReplyParts(),null);
  }finally{store.close();}
});
test('paragraph splitting keeps code, lists, quotes and plain single replies intact',()=>{
  assert.deepEqual(splitReply('a\n\nb\n\nc',2),['a','b\n\nc']);assert.deepEqual(splitReply('a\n\nb',1),['a\n\nb']);
  for(const text of ['a\n\n```js\nhi\n```','a\n\n- item','a\n\n> quote'])assert.deepEqual(splitReply(text,0),[text]);
});
test('context maintenance caps retries, respects disabled threshold and never deletes history',async()=>{
  let calls=0;const base={policy:{enabled:true,maxTokens:4000},measurement:{totalTokens:5000},signature:'same',now:epoch,compact:async()=>{calls++;throw Error('offline');}};
  let previous=await maintainMode(base);assert.equal(calls,1);
  previous=await maintainMode({...base,previous,now:epoch+100});assert.equal(calls,1);
  for(let i=1;i<5;i++)previous=await maintainMode({...base,previous,now:epoch+i*300001});assert.equal(calls,3);
  assert.equal((await maintainMode({...base,policy:{enabled:true,maxTokens:0}})).state,'disabled');
  const done=await maintainMode({...base,signature:'new',compact:async()=>({})});assert.equal(done.state,'compacted');
});
test('management endpoints require admin scope; local stop does not call a model', async t=>{
  const box=sandbox(t);let calls=0;const service=await startService({dataRoot:path.join(box.root,'service'),backend:{reply:async()=>{calls++;return 'test';}},devicePort:0});
  try{
    const boot=await(await fetch(service.url+'/v1/bootstrap')).json(),headers={'X-Chatagent-Token':boot.token,'Content-Type':'application/json'};
    assert.equal((await fetch(service.url+'/v1/preferences')).status,401);
    const prefs=await(await fetch(service.url+'/v1/preferences',{headers})).json();prefs.policy.maxMessages=3;
    assert.equal((await fetch(service.url+'/v1/preferences',{headers,method:'POST',body:JSON.stringify(prefs)})).status,200);
    assert.equal((await fetch(service.url+'/v1/preferences',{headers,method:'POST',body:JSON.stringify(prefs)})).status,409);
    await fetch(service.url+'/v1/messages',{headers,method:'POST',body:JSON.stringify({...input('stop',Date.now(),'停止分段'),expectedMode:boot.mode,expectedModeRevision:boot.modeRevision})});await service.tick();assert.equal(calls,0);
    const invitation=await(await fetch(service.url+'/v1/pairing/invitations',{headers,method:'POST',body:'{}'})).json();
    const deviceToken=randomBytes(32).toString('hex');
    const device=await(await fetch(service.deviceUrl+'/v1/pairing/claim',{headers:{'Content-Type':'application/json'},method:'POST',body:JSON.stringify({credential:invitation.credential,deviceToken,name:'test'})})).json();
    assert.ok(device.deviceId);
    assert.equal((await fetch(service.deviceUrl+'/v1/preferences',{headers:{Authorization:'Bearer '+deviceToken}})).status,403);
  }finally{await service.close();}
});

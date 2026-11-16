import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {startService} from '../apps/service/server.mjs';
import {ChatStore} from '../packages/conversation/store.mjs';
import {DEFAULT_POLICY} from '../packages/conversation/preferences.mjs';
import {startDshBridgeHost} from '../packages/dsh-bridge/host.mjs';
import {verifyWorkspaceBackup,restoreWorkspaceBackup} from '../packages/migration/workspace-backup.mjs';
import {BackupCoordinator} from '../packages/migration/backup-coordinator.mjs';
import {sandbox} from './helpers.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const input=(id,at=Date.now())=>({deviceId:'fixture',clientMessageId:id,text:id,queuedAt:at});
async function setup(t,options={}){
  let cleanup;const box=sandbox({after:fn=>cleanup=fn});const service=await startService({dataRoot:path.join(box.root,'service'),...options});
  t.after(async()=>{await service.close();cleanup();});
  const call=(route,body,base=service.url,headers={'X-Chatagent-Token':service.adminToken})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...headers,'Content-Type':'application/json'},...body===undefined?{}:{body:JSON.stringify(body)}});
  return {box,service,call};
}

test('停止具体轮次抑制迟到回复和后续能力，旧停止请求不会误伤下一轮',async t=>{
  const started=deferred(),finish=deferred();let calls=0,stops=0,after=0;
  const {service,call}=await setup(t,{backend:{async reply(){if(++calls===1){started.resolve();await finish.promise;}return 'reply';},stopReply:async()=>{stops++;return {requested:true};},afterReply:()=>after++}});
  t.after(()=>finish.resolve());
  const first=service.store.submit(input('first'));const running=service.tick();await started.promise;
  const status=await(await call('/v1/activity')).json();assert.equal(status.state,'working');assert.equal(status.requestId,first.id);
  const stopped=await call('/v1/activity/stop',{requestId:status.requestId,revision:status.revision});assert.equal((await stopped.json()).state,'stopping');
  service.store.submit(input('second'));finish.resolve();await running;
  assert.equal(service.store.message(first.id).state,'cancelled');assert.equal(service.store.history().filter(r=>r.role==='assistant').length,0);assert.equal(after,0);
  await service.tick();assert.equal(calls,2);assert.equal(after,1);
  assert.equal((await call('/v1/activity/stop',{requestId:status.requestId,revision:status.revision})).status,409);assert.equal(stops,1);
});

test('停止合并轮次保留全部用户原文，分段停止只取消尚未发出的内容',t=>{
  const box=sandbox(t);let at=Date.now();const store=new ChatStore(path.join(box.root,'chat.sqlite'),{now:()=>at});
  try{
    const one=store.submit(input('one',at));at+=100;const two=store.submit(input('two',at));at+=1000;
    const run=store.claim({policy:{...DEFAULT_POLICY,mergeMs:1000}});assert.deepEqual(run.memberIds,[one.id,two.id]);
    assert.throws(()=>store.requestStop(two.id,store.message(two.id).revision),/MESSAGE_STATE_CHANGED/);
    store.requestStop(run.id,run.revision);assert.equal(store.complete(run.id,'late'),null);
    assert.equal(store.message(one.id).state,'cancelled');assert.equal(store.message(two.id).state,'cancelled');assert.equal(store.message(two.id).text,'two');
    store.submit(input('third',at));const next=store.claim({policy:{...DEFAULT_POLICY,maxMessages:0,minIntervalMs:60000}});store.complete(next.id,'sent\n\nunsent\n\nunsent too');
    const sent=store.history().find(r=>r.role==='assistant');const activity=store.activity(false);assert.equal(activity.state,'sending');assert.equal(activity.pendingParts,2);
    assert.equal(store.requestStop(activity.requestId,activity.revision).partsOnly,true);at+=200000;assert.equal(store.flushReplyParts(),null);assert.deepEqual(store.message(sent.id),sent);
  }finally{store.close();}
});

test('停止回执失联保持待确认，重新启动和只读恢复均不复活迟到答案',async t=>{
  const started=deferred(),finish=deferred();let receipt={state:'unknown'};
  const {service,call,box}=await setup(t,{backend:{reply:async()=>{started.resolve();await finish.promise;return 'late answer';},stopReply:async()=>{throw Error('network');},lookupResult:async()=>{throw Error('must not read stopped text');},replyState:async()=>receipt}});
  t.after(()=>finish.resolve());
  const first=service.store.submit(input('first'));const running=service.tick();await started.promise;
  const status=service.store.activity(true);assert.equal((await(await call('/v1/activity/stop',{requestId:status.requestId,revision:status.revision})).json()).state,'stop-unknown');
  finish.resolve();await running;assert.equal(service.store.message(first.id).state,'unknown');assert.equal(service.store.history().filter(r=>r.role==='assistant').length,0);
  await service.tick();assert.equal(service.store.message(first.id).state,'unknown');receipt={state:'completed',text:'late answer'};await service.tick();assert.equal(service.store.message(first.id).state,'cancelled');
  const file=path.join(box.root,'restart.sqlite');let store=new ChatStore(file);const row=store.submit(input('restart'));const run=store.claim();store.requestStop(run.id,run.revision);store.close();
  store=new ChatStore(file);try{store.recoverInterrupted();const unknown=store.message(row.id);assert.equal(store.complete(row.id,'late',unknown.revision),null);assert.equal(store.message(row.id).state,'cancelled');assert.equal(store.history().length,1);}finally{store.close();}
});

test('设备可以读取并停止所在聊天，但不能访问全量备份管理',async t=>{
  const {service,call}=await setup(t,{devicePort:0});
  const invitation=await(await call('/v1/pairing/invitations',{})).json(),token=randomBytes(32).toString('hex');
  const claimed=await call('/v1/pairing/claim',{credential:invitation.credential,deviceToken:token,name:'fixture'},service.deviceUrl,{});assert.equal(claimed.status,200);
  const device=(route,body)=>call(route,body,service.deviceUrl,{Authorization:'Bearer '+token});
  assert.equal((await device('/v1/activity')).status,200);assert.equal((await device('/v1/activity/stop',{requestId:randomUUID(),revision:1})).status,409);
  assert.equal((await device('/v1/backups/workspace/status')).status,403);assert.equal((await device('/v1/backups/workspace',{})).status,403);
});

test('桥接在准备阶段接收停止后不发模型请求，持久回执不被原生日志复活',async t=>{
  let cleanup;const box=sandbox({after:fn=>cleanup=fn}),token='x'.repeat(40),prepared=deferred(),resume=deferred();let prompts=0,cancels=0;
  const driver={configure(){},ensure:async()=>{},prepare:async body=>{prepared.resolve();await resume.promise;return body;},prompt:async()=>prompts++,wait:async()=>{},flush:async()=>{},events:async()=>[],status:()=>({}),cancel:async()=>cancels++};
  let host=await startDshBridgeHost({root:path.join(box.root,'bridge'),token,port:0,driver});
  const call=async(route,body)=>{const r=await fetch(host.url+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...body===undefined?{}:{body:JSON.stringify(body)}});return r.json();};
  try{
    await call('/v1/requests',{id:'target',text:'synthetic'});await prepared.promise;
    assert.equal((await call('/v1/cancel',{requestId:'old'})).requested,false);assert.equal(cancels,0);
    assert.equal((await call('/v1/cancel',{requestId:'target'})).requested,true);resume.resolve();
    for(let i=0;i<50&&(await call('/v1/requests/target')).state!=='cancelled';i++)await new Promise(r=>setTimeout(r,5));
    assert.equal((await call('/v1/requests/target')).state,'cancelled');assert.equal(prompts,0);assert.equal(cancels,1);
    await host.close();host=await startDshBridgeHost({root:path.join(box.root,'bridge'),token,port:0,driver});assert.equal((await call('/v1/requests/target')).state,'cancelled');
    assert.equal((await call('/v1/cancel',{requestId:'before-acceptance'})).state,'cancelled');
    assert.equal((await call('/v1/requests',{id:'before-acceptance',text:'synthetic'})).state,'cancelled');assert.equal(prompts,0);
  }finally{resume.resolve();await host.close();cleanup();}
});

test('所有聊天备份等待在途轮次、共享写入屏障、保留人格附件及档案，恢复冻结旧任务',async t=>{
  const started=deferred(),finish=deferred();let calls=0;
  const backend={kind:'test-injected',externalRuntime:true,async reply(){calls++;started.resolve();await finish.promise;return 'saved answer';},openChat:async()=>({kind:'test-injected',externalRuntime:true,reply:async()=> 'child answer'})};
  const {service,call,box}=await setup(t,{backend,preferencesSeed:{personas:[{id:'persona',name:'fixture',text:'preserve this persona',categoryId:null}],activePersonaId:'persona'}});t.after(()=>finish.resolve());
  const id=randomUUID();assert.equal((await call('/v1/chats',{id,name:'second',personaId:'persona'})).status,200);
  const child='/v1/chats/'+id;
  assert.equal((await call(child+'/v1/messages',{...input('child'),expectedMode:'social',expectedModeRevision:0})).status,200);
  const file=path.join(box.root,'fixture.txt');fs.writeFileSync(file,'attachment fixture');const attached=service.attachments.importFile(file);
  const one=service.store.submit({...input('one'),attachments:[{id:attached.id,name:attached.name,bytes:attached.bytes,sha256:attached.sha256,mediaType:attached.media_type}]});service.store.submit(input('waiting'));
  backend.supportsAttachments=true;const running=service.tick();await started.promise;
  const capturing=service.workspaceBackup(),concurrent=service.workspaceBackup();
  await new Promise(r=>setTimeout(r,10));
  assert.equal((await call('/v1/messages',input('blocked'))).status,503);assert.equal((await call(child+'/v1/messages',input('blocked-child'))).status,503);
  assert.equal((await call('/v1/chats',{id:randomUUID(),name:'blocked',personaId:'persona'})).status,503);
  finish.resolve();await running;const [manifest,duplicate]=await Promise.all([capturing,concurrent]);assert.equal(manifest.id,duplicate.id);assert.equal(manifest.chats.length,2);
  const directory=path.join(service.root,'workspace-backups',manifest.id);verifyWorkspaceBackup(directory);
  const restored=restoreWorkspaceBackup(directory,path.join(box.root,'restored'));assert.equal(restored.executionEnabled,false);assert.equal(restored.chats,2);
  const db=new DatabaseSync(path.join(restored.chatRoot,'chat.sqlite'),{readOnly:true});
  try{assert.equal(db.prepare('SELECT state FROM messages WHERE id=?').get(one.id).state,'completed');assert.equal(db.prepare("SELECT state FROM messages WHERE text='waiting'").get().state,'unknown');assert.equal(db.prepare("SELECT value FROM settings WHERE key='preferences'").get().value,service.store.db.prepare("SELECT value FROM settings WHERE key='preferences'").get().value);assert.notEqual(db.prepare("SELECT value FROM settings WHERE key='sync_epoch'").get().value,service.store.epoch);}finally{db.close();}
  assert.equal(fs.existsSync(path.join(restored.chatRoot,'conversations',id,'chat.sqlite')),true);assert.equal(fs.existsSync(path.join(restored.chatRoot,'devices.sqlite')),false);
  assert.throws(()=>restoreWorkspaceBackup(directory,path.join(box.root,'restored')),/RESTORE_TARGET_EXISTS/);
  fs.appendFileSync(path.join(directory,'chats/default/payload/chat/chat.sqlite'),'damaged');assert.throws(()=>verifyWorkspaceBackup(directory),/BACKUP_VERIFICATION_FAILED/);
});

test('自动备份开关持久化且失败不会报告成功，旧备份不删除',async t=>{
  const box=sandbox(t),file=path.join(box.root,'jobs.json');let at=Date.now(),calls=0;
  const options={file,isIdle:()=>true,now:()=>at,capture:async()=>{calls++;if(calls===1)throw Error('SYNTHETIC_FAILURE');return {id:'snapshot-'+calls,status:'complete',coverage:['fixture'],createdAt:at};}};
  let coordinator=new BackupCoordinator(options);coordinator.configure(true);await assert.rejects(coordinator.tick(),/SYNTHETIC_FAILURE/);assert.equal(coordinator.status().lastComplete,null);
  coordinator=new BackupCoordinator(options);assert.equal(coordinator.status().enabled,true);at+=10*60000;await coordinator.tick();assert.equal(coordinator.status().lastComplete.id,'snapshot-2');await coordinator.tick();assert.equal(calls,2);
  coordinator.configure(false);coordinator=new BackupCoordinator({...options,enabled:true});assert.equal(coordinator.status().enabled,false);assert.equal(coordinator.status().lastComplete.id,'snapshot-2');
});

test('所有聊天捕获失败释放屏障，保留上次成功备份并拒绝发布残缺快照',async t=>{
  const {service,call,box}=await setup(t);
  const file=path.join(box.root,'attachment.txt');fs.writeFileSync(file,'fixture');const ref=service.attachments.importFile(file);
  const first=await service.workspaceBackup();fs.unlinkSync(path.join(service.attachments.root,'objects',ref.sha256));
  await assert.rejects(service.workspaceBackup());
  const status=await(await call('/v1/backups/workspace/status')).json();assert.equal(status.lastComplete.id,first.id);assert.equal(status.lastAttempt.state,'failed');
  const published=fs.readdirSync(path.join(service.root,'workspace-backups')).filter(name=>!name.startsWith('.'));assert.deepEqual(published,[first.id]);
  assert.equal((await call('/v1/messages',{...input('after-failure'),expectedMode:'social',expectedModeRevision:0})).status,200);
});

test('在线服务每日空闲备份实际触发，后台忙时不会触发',async t=>{
  let background=true;
  const {service,call}=await setup(t,{workspaceAutomaticBackups:true,backupIdleMs:0,backend:{backupIdle:()=>!background,reply:async()=> 'synthetic'}});
  await new Promise(r=>setTimeout(r,1100));assert.equal((await(await call('/v1/backups/workspace/status')).json()).lastComplete,null);
  background=false;
  let status;
  for(let i=0;i<40;i++){status=await(await call('/v1/backups/workspace/status')).json();if(status.lastComplete)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(status.lastComplete?.kind,'automatic');assert.equal(status.lastAttempt.state,'published');
});

test('捕获快照期间停止分段也受共享屏障保护，发布后可以正常停止',async t=>{
  const {service,call}=await setup(t);const captured=deferred(),resume=deferred();
  service.store.submit(input('parts'));const run=service.store.claim({policy:{...DEFAULT_POLICY,maxMessages:0,minIntervalMs:60000}});service.store.complete(run.id,'sent\n\nqueued');
  const original=service.attachments.checkpoint.bind(service.attachments);service.attachments.checkpoint=async destination=>{captured.resolve();await resume.promise;return original(destination);};
  const job=service.workspaceBackup();await captured.promise;
  try{const current=service.store.activity(true);assert.equal((await call('/v1/activity/stop',{requestId:current.requestId,revision:current.revision})).status,503);}finally{resume.resolve();}
  await job;const current=service.store.activity(true);assert.equal((await call('/v1/activity/stop',{requestId:current.requestId,revision:current.revision})).status,200);
});

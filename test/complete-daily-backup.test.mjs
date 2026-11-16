import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ChatStore} from '../packages/conversation/store.mjs';
import {AttachmentStore} from '../packages/storage/attachments.mjs';
import {inventory,captureRuntimeBackup} from '../packages/migration/runtime-backup.mjs';
import {captureWorkspaceBackup,restoreWorkspaceBackup,verifyWorkspaceBackup} from '../packages/migration/workspace-backup.mjs';
import {backupDay,dailyPlan,pruneDailyBackups,listDailyBackups} from '../packages/migration/daily-backups.mjs';
import {startDshBridgeHost} from '../packages/dsh-bridge/host.mjs';
import {sandbox} from './helpers.mjs';

function nativeFixture(root){
  const directory=path.join(root,randomUUID()),sessionId='chatagent-'+randomUUID();fs.mkdirSync(directory);fs.mkdirSync(path.join(directory,'session'));
  fs.writeFileSync(path.join(directory,'session/session.v4.jsonl'),JSON.stringify({type:'header',id:sessionId})+'\n');
  fs.writeFileSync(path.join(directory,'scope.json'),JSON.stringify({format:'chatagent-native-scope-v1',sessionId,nativeFile:'session.v4.jsonl',executionEnabled:false}));
  fs.writeFileSync(path.join(directory,'identity.json'),JSON.stringify({sessionId}));
  fs.writeFileSync(path.join(directory,'memory.json'),JSON.stringify({version:2,memories:[{text:'preserved memory'}],deleted:[{text:'deleted memory'}],policy:{limit:999},traces:[{text:'trace'}]}));
  fs.mkdirSync(path.join(directory,'voice-replies'));fs.writeFileSync(path.join(directory,'voice-replies/settings.json'),JSON.stringify({format:'chatagent-voice-replies-v1',source:'system',voice:'Synthetic Chinese'}));
  let db=new DatabaseSync(path.join(directory,'requests.sqlite'));db.exec("CREATE TABLE requests(id TEXT,state TEXT);INSERT INTO requests VALUES('inflight','running'),('old','unknown')");db.close();
  db=new DatabaseSync(path.join(directory,'diaries.sqlite'));db.exec('CREATE TABLE jobs(id TEXT,state TEXT);CREATE TABLE documents(id TEXT,body TEXT)');for(let i=0;i<250;i++)db.prepare('INSERT INTO documents VALUES(?,?)').run(String(i),'diary '+i);db.exec("INSERT INTO jobs VALUES('inflight','running')");db.close();
  return {directory,sessionId,files:inventory(directory)};
}
test('完整备份保留全部记忆、250篇日记及专属会话，恢复冻结未决任务，检测篡改与失败清理',async t=>{
  let cleanup;const box=sandbox({after:fn=>cleanup=fn}),store=new ChatStore(path.join(box.root,'chat.sqlite'));
  const attachments=new AttachmentStore(path.join(box.root,'attachments'));t.after(()=>{attachments.close();store.close();cleanup();});
  const native=nativeFixture(box.root),chats=[{id:'default',store,attachments,native}],destination=path.join(box.root,randomUUID());let finished=0;
  const manifest=await captureWorkspaceBackup({chats,destination,finishNative:async()=>finished++});assert.equal(finished,1);assert.equal(manifest.version,2);verifyWorkspaceBackup(destination);
  const target=path.join(box.root,'restored');restoreWorkspaceBackup(destination,target);
  assert.deepEqual(fs.readFileSync(path.join(target,'native/default/memory.json')),fs.readFileSync(path.join(native.directory,'memory.json')));
  assert.deepEqual(fs.readFileSync(path.join(target,'native/default/voice-replies/settings.json')),fs.readFileSync(path.join(native.directory,'voice-replies/settings.json')));
  let db=new DatabaseSync(path.join(target,'native/default/diaries.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) n FROM documents').get().n,250);assert.equal(db.prepare('SELECT state FROM jobs').get().state,'unknown');db.close();
  db=new DatabaseSync(path.join(target,'native/default/requests.sqlite'),{readOnly:true});assert.equal(db.prepare("SELECT state FROM requests WHERE id='inflight'").get().state,'unknown');db.close();
  const failed=path.join(box.root,randomUUID());await assert.rejects(captureWorkspaceBackup({chats,destination:failed,finishNative:async()=>{throw Error('BACKUP_SOURCE_CHANGED');}}),/BACKUP_SOURCE_CHANGED/);assert.equal(fs.existsSync(failed),false);assert.equal(fs.readdirSync(box.root).some(n=>n.startsWith('.staging-')),false);
  fs.appendFileSync(path.join(destination,'native/default/memory.json'),'tampered');assert.throws(()=>verifyWorkspaceBackup(destination),/BACKUP_VERIFICATION_FAILED/);
});
test('上海自然日只保留最近七天每天最新一份，跨日、同毫秒手动替换、未来日期均有确定结果',()=>{
  const now=Date.parse('2026-11-07T00:00:01+08:00'),rows=[];
  for(let i=0;i<10;i++)for(let j=0;j<3;j++)rows.push({id:i+'-'+j,path:i+'-'+j,createdAt:now-i*86400000-j});
  const plan=dailyPlan(rows,now);assert.equal(plan.keep.length,7);assert.equal(plan.remove.length,23);assert.ok(plan.keep.every(p=>p.endsWith('-0')));
  assert.equal(backupDay(now-2000),'2026-11-06');assert.deepEqual(dailyPlan([{id:'a',path:'a',createdAt:now},{id:'b',path:'b',createdAt:now}],now,'a').keep,['a']);
});
test('真实目录清理保护迁移底档和未归属目录，旧副本损坏时停止删除',async t=>{
  let cleanup;const box=sandbox({after:fn=>cleanup=fn}),root=box.root;fs.mkdirSync(path.join(root,'workspace-backups'));fs.mkdirSync(path.join(root,'migration-original'));fs.writeFileSync(path.join(root,'migration-original/original'),'original');
  const store=new ChatStore(path.join(root,'chat.sqlite')),attachments=new AttachmentStore(path.join(root,'attachments'));t.after(()=>{attachments.close();store.close();cleanup();});const now=Date.now(),ids=[];
  for(let i=8;i>=0;i--){const id=randomUUID();ids.push(id);await captureWorkspaceBackup({chats:[{id:'default',store,attachments}],destination:path.join(root,'workspace-backups',id),now:()=>now-i*86400000});}
  fs.mkdirSync(path.join(root,'backups'));await captureRuntimeBackup({store,attachments,destination:path.join(root,'backups',randomUUID()),now:()=>now-8*86400000});
  pruneDailyBackups(root,now);assert.equal(listDailyBackups(root).length,7);assert.equal(fs.readFileSync(path.join(root,'migration-original/original'),'utf8'),'original');
  fs.appendFileSync(path.join(root,'workspace-backups',ids[3],'chats/default/payload/chat/chat.sqlite'),'bad');assert.throws(()=>pruneDailyBackups(root,now+86400000),/BACKUP_VERIFICATION_FAILED/);assert.equal(listDailyBackups(root).length,7);
});
test('桥接备份租约阻止新请求，检查失败释放租约且不调用模型，不接受错误租约',async t=>{
  let cleanup;const box=sandbox({after:fn=>cleanup=fn});let closed=0,prompts=0,fail=true;
  const driver={configure(){},status:()=>({}),beginBackup:async()=>({directory:box.root,files:[],check(){if(fail)throw Error('BACKUP_SOURCE_CHANGED');},close(){closed++;}}),prompt:()=>prompts++,ensure:async()=>{}};
  const host=await startDshBridgeHost({root:path.join(box.root,'bridge'),token:'x'.repeat(40),port:0,driver});t.after(async()=>{await host.close();cleanup();});
  const call=(route,body)=>fetch(host.url+route,{method:'POST',headers:{Authorization:'Bearer '+'x'.repeat(40),'Content-Type':'application/json'},body:JSON.stringify(body)});
  let lease=await(await call('/v1/backup/begin',{})).json();assert.equal((await call('/v1/requests',{id:'blocked',text:'blocked'})).status,409);assert.equal((await call('/v1/backup/end',{lease:'wrong',commit:true})).status,409);
  assert.equal((await call('/v1/backup/end',{lease:lease.lease,commit:true})).status,409);assert.equal(closed,1);assert.equal(prompts,0);
  fail=false;lease=await(await call('/v1/backup/begin',{})).json();assert.equal((await call('/v1/backup/end',{lease:lease.lease,commit:true})).status,200);assert.equal(closed,2);
});

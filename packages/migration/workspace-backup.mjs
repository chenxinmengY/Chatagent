import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {captureRuntimeBackup,verifyRuntimeBackup,restoreRuntimeBackup,inventory,plainDirectory,copyTree} from './runtime-backup.mjs';

const FORMAT='chatagent-workspace-backup-v1';
export const workspaceCoverage=['chatagent.all-chats','chatagent.local-chat.sqlite','chatagent.attachments','chatagent.preferences-and-profiles','chatagent.imported-archives'];
export const workspaceExcluded=['dsh.native-sessions','dsh.model-and-plugin-configuration','dsh.external-memory-and-diaries','device.pairing-credentials','phone.local-cache'];
export const completeWorkspaceCoverage=[...workspaceCoverage,'dsh.chatagent-native-sessions','dsh.long-term-memory','dsh.diaries','dsh.chatagent-bridge-state'];
export const completeWorkspaceExcluded=['dsh.model-and-plugin-configuration','device.pairing-credentials','phone.local-cache'];
const validId=id=>id==='default'||/^[a-f0-9-]{36}$/.test(id??'');
const fail=code=>{throw Error(code);};

// Service holds one shared write barrier for every chat during this capture.
// Each chat uses the existing SQLite/attachment capture and restore validators.
export async function captureWorkspaceBackup({chats,destination,now=Date.now,finishNative}){
  plainDirectory(path.dirname(destination));
  if(fs.existsSync(destination))fail('BACKUP_TARGET_EXISTS');
  if(!Array.isArray(chats)||!chats.length||chats[0].id!=='default'||chats.some(c=>!validId(c.id))||new Set(chats.map(c=>c.id)).size!==chats.length)fail('BACKUP_CHAT_LIST_INVALID');
  const stage=path.join(path.dirname(destination),'.staging-'+randomUUID());fs.mkdirSync(stage);fs.mkdirSync(path.join(stage,'chats'));
  try{
  const complete=chats.every(c=>c.native);
  if(chats.some(c=>c.native)&&!complete)fail('BACKUP_NATIVE_SCOPE_MISSING');
  if(complete)fs.mkdirSync(path.join(stage,'native'));
  const rows=[];
  for(const chat of chats){
    const manifest=await captureRuntimeBackup({store:chat.store,attachments:chat.attachments,destination:path.join(stage,'chats',chat.id),now});
    rows.push({id:chat.id,messages:manifest.messages});
    if(complete){
      const native=chat.native;plainDirectory(native.directory);
      if(JSON.stringify(inventory(native.directory))!==JSON.stringify(native.files))fail('BACKUP_SOURCE_CHANGED');
      copyTree(native.directory,path.join(stage,'native',chat.id));
      if(JSON.stringify(inventory(path.join(stage,'native',chat.id)))!==JSON.stringify(native.files))fail('BACKUP_SOURCE_CHANGED');
      rows.at(-1).sessionId=native.sessionId;
    }
  }
  if(complete)await finishNative();
  const manifest={format:complete?'chatagent-workspace-backup-v2':FORMAT,version:complete?2:1,id:path.basename(destination),createdAt:now(),status:'complete',coverage:complete?completeWorkspaceCoverage:workspaceCoverage,excluded:complete?completeWorkspaceExcluded:workspaceExcluded,chats:rows,files:inventory(path.join(stage,'chats')),...complete?{nativeFiles:inventory(path.join(stage,'native'))}:{}};
  fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
  verifyWorkspaceBackup(stage);
  const proof=path.join(path.dirname(destination),'.restore-proof-'+randomUUID());
  try{restoreWorkspaceBackup(stage,proof);}finally{if(fs.existsSync(proof)){plainDirectory(proof);inventory(proof);fs.rmSync(proof,{recursive:true});}}
  manifest.restoreVerified=true;fs.writeFileSync(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2));
  fs.renameSync(stage,destination);return manifest;
  }catch(error){plainDirectory(stage);inventory(stage);fs.rmSync(stage,{recursive:true});throw error;}
}

export function verifyWorkspaceBackup(directory){
  plainDirectory(directory);
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const complete=manifest.format==='chatagent-workspace-backup-v2'&&manifest.version===2;
  if(fs.readdirSync(directory).sort().join(',')!==(complete?'chats,manifest.json,native':'chats,manifest.json'))fail('BACKUP_UNEXPECTED_FILE');
  if((!complete&&(manifest.format!==FORMAT||manifest.version!==1))||manifest.status!=='complete'||typeof manifest.id!=='string'||!manifest.id||
    JSON.stringify(manifest.coverage)!==JSON.stringify(complete?completeWorkspaceCoverage:workspaceCoverage)||JSON.stringify(manifest.excluded)!==JSON.stringify(complete?completeWorkspaceExcluded:workspaceExcluded)||
    !Array.isArray(manifest.chats)||manifest.chats[0]?.id!=='default'||manifest.chats.some(c=>!validId(c.id)||!Number.isSafeInteger(c.messages)||c.messages<0)||
    new Set(manifest.chats.map(c=>c.id)).size!==manifest.chats.length)fail('BACKUP_MANIFEST_INVALID');
  if(JSON.stringify(inventory(path.join(directory,'chats')))!==JSON.stringify(manifest.files))fail('BACKUP_VERIFICATION_FAILED');
  const ids=manifest.chats.map(c=>c.id).sort();
  if(JSON.stringify(fs.readdirSync(path.join(directory,'chats')).sort())!==JSON.stringify(ids))fail('BACKUP_CHAT_LIST_INVALID');
  for(const chat of manifest.chats){const nested=verifyRuntimeBackup(path.join(directory,'chats',chat.id));if(nested.id!==chat.id||nested.messages!==chat.messages||nested.coverage.includes('chatagent.isolated-dsh'))fail('BACKUP_CHAT_LIST_INVALID');}
  if(complete){
    if(JSON.stringify(inventory(path.join(directory,'native')))!==JSON.stringify(manifest.nativeFiles)||JSON.stringify(fs.readdirSync(path.join(directory,'native')).sort())!==JSON.stringify(ids))fail('BACKUP_VERIFICATION_FAILED');
    for(const chat of manifest.chats){
      const folder=path.join(directory,'native',chat.id),scope=JSON.parse(fs.readFileSync(path.join(folder,'scope.json'))),identity=JSON.parse(fs.readFileSync(path.join(folder,'identity.json'))),memory=JSON.parse(fs.readFileSync(path.join(folder,'memory.json')));
      if(scope.format!=='chatagent-native-scope-v1'||scope.sessionId!==chat.sessionId||identity.sessionId!==chat.sessionId||!/^chatagent-[a-f0-9-]{36}$/.test(chat.sessionId)||!['session.v4.jsonl','session.v4.jsonl.zstd'].includes(scope.nativeFile)||!fs.statSync(path.join(folder,'session',scope.nativeFile)).size||!Array.isArray(memory.memories)||!Array.isArray(memory.deleted))fail('BACKUP_NATIVE_SCOPE_INVALID');
      for(const name of ['requests.sqlite','diaries.sqlite']){const db=new DatabaseSync(path.join(folder,name),{readOnly:true});try{if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')fail('BACKUP_DATABASE_INVALID');}finally{db.close();}}
    }
  }
  const db=new DatabaseSync(path.join(directory,'chats/default/payload/chat/chat.sqlite'),{readOnly:true});
  try{
    const registered=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='chat_spaces'").get()?db.prepare('SELECT id FROM chat_spaces ORDER BY id').all().map(r=>r.id):[];
    if(JSON.stringify(registered)!==JSON.stringify(ids.filter(id=>id!=='default')))fail('BACKUP_CHAT_LIST_INVALID');
  }finally{db.close();}
  return manifest;
}

// Never restore over a live workspace. Native sessions and pairing stay external;
// restored queued/running tasks are frozen by restoreRuntimeBackup, never replayed.
export function restoreWorkspaceBackup(directory,target){
  directory=path.resolve(directory);target=path.resolve(target);
  const manifest=verifyWorkspaceBackup(directory);plainDirectory(path.dirname(target));
  if(fs.existsSync(target))fail('RESTORE_TARGET_EXISTS');
  const stage=path.join(path.dirname(target),'.restore-'+randomUUID());fs.mkdirSync(stage);
  try{
  for(const chat of manifest.chats){
    const wrapper=path.join(stage,'restoring-'+chat.id);
    restoreRuntimeBackup(path.join(directory,'chats',chat.id),wrapper);
    const dest=chat.id==='default'?path.join(stage,'chat'):path.join(stage,'chat/conversations',chat.id);
    fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(path.join(wrapper,'chat'),dest);
    fs.renameSync(path.join(wrapper,'restore.json'),path.join(stage,'restore-'+chat.id+'.json'));fs.rmdirSync(wrapper);
  }
  if(manifest.version===2){
    copyTree(path.join(directory,'native'),path.join(stage,'native'));
    // Preserve the original ledgers in the archive; recovery copies cannot
    // replay in-flight plugin/model work after an interrupted old process.
    for(const chat of manifest.chats)for(const [name,table] of [['requests.sqlite','requests'],['diaries.sqlite','jobs']]){const db=new DatabaseSync(path.join(stage,'native',chat.id,name));try{db.exec(`UPDATE ${table} SET state='unknown' WHERE state='running'`);}finally{db.close();}}
  }
  // Detect source replacement between validation and the per-chat copies.
  const finalManifest=verifyWorkspaceBackup(directory);
  if(JSON.stringify(finalManifest)!==JSON.stringify(manifest))fail('BACKUP_CHANGED_DURING_RESTORE');
  fs.writeFileSync(path.join(stage,'restore.json'),JSON.stringify({format:manifest.format,restoredFrom:manifest.id,executionEnabled:false,excluded:manifest.excluded,nativeRoot:manifest.version===2?'native':null},null,2),{flag:'wx'});
  fs.renameSync(stage,target);return {chatRoot:path.join(target,'chat'),executionEnabled:false,chats:manifest.chats.length,excluded:manifest.excluded};
  }catch(error){if(fs.existsSync(stage)){plainDirectory(stage);inventory(stage);fs.rmSync(stage,{recursive:true});}throw error;}
}

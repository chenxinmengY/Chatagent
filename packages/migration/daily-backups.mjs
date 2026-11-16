import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {inventory,plainDirectory,verifyRuntimeBackup} from './runtime-backup.mjs';
import {verifyLocalDatabase} from './local-restore.mjs';
import {verifyWorkspaceBackup} from './workspace-backup.mjs';

export const backupDay=time=>new Date(time+8*3600000).toISOString().slice(0,10);
export function dailyPlan(rows,now=Date.now(),preferredId=null){
  const oldest=backupDay(now-6*86400000),today=backupDay(now),keep=new Map();
  for(const row of [...rows].sort((a,b)=>b.createdAt-a.createdAt||Number(b.id===preferredId)-Number(a.id===preferredId)||b.path.localeCompare(a.path))){const day=backupDay(row.createdAt);if(day>=oldest&&day<=today&&!keep.has(day))keep.set(day,row.path);}
  return {keep:[...keep.values()],remove:rows.filter(r=>!new Set(keep.values()).has(r.path)).map(r=>r.path)};
}
export function listDailyBackups(root){
  const rows=[];
  for(const name of ['workspace-backups','backups']){const directory=path.join(root,name);if(!fs.existsSync(directory))continue;plainDirectory(directory);
    for(const id of fs.readdirSync(directory)){if(!/^[a-f0-9-]{36}$/.test(id))continue;const folder=path.join(directory,id);plainDirectory(folder);const file=path.join(folder,'manifest.json');if(!fs.existsSync(file))continue;
      const manifest=JSON.parse(fs.readFileSync(file));if(manifest.id!==id||manifest.status!=='complete'||!Number.isFinite(manifest.createdAt))throw Error('BACKUP_MANIFEST_INVALID');
      rows.push({id,path:folder,createdAt:manifest.createdAt,format:manifest.format??'local',coverage:manifest.coverage});
    }
  }return rows;
}
function verify(row){
  if(row.format.startsWith('chatagent-workspace-backup-'))return verifyWorkspaceBackup(row.path);
  if(['chatagent-runtime-backup-v1','chatagent-archive-backup-v2'].includes(row.format))return verifyRuntimeBackup(row.path);
  const manifest=JSON.parse(fs.readFileSync(path.join(row.path,'manifest.json'))),file=path.join(row.path,'chat.sqlite');inventory(row.path);
  if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==manifest.sha256||verifyLocalDatabase(file,manifest.messages).length)throw Error('BACKUP_VERIFICATION_FAILED');
  return manifest;
}
// Called only after a new complete snapshot has passed restore verification.
// Resolve every deletion independently and persist an audit before removing it.
export function pruneDailyBackups(root,now=Date.now(),preferredId=null){
  plainDirectory(root);const rows=listDailyBackups(root),plan=dailyPlan(rows,now,preferredId);
  for(const row of rows)verify(row);
  fs.writeFileSync(path.join(root,'backup-retention-audit.json'),JSON.stringify({at:now,policy:'migration-plus-seven-calendar-days',...plan},null,2));
  for(const target of plan.remove){const resolved=path.resolve(target),parent=path.dirname(resolved);if(!['backups','workspace-backups'].some(name=>parent===path.join(path.resolve(root),name))||!rows.some(r=>r.path===resolved))throw Error('BACKUP_DELETE_REFUSED');plainDirectory(resolved);inventory(resolved);fs.rmSync(resolved,{recursive:true});}
  return {...plan,remaining:listDailyBackups(root)};
}

// Historic archives may contain thousands of plugin files. Their validation
// and deletion must not block HTTP, chat sync, or foreground message delivery.
export function pruneDailyBackupsAsync(root,now=Date.now(),preferredId=null){
  return new Promise((resolve,reject)=>{const worker=new Worker(new URL(import.meta.url),{workerData:{kind:'chatagent-retention',root,now,preferredId}});worker.once('message',result=>result.error?reject(Error(result.error)):resolve(result.value));worker.once('error',reject);worker.once('exit',code=>{if(code)reject(Error('BACKUP_RETENTION_FAILED'));});});
}
if(!isMainThread&&workerData?.kind==='chatagent-retention'){
  try{parentPort.postMessage({value:pruneDailyBackups(workerData.root,workerData.now,workerData.preferredId)});}catch(error){parentPort.postMessage({error:/^[A-Z_]+$/.test(error.message)?error.message:'BACKUP_RETENTION_FAILED'});}
}

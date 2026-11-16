import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {backup,DatabaseSync} from 'node:sqlite';
import {inventory,plainDirectory,sealDatabase} from '../migration/runtime-backup.mjs';

const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Only this bridge's session and memory library are exported. No global model
// connections, credentials, or unrelated DSH sessions enter the snapshot.
export async function nativeBackupSnapshot({config,sessionId,sessionsRoot,ledger}){
  plainDirectory(config.root);plainDirectory(sessionsRoot);
  const stage=path.join(config.root,'.backup-'+randomUUID());fs.mkdirSync(stage);
  const watched=[];
  const databases=[];
  const fingerprint=db=>JSON.stringify(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'" ORDER BY rowid').all()]));
  const copy=(source,name)=>{
    const absolute=path.resolve(source);if(fs.realpathSync(absolute).toLowerCase()!==absolute.toLowerCase()||!fs.lstatSync(absolute).isFile())throw Error('BACKUP_LINK_REFUSED');
    const hash=digest(source),target=path.join(stage,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
    if(digest(target)!==hash)throw Error('BACKUP_SOURCE_CHANGED');watched.push([source,hash]);
  };
  const database=async(source,name)=>{const db=source instanceof DatabaseSync?source:new DatabaseSync(source,{readOnly:true});try{const state=fingerprint(db);await backup(db,path.join(stage,name));sealDatabase(path.join(stage,name));if(fingerprint(db)!==state)throw Error('BACKUP_SOURCE_CHANGED');databases.push([source,state]);}finally{if(db!==source)db.close();}};
  const remove=()=>{if(path.dirname(stage)!==path.resolve(config.root))throw Error('BACKUP_CLEANUP_REFUSED');plainDirectory(stage);inventory(stage);fs.rmSync(stage,{recursive:true});};
  try{
    const matches=[];
    for(const project of fs.readdirSync(sessionsRoot)){const folder=path.join(sessionsRoot,project,sessionId);if(fs.existsSync(folder)){plainDirectory(folder);for(const name of ['session.v4.jsonl.zstd','session.v4.jsonl'])if(fs.existsSync(path.join(folder,name)))matches.push({folder,name});}}
    if(matches.length!==1)throw Error('BACKUP_NATIVE_SESSION_AMBIGUOUS');
    const native=matches[0];copy(path.join(native.folder,native.name),'session/'+native.name);
    const memory=await import(config.migrationOptions.module),cfg=memory.loadCfg(),mode=cfg.模式==='workspace'?'workspace':'session',key=String(memory.库名(sessionId,{模式:mode})||sessionId);
    const home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh'),memoryFile=path.join(home,'fish-memory',key.replace(/[^a-zA-Z0-9_-]/g,'_')+'.json');
    if(fs.existsSync(memoryFile))copy(memoryFile,'memory.json');
    else fs.writeFileSync(path.join(stage,'memory.json'),JSON.stringify(memory.loadStore(sessionId)));
    const memoryConfig={模式:mode,全局开关:cfg.全局开关,sessions:{[sessionId]:cfg.sessions?.[sessionId]??true},policy:cfg.policy,pronoun:cfg.pronoun,selfPronoun:cfg.selfPronoun,pronouns:{[key]:cfg.pronouns?.[key]},selfPronouns:{[key]:cfg.selfPronouns?.[key]}};
    fs.writeFileSync(path.join(stage,'memory-config.json'),JSON.stringify(memoryConfig));
    const cfgFile=path.join(home,'fish-memory-config.json');if(fs.existsSync(cfgFile))watched.push([cfgFile,digest(cfgFile)]);
    for(const name of ['identity.json','imported.json','chat-window.json','context-exclusions.json','voice-replies/settings.json'])if(fs.existsSync(path.join(config.root,name)))copy(path.join(config.root,name),name);
    const settings=config.migrationOptions.root&&path.join(config.migrationOptions.root,'state/chatagent-memory-settings.json');if(settings&&fs.existsSync(settings))copy(settings,'memory-settings.json');
    await database(ledger,'requests.sqlite');await database(path.join(config.root,'plugins/plugins.sqlite'),'diaries.sqlite');
    fs.writeFileSync(path.join(stage,'scope.json'),JSON.stringify({format:'chatagent-native-scope-v1',sessionId,memoryKey:key,memoryMode:mode,projectDirectory:path.basename(path.dirname(native.folder)),nativeFile:native.name,executionEnabled:false}));
    const files=inventory(stage);
    return {directory:stage,files,sessionId,check(){if(watched.some(([file,hash])=>!fs.existsSync(file)||digest(file)!==hash))throw Error('BACKUP_SOURCE_CHANGED');for(const [source,state] of databases){const db=source instanceof DatabaseSync?source:new DatabaseSync(source,{readOnly:true});try{if(fingerprint(db)!==state)throw Error('BACKUP_SOURCE_CHANGED');}finally{if(db!==source)db.close();}}},close:remove};
  }catch(error){remove();throw error;}
}

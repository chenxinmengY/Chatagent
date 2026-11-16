import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {normalizeImport,recordKey} from '../migration/portable.mjs';
import {ownerRecord,ownerDefinitelyGone} from '../storage/process-owner.mjs';
import {windowPolicy} from '../conversation/window-policy.mjs';
import {validReplyLimit} from '../conversation/reply-layout.mjs';

const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fault=code=>Object.assign(Error(code),{code});
export function bridgeReply(events,id){
  const accepted=events.find(e=>e.type==='user/message'&&e.data.source?.rpcId===id);
  if(!accepted)return null;
  const turn=events.findLast(e=>e.type==='turn/start'&&e.seq<accepted.seq)?.data.turn;
  const end=events.find(e=>e.type==='turn/end'&&e.data.turn===turn&&e.seq>accepted.seq);
  if(end?.data.reason?.kind!=='completed')return null;
  const message=events.findLast(e=>e.type==='assistant/message'&&e.data.turn===turn&&e.seq>accepted.seq&&e.seq<end.seq)?.data.message;
  if(!message||message.toolCalls?.length||message.content.some(p=>['tool-call','tool_call','tool_use'].includes(p.type)))return null;
  const text=message.content.filter(p=>p.type==='text').map(p=>p.text).join('');
  return text.trim()?text:null;
}
export async function startDshBridgeHost({root,token,port=37826,driver,openChat}){
  if(!path.isAbsolute(root)||typeof token!=='string'||token.length<32)throw fault('BRIDGE_CONFIG_INVALID');
  fs.mkdirSync(root,{recursive:true});
  if(fs.realpathSync(root).toLowerCase()!==path.resolve(root).toLowerCase())throw fault('BRIDGE_ROOT_LINK_REFUSED');
  for(const name of ['identity.json','requests.sqlite','requests.sqlite-wal','requests.sqlite-shm','imported.json','runtime.lock']){const file=path.join(root,name);if(fs.existsSync(file)&&!fs.lstatSync(file).isFile())throw fault('BRIDGE_FILE_REFUSED');}
  const identityFile=path.join(root,'identity.json');
  if(!fs.existsSync(identityFile)){if(fs.readdirSync(root).length)throw fault('BRIDGE_ROOT_NOT_EMPTY');fs.writeFileSync(identityFile,JSON.stringify({format:'chatagent-dsh-bridge-v1',sessionId:'chatagent-'+randomUUID()}),{flag:'wx'});}
  const identity=JSON.parse(fs.readFileSync(identityFile));
  if(identity.format!=='chatagent-dsh-bridge-v1'||!/^chatagent-[a-f0-9-]{36}$/.test(identity.sessionId??''))throw fault('BRIDGE_IDENTITY_INVALID');
  const lock=path.join(root,'runtime.lock'),lockId=randomUUID();
  if(fs.existsSync(lock)){if(!ownerDefinitelyGone(JSON.parse(fs.readFileSync(lock)),lock))throw fault('BRIDGE_ALREADY_RUNNING');fs.renameSync(lock,lock+'.stale-'+randomUUID());}
  fs.writeFileSync(lock,JSON.stringify(ownerRecord(lockId)),{flag:'wx'});
  const release=()=>{if(fs.existsSync(lock)&&JSON.parse(fs.readFileSync(lock)).token===lockId)fs.unlinkSync(lock);};
  const db=new DatabaseSync(path.join(root,'requests.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,text TEXT); UPDATE requests SET state='unknown' WHERE state='running'");
  db.exec('CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,body TEXT NOT NULL,ack INTEGER NOT NULL DEFAULT 0)');
  if(!db.prepare("SELECT 1 FROM pragma_table_info('requests') WHERE name='stop_requested'").get())db.exec('ALTER TABLE requests ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0');
  const importedFile=path.join(root,'imported.json');
  let imported=fs.existsSync(importedFile)?JSON.parse(fs.readFileSync(importedFile)):null,active=null,activeRun=null,cancelling=null,closed=false;
  driver.configure({sessionId:identity.sessionId,imported:()=>imported,publish(value){
    if(typeof value.deliveryId!=='string'||!/^[\w-]{1,100}$/.test(value.deliveryId)||typeof value.text!=='string'||!value.text.trim()||value.text.length>32000||value.mode&&value.mode!=='social')throw fault('BRIDGE_DELIVERY_INVALID');
    const body={id:value.deliveryId,deliveryId:value.deliveryId,text:value.text,mode:'social',attachments:value.attachments??[]},old=db.prepare('SELECT body FROM deliveries WHERE id=?').get(value.deliveryId);
    if(old&&hash(JSON.parse(old.body))!==hash(body))throw fault('BRIDGE_DELIVERY_CONFLICT');
    db.prepare('INSERT OR IGNORE INTO deliveries(id,body) VALUES(?,?)').run(value.deliveryId,JSON.stringify(body));return body;
  },lookup(id){const row=db.prepare('SELECT body FROM deliveries WHERE id=?').get(id);return row?JSON.parse(row.body):null;}});
  const replyText=async id=>{const text=bridgeReply(await driver.events(),id);return text===null?null:await driver.finalizeReply?.(text,id)??text;};
  async function result(id){const row=db.prepare('SELECT * FROM requests WHERE id=?').get(id);if(!row)return {state:'not-found'};if(row.stop_requested)return {state:row.state==='running'?'stopping':row.state==='completed'?'cancelled':row.state};if(row.state==='completed')return {state:row.state,text:row.text};
    await driver.ensure();const text=await replyText(id);if(text!==null){db.prepare("UPDATE requests SET state='completed',text=? WHERE id=?").run(text,id);return {state:'completed',text};}return {state:row.state};}
  const retiredFile=path.join(root,'retired.json');let retired=fs.existsSync(retiredFile);
  let backupLease=null;
  const releaseBackup=()=>{const value=backupLease;backupLease=null;if(value){clearTimeout(value.timer);value.snapshot?.close();}};
  const server=http.createServer(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Chatagent-Dsh-Session':identity.sessionId});res.end(JSON.stringify(data));};
    try{
      const expected=Buffer.from('Bearer '+token),actual=Buffer.from(req.headers.authorization??'');
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return send(401,{error:'BRIDGE_AUTH_REQUIRED'});
      if(req.headers.origin||!/^127\.0\.0\.1:\d+$/.test(req.headers.host??''))return send(403,{error:'BRIDGE_LOCAL_ONLY'});
      const url=new URL(req.url,'http://127.0.0.1'),route=url.pathname;
      const childRoute=/^\/v1\/chats\/([a-f0-9-]{36})\/(open|v1\/.*)$/.exec(route);
      if(childRoute&&openChat){const child=await openChat(childRoute[1]);if(childRoute[2]==='open')return send(200,{sessionId:child.sessionId});
        let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>32*1024*1024)throw fault('BRIDGE_BODY_TOO_LARGE');chunks.push(chunk);}
        const response=await fetch(child.url+'/'+childRoute[2]+url.search,{method:req.method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...req.method==='GET'?{}:{body:Buffer.concat(chunks)},signal:AbortSignal.timeout(childRoute[2]==='v1/voice-replies/setup'?1200000:childRoute[2].startsWith('v1/voice-replies')?70000:15000)});
        res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Chatagent-Dsh-Session':child.sessionId});return res.end(Buffer.from(await response.arrayBuffer()));
      }
      if(retired&&!['/v1/status','/v1/retire','/v1/backup/begin','/v1/backup/end'].includes(route))throw fault('CHAT_DELETED');
      if(req.method==='GET'&&route==='/v1/status')return send(200,{format:'chatagent-dsh-bridge-v1',sessionId:identity.sessionId,retired,imported:!!imported,migration:imported?{records:imported.records.length,messages:imported.records.filter(r=>r.kind==='message').length,memory:imported.memory}:null,busy:!!(active||cancelling),...await driver.status()});
      if(req.method==='GET'&&route==='/v1/media-connections')return send(200,await driver.mediaConnections());
      if(req.method==='GET'&&route==='/v1/voice-replies'){if(!driver.voiceReplies)throw fault('VOICE_REPLY_UNAVAILABLE');return send(200,await driver.voiceReplies());}
      if(req.method==='GET'&&route==='/v1/plugins')return send(200,await driver.pluginStatus?.()??[]);
      if(req.method==='GET'&&route==='/v1/plugins/course-query/timetable')return send(200,await driver.pluginDetail('course-query'));
      if(req.method==='GET'&&route==='/v1/deliveries')return send(200,db.prepare('SELECT body FROM deliveries WHERE ack=0 ORDER BY rowid LIMIT 20').all().map(r=>JSON.parse(r.body)));
      const query=/^\/v1\/requests\/([a-zA-Z0-9_-]{1,150})$/.exec(route);
      if(backupLease&&query)throw fault('BACKUP_RUNTIME_BUSY');
      if(req.method==='GET'&&query)return send(200,await result(query[1]));
      if(req.method!=='POST')return send(404,{error:'NOT_FOUND'});
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>32*1024*1024)throw fault('BRIDGE_BODY_TOO_LARGE');chunks.push(chunk);}const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(route==='/v1/retire'){
        if(retired){await driver.syncRetirement?.();return send(200,{retired:true});}
        if(active||cancelling||backupLease||(await driver.status()).backgroundBusy)throw fault('CHAT_BUSY');
        if(!driver.retire)throw fault('CHAT_DELETE_UNAVAILABLE');
        await driver.retire();fs.writeFileSync(retiredFile,JSON.stringify({sessionId:identity.sessionId,retiredAt:Date.now()}),{flag:'wx'});retired=true;return send(200,{retired:true});
      }
      if(retired&&!['/v1/backup/begin','/v1/backup/end'].includes(route))throw fault('CHAT_DELETED');
      if(route==='/v1/backup/end'){
        if(!backupLease||body.lease!==backupLease.id)throw fault('BACKUP_LEASE_EXPIRED');
        try{if(body.commit===true)backupLease.snapshot.check();return send(200,{complete:body.commit===true});}finally{releaseBackup();}
      }
      if(backupLease)throw fault('BACKUP_RUNTIME_BUSY');
      if(route==='/v1/voice-replies/setup'||route==='/v1/voice-replies/preview'){
        if(active||cancelling||(await driver.status()).backgroundBusy)throw fault('VOICE_REPLY_BUSY');
        if(!driver.setupVoiceReplies||!driver.previewVoiceReplies)throw fault('VOICE_REPLY_UNAVAILABLE');
        return send(200,route.endsWith('/setup')?await driver.setupVoiceReplies(body):await driver.previewVoiceReplies());
      }
      if(route==='/v1/backup/begin'){
        if(active||cancelling||!driver.beginBackup)throw fault('BACKUP_RUNTIME_BUSY');
        const lease={id:randomUUID()};backupLease=lease;
        try{lease.snapshot=await driver.beginBackup(db);lease.timer=setTimeout(releaseBackup,90000);lease.timer.unref();return send(200,{lease:lease.id,directory:lease.snapshot.directory,files:lease.snapshot.files,sessionId:identity.sessionId});}catch(error){releaseBackup();throw error;}
      }
      if(route==='/v1/media-connections/test'){if(active||(await driver.status()).backgroundBusy)throw fault('MEDIA_CONFIG_BUSY');return send(200,await driver.probeMediaConnections(body));}
      if(route==='/v1/media-connections'){if(active||(await driver.status()).backgroundBusy)throw fault('MEDIA_CONFIG_BUSY');return send(200,await driver.saveMediaConnections(body));}
      const pluginAction=/^\/v1\/plugins\/(fish-notebook|media-browser|course-query)\/(settings|run|stop|preview|apply)$/.exec(route);
      if(pluginAction)return send(200,await driver.pluginAction(pluginAction[1],pluginAction[2],body));
      if(route==='/v1/deliveries/ack'){if(!Array.isArray(body.ids)||body.ids.length>20)throw fault('BRIDGE_REQUEST_INVALID');for(const id of body.ids)db.prepare('UPDATE deliveries SET ack=1 WHERE id=?').run(id);return send(200,{saved:true});}
      if(route==='/v1/transcription'){return send(200,await driver.transcription(body));}
      if(route==='/v1/archive'){
        if(!imported)throw fault('BRIDGE_IMPORT_REQUIRED');
        const records=normalizeImport(body.package),merged=new Map(imported.records.map(r=>[recordKey(r),r]));
        for(const row of records){const key=recordKey(row),old=merged.get(key);if(old&&hash(old)!==hash(row))throw fault('BRIDGE_ARCHIVE_CONFLICT');merged.set(key,row);}
        const next={...imported,records:[...merged.values()]},tmp=importedFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(next));fs.renameSync(tmp,importedFile);imported=next;return send(200,{records:merged.size});
      }
      if(route==='/v1/import/preview'||route==='/v1/import/apply'){
        const records=normalizeImport(body.package);
        if(db.prepare('SELECT 1 FROM requests LIMIT 1').get())throw fault('BRIDGE_SESSION_ALREADY_USED');
        const digest=hash([records,body.persona??'',body.memoryPolicy??null]);
        if(imported&&imported.digest!==digest)throw fault('BRIDGE_IMPORT_CONFLICT');
        const report={records:records.length,messages:records.filter(r=>r.kind==='message').length,memories:records.filter(r=>r.kind==='memory').length,digest};
        if(route.endsWith('/apply')){
          if(body.preview!==digest)throw fault('BRIDGE_PREVIEW_CHANGED');
          await driver.ensure();
          const memory=await driver.importMemory?.(records,body.memoryPolicy);
          imported={digest,records,persona:body.persona??'',memory:memory??{state:'archived'}};
          const tmp=importedFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(imported));fs.renameSync(tmp,importedFile);
          await driver.flush();
          return send(200,{...report,memory:imported.memory,sessionId:identity.sessionId});
        }
        return send(200,report);
      }
      if(route==='/v1/requests'){
        if(closed||typeof body.id!=='string'||!/^[a-zA-Z0-9_-]{1,150}$/.test(body.id)||typeof body.text!=='string'||!body.text.trim()&&!body.attachments?.length||body.text.length>32000||body.attachments!=null&&!Array.isArray(body.attachments)||body.attachments?.length>8)throw fault('BRIDGE_REQUEST_INVALID');
        if(body.persona!=null&&(typeof body.persona.text!=='string'||Buffer.byteLength(body.persona.text)>60000))throw fault('BRIDGE_REQUEST_INVALID');
        if(body.maxMessages!==undefined&&!validReplyLimit(body.maxMessages))throw fault('BRIDGE_REQUEST_INVALID');
        if(body.disabledTools!==undefined&&(!Array.isArray(body.disabledTools)||body.disabledTools.length>300||body.disabledTools.some(n=>typeof n!=='string'||!/^[-a-zA-Z0-9_.:]+$/.test(n))))throw fault('BRIDGE_REQUEST_INVALID');
        if(body.allowedTools!==undefined&&(!Array.isArray(body.allowedTools)||body.allowedTools.length>300||body.allowedTools.some(n=>typeof n!=='string'||!/^[-a-zA-Z0-9_.:]{1,150}$/.test(n))))throw fault('BRIDGE_REQUEST_INVALID');
        if(body.windowPolicy!==undefined){try{windowPolicy(body.windowPolicy);}catch{throw fault('BRIDGE_WINDOW_POLICY_INVALID');}}
        const digest=hash([body.text,body.attachments??[],body.persona??null,body.proactive===true,...(body.disabledTools?.length?[body.disabledTools]:[]),...(body.allowedTools!==undefined?[{allowedTools:body.allowedTools}]:[]),...(body.windowPolicy!==undefined?[{windowPolicy:body.windowPolicy}]:[]),...(body.maxMessages!==undefined?[{maxMessages:body.maxMessages}]:[])]),previous=db.prepare('SELECT * FROM requests WHERE id=?').get(body.id);
        if(previous){if(!previous.stop_requested&&previous.digest!==digest)throw fault('BRIDGE_REQUEST_CONFLICT');return send(200,await result(body.id));}
        if(active||cancelling)throw fault('BRIDGE_BUSY');
        db.prepare("INSERT INTO requests(id,digest,state,text) VALUES(?,?,'running',NULL)").run(body.id,digest);
        const run={id:body.id,stopped:false,dispatched:false,settled:false,controller:new AbortController()};activeRun=run;
        active=(async()=>{try{await driver.ensure();if(run.stopped)return;const prepared=await driver.prepare?.(body)??body;if(run.stopped)return;if(prepared.failure){db.prepare("UPDATE requests SET state='completed',text=? WHERE id=?").run(prepared.failure,body.id);return;}run.dispatched=true;const prompted=await driver.prompt(prepared,{signal:run.controller.signal});if(prompted?.cancelledBeforeDispatch){run.dispatched=false;return;}if(run.stopped)await driver.cancel();await driver.wait();run.settled=true;await driver.flush();if(run.stopped)return;const text=await replyText(body.id);db.prepare('UPDATE requests SET state=?,text=? WHERE id=?').run(text===null?'unknown':'completed',text,body.id);if(text!==null)driver.afterReply?.();}catch{db.prepare("UPDATE requests SET state='unknown' WHERE id=?").run(body.id);}finally{if(run.stopped)db.prepare('UPDATE requests SET state=?,text=NULL WHERE id=?').run(run.dispatched&&!run.settled?'unknown':'cancelled',body.id);activeRun=null;active=null;}})();
        return send(202,{state:'running'});
      }
      if(route==='/v1/context/compact'){if(active)throw fault('BRIDGE_BUSY');return send(200,await driver.compact());}
      if(route==='/v1/cancel'){
        if(body.requestId!==undefined){
          if(typeof body.requestId!=='string'||!/^[a-zA-Z0-9_-]{1,150}$/.test(body.requestId))throw fault('BRIDGE_REQUEST_INVALID');
          if(activeRun?.id!==body.requestId){
            // Cancellation may arrive before POST /requests on another connection.
            // Retain an exact-ID tombstone so that late acceptance cannot start it.
            db.prepare("INSERT OR IGNORE INTO requests(id,digest,state,text,stop_requested) VALUES(?,?,'cancelled',NULL,1)").run(body.requestId,hash(['stop-before-acceptance',body.requestId]));
            return send(200,{requested:false,...await result(body.requestId)});
          }
          activeRun.stopped=true;activeRun.controller.abort();db.prepare('UPDATE requests SET stop_requested=1 WHERE id=?').run(body.requestId);
        }
        if(!cancelling)cancelling=Promise.resolve().then(()=>driver.cancel()).finally(()=>{cancelling=null;});
        await cancelling;return send(200,{requested:true});
      }
      return send(404,{error:'NOT_FOUND'});
    }catch(e){fs.writeFileSync(path.join(root,'last-error.private.json'),JSON.stringify({at:new Date().toISOString(),code:e.code??null,message:e.message,stack:e.stack}));return send(e.code==='BRIDGE_BODY_TOO_LARGE'?413:409,{error:e.code??(/^(?:CHAT_|PLUGIN_|MEDIA_|MODEL_|VOICE_REPLY_|ASR_SETUP_)[A-Z_]+$/.test(e.message)?e.message:'BRIDGE_OPERATION_FAILED')});}
  });
  server.requestTimeout=15000;
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}catch(e){db.close();release();throw e;}
  let closing;return {url:'http://127.0.0.1:'+server.address().port,sessionId:identity.sessionId,close(){return closing??=(async()=>{closed=true;releaseBackup();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await cancelling?.catch(()=>{});if(active)await driver.cancel();await active;db.close();release();})();}};
}

import {randomUUID} from 'node:crypto';
import {createPeriodicProactive} from './periodic-proactive.mjs';
// One attempt per last user message. A restart may reconcile proof, never rerun.
export function createProactiveScheduler({store,backend,preferences,now,random}){
  const db=store.db;db.exec("CREATE TABLE IF NOT EXISTS proactive_runs(id TEXT PRIMARY KEY,anchor TEXT UNIQUE NOT NULL,day TEXT NOT NULL,at INTEGER NOT NULL,state TEXT NOT NULL); UPDATE proactive_runs SET state='unknown' WHERE state='running'");
  let periodic;
  const save=(row,text)=>{store.publish({deliveryId:row.id,text});db.prepare("UPDATE proactive_runs SET state='completed' WHERE id=?").run(row.id);};
  return {async tick(){
    const p=preferences.read().policy;if(!p.proactiveEnabled||!backend?.proactive)return;
    if(p.proactiveSchedule==='periodic'){periodic??=createPeriodicProactive({store,backend,preferences,now,random});return periodic.tick();}
    const anchor=db.prepare("SELECT id FROM messages WHERE role='user' ORDER BY seq DESC LIMIT 1").get();if(!anchor)return;
    const previous=db.prepare('SELECT * FROM proactive_runs WHERE anchor=?').get(anchor.id);
    if(previous){if(previous.state==='unknown'&&backend.lookupResult){const text=await backend.lookupResult({id:previous.id});if(text!==null)save(previous,text);}return;}
    const at=now(),local=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at),hour=Number(local.find(p=>p.type==='hour').value),day=local.filter(p=>['year','month','day'].includes(p.type)).map(p=>p.value).join('-');
    const minute=hour*60+Number(local.find(p=>p.type==='minute').value),start=p.quietStart*60+(p.quietStartMinute??0),end=p.quietEnd*60+(p.quietEndMinute??0);
    const quiet=start<end?minute>=start&&minute<end:start>end&&(minute>=start||minute<end);
    if(quiet)return;
    const last=db.prepare('SELECT MAX(created_at) at FROM messages').get().at,attempt=db.prepare('SELECT MAX(at) at FROM proactive_runs').get().at;
    if(at-last<p.proactiveIdleMinutes*60000||attempt!=null&&at-attempt<p.proactiveMinIntervalMinutes*60000||p.proactiveMaxPerDay>0&&db.prepare('SELECT COUNT(*) n FROM proactive_runs WHERE day=?').get(day).n>=p.proactiveMaxPerDay)return;
    const id='proactive-'+randomUUID(),row={id};db.prepare("INSERT INTO proactive_runs VALUES(?,?,?,?,'running')").run(id,anchor.id,day,at);
    try{const policy=preferences.forMode('social'),text=await backend.proactive({id,persona:policy.persona,policy});save(row,text);}catch{db.prepare("UPDATE proactive_runs SET state='unknown' WHERE id=?").run(id);}
  }};
}

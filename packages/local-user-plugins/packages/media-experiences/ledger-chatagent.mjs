import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readMediaSettings} from './settings.mjs';

export const mediaDay=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
export const mediaId=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
export function mediaLedger({root,account,key,now=Date.now,readonly=false,musicRecovery=false}){
 if(!path.isAbsolute(root)||!/^[a-f0-9]{64}$/.test(account??'')||!/^wechat:private:[1-9]\d{0,15}$/.test(key??''))throw Error('MEDIA_SCOPE_INVALID');
 const folder=path.join(root,'state','accounts',account,'media-experiences'),file=path.join(folder,mediaId(key)+'.sqlite');
 for(let p=file;;p=path.dirname(p)){try{if(fs.lstatSync(p).isSymbolicLink())throw Error('MEDIA_PATH_DENIED');}catch(e){if(e.code!=='ENOENT')throw e;}if(path.dirname(p)===p)break;}
 if(readonly&&!fs.existsSync(file))return null;
 if(!readonly)fs.mkdirSync(folder,{recursive:true});
 const db=new DatabaseSync(file,{readOnly:readonly});db.exec('PRAGMA busy_timeout=5000');
 if(!readonly)db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS rounds(id TEXT PRIMARY KEY,category TEXT NOT NULL,day TEXT NOT NULL,at INTEGER NOT NULL,deadline INTEGER NOT NULL,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,round_id TEXT NOT NULL,day TEXT NOT NULL,reserved INTEGER NOT NULL,used INTEGER,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS experiences(id TEXT PRIMARY KEY,kind TEXT NOT NULL,day TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memories(event_id TEXT PRIMARY KEY,status TEXT NOT NULL,memory_id TEXT,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS round_outcomes(round_id TEXT PRIMARY KEY,bvid TEXT,status TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',confirmed_ms INTEGER NOT NULL DEFAULT 0,feeling_recorded INTEGER NOT NULL DEFAULT 0,at INTEGER NOT NULL);
 `);
 const columns=new Set(db.prepare('PRAGMA table_info(rounds)').all().map(r=>r.name));
 if(!readonly){for(const [name,type] of [['origin',"TEXT NOT NULL DEFAULT 'autonomous'"],['charged_ms','INTEGER NOT NULL DEFAULT 0']])if(!columns.has(name)){db.exec('ALTER TABLE rounds ADD COLUMN '+name+' '+type);columns.add(name);}}
 const modern=columns.has('origin');
 const hasOutcomes=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='round_outcomes'").get();
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const usage=(day=mediaDay(now()))=>{
  const origin=modern?" AND r.origin='autonomous'":"";
  const r=db.prepare('SELECT COALESCE(SUM(COALESCE(q.used,q.reserved)),0) AS tokens,COALESCE(SUM(CASE WHEN q.used IS NULL THEN q.reserved ELSE 0 END),0) AS pending FROM requests q JOIN rounds r ON r.id=q.round_id WHERE q.day=?'+origin).get(day);
  const attempts=db.prepare('SELECT category,COUNT(*) AS count FROM rounds r WHERE day=?'+origin+' GROUP BY category').all(day);
  const outcomes=hasOutcomes?db.prepare('SELECT r.*,o.confirmed_ms,o.feeling_recorded,o.at AS outcome_at FROM rounds r LEFT JOIN round_outcomes o ON o.round_id=r.id WHERE r.day=?').all(day):[];
  const music=outcomes.filter(r=>r.category==='music'&&r.origin==='autonomous'),confirmed=music.filter(r=>r.confirmed_ms>0),pendingMusic=music.filter(r=>r.status==='active'&&r.deadline>now()&&!r.confirmed_ms).length;
  const rounds=attempts.filter(r=>r.category!=='music');if(confirmed.length)rounds.push({category:'music',count:confirmed.length});
  const start=Date.parse(day+'T00:00:00+08:00'),end=start+86400000;
  const times=modern?db.prepare("SELECT category,SUM(MAX(0,MIN(CASE WHEN status='active' THEN MIN(deadline,?) ELSE at+charged_ms END,?)-MAX(at,?))) AS milliseconds FROM rounds WHERE origin='autonomous' AND category='video' AND at<? AND deadline>=? GROUP BY category").all(now(),end,start,end,start):[];
  if(confirmed.length)times.push({category:'music',milliseconds:confirmed.reduce((n,r)=>n+r.confirmed_ms,0)});
  const invited=outcomes.filter(r=>r.category==='music'&&r.origin==='invited'&&r.confirmed_ms>0);
  // A verified manual listen proves recovery. Keep all history and daily success/time caps.
  const musicRecoveryAt=Math.max(0,...invited.map(r=>r.outcome_at));
  return {...r,rounds,times,attempts,pendingMusic,invitedMusic:invited.length,...musicRecovery?{musicRecoveryAt,musicAttemptsSinceRecovery:music.filter(r=>r.at>=musicRecoveryAt).length}:{}};
 };
 return {db,file,close:()=>db.close(),usage,
  round:id=>db.prepare('SELECT * FROM rounds WHERE id=?').get(id),
  outcome:id=>hasOutcomes?db.prepare('SELECT * FROM round_outcomes WHERE round_id=?').get(id):undefined,
  activity(day=mediaDay(now())){return db.prepare('SELECT * FROM rounds WHERE day=? ORDER BY at DESC').all(day).map(r=>({...r,...(hasOutcomes?db.prepare('SELECT bvid,status AS outcome,reason,confirmed_ms,feeling_recorded FROM round_outcomes WHERE round_id=?').get(r.id):{})}));},
  setOutcome(id,{status,bvid=null,reason=''}){if(!db.prepare('SELECT 1 FROM rounds WHERE id=?').get(id)||!['selected','listening','source_unavailable','no_observation','not_invoked','result_invalid','request_failed','no_signal','not_music','content_unverified','declined','unknown','heard','feeling_recorded'].includes(status)||bvid!==null&&!/^BV[A-Za-z0-9]{10}$/.test(bvid)||typeof reason!=='string'||reason.length>200)throw Error('MEDIA_OUTCOME_INVALID');db.prepare("INSERT INTO round_outcomes(round_id,bvid,status,reason,at) VALUES(?,?,?,?,?) ON CONFLICT(round_id) DO UPDATE SET bvid=COALESCE(excluded.bvid,round_outcomes.bvid),status=CASE WHEN round_outcomes.confirmed_ms>0 THEN round_outcomes.status ELSE excluded.status END,reason=excluded.reason,at=excluded.at").run(id,bvid,status,reason,now());},
  confirmMusic(id,seconds,bvid){const r=db.prepare('SELECT * FROM rounds WHERE id=?').get(id);if(!r||r.category!=='music'||!Number.isFinite(seconds)||seconds<=0||seconds>300||seconds*1000>r.deadline-r.at||!/^BV[A-Za-z0-9]{10}$/.test(bvid))throw Error('MEDIA_MUSIC_CONFIRMATION_INVALID');db.prepare("INSERT INTO round_outcomes(round_id,bvid,status,confirmed_ms,at) VALUES(?,?,'heard',?,?) ON CONFLICT(round_id) DO UPDATE SET bvid=excluded.bvid,status=CASE WHEN round_outcomes.feeling_recorded=1 THEN 'feeling_recorded' ELSE 'heard' END,confirmed_ms=MAX(round_outcomes.confirmed_ms,excluded.confirmed_ms),at=excluded.at").run(id,bvid,Math.ceil(seconds*1000),now());},
  markFeeling(id){db.prepare("UPDATE round_outcomes SET feeling_recorded=1,status='feeling_recorded',at=? WHERE round_id=? AND confirmed_ms>0").run(now(),id);},
  seedVideoHistory(days){transaction(()=>{if(db.prepare('SELECT 1 FROM migrations WHERE name=?').get('legacy-video-v1'))return;for(const [day,value] of Object.entries(days??{})){if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isSafeInteger(value.count)||value.count<0||value.count>3)throw Error('MEDIA_LEGACY_BUDGET_INVALID');for(let i=0;i<value.count;i++){const id='legacy-video-'+day+'-'+i,at=Date.parse(day+'T00:00:00+08:00');const inserted=db.prepare("INSERT OR IGNORE INTO rounds(id,category,day,at,deadline,status) VALUES(?,'video',?,?,?,'historical')").run(id,day,at,at);if(inserted.changes)db.prepare("INSERT INTO requests VALUES(?,?,?,?,NULL,'historical_unmetered')").run(id,id,day,100000);}}db.prepare('INSERT INTO migrations VALUES(?,?)').run('legacy-video-v1',now());});},
  reserveRound(category,id,{limit,at=now(),duration=1200000,seed=0,origin='autonomous'}={}){
   if(!['video','music'].includes(category)||!['autonomous','invited'].includes(origin)||typeof id!=='string'||!id||id.length>200||!Number.isSafeInteger(at)||!Number.isSafeInteger(duration)||duration<1)throw Error('MEDIA_ROUND_INVALID');
   return transaction(()=>{const old=db.prepare('SELECT * FROM rounds WHERE id=?').get(id);if(old){if(old.category!==category||old.origin!==origin)throw Error('MEDIA_ROUND_CONFLICT');return old;}
    const day=mediaDay(at),settings=readMediaSettings(root)[category],used=usage(day),count=used.rounds.find(r=>r.category===category)?.count??0;
    if(origin==='autonomous'){
     if(!settings.enabled||Math.max(count,seed)+(category==='music'?used.pendingMusic:0)>=(limit??settings.dailyRounds))throw Error('MEDIA_DAILY_LIMIT');
     if(category==='music'&&(used.musicAttemptsSinceRecovery??used.attempts.find(r=>r.category==='music')?.count??0)>=Math.max(10,settings.dailyRounds*2))throw Error('MEDIA_DAILY_ATTEMPT_LIMIT');
     const remaining=settings.dailyMinutes*60000-(used.times.find(t=>t.category===category)?.milliseconds??0);
     if(remaining<=0)throw Error('MEDIA_DAILY_TIME_LIMIT');duration=Math.min(duration,remaining);
    }
    db.prepare("INSERT INTO rounds(id,category,day,at,deadline,status,origin) VALUES(?,?,?,?,?,'active',?)").run(id,category,day,at,at+duration,origin);
    return db.prepare('SELECT * FROM rounds WHERE id=?').get(id);
   });
  },
  finishRound(id,status='finished'){db.prepare("UPDATE rounds SET status=?,charged_ms=CASE WHEN category='video' AND status='active' THEN MAX(charged_ms,MAX(0,MIN(deadline,?)-at)) ELSE charged_ms END WHERE id=?").run(status,now(),id);},
  chargeMusic(id,seconds){if(!Number.isFinite(seconds)||seconds<0||seconds>300)throw Error('MEDIA_MUSIC_TIME_INVALID');const r=db.prepare('SELECT * FROM rounds WHERE id=?').get(id);if(!r||r.category!=='music'||seconds*1000>r.deadline-r.at)throw Error('MEDIA_MUSIC_TIME_LIMIT');db.prepare('UPDATE rounds SET charged_ms=MAX(charged_ms,?) WHERE id=?').run(Math.ceil(seconds*1000),id);},
  reserveRequest(id,roundId,reserved=100000){if(!Number.isSafeInteger(reserved)||reserved<1)throw Error('MEDIA_RESERVATION_INVALID');return transaction(()=>{const old=db.prepare('SELECT * FROM requests WHERE id=?').get(id);if(old)return old;const round=db.prepare('SELECT * FROM rounds WHERE id=?').get(roundId);if(!round||round.category!=='video'||round.status!=='active'||now()>=round.deadline)throw Error('MEDIA_ROUND_CLOSED');const day=mediaDay(now());if(round.origin==='autonomous'&&usage(day).tokens+reserved>readMediaSettings(root).video.tokenLimit)throw Error('MEDIA_TOKEN_LIMIT');db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(id,roundId,day,reserved,null,'reserved');return {id,roundId,reserved};});},
  settleRequest(id,tokens){if(!Number.isSafeInteger(tokens)||tokens<0)throw Error('MEDIA_USAGE_INVALID');db.prepare("UPDATE requests SET used=?,status='settled' WHERE id=? AND used IS NULL").run(tokens,id);},
  addExperience(entry){if(!entry||!['video','music'].includes(entry.kind)||typeof entry.id!=='string'||entry.id.length>200||!/^BV[A-Za-z0-9]{10}$/.test(entry.bvid??'')||!Number.isFinite(Date.parse(entry.at))||typeof entry.feeling!=='string'||entry.feeling.length>1000||(entry.title!==undefined&&(typeof entry.title!=='string'||entry.title.length>200))||(entry.frameCount!==undefined&&(!Number.isSafeInteger(entry.frameCount)||entry.frameCount<1||entry.frameCount>1200))||![entry.start,entry.end].every(v=>v===undefined||Number.isFinite(v)&&v>=0&&v<=86401)||(entry.start!==undefined&&entry.end!==undefined&&entry.end<entry.start))throw Error('MEDIA_EXPERIENCE_INVALID');const bytes=JSON.stringify(entry);if(bytes.length>24000)throw Error('MEDIA_EXPERIENCE_TOO_LARGE');const old=db.prepare('SELECT data FROM experiences WHERE id=?').get(entry.id);if(old){if(old.data!==bytes)throw Error('MEDIA_EXPERIENCE_CONFLICT');return;}db.prepare('INSERT INTO experiences VALUES(?,?,?,?,?)').run(entry.id,entry.kind,mediaDay(entry.at),entry.at,bytes);},
  setFeeling(id,feeling){if(typeof feeling!=='string'||feeling.length>1000)throw Error('MEDIA_FEELING_INVALID');return transaction(()=>{const row=db.prepare('SELECT data FROM experiences WHERE id=?').get(id);if(!row)throw Error('MEDIA_EXPERIENCE_MISSING');const entry=JSON.parse(row.data);if(entry.feeling&&entry.feeling!==feeling)throw Error('MEDIA_FEELING_CONFLICT');entry.feeling=feeling;db.prepare('UPDATE experiences SET data=? WHERE id=?').run(JSON.stringify(entry),id);});},
  experiences(kind,day){return db.prepare('SELECT data FROM experiences WHERE (? IS NULL OR kind=?) AND (? IS NULL OR day=?) ORDER BY at DESC LIMIT 5000').all(kind??null,kind??null,day??null,day??null).map(r=>({...JSON.parse(r.data),memory:db.prepare('SELECT status,memory_id AS memoryId FROM memories WHERE event_id=?').get(JSON.parse(r.data).id)??{status:'not_recorded'}}));},
  markMemory(eventId,status,memoryId=null){if(!['verified','unconfirmed','not_selected'].includes(status))throw Error('MEDIA_MEMORY_INVALID');if(status==='verified'&&(typeof memoryId!=='string'||!memoryId))throw Error('MEDIA_MEMORY_ID_REQUIRED');db.prepare("INSERT INTO memories VALUES(?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET status=excluded.status,memory_id=excluded.memory_id,at=excluded.at WHERE memories.status!='verified' OR excluded.status='verified'").run(eventId,status,memoryId,new Date(now()).toISOString());},
 };
}

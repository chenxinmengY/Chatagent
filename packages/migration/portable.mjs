import { createHash } from 'node:crypto';
import { fault } from '../conversation/store.mjs';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const string = (v, max = 32000) => typeof v === 'string' && v.length <= max && !v.includes('\0');
const time = v => { if(v == null || v === '')return null; const n = typeof v === 'number' ? v : Date.parse(v); if(!Number.isSafeInteger(n) || n < 0)throw fault('IMPORT_TIME_INVALID',400); return n; };
export function normalizeImport(input) {
  if (!input || !['chatagent-portable-v1','wechatagent-history-v1','astrbot-openai-v1','astrbot-export-v1'].includes(input.format) || !string(input.sourceId,100) || !input.sourceId || !string(input.scope,200) || !input.scope) throw fault('IMPORT_SOURCE_REQUIRED',400);
  if(input.format==='astrbot-export-v1') {
    if(!Array.isArray(input.conversations) || input.conversations.length!==1)throw fault('IMPORT_SELECT_ONE_CONVERSATION',400);
    const conv=input.conversations[0];
    if(!conv||typeof conv.cid!=='string'||typeof conv.user_id!=='string'||!Array.isArray(conv.content)||conv.content.length>50000)throw fault('IMPORT_ASTRBOT_INVALID',400);
    return conv.content.map((row,index)=>{
      const text=typeof row.content==='string'?row.content:JSON.stringify(row.content??row);
      return validateRecord({sourceId:input.sourceId,scope:conv.user_id+'/'+conv.cid,id:String(index),kind:['user','assistant'].includes(row.role)?'message':'context',role:row.role,text,at:time(row.timestamp),mode:input.mode??'social',attachments:[],metadata:{original:row,conversation:{cid:conv.cid,user_id:conv.user_id,platform_id:conv.platform_id,title:conv.title,persona_id:conv.persona_id,created_at:conv.created_at,updated_at:conv.updated_at}}});
    });
  }
  if(input.format === 'chatagent-portable-v1') {
    if (!Array.isArray(input.records) || input.records.length > 50000 || input.digest !== hash(input.records))throw fault('IMPORT_DIGEST_INVALID',400);
    return input.records.map(validateRecord);
  }
  if(!Array.isArray(input.messages) || input.messages.length > 50000)throw fault('IMPORT_MESSAGES_INVALID',400);
  return input.messages.map((row,index) => {
    const body = input.format === 'wechatagent-history-v1' ? (typeof row.body === 'string' ? JSON.parse(row.body) : row.body ?? row) : row;
    const role = input.format === 'wechatagent-history-v1' ? (body.outgoing === true ? 'assistant' : body.outgoing === false ? 'user' : null) : body.role;
    if(!['user','assistant'].includes(role))throw fault('IMPORT_ROLE_UNSUPPORTED',400);
    const text = body.text ?? body.content;
    if(!string(text))throw fault('IMPORT_CONTENT_UNSUPPORTED',400);
    const at = input.format === 'wechatagent-history-v1' ? (row.at == null ? null : time(Number(row.at) * 1000)) : time(row.timestamp);
    return validateRecord({ sourceId: input.sourceId, scope: input.scope, id: String(row.id ?? row.seq ?? index), kind:'message', text, role, at, mode: input.mode ?? 'social', attachments: [], metadata: { sourceFormat: input.format, original: row } });
  });
}
export function validateRecord(row) {
  if(!row || !string(row.sourceId,100) || !row.sourceId || !string(row.scope,200) || !row.scope || !string(row.id,200) || !row.id || !['message','memory','diary','persona','context'].includes(row.kind) || !string(row.text,60000) || !['social','assistant'].includes(row.mode ?? 'social') || row.kind === 'message' && !['user','assistant'].includes(row.role) || row.attachments != null && !Array.isArray(row.attachments))throw fault('IMPORT_RECORD_INVALID',400);
  if(row.attachments?.some(f => !f || !string(f.name,255) || !/^[a-f0-9]{64}$/.test(f.sha256 ?? '') || !Number.isSafeInteger(f.bytes) || f.bytes<0 || !string(f.mediaType,200)))throw fault('IMPORT_ATTACHMENT_INVALID',400);
  return { ...row, at: time(row.at), mode: row.mode ?? 'social', attachments: row.attachments ?? [] };
}
export const recordKey = row => hash([row.sourceId,row.scope,row.kind,row.id]);
export class PortableArchive {
  constructor(store) {
    this.store = store;
    store.db.exec('CREATE TABLE IF NOT EXISTS portable_records(key TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS portable_imports(id TEXT PRIMARY KEY,report TEXT NOT NULL)');
  }
  records() { return this.store.db.prepare('SELECT body FROM portable_records ORDER BY key').all().map(r=>JSON.parse(r.body)); }
  preview(input) {
    const records=normalizeImport(input), seen=new Map(); let duplicates=0,conflicts=0;
    for(const row of records) {
      const key=recordKey(row), old=seen.get(key) ?? this.store.db.prepare('SELECT body FROM portable_records WHERE key=?').get(key)?.body, body=JSON.stringify(row);
      if(old) { if(hash(JSON.parse(old))===hash(row))duplicates++; else conflicts++; } else seen.set(key,body);
    }
    return { records, report: { total:records.length, added:seen.size, duplicates, conflicts, unknownTimes:records.filter(r=>r.at===null).length, missingAttachments:records.reduce((n,r)=>n+r.attachments.length,0), scopes:[...new Set(records.map(r=>r.scope))], byKind:Object.fromEntries(['message','memory','diary','persona','context'].map(k=>[k,records.filter(r=>r.kind===k).length])) } };
  }
  apply(input, expected) {
    return this.store.transaction(()=>{
      const result=this.preview(input);
      if(hash([result.report,result.records])!==expected)throw fault('IMPORT_PREVIEW_CHANGED');
      if(result.report.conflicts)throw fault('IMPORT_CONFLICT');
      for(const row of result.records)this.store.db.prepare('INSERT OR IGNORE INTO portable_records VALUES(?,?)').run(recordKey(row),JSON.stringify(row));
      const id=hash(result.records); this.store.db.prepare('INSERT OR REPLACE INTO portable_imports VALUES(?,?)').run(id,JSON.stringify(result.report));
      return {id,...result.report};
    });
  }
  export(extra=[]) {
    const unique=new Map();
    for(const r of [...this.records(),...extra].map(validateRecord)){
      const key=recordKey(r),old=unique.get(key);
      if(old&&hash(old)!==hash(r))throw fault('EXPORT_IDENTITY_CONFLICT');
      unique.set(key,r);
    }
    const records=[...unique.values()];
    return {format:'chatagent-portable-v1',sourceId:'chatagent',scope:'export',exportedAt:new Date().toISOString(),records,digest:hash(records),mediaIncluded:false};
  }
}

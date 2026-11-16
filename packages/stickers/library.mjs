import {searchRows} from './vendor/search.mjs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const imageTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);
const fail=code=>{throw Object.assign(Error(code),{status:400});};
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\x00-\x1f]/.test(value);
export const attachmentRef=file=>({id:file.id,name:file.name,bytes:file.bytes,sha256:file.sha256,mediaType:file.media_type});

// Shared library lives in the main chat database and attachment store, so the
// existing complete backup preserves both the index and original animated files.
export class StickerLibrary{
  constructor(db,attachments){
    this.db=db;this.attachments=attachments;
    db.exec(`CREATE TABLE IF NOT EXISTS sticker_library(id TEXT PRIMARY KEY,sha256 TEXT UNIQUE NOT NULL,caption TEXT NOT NULL DEFAULT '',keywords TEXT NOT NULL DEFAULT '',tag TEXT NOT NULL DEFAULT '',source TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sticker_collections(session_id TEXT NOT NULL,sticker_id TEXT NOT NULL,PRIMARY KEY(session_id,sticker_id));`);
  }
  rows(){return this.db.prepare('SELECT * FROM sticker_library ORDER BY created_at DESC,id').all().map(row=>{const file=this.attachments.get(row.id);return {...row,...attachmentRef(file)};});}
  find({query='',offset=0,limit=80}={}){
    if(!text(query,200)||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>120)fail('STICKER_QUERY_INVALID');
    const all=this.rows(),matches=query.trim()?searchRows(all,query,all.length):all;
    return {stickers:matches.slice(offset,offset+limit),total:matches.length,totalAll:all.length,nextOffset:offset+limit,hasMore:offset+limit<matches.length};
  }
  get(id){const row=this.db.prepare('SELECT * FROM sticker_library WHERE id=?').get(id);if(!row)throw Object.assign(Error('STICKER_NOT_FOUND'),{status:404});return {...row,...attachmentRef(this.attachments.verify(id))};}
  byHash(hash){const row=this.db.prepare('SELECT id FROM sticker_library WHERE sha256=?').get(hash);return row?this.get(row.id):null;}
  metadata(hash){const row=this.db.prepare('SELECT id,caption,tag FROM sticker_library WHERE sha256=?').get(hash);return row?{stickerId:row.id,caption:row.caption,tag:row.tag}:{};}
  add(file,{caption='',keywords='',tag='',source='import'}={}){
    if(!imageTypes.has(file.media_type))fail('STICKER_IMAGE_REQUIRED');
    if(!text(caption,500)||!text(keywords,1000)||!text(tag,100)||!text(source,80))fail('STICKER_METADATA_INVALID');
    const old=this.byHash(file.sha256);if(old)return old;
    // A file from a different chat is copied into the shared library first.
    let shared;try{shared=this.attachments.verify(file.id);if(shared.sha256!==file.sha256)fail('STICKER_ATTACHMENT_CHANGED');}catch(error){if(error.message!=='ATTACHMENT_NOT_FOUND')throw error;shared=this.attachments.importFile(file.file,file.name);}
    this.db.prepare('INSERT OR IGNORE INTO sticker_library(id,sha256,caption,keywords,tag,source,created_at) VALUES(?,?,?,?,?,?,?)').run(shared.id,shared.sha256,caption.trim(),keywords.trim(),tag.trim(),source,Date.now());
    return this.byHash(shared.sha256);
  }
  importFile(file,metadata){const hash=createHash('sha256').update(fs.readFileSync(file)).digest('hex'),old=this.byHash(hash);return old??this.add(this.attachments.verify(this.attachments.importFile(file).id),metadata);}
  update(id,{caption,keywords='',tag=''}){
    if(!text(caption,500)||!caption.trim()||!text(keywords,1000)||!text(tag,100))fail('STICKER_METADATA_INVALID');
    this.get(id);this.db.prepare('UPDATE sticker_library SET caption=?,keywords=?,tag=? WHERE id=?').run(caption.trim(),keywords.trim(),tag.trim(),id);return this.get(id);
  }
  collect(sessionId,id){this.get(id);this.db.prepare('INSERT OR IGNORE INTO sticker_collections VALUES(?,?)').run(sessionId,id);}
  use(id,attachments){
    const sticker=this.get(id),file=this.attachments.verify(id);
    if(attachments.root===this.attachments.root)return {...attachmentRef(file),sticker};
    const existing=attachments.db.prepare("SELECT id FROM attachments WHERE state='ready' AND sha256=? ORDER BY rowid LIMIT 1").get(file.sha256);
    const local=existing?attachments.verify(existing.id):attachments.verify(attachments.importFile(file.file,file.name).id);
    return {...attachmentRef(local),sticker};
  }
}

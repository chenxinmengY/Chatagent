import {fault} from './store.mjs';
export class SessionTools {
 constructor(store){this.store=store;}
 read(sessionId){const row=this.store.db.prepare('SELECT value FROM settings WHERE key=?').get('session-tools:'+sessionId);return row?JSON.parse(row.value):{sessionId,revision:0,allowedTools:[]};}
 save(value,transactional=true){if(typeof value?.sessionId!=='string'||!value.sessionId||!Array.isArray(value.allowedTools)||value.allowedTools.length>300||value.allowedTools.some(n=>typeof n!=='string'||!/^[-a-zA-Z0-9_.:]{1,150}$/.test(n)))throw fault('INVALID_CHAT_POLICY',400);return (transactional?fn=>this.store.transaction(fn):fn=>fn())(()=>{const old=this.read(value.sessionId);if(value.revision!==old.revision)throw fault('PREFERENCES_CHANGED',409);const next={sessionId:value.sessionId,revision:old.revision+1,allowedTools:[...new Set(value.allowedTools)]};this.store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('session-tools:'+value.sessionId,JSON.stringify(next));return next;});}
}

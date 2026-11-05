import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { recoveryAction } from './recovery.mjs';
import { splitReply } from './preferences.mjs';

export function fault(code, status = 409) { return Object.assign(new Error(code), { status }); }
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const APPLICATION_ID = 0x43414348;

export class ChatStore {
  constructor(file, { now = Date.now } = {}) {
    if (!path.isAbsolute(file) || fs.realpathSync(path.dirname(file)).toLowerCase() !== path.dirname(file).toLowerCase()) throw fault('ISOLATED_PATH_REQUIRED');
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix) && fs.lstatSync(file + suffix).isSymbolicLink()) throw fault('DATABASE_LINK_REFUSED');
    if (fs.existsSync(file)) {
      const probe = new DatabaseSync(file, { readOnly: true });
      try { if (probe.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID) throw fault('FOREIGN_DATABASE_REFUSED'); }
      finally { probe.close(); }
    } else fs.closeSync(fs.openSync(file, 'wx'));
    this.file = file; this.now = now;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES('mode','social');
      INSERT OR IGNORE INTO settings VALUES('mode_revision','0');
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
        device TEXT,client_id TEXT,role TEXT NOT NULL,text TEXT NOT NULL,mode TEXT NOT NULL,
        queued_at INTEGER NOT NULL,created_at INTEGER NOT NULL,confirmed_at INTEGER,state TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,parent TEXT UNIQUE,UNIQUE(device,client_id));
      CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reply_runs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reply_parts(id TEXT PRIMARY KEY,parent TEXT NOT NULL,part INTEGER NOT NULL,text TEXT NOT NULL,mode TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL,UNIQUE(parent,part));`);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name='attachments'").get()) this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    this.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('sync_epoch',?)").run(randomUUID());
    this.epoch = this.db.prepare("SELECT value FROM settings WHERE key='sync_epoch'").get().value;
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  mode() { return this.db.prepare("SELECT value FROM settings WHERE key='mode'").get().value; }
  modeRevision() { return Number(this.db.prepare("SELECT value FROM settings WHERE key='mode_revision'").get().value); }
  setMode(mode) {
    if (!['social', 'assistant'].includes(mode)) throw fault('INVALID_MODE', 400);
    return this.transaction(() => {
      if (this.mode() !== mode) {
        this.db.prepare("UPDATE settings SET value=? WHERE key='mode'").run(mode);
        this.db.prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='mode_revision'").run();
      }
      return mode;
    });
  }
  hydrate(row) { return row ? { ...row, attachments: typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments ?? [] } : row; }
  message(id) { return this.hydrate(this.db.prepare('SELECT * FROM messages WHERE id=?').get(id)); }
  lookup(device, clientId) { return this.hydrate(this.db.prepare('SELECT * FROM messages WHERE device=? AND client_id=?').get(device, clientId)) ?? null; }
  event(message) { this.db.prepare('INSERT INTO changes(body) VALUES(?)').run(JSON.stringify(message)); }
  // 插件主动消息沿用同一持久档案和同步流；保存不代表手机已收到或已读。
  publish({ deliveryId, text, mode = 'social', attachments = [] }) {
    if (!validId(deliveryId) || typeof text !== 'string' || !text.trim() || text.length > 32000 || !['social', 'assistant'].includes(mode)) throw fault('INVALID_PLUGIN_DELIVERY', 400);
    if (!Array.isArray(attachments) || attachments.length > 8 || new Set(attachments.map(f => f?.id)).size !== attachments.length || attachments.some(f => !f || !/^[a-f0-9-]{36}$/.test(f.id ?? '') || typeof f.name !== 'string' || !f.name.trim() || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || !/^[a-f0-9]{64}$/.test(f.sha256 ?? '') || typeof f.mediaType !== 'string')) throw fault('INVALID_ATTACHMENTS', 400);
    attachments = attachments.map(({ id, name, bytes, sha256, mediaType }) => ({ id, name, bytes, sha256, mediaType }));
    return this.transaction(() => {
      const old = this.lookup('plugin-delivery', deliveryId);
      if (old) { if (old.text !== text || old.mode !== mode || JSON.stringify(old.attachments) !== JSON.stringify(attachments)) throw fault('PLUGIN_DELIVERY_ID_REUSED'); return old; }
      const id = randomUUID(), now = this.now();
      this.db.prepare("INSERT INTO messages(id,device,client_id,role,text,mode,queued_at,created_at,state,attachments) VALUES(?,'plugin-delivery',?,'assistant',?,?,?,?,'completed',?)").run(id, deliveryId, text, mode, now, now, JSON.stringify(attachments));
      const message = this.message(id); this.event(message); return message;
    });
  }
  update(id, state, confirmedAt = null) {
    this.db.prepare('UPDATE messages SET state=?,revision=revision+1,confirmed_at=COALESCE(?,confirmed_at) WHERE id=?').run(state, confirmedAt, id);
    const message = this.message(id); this.event(message); return message;
  }
  submit({ deviceId, clientMessageId, text, queuedAt, expectedMode, expectedModeRevision, attachments = [] }) {
    if (!Array.isArray(attachments) || attachments.length > 8 || new Set(attachments.map(file => file?.id)).size !== attachments.length || attachments.some(file =>
      !file || !/^[a-f0-9-]{36}$/.test(file.id ?? '') || typeof file.name !== 'string' || !file.name.trim() || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || typeof file.mediaType !== 'string')) throw fault('INVALID_ATTACHMENTS', 400);
    attachments = attachments.map(({ id, name, bytes, sha256, mediaType }) => ({ id, name, bytes, sha256, mediaType }));
    if (!validId(deviceId) || !validId(clientMessageId) || typeof text !== 'string' || (!text.trim() && !attachments.length) || text.length > 32000 ||
      !Number.isSafeInteger(queuedAt) || queuedAt < 0 || queuedAt > this.now() + 60000) throw fault('INVALID_MESSAGE', 400);
    return this.transaction(() => {
      const old = this.lookup(deviceId, clientMessageId);
      if (old) {
        if (old.text !== text || old.queued_at !== queuedAt || JSON.stringify(old.attachments) !== JSON.stringify(attachments)) throw fault('MESSAGE_ID_REUSED');
        return old;
      }
      if (expectedMode !== undefined || expectedModeRevision !== undefined) {
        if (!['social', 'assistant'].includes(expectedMode) || !Number.isSafeInteger(expectedModeRevision) || expectedModeRevision < 0) throw fault('INVALID_MODE_EXPECTATION', 400);
        if (expectedMode !== this.mode() || expectedModeRevision !== this.modeRevision()) throw fault('MODE_CHANGED');
      }
      const id = randomUUID(), now = this.now();
      const action = recoveryAction({ state: 'queued', queuedAt: Math.min(now, queuedAt), now });
      const state = action === 'resume_same_id' ? 'queued' : 'awaiting_confirmation';
      this.db.prepare(`INSERT INTO messages(id,device,client_id,role,text,mode,queued_at,created_at,state,attachments)
        VALUES(?,?,?,'user',?,?,?,?,?,?)`).run(id, deviceId, clientMessageId, text, this.mode(), queuedAt, now, state, JSON.stringify(attachments));
      const result = this.message(id); this.event(result); return result;
    });
  }
  decide(id, revision, action) {
    if (!['confirm', 'cancel'].includes(action) || !Number.isSafeInteger(revision)) throw fault('INVALID_DECISION', 400);
    return this.transaction(() => {
      const message = this.message(id);
      if (!message || message.role !== 'user') throw fault('MESSAGE_NOT_FOUND', 404);
      if (message.revision !== revision || !['queued', 'awaiting_confirmation'].includes(message.state)) throw fault('MESSAGE_STATE_CHANGED');
      return this.update(id, action === 'cancel' ? 'cancelled' : 'queued', action === 'confirm' ? this.now() : null);
    });
  }
  workRequest(row) {
    if (!row) return null;
    const run = this.db.prepare('SELECT body FROM reply_runs WHERE id=?').get(row.id);
    return run ? { ...row, ...JSON.parse(run.body) } : row;
  }
  claim({ allowAttachments = false, policy = null, mode = null } = {}) {
    return this.transaction(() => {
      const first = this.db.prepare("SELECT * FROM messages WHERE role='user' AND (? IS NULL OR mode=?) AND state IN ('queued','awaiting_confirmation','running','unknown') ORDER BY seq LIMIT 1").get(mode,mode);
      if (!first || first.state !== 'queued') return null;
      if (!allowAttachments && JSON.parse(first.attachments).length) return null;
      // Preserve the original client timestamp for idempotency, but cap an
      // accepted fast device clock at server receipt time for aging decisions.
      const action = recoveryAction({ state: first.state, queuedAt: Math.min(first.queued_at, first.created_at), confirmedAt: first.confirmed_at ?? undefined, now: this.now() });
      if (action !== 'resume_same_id') { this.update(first.id, 'awaiting_confirmation'); return null; }
      if (!policy) return this.update(first.id, 'running');
      const lastReply = this.db.prepare("SELECT MAX(created_at) at FROM messages WHERE role='assistant'").get().at ?? 0;
      if (this.now() - lastReply < policy.minIntervalMs || this.db.prepare("SELECT 1 FROM reply_parts WHERE state='queued' LIMIT 1").get()) return null;
      const members = [this.hydrate(first)]; let text = first.text;
      if (policy.mergeMs > 0 && !JSON.parse(first.attachments).length) {
        for (const row of this.db.prepare("SELECT * FROM messages WHERE role='user' AND seq>? AND state IN ('queued','awaiting_confirmation','running','unknown') ORDER BY seq").all(first.seq)) {
          if (row.state !== 'queued' || row.mode !== first.mode || row.device !== first.device || JSON.parse(row.attachments).length || row.created_at - members.at(-1).created_at > policy.mergeMs || text.length + row.text.length + 2 > 32000) break;
          if (recoveryAction({ state: row.state, queuedAt: Math.min(row.queued_at, row.created_at), confirmedAt: row.confirmed_at ?? undefined, now: this.now() }) !== 'resume_same_id') break;
          members.push(this.hydrate(row)); text += '\n\n' + row.text;
        }
        if (this.now() - members.at(-1).created_at < policy.mergeMs) return null;
      }
      const run = { text, memberIds: members.map(m => m.id), policy, persona: policy.persona, maxMessages: policy.maxMessages, splitCancelVersion: this.db.prepare("SELECT value FROM settings WHERE key='split_cancel_version'").get()?.value ?? '0' };
      this.db.prepare('INSERT INTO reply_runs VALUES(?,?)').run(first.id, JSON.stringify(run));
      for (const member of members) this.update(member.id, 'running');
      return this.workRequest(this.message(first.id));
    });
  }
  expire() {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM messages WHERE state='queued'").all()) {
        if (recoveryAction({ state: row.state, queuedAt: Math.min(row.queued_at, row.created_at), confirmedAt: row.confirmed_at ?? undefined, now: this.now() }) !== 'resume_same_id') this.update(row.id, 'awaiting_confirmation');
      }
    });
  }
  complete(id, text, recoveredRevision = null) {
    if (typeof text !== 'string' || !text.trim() || text.length > 128000) throw fault('INVALID_BACKEND_REPLY');
    return this.transaction(() => {
      const request = this.message(id);
      if (!request || (recoveredRevision === null ? request.state !== 'running' : request.state !== 'unknown' || request.revision !== recoveredRevision)) throw fault('RUN_NOT_ACTIVE');
      const run = this.workRequest(request), parts = splitReply(text, run.policy?.maxMessages ?? 1);
      const replyId = randomUUID();
      this.db.prepare(`INSERT INTO messages(id,role,text,mode,queued_at,created_at,state,parent)
        VALUES(?,'assistant',?,?,?,?,'completed',?)`).run(replyId, parts[0], request.mode, this.now(), this.now(), id);
      const splitCancelled = run.splitCancelVersion !== undefined && run.splitCancelVersion !== (this.db.prepare("SELECT value FROM settings WHERE key='split_cancel_version'").get()?.value ?? '0');
      for (let i = 1; i < parts.length; i++) this.db.prepare('INSERT INTO reply_parts VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, i, parts[i], request.mode, this.now() + i * Math.max(1, run.policy?.minIntervalMs ?? 1000), splitCancelled ? 'cancelled' : 'queued');
      for (const member of run.memberIds ?? [id]) this.update(member, 'completed');
      const reply = this.message(replyId); this.event(reply); return reply;
    });
  }
  unknown(id) { return this.transaction(() => { for (const member of this.workRequest(this.message(id))?.memberIds ?? [id]) if (this.message(member)?.state === 'running') this.update(member, 'unknown'); }); }
  flushReplyParts() {
    return this.transaction(() => {
      const part = this.db.prepare("SELECT * FROM reply_parts WHERE state='queued' ORDER BY due_at,part LIMIT 1").get();
      if (!part || part.due_at > this.now()) return null;
      const request = this.workRequest(this.message(part.parent)), interval = request?.policy?.minIntervalMs ?? 1000;
      const last = this.db.prepare("SELECT MAX(created_at) at FROM messages WHERE role='assistant'").get().at ?? 0;
      if (this.now() - last < interval) return null;
      const at = this.now();
      this.db.prepare("INSERT INTO messages(id,device,client_id,role,text,mode,queued_at,created_at,state) VALUES(?,'reply-part',?,'assistant',?,?,?,?,'completed')").run(part.id, part.id, part.text, part.mode, at, at);
      this.db.prepare("UPDATE reply_parts SET state='completed' WHERE id=?").run(part.id);
      const message = this.message(part.id); this.event(message); return message;
    });
  }
  stopReplyParts(inTransaction = false) { const stop = () => {
    this.db.prepare("INSERT INTO settings VALUES('split_cancel_version','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
    return this.db.prepare("UPDATE reply_parts SET state='cancelled' WHERE state='queued'").run().changes;
  }; return inTransaction ? stop() : this.transaction(stop); }
  stopSplittingCommand(id) { return this.transaction(() => {
    const request = this.message(id); if (!request || request.state !== 'queued' || request.text.trim() !== '停止分段') throw fault('RUN_NOT_ACTIVE');
    const cancelled = this.stopReplyParts(true), replyId = randomUUID(), at = this.now();
    this.db.prepare("INSERT INTO messages(id,role,text,mode,queued_at,created_at,state,parent) VALUES(?,'assistant',?,?,?,?,'completed',?)").run(replyId, `已停止 ${cancelled} 条尚未发送的分段。正在处理的对话任务不会被中断。`, request.mode, at, at, id);
    this.update(id, 'completed'); const reply = this.message(replyId); this.event(reply); return reply;
  }); }
  recoverInterrupted() { this.transaction(() => { for (const row of this.db.prepare("SELECT id FROM messages WHERE state='running'").all()) this.update(row.id, 'unknown'); }); }
  recoverRestoredWork() {
    // 快照之后可能已执行过这些请求；快照内的 queued 不能证明现在仍未执行。
    this.transaction(() => {
      // A restored snapshot cannot prove whether later parts were already sent.
      this.db.prepare("UPDATE reply_parts SET state='cancelled' WHERE state='queued'").run();
      for (const row of this.db.prepare("SELECT id FROM messages WHERE state IN ('queued','awaiting_confirmation','running')").all()) this.update(row.id, 'unknown');
    });
  }
  resetEpochAfterRestore() { this.epoch = randomUUID(); this.db.prepare("UPDATE settings SET value=? WHERE key='sync_epoch'").run(this.epoch); }
  sync(epoch, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw fault('INVALID_CURSOR', 400);
    return this.transaction(() => {
      const max = this.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM changes').get().n;
      const mode = { mode: this.mode(), modeRevision: this.modeRevision() };
      if (epoch !== this.epoch || after > max) {
        const recent = this.db.prepare('SELECT * FROM messages ORDER BY seq DESC LIMIT 200').all();
        return { reset: true, epoch: this.epoch, cursor: max, ...mode,
          historyBefore: recent.at(-1)?.seq ?? 1, cacheSince: Math.max(0, this.now() - 30 * 86400000),
          messages: this.db.prepare(`SELECT * FROM messages WHERE seq IN (SELECT seq FROM messages ORDER BY seq DESC LIMIT 200)
            OR state IN ('queued','awaiting_confirmation','running','unknown') ORDER BY seq`).all().map(row => this.hydrate(row)), hasMore: false };
      }
      const events = this.db.prepare('SELECT seq,body FROM changes WHERE seq>? ORDER BY seq LIMIT 200').all(after);
      const cursor = events.at(-1)?.seq ?? after;
      return { reset: false, epoch: this.epoch, cursor, ...mode, messages: events.map(row => this.hydrate(JSON.parse(row.body))), hasMore: cursor < max };
    });
  }
  cachePage(epoch, before, since) {
    if (epoch !== this.epoch) throw fault('ARCHIVE_CHANGED');
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(since) || since < 0) throw fault('INVALID_CURSOR', 400);
    const rows = this.db.prepare('SELECT * FROM messages WHERE seq<? AND created_at>=? ORDER BY seq DESC LIMIT 201').all(before, since);
    const page = rows.slice(0, 200).reverse().map(row => this.hydrate(row));
    return { epoch: this.epoch, messages: page, nextBefore: page[0]?.seq ?? null, hasMore: rows.length > 200 };
  }
  history(before = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(before) || before < 1) throw fault('INVALID_CURSOR', 400);
    return this.db.prepare('SELECT * FROM messages WHERE seq<? ORDER BY seq DESC LIMIT 100').all(before).reverse().map(row => this.hydrate(row));
  }
}

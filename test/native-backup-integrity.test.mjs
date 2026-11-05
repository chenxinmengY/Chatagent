import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../packages/conversation/store.mjs';
import { captureRuntimeBackup, restoreRuntimeBackup, inventory, verifyRuntimeBackup } from '../packages/migration/runtime-backup.mjs';
import { sandbox } from './helpers.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
async function fixture(root) {
  const identity = randomUUID(), session = 'chatagent-social-' + hash(identity).slice(0, 32);
  const store = new ChatStore(path.join(root, 'chat.sqlite'));
  const message = store.submit({ deviceId: 'synthetic', clientMessageId: 'native-proof', text: 'SYNTHETIC_NATIVE_BACKUP', queuedAt: Date.now() });
  store.claim(); store.complete(message.id, 'SYNTHETIC_NATIVE_REPLY');
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: message.text }], source: { kind: 'chatagent-isolated-dsh-v1', requestId: message.id, mode: 'social' } } },
    { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'SYNTHETIC_NATIVE_REPLY' }] } } },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } }
  ];
  const runtime = { kind: 'isolated-sdk', async checkpoint(destination, captureChat) {
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, '.chatagent-dsh.json'), JSON.stringify({ format: 'chatagent-isolated-dsh-v1', id: identity }));
    const db = new DatabaseSync(path.join(destination, 'requests.sqlite'));
    try {
      db.exec(`PRAGMA application_id=1128350803; CREATE TABLE modes(mode TEXT PRIMARY KEY,session_id TEXT UNIQUE NOT NULL);
        CREATE TABLE requests(id TEXT PRIMARY KEY,mode TEXT NOT NULL,text_hash TEXT NOT NULL,state TEXT NOT NULL,reply TEXT,session_id TEXT NOT NULL);`);
      db.prepare('INSERT INTO modes VALUES(?,?)').run('social', session);
      db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?)').run(message.id, 'social', hash(message.text), 'completed', 'SYNTHETIC_NATIVE_REPLY', session);
    } finally { db.close(); }
    const directory = path.join(destination, 'sessions', 'synthetic-project', session); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'session.v4.jsonl'), [{ type: 'session', version: 4, id: session, createdAt: 1, isSeeded: false }, ...events].map(row => JSON.stringify(row)).join('\n') + '\n');
    await captureChat();
  } };
  const destination = path.join(root, 'backup');
  try { await captureRuntimeBackup({ store, runtime, destination }); } finally { store.close(); }
  return { destination, session, log: path.join(destination, 'payload/dsh/sessions/synthetic-project', session, 'session.v4.jsonl') };
}
function reseal(directory) {
  const file = path.join(directory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
  manifest.files = inventory(path.join(directory, 'payload')); fs.writeFileSync(file, JSON.stringify(manifest));
}

test('已完成账本仍在但原生会话文件缺失，重算文件清单也不能通过恢复', async t => {
  const box = sandbox(t), bundle = await fixture(box.root);
  fs.unlinkSync(bundle.log); reseal(bundle.destination);
  assert.throws(() => restoreRuntimeBackup(bundle.destination, path.join(box.root, 'restored')), /BACKUP_DSH_SESSION_MISSING/);
  assert.equal(fs.existsSync(path.join(box.root, 'restored')), false);
});

test('原生日志缺少完成轮次或回复内容与账本不符，不能宣称已有完成证据', async t => {
  const box = sandbox(t), bundle = await fixture(box.root), original = fs.readFileSync(bundle.log, 'utf8');
  fs.writeFileSync(bundle.log, original.trimEnd().split('\n').slice(0, -1).join('\n') + '\n'); reseal(bundle.destination);
  assert.throws(() => verifyRuntimeBackup(bundle.destination), /BACKUP_DSH_REPLY_UNPROVEN/);
  fs.writeFileSync(bundle.log, original.replace('SYNTHETIC_NATIVE_REPLY', 'SYNTHETIC_DIFFERENT_REPLY')); reseal(bundle.destination);
  assert.throws(() => verifyRuntimeBackup(bundle.destination), /BACKUP_DSH_REPLY_UNPROVEN/);
});

test('原生会话格式升级、身份更换、截断末行和事件序号断裂均明确拒绝', async t => {
  const box = sandbox(t), bundle = await fixture(box.root), original = fs.readFileSync(bundle.log, 'utf8');
  const cases = [
    [original.replace('"version":4', '"version":5'), /BACKUP_DSH_FORMAT_UNSUPPORTED/],
    [original.replace(bundle.session, 'foreign-session'), /BACKUP_DSH_SESSION_IDENTITY_INVALID/],
    [original.slice(0, -1), /BACKUP_DSH_LOG_INVALID/],
    [original.replace('"seq":2', '"seq":99'), /BACKUP_DSH_LOG_INVALID/]
  ];
  for (const [content, expected] of cases) { fs.writeFileSync(bundle.log, content); reseal(bundle.destination); assert.throws(() => verifyRuntimeBackup(bundle.destination), expected); }
  fs.writeFileSync(bundle.log, original); reseal(bundle.destination); assert.equal(verifyRuntimeBackup(bundle.destination).status, 'complete');
});

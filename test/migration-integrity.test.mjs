import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../packages/conversation/store.mjs';
import { canonical, makeSnapshot } from '../packages/migration/snapshot.mjs';
import { restoreLocalBackup } from '../packages/migration/local-restore.mjs';
import { sandbox } from './helpers.mjs';

const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function manifest(directory, messages) {
  const record = { version: 1, id: 'synthetic-backup', status: 'complete', coverage: ['chatagent.local-chat.sqlite'],
    messages, sha256: hashFile(path.join(directory, 'chat.sqlite')) };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(record));
  return record;
}
function validBackup(root, name, withMessage = false) {
  const directory = path.join(root, name); fs.mkdirSync(directory);
  const store = new ChatStore(path.join(directory, 'chat.sqlite'));
  const epoch = store.epoch;
  let message;
  try {
    if (withMessage) message = store.submit({ deviceId: 'synthetic', clientMessageId: 'one', text: '合成恢复原件', queuedAt: Date.now() });
  } finally { store.close(); }
  manifest(directory, withMessage ? 1 : 0);
  return { directory, epoch, message };
}
function assertUnmodifiedFailure(directory, target, expected) {
  const originalHash = hashFile(path.join(directory, 'chat.sqlite'));
  assert.throws(() => restoreLocalBackup(directory, target), expected);
  assert.equal(hashFile(path.join(directory, 'chat.sqlite')), originalHash);
  if (fs.existsSync(path.join(target, 'chat.sqlite'))) assert.equal(hashFile(path.join(target, 'chat.sqlite')), originalHash);
  assert.equal(fs.existsSync(path.join(target, '.chatagent-local.json')), false);
}

test('恢复缺表的同标识SQLite必须失败，不能先自动建表再宣称恢复成功', t => {
  const box = sandbox(t), directory = path.join(box.root, 'missing-tables'); fs.mkdirSync(directory);
  const db = new DatabaseSync(path.join(directory, 'chat.sqlite'));
  try { db.exec('PRAGMA application_id=1128350536; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES(\'synthetic\')'); }
  finally { db.close(); }
  manifest(directory, 1);
  assertUnmodifiedFailure(directory, path.join(box.root, 'rejected'), /BACKUP_SCHEMA_INVALID/);
});

test('恢复缺少必需消息列的备份必须在任何初始化写入前拒绝', t => {
  const box = sandbox(t), { directory } = validBackup(box.root, 'missing-column');
  const db = new DatabaseSync(path.join(directory, 'chat.sqlite'));
  try { db.exec('ALTER TABLE messages DROP COLUMN confirmed_at'); } finally { db.close(); }
  manifest(directory, 0);
  assertUnmodifiedFailure(directory, path.join(box.root, 'rejected'), /BACKUP_SCHEMA_INVALID/);
});

test('恢复拒绝丢失消息唯一性约束的备份', t => {
  const box = sandbox(t), { directory } = validBackup(box.root, 'missing-key');
  const db = new DatabaseSync(path.join(directory, 'chat.sqlite'));
  try {
    db.exec(`DROP TABLE messages;
      CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,
        device TEXT,client_id TEXT,role TEXT NOT NULL,text TEXT NOT NULL,mode TEXT NOT NULL,
        queued_at INTEGER NOT NULL,created_at INTEGER NOT NULL,confirmed_at INTEGER,state TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,parent TEXT);`);
  } finally { db.close(); }
  manifest(directory, 0);
  assertUnmodifiedFailure(directory, path.join(box.root, 'rejected'), /BACKUP_SCHEMA_INVALID/);
});

test('恢复必须核对清单消息数，不接受数量不符或无效计数', t => {
  const box = sandbox(t), { directory } = validBackup(box.root, 'wrong-count', true);
  manifest(directory, 2);
  assertUnmodifiedFailure(directory, path.join(box.root, 'wrong-count-target'), /BACKUP_MESSAGE_COUNT_MISMATCH/);
  for (const [index, count] of [undefined, -1, 0.5, '1'].entries()) {
    manifest(directory, count);
    assertUnmodifiedFailure(directory, path.join(box.root, 'invalid-' + index), /BACKUP_VERIFICATION_FAILED/);
  }
});

test('合法空备份和消息备份通过预检，恢复仍隔离未结束任务', t => {
  const box = sandbox(t);
  for (const withMessage of [false, true]) {
    const { directory, epoch, message } = validBackup(box.root, 'valid-' + withMessage, withMessage);
    const sourceHash = hashFile(path.join(directory, 'chat.sqlite'));
    const target = path.join(box.root, 'restored-' + withMessage);
    const result = restoreLocalBackup(directory, target);
    assert.equal(result.messages, withMessage ? 1 : 0); assert.notEqual(result.epoch, epoch);
    assert.equal(hashFile(path.join(directory, 'chat.sqlite')), sourceHash);
    const restored = new DatabaseSync(path.join(target, 'chat.sqlite'), { readOnly: true });
    try {
      if (message) {
        const row = restored.prepare('SELECT id,text,state FROM messages').get();
        assert.equal(row.id, message.id); assert.equal(row.text, message.text); assert.equal(row.state, 'unknown');
      }
    } finally { restored.close(); }
  }
});

test('稀疏数组不能被散列为其他JSON内容，正常null数组仍可往返', () => {
  for (const value of [new Array(1), { nested: new Array(2) }, [1, , 3]]) {
    assert.throws(() => canonical(value), /INVALID_JSON_VALUE/);
    assert.throws(() => makeSnapshot({ sourceId: 'synthetic', scope: 'arrays', coverage: ['json'], objects: [{ key: 'array', value }] }), /INVALID_JSON_VALUE/);
  }
  assert.equal(canonical([null, null]), '[null,null]');
  assert.equal(canonical(JSON.parse(canonical([null, { text: '合成内容' }]))), canonical([null, { text: '合成内容' }]));
});

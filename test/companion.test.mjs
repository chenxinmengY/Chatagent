import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../packages/conversation/store.mjs';
import { captureStandby, sealStandbyCapture, verifyStandbyCapture } from '../packages/migration/standby-capture.mjs';
import { sealDatabase } from '../packages/migration/runtime-backup.mjs';

test('plugin delivery survives reopen and retries without duplicate synchronization', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chatagent-plugin-'));
  const file = path.join(root, 'chat.sqlite'); let store;
  try {
    store = new ChatStore(file); const first = store.publish({ deliveryId: 'reminder-proof', text: '到点提醒' });
    assert.equal(store.publish({ deliveryId: 'reminder-proof', text: '到点提醒' }).id, first.id);
    assert.throws(() => store.publish({ deliveryId: 'reminder-proof', text: '内容改变' }), /ID_REUSED/);
    assert.equal(store.db.prepare('SELECT count(*) n FROM changes').get().n, 1);
    store.close(); store = new ChatStore(file);
    assert.equal(store.publish({ deliveryId: 'reminder-proof', text: '到点提醒' }).id, first.id);
    assert.equal(store.history().length, 1);
  } finally { store?.close(); fs.rmSync(root, { recursive: true }); }
});

test('capture refuses relative, overlapping or pre-existing targets before source reads', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chatagent-capture-'));
  try {
    await assert.rejects(captureStandby({ sourceRoot: root, dshHome: root, destination: 'relative' }), /ABSOLUTE_PATH/);
    await assert.rejects(captureStandby({ sourceRoot: root, dshHome: root, destination: root }), /TARGET_REFUSED/);
    await assert.rejects(captureStandby({ sourceRoot: root, dshHome: root, destination: path.join(root, 'nested') }), /TARGET_REFUSED/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('Windows deep snapshot SQLite is sealed without MAX_PATH failure', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chatagent-long-sqlite-'));
  const folder = path.join(root, ...Array(5).fill('snapshot-companion-012345678901234567890123456789'));
  const file = path.join(folder, 'reminders.sqlite'); fs.mkdirSync(folder, { recursive: true });
  try {
    const db = new DatabaseSync(path.toNamespacedPath(file)); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES(\'saved\')'); db.close();
    sealDatabase(file);
    const check = new DatabaseSync(path.toNamespacedPath(file), { readOnly: true });
    try { assert.equal(check.prepare('SELECT value FROM proof').get().value, 'saved'); assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode, 'delete'); } finally { check.close(); }
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('sealed source capture detects changed or missing private originals', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chatagent-sealed-'));
  try {
    fs.mkdirSync(path.join(root, 'archive')); fs.mkdirSync(path.join(root, 'workspace'));
    fs.writeFileSync(path.join(root, '.standby-capture.json'), JSON.stringify({ format: 'chatagent-standby-v1', id: 'fixture', completed: true }));
    const file = path.join(root, 'archive/original.txt'); fs.writeFileSync(file, 'original');
    sealStandbyCapture(root); assert.equal(verifyStandbyCapture(root).files, 1);
    fs.writeFileSync(file, 'changed'); assert.throws(() => verifyStandbyCapture(root), /DAMAGED/);
    fs.unlinkSync(file); assert.throws(() => verifyStandbyCapture(root), /DAMAGED/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

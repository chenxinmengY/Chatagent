import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { captureHistory, canonical } from '../packages/migration/snapshot.mjs';
import { sandbox } from './helpers.mjs';

test('活跃WAL库的一致性副本包含已提交数据，旧seq原地更新也能被导入识别', async t => {
  const box = sandbox(t);
  fs.mkdirSync(path.join(box.root, 'source'));
  const writer = box.database('source/history.sqlite');
  writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE records(seq INTEGER PRIMARY KEY,chat TEXT NOT NULL,id TEXT NOT NULL,at REAL NOT NULL,
      body TEXT NOT NULL,text TEXT NOT NULL,source TEXT NOT NULL,UNIQUE(chat,id));`);
  writer.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(1, 'wechat:private:synthetic', 'message:1', 1,
    JSON.stringify({ text: '合成短消息', delivery_status: 'pending' }), '合成短消息', 'bridge');
  const first = await captureHistory(path.join(box.root, 'source/history.sqlite'), path.join(box.root, 'capture1'),
    { sourceId: 'fixture', scope: 'history' });
  const store = box.store(); store.import(first);
  writer.prepare('UPDATE records SET body=?,text=? WHERE seq=1').run(
    JSON.stringify({ text: '合成完整消息', delivery_status: 'confirmed' }), '合成完整消息');
  const second = await captureHistory(path.join(box.root, 'source/history.sqlite'), path.join(box.root, 'capture2'),
    { sourceId: 'fixture', scope: 'history', parentId: first.snapshotId });
  assert.equal(second.objects.length, 1);
  assert.equal(store.import(second).changed, 1);
  const key = canonical(['wechat:private:synthetic', 'message:1']);
  assert.equal(store.get('fixture', 'history', key).target.body.delivery_status, 'confirmed');
  assert.equal(writer.prepare('SELECT seq FROM records').get().seq, 1);
  assert.equal(writer.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.root, 'capture2/snapshot.json'), 'utf8')).coverage[0], 'wechatagent.history.records');
});

test('备份只包含捕获时已提交状态，不会提交来源未完成事务', async t => {
  const box = sandbox(t); fs.mkdirSync(path.join(box.root, 'source'));
  const writer = box.database('source/history.sqlite');
  writer.exec(`PRAGMA journal_mode=WAL; CREATE TABLE records(chat TEXT,id TEXT,at REAL,body TEXT,text TEXT,source TEXT);
    INSERT INTO records VALUES('chat','1',1,'{"text":"committed"}','committed','bridge');
    BEGIN IMMEDIATE; UPDATE records SET body='{"text":"uncommitted"}',text='uncommitted';`);
  try {
    const snapshot = await captureHistory(path.join(box.root, 'source/history.sqlite'), path.join(box.root, 'capture'),
      { sourceId: 'fixture', scope: 'history' });
    assert.equal(snapshot.objects[0].value.text, 'committed');
    assert.equal(writer.prepare('SELECT text FROM records').get().text, 'uncommitted');
  } finally { writer.exec('ROLLBACK'); }
});

test('拒绝已有目标与来源目录内目标，不覆盖任何原件', async t => {
  const box = sandbox(t); fs.mkdirSync(path.join(box.root, 'source'));
  const writer = box.database('source/history.sqlite'); writer.exec('CREATE TABLE sentinel(value TEXT)');
  const existing = path.join(box.root, 'existing'); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'keep'), 'original');
  const source = path.join(box.root, 'source/history.sqlite');
  const metadata = { sourceId: 'fixture', scope: 'history' };
  await assert.rejects(captureHistory(source, path.join(box.root, 'source/copy'), metadata), /DESTINATION_INSIDE_SOURCE/);
  await assert.rejects(captureHistory(source, existing, metadata), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(existing, 'keep'), 'utf8'), 'original');
});

test('目标父目录链接被拒绝，不能把隔离输出重定向到其他目录', async t => {
  const box = sandbox(t); fs.mkdirSync(path.join(box.root, 'source')); fs.mkdirSync(path.join(box.root, 'outside'));
  box.database('source/history.sqlite');
  fs.symlinkSync(path.join(box.root, 'outside'), path.join(box.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(captureHistory(path.join(box.root, 'source/history.sqlite'), path.join(box.root, 'link/capture'),
    { sourceId: 'fixture', scope: 'history' }), /DESTINATION_LINK_NOT_ALLOWED/);
  assert.deepEqual(fs.readdirSync(path.join(box.root, 'outside')), []);
});

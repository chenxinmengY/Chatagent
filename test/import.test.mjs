import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../packages/migration/snapshot.mjs';
import { sandbox, fixture, get } from './helpers.mjs';
import { ImportStore } from '../packages/migration/import-store.mjs';
import path from 'node:path';

test('已有非Chatagent数据库被拒绝，不给来源库增加表或写入标记', t => {
  const box = sandbox(t), original = box.database('original.sqlite');
  original.exec('CREATE TABLE important_data(value TEXT); INSERT INTO important_data VALUES(\'keep\')');
  assert.throws(() => new ImportStore(path.join(box.root, 'original.sqlite')), /FOREIGN_DATABASE_REFUSED/);
  assert.equal(original.prepare('PRAGMA application_id').get().application_id, 0);
  assert.deepEqual(original.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name), ['important_data']);
  assert.equal(original.prepare('SELECT value FROM important_data').get().value, 'keep');
});

test('重复导入与重启不会重复修改资料', t => {
  const { store } = sandbox(t), target = store();
  const first = fixture({ message: { text: '合成短句', status: 'pending' }, note: { visits: 1 } });
  assert.equal(target.import(first).changed, 2);
  assert.equal(target.import(first).status, 'already_imported');
  assert.equal(store().import(first).status, 'already_imported');
  assert.deepEqual(get(target, 'note').target, { visits: 1 });
});

test('同一旧记录更新后可导入，旧快照和旧分支不能覆盖新数据', t => {
  const target = sandbox(t).store();
  const first = fixture({ message: { seq: 1, text: '短', status: 'pending' } });
  target.import(first);
  const second = fixture({ message: { seq: 1, text: '更完整的合成原文', status: 'confirmed' } }, { parentId: first.snapshotId });
  assert.equal(target.import(second).changed, 1);
  target.import(first);
  const branch = fixture({ message: { seq: 1, text: '旧分支' } }, { parentId: first.snapshotId, capturedAt: Date.now() + 999999 });
  assert.equal(target.import(branch).status, 'history_only');
  assert.equal(get(target, 'message').target.status, 'confirmed');
});

test('部分包的缺失不删除；完整后继包可记录来源删除，原件仍保留', t => {
  const target = sandbox(t).store();
  const first = fixture({ a: '保留', b: '被来源删除的值' }); target.import(first);
  const partial = fixture({ a: '保留' }, { parentId: first.snapshotId, status: 'partial' }); target.import(partial);
  assert.equal(get(target, 'b').target, '被来源删除的值');
  const complete = fixture({ a: '保留' }, { parentId: partial.snapshotId }); target.import(complete);
  assert.equal(get(target, 'b').targetDeleted, true);
  const original = target.db.prepare('SELECT body FROM snapshots WHERE id=?').get(first.snapshotId);
  assert.equal(JSON.parse(original.body).objects.find(x => x.key === 'b').value, '被来源删除的值');
});

test('来源和目标同时修改时保留双方与冲突，不覆盖本地批注', t => {
  const target = sandbox(t).store();
  const first = fixture({ diary: { text: '原件', visits: 1 } }); target.import(first);
  target.edit(first.sourceId, first.scope, 'diary', { text: '本地批注', visits: 1 });
  const second = fixture({ diary: { text: '原件', visits: 2 } }, { parentId: first.snapshotId });
  assert.equal(target.import(second).conflicts, 1);
  assert.equal(get(target, 'diary').source.visits, 2);
  assert.equal(get(target, 'diary').target.text, '本地批注');
  const conflict = target.conflicts()[0];
  assert.deepEqual(JSON.parse(conflict.before_json), { text: '原件', visits: 1 });
  assert.deepEqual(JSON.parse(conflict.incoming_json), { text: '原件', visits: 2 });
  assert.equal(target.import(second).status, 'already_imported');
  assert.equal(target.conflicts().length, 1);
});

test('来源未变化时不把本地修改误判为冲突；来源删除也不抹除本地修改', t => {
  const target = sandbox(t).store();
  const first = fixture({ diary: '原件' }); target.import(first);
  target.edit(first.sourceId, first.scope, 'diary', '本地版本');
  const unchanged = fixture({ diary: '原件' }, { parentId: first.snapshotId });
  assert.equal(target.import(unchanged).conflicts, 0);
  const deleted = fixture({}, { parentId: unchanged.snapshotId });
  assert.equal(target.import(deleted).conflicts, 1);
  assert.equal(get(target, 'diary').target, '本地版本');
  assert.equal(get(target, 'diary').sourceDeleted, true);
});

test('不同来源隔离；覆盖范围缩小不被解释为删除', t => {
  const target = sandbox(t).store(), first = fixture({ note: 1 }); target.import(first);
  const foreign = fixture({ note: 2 }, { sourceId: 'other-source' }); target.import(foreign);
  assert.equal(get(target, 'note').target, 1);
  const narrow = fixture({}, { parentId: first.snapshotId, coverage: ['messages'] });
  assert.equal(target.import(narrow).status, 'history_only');
  assert.equal(get(target, 'note').target, 1);
});

test('未见过的父快照只存档，父快照到达后可再次按链导入', t => {
  const target = sandbox(t).store(), first = fixture({ note: 1 });
  const child = fixture({ note: 2 }, { parentId: first.snapshotId });
  assert.equal(target.import(child).status, 'history_only');
  assert.equal(get(target, 'note'), undefined);
  target.import(first);
  assert.equal(target.import(child).status, 'imported');
  assert.equal(get(target, 'note').target, 2);
});

test('哈希损坏、重复键、循环父引用和ID碰撞均拒绝且不改变目标', t => {
  const target = sandbox(t).store(), first = fixture({ a: 1 }); target.import(first);
  const corrupt = fixture({ a: 2 }, { parentId: first.snapshotId }); corrupt.objects[0].value = 3;
  assert.throws(() => target.import(corrupt), /INVALID_SNAPSHOT_OBJECT/);
  const duplicate = fixture({ a: 2 }); duplicate.objects.push(duplicate.objects[0]);
  assert.throws(() => target.import(duplicate), /INVALID_SNAPSHOT_OBJECT/);
  const self = fixture({ a: 2 }); self.parentId = self.snapshotId;
  assert.throws(() => target.import(self), /INVALID_SNAPSHOT/);
  const collision = fixture({ a: 2 }); collision.snapshotId = first.snapshotId;
  assert.throws(() => target.import(collision), /SNAPSHOT_ID_COLLISION/);
  assert.equal(get(target, 'a').target, 1);
  assert.equal(target.db.prepare('SELECT count(*) n FROM snapshots').get().n, 1);
});

test('导入中途数据库失败会回滚整个包及导入账本', t => {
  const target = sandbox(t).store();
  target.db.exec(`CREATE TRIGGER stop_import BEFORE INSERT ON objects WHEN NEW.key='second'
    BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;`);
  assert.throws(() => target.import(fixture({ first: 1, second: 2 })), /synthetic failure/);
  assert.equal(target.db.prepare('SELECT count(*) n FROM objects').get().n, 0);
  assert.equal(target.db.prepare('SELECT count(*) n FROM snapshots').get().n, 0);
  assert.equal(target.db.prepare('SELECT count(*) n FROM heads').get().n, 0);
});

test('JSON空值与删除不同；对象键顺序不影响内容哈希', t => {
  const target = sandbox(t).store(), first = fixture({ nullable: null }); target.import(first);
  assert.equal(get(target, 'nullable').targetDeleted, false);
  assert.equal(get(target, 'nullable').target, null);
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  assert.throws(() => canonical({ a: undefined }), /INVALID_JSON_VALUE/);
});

test('导入任务状态只是资料，没有执行队列或自动恢复任务', t => {
  const target = sandbox(t).store();
  target.import(fixture({ task: { state: 'unknown', command: 'SYNTHETIC_DO_NOT_EXECUTE' } }));
  assert.equal(get(target, 'task').target.state, 'unknown');
  const tables = target.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
  assert.deepEqual(tables.sort(), ['conflicts', 'heads', 'objects', 'snapshots']);
});

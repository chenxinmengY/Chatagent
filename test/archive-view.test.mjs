import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKey, validDate, videoRecord, videoGroups, readAllPages } from '../apps/web/archive.js';

test('archive dates use Beijing midnight and reject invalid dates', () => {
  assert.equal(dateKey({ at: Date.parse('2026-11-02T16:00:00Z') }), '2026-11-03');
  assert.equal(dateKey({ at: Date.parse('2026-11-02T15:59:59Z') }), '2026-11-02');
  assert.equal(dateKey({ date: '2026-10-26', at: 0 }), '2026-10-26');
  assert.equal(dateKey({ at: null }), 'undated');
  assert.equal(dateKey({ at: 'invalid' }), 'undated');
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2028-02-29'), true);
});
test('date index includes older pages and fails visibly on partial reads', async () => {
  const all = Array.from({ length: 172 }, (_, id) => ({ id })), calls = [];
  assert.deepEqual(await readAllPages(async offset => { calls.push(offset); return { total: 172, entries: all.slice(offset, offset + 50) }; }), all);
  assert.deepEqual(calls, [0, 50, 100, 150]);
  await assert.rejects(readAllPages(async offset => offset ? { total: 100, entries: [] } : { total: 100, entries: all.slice(0, 50) }));
  assert.equal(await readAllPages(async () => ({ entries: all }), () => true), null);
});
test('video grouping preserves every feeling and safe unknown records', () => {
  const text = '标题 (BV1Lrxt6uEuR)\n<img onerror="bad()">\n第二段\n导入的历史记录；不会恢复旧阅读任务。';
  const groups = videoGroups([{ id: 'a', at: 2, text }, { id: 'b', at: 1, text }]);
  assert.equal(groups.length, 1); assert.deepEqual(groups[0].entries.map(e => e.id), ['b', 'a']);
  assert.equal(groups[0].entries[0].feeling, '<img onerror="bad()">\n第二段');
  const unknown = 'unrecognized\noriginal text';
  assert.equal(videoRecord({ text: unknown }).feeling, unknown);
  assert.equal(videoGroups([{ id: 'a', text: unknown }, { id: 'b', text: unknown }]).length, 2);
});

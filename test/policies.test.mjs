import test from 'node:test';
import assert from 'node:assert/strict';
import { retentionPlan } from '../packages/migration/retention.mjs';
import { recoveryAction, STALE_AFTER_MS } from '../packages/conversation/recovery.mjs';

const time = Date.parse('2026-11-02T16:30:00Z');
function entry(id, daysAgo, extra = {}) {
  return { id, kind: 'automatic', published: true, status: 'complete', createdAt: time - daysAgo * 86400000, ...extra };
}

test('每日7份和每周4份按并集保留，保护重要与最近恢复成功快照', () => {
  const snapshots = Array.from({ length: 40 }, (_, i) => entry(String(i), i));
  snapshots[38].restoreVerified = true; snapshots[39].pinned = true;
  snapshots.push(entry('manual', 45, { kind: 'manual' }), entry('partial', 0, { status: 'partial' }));
  const plan = retentionPlan(snapshots), kept = new Map(plan.keep.map(x => [x.id, x.reasons]));
  for (let i = 0; i < 7; i++) assert.ok(kept.get(String(i)).includes('daily'));
  assert.equal([...kept.values()].filter(x => x.includes('weekly')).length, 4);
  for (const id of ['38', '39', 'manual', 'partial']) assert.ok(kept.has(id));
  assert.ok(plan.removalCandidates.length > 0);
  assert.equal(new Set(plan.keep.map(x => x.id)).size, plan.keep.length);
  assert.equal(JSON.stringify(snapshots).includes('removalCandidates'), false);
});

test('上海日期与自然周边界正确，同一天多次只选最新完整快照', () => {
  const make = (id, at) => ({ ...entry(id, 0), createdAt: Date.parse(at) });
  const plan = retentionPlan([
    make('sunday', '2026-11-01T15:59:00Z'), // 上海周日23:59
    make('monday-early', '2026-11-01T16:01:00Z'),
    make('monday-late', '2026-11-02T02:00:00Z')
  ]);
  assert.deepEqual(new Set(plan.keep.map(x => x.id)), new Set(['sunday', 'monday-late']));
  assert.deepEqual(plan.removalCandidates, ['monday-early']);
});

test('不完整和未发布快照不挤占完整名额，不生成删除动作', () => {
  const all = Array.from({ length: 7 }, (_, i) => entry(String(i), i + 1));
  all.push(entry('failed', 0, { status: 'failed' }), entry('staging', 0, { published: false }));
  const plan = retentionPlan(all);
  assert.equal(plan.keep.length, 9);
  assert.deepEqual(plan.removalCandidates, []);
  assert.throws(() => retentionPlan([entry('same', 0), entry('same', 1)]), /INVALID_RETENTION_ITEM/);
});

test('超过30分钟的未开始消息才需确认，已接收但未开始同样检查', () => {
  for (const state of ['not_received', 'queued']) {
    assert.equal(recoveryAction({ state, queuedAt: time, now: time + STALE_AFTER_MS }), 'resume_same_id');
    assert.equal(recoveryAction({ state, queuedAt: time, now: time + STALE_AFTER_MS + 1 }), 'require_confirmation');
  }
});

test('已生成、运行中和未知结果均不重新生成或自动执行', () => {
  assert.equal(recoveryAction({ state: 'completed' }), 'sync_existing_reply');
  assert.equal(recoveryAction({ state: 'running' }), 'observe_existing_run');
  assert.equal(recoveryAction({ state: 'unknown' }), 'reconcile');
  assert.equal(recoveryAction({ state: 'cancelled' }), 'show_terminal_state');
});

test('恢复旧备份或时钟倒退时不以缺少记录推断可以重发', () => {
  assert.equal(recoveryAction({ state: 'not_received', queuedAt: time, now: time + 10, epochChanged: true }), 'reconcile');
  assert.equal(recoveryAction({ state: 'queued', queuedAt: time + 1, now: time }), 'reconcile');
  assert.equal(recoveryAction({ state: 'queued', now: time }), 'reconcile');
  assert.throws(() => recoveryAction({ state: 'other' }), /INVALID_MESSAGE_STATE/);
});

test('用户确认后允许同ID继续；确认后再次长时间搁置仍须重新确认', () => {
  const confirmedAt = time + 2 * STALE_AFTER_MS;
  assert.equal(recoveryAction({ state: 'queued', queuedAt: time, confirmedAt, now: confirmedAt }), 'resume_same_id');
  assert.equal(recoveryAction({ state: 'queued', queuedAt: time, confirmedAt, now: confirmedAt + STALE_AFTER_MS + 1 }), 'require_confirmation');
  assert.equal(recoveryAction({ state: 'queued', queuedAt: time, confirmedAt: confirmedAt + 1, now: confirmedAt }), 'reconcile');
  assert.equal(recoveryAction({ state: 'queued', queuedAt: time, confirmedAt, now: confirmedAt, epochChanged: true }), 'reconcile');
});

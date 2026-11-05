import test from 'node:test';
import assert from 'node:assert/strict';
import { outboxAction } from '../apps/web/outbox.js';

const now = Date.parse('2026-11-02T12:00:00Z');
const age = 30 * 60000;
const item = { queuedAt: now, epoch: 'archive-a', hold: false };

test('短暂离线续传，超过30分钟及等待确认的消息不自动补发', () => {
  assert.equal(outboxAction(item, 'archive-a', now + age), 'submit');
  assert.equal(outboxAction(item, 'archive-a', now + age + 1), 'hold');
  assert.equal(outboxAction({ ...item, hold: true }, 'archive-a', now), 'hold');
  assert.equal(outboxAction({ ...item, epoch: null }, 'archive-a', now), 'submit');
});

test('确认补发再次积压或档案改变必须重新确认，旧explicit字段不授予永久授权', () => {
  const confirmed = { ...item, confirmedAt: now + age + 1 };
  assert.equal(outboxAction(confirmed, 'archive-a', confirmed.confirmedAt), 'submit_and_confirm');
  assert.equal(outboxAction(confirmed, 'archive-a', confirmed.confirmedAt + age + 1), 'hold');
  assert.equal(outboxAction(confirmed, 'archive-b', confirmed.confirmedAt), 'hold');
  assert.equal(outboxAction({ ...item, explicit: true }, 'archive-a', now + age + 1), 'hold');
});

test('客户端时钟回退或无效确认不能变为自动补发', () => {
  assert.equal(outboxAction(item, 'archive-a', now - 1), 'hold');
  for (const confirmedAt of [now - 1, now + 1, NaN, 'now']) {
    assert.equal(outboxAction({ ...item, confirmedAt }, 'archive-a', now), 'hold');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerDefinitelyGone, ownerRecord } from '../packages/storage/process-owner.mjs';
test('进程号被复用时按出生时间识别旧锁，不停止新进程', () => {
  const options = { probe: () => {}, birth: () => 50000, modified: () => 10000 };
  assert.equal(ownerDefinitelyGone({ pid: 12, birthMs: 1000 }, 'test', options), true);
  assert.equal(ownerDefinitelyGone({ pid: 12, birthMs: 50000 }, 'test', options), false);
  assert.equal(ownerDefinitelyGone({ pid: 12 }, 'test', options), true);
  assert.equal(ownerDefinitelyGone({ pid: 12 }, 'test', { ...options, modified: () => 49500 }), false);
});
test('无法确认进程身份或权限不足时保留锁，仅不存在的进程可回收', () => {
  const options = { probe: () => {}, birth: () => null, modified: () => 1 };
  assert.equal(ownerDefinitelyGone({ pid: 12 }, 'test', options), false);
  assert.equal(ownerDefinitelyGone({ pid: 12 }, 'test', { ...options, probe: () => { throw Object.assign(Error(), { code: 'EPERM' }); } }), false);
  assert.equal(ownerDefinitelyGone({ pid: 12 }, 'test', { ...options, probe: () => { throw Object.assign(Error(), { code: 'ESRCH' }); } }), true);
  const self = ownerRecord('synthetic-token'); assert.equal(ownerDefinitelyGone(self, 'unused'), false);
});

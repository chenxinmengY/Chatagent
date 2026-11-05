import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { BackupCoordinator } from '../packages/migration/backup-coordinator.mjs';
import { sandbox } from './helpers.mjs';

test('每日首次空闲、上海日期、关机不补跑，手动自动合并同一捕获', async t => {
  const box = sandbox(t); let time = Date.parse('2026-11-02T15:59:00Z'), idle = false, calls = 0, release;
  const coordinator = new BackupCoordinator({ file: path.join(box.root, 'jobs.json'), enabled: true, now: () => time, isIdle: () => idle,
    capture: async () => { calls++; await new Promise(resolve => { release = resolve; }); return { id: 'snapshot-' + calls, createdAt: time, status: 'complete', coverage: ['synthetic'] }; } });
  assert.equal(await coordinator.tick(), null); idle = true;
  const daily = coordinator.tick(); const manual = coordinator.request(); await Promise.resolve(); assert.equal(calls, 1); release();
  assert.equal((await daily).id, (await manual).id); assert.equal(await coordinator.tick(), null);
  time += 120000; const midnight = coordinator.tick(); await Promise.resolve(); assert.equal(calls, 2); release(); await midnight;
  time += 5 * 86400000; const afterOff = coordinator.tick(); await Promise.resolve(); assert.equal(calls, 3); release(); await afterOff;
  assert.equal(await coordinator.tick(), null); assert.equal(coordinator.status().lastComplete.restoreVerified, false);
  coordinator.pin('snapshot-1', true); assert.ok(coordinator.status().retention.keep.find(item => item.id === 'snapshot-1').reasons.includes('important'));
});

test('捕获失败不更新完整备份，有限重试与重启保留失败事实', async t => {
  const box = sandbox(t), file = path.join(box.root, 'jobs.json'); let time = Date.parse('2026-11-03T01:00:00Z'), calls = 0;
  const options = { file, enabled: true, now: () => time, isIdle: () => true, retryMs: 100, capture: async () => { calls++; throw Error('SYNTHETIC_BUSY'); } };
  let coordinator = new BackupCoordinator(options);
  for (let i = 0; i < 3; i++) { await assert.rejects(coordinator.tick(), /SYNTHETIC_BUSY/); assert.equal(await coordinator.tick(), null); time += 101; }
  assert.equal(calls, 3); coordinator = new BackupCoordinator(options); assert.equal(await coordinator.tick(), null); assert.equal(coordinator.status().lastComplete, null);
  const stored = JSON.parse(fs.readFileSync(file)); stored.attempts.push({ kind: 'automatic', startedAt: time, state: 'capturing' }); fs.writeFileSync(file, JSON.stringify(stored));
  coordinator = new BackupCoordinator(options); assert.equal(coordinator.status().lastAttempt.state, 'interrupted'); assert.equal(coordinator.status().lastComplete, null);
});

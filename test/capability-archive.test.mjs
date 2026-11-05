import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.mjs';
import { digest } from '../packages/migration/standby-capture.mjs';
import { captureCapabilityArchive, importCapabilityArchive, verifyCapabilityArchive } from '../packages/migration/capability-archive.mjs';
test('能力补充档案保留旧任务原文但不运行，重复导入不改来源，篡改必须拒绝', async t => {
  const { root } = sandbox(t), sourceRoot = path.join(root, 'source'), destination = path.join(root, 'capture');
  const capsule = { account: 'a'.repeat(64), key: 'wechat:private:12345', personaDigest: digest('synthetic persona') };
  const write = (rel, value) => { const file = path.join(sourceRoot, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  write('state/weflow/active-account.json', { id: capsule.account });
  write('state/accounts/' + capsule.account + '/dsh-sessions.json', { profiles: { [capsule.key]: { persona: 'synthetic persona' } } });
  const original = write('state/singing/old-job.json', { state: 'unknown', command: 'DO_NOT_RUN' }), before = fs.readFileSync(original);
  const result = await captureCapabilityArchive({ sourceRoot, destination, capsule }); assert.equal(result.files.length, 1);
  const target = path.join(root, 'imported'); importCapabilityArchive(destination, target, capsule); importCapabilityArchive(destination, target, capsule);
  assert.deepEqual(fs.readFileSync(original), before); assert.equal(verifyCapabilityArchive(target, capsule).id, result.id);
  fs.appendFileSync(path.join(target, 'archive/state/singing/old-job.json'), ' '); assert.throws(() => verifyCapabilityArchive(target, capsule), /CHANGED/);
});
test('能力档案拒绝重叠目录、已有目标与错误人格绑定', async t => {
  const { root } = sandbox(t), capsule = { account: 'a'.repeat(64), key: 'wechat:private:1', personaDigest: digest('test') };
  await assert.rejects(captureCapabilityArchive({ sourceRoot: root, destination: path.join(root, 'inside'), capsule }), /OVERLAP/);
  await assert.rejects(captureCapabilityArchive({ sourceRoot: path.join(root, 'source'), destination: root, capsule }), /OVERLAP/);
  await assert.rejects(captureCapabilityArchive({ sourceRoot: path.join(root, 'source'), destination: 'relative', capsule }), /ABSOLUTE/);
});

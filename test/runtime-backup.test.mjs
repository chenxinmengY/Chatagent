import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startService } from '../apps/service/server.mjs';
import { restoreRuntimeBackup, verifyRuntimeBackup, inventory } from '../packages/migration/runtime-backup.mjs';
import { sandbox } from './helpers.mjs';

function checkpointFixture(destination) {
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, '.chatagent-dsh.json'), JSON.stringify({ format: 'chatagent-isolated-dsh-v1', id: randomUUID() }));
  const db = new DatabaseSync(path.join(destination, 'requests.sqlite'));
  try { db.exec(`PRAGMA application_id=1128350803;
    CREATE TABLE modes(mode TEXT PRIMARY KEY,session_id TEXT UNIQUE NOT NULL);
    CREATE TABLE requests(id TEXT PRIMARY KEY,mode TEXT NOT NULL,text_hash TEXT NOT NULL,state TEXT NOT NULL,reply TEXT,session_id TEXT NOT NULL);`); }
  finally { db.close(); }
  fs.mkdirSync(path.join(destination, 'workspaces'));
  fs.writeFileSync(path.join(destination, 'workspaces', '合成资料.txt'), 'synthetic-only');
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const input = id => ({ deviceId: 'fixture', clientMessageId: id, text: 'synthetic', queuedAt: Date.now() });
async function client(service) {
  const boot = await (await fetch(service.url + '/v1/bootstrap')).json();
  return (route, body) => fetch(service.url + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Chatagent-Token': boot.token },
    ...(body === undefined ? {} : { body: JSON.stringify({ expectedMode: boot.mode, expectedModeRevision: boot.modeRevision, ...body }) }) });
}

test('联合备份等待当前轮次落盘，阻止新写入和下一轮，合并并发备份', async t => {
  const box = sandbox(t), started = deferred(), finish = deferred(), checkpoint = deferred(), resume = deferred();
  let calls = 0, captures = 0;
  const backend = { kind: 'isolated-sdk', async reply() { calls++; started.resolve(); await finish.promise; return 'synthetic reply'; },
    async checkpoint(destination, captureChat) { captures++; checkpoint.resolve(); await resume.promise; checkpointFixture(destination); await captureChat(); } };
  const service = await startService({ dataRoot: path.join(box.root, 'service'), backend });
  try {
    const call = await client(service);
    const first = service.store.submit(input('one')); service.store.submit(input('two'));
    const running = service.tick(); await started.promise;
    const backup1 = service.backup(), backup2 = service.backup();
    assert.equal((await call('/v1/messages', input('blocked'))).status, 503);
    assert.equal((await call('/v1/mode', { mode: 'assistant' })).status, 503);
    assert.equal((await call(`/v1/messages/${first.id}/decision`, { revision: first.revision, action: 'cancel' })).status, 503);
    assert.equal((await call('/v1/sync?after=0')).status, 200);
    assert.equal(captures, 0);
    finish.resolve(); await running; await checkpoint.promise;
    await service.tick(); assert.equal(calls, 1);
    assert.equal(service.store.message(first.id).state, 'completed');
    resume.resolve();
    const [one, two] = await Promise.all([backup1, backup2]);
    assert.equal(one.id, two.id); assert.equal(captures, 1); assert.equal(one.messages, 3);
    const directory = path.join(service.root, 'backups', one.id), before = inventory(directory);
    assert.equal(verifyRuntimeBackup(directory).id, one.id);
    const restored = restoreRuntimeBackup(directory, path.join(box.root, 'restored'));
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/restore-runtime-backup.mjs', import.meta.url)), directory, path.join(box.root, 'cli-restored')], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr); const cliResult = JSON.parse(cli.stdout);
    assert.equal(cliResult.executionEnabled, false); assert.equal(cliResult.messages, 3);
    assert.deepEqual(inventory(directory), before); assert.equal(restored.executionEnabled, false);
    assert.equal(fs.readFileSync(path.join(restored.dshRoot, 'workspaces', '合成资料.txt'), 'utf8'), 'synthetic-only');
    const check = new DatabaseSync(path.join(restored.chatRoot, 'chat.sqlite'), { readOnly: true });
    try { assert.equal(check.prepare("SELECT state FROM messages WHERE client_id='two'").get().state, 'unknown'); }
    finally { check.close(); }
    assert.equal((await call('/v1/messages', input('after-backup'))).status, 200);
  } finally { finish.resolve(); resume.resolve(); await service.close(); }
});

test('Windows恢复遇到短暂改名占用可完成，持续失败或目标出现时保留副本', { skip: process.platform !== 'win32' }, async t => {
  const box = sandbox(t), service = await startService({ dataRoot: path.join(box.root, 'service'), backend: { kind: 'isolated-sdk', async checkpoint(destination, captureChat) { checkpointFixture(destination); await captureChat(); } } });
  try {
    const bundle = await service.backup(), directory = path.join(service.root, 'backups', bundle.id), before = inventory(directory);
    const rename = fs.renameSync; let calls = 0;
    const transient = t.mock.method(fs, 'renameSync', (source, target) => {
      if (++calls === 1) throw Object.assign(Error('transient fixture'), { code: 'EPERM' });
      return rename(source, target);
    });
    const restored = restoreRuntimeBackup(directory, path.join(box.root, 'transient'));
    transient.mock.restore(); assert.equal(calls, 2); assert.equal(restored.executionEnabled, false);
    calls = 0; let retained;
    const persistent = t.mock.method(fs, 'renameSync', source => { retained = source; calls++; throw Object.assign(Error('persistent fixture'), { code: 'EBUSY' }); });
    assert.throws(() => restoreRuntimeBackup(directory, path.join(box.root, 'persistent')), /persistent fixture/);
    persistent.mock.restore(); assert.equal(calls, 6); assert.equal(fs.existsSync(path.join(box.root, 'persistent')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(retained, 'restore.json'))).executionEnabled, false);
    const occupied = path.join(box.root, 'occupied'); calls = 0;
    const race = t.mock.method(fs, 'renameSync', () => {
      calls++; fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'keep.txt'), 'keep');
      throw Object.assign(Error('occupied fixture'), { code: 'EPERM' });
    });
    assert.throws(() => restoreRuntimeBackup(directory, occupied), /RESTORE_TARGET_EXISTS/);
    race.mock.restore(); assert.equal(calls, 1); assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'keep');
    assert.deepEqual(inventory(directory), before);
  } finally { t.mock.restoreAll(); await service.close(); }
});

test('后端捕获失败不能发布完整备份，释放写入屏障且不重启任何服务', async t => {
  const box = sandbox(t);
  const service = await startService({ dataRoot: path.join(box.root, 'service'), backend: { kind: 'isolated-sdk', async checkpoint(destination) { fs.mkdirSync(destination); throw Error('SYNTHETIC_CAPTURE_FAILURE'); } } });
  try {
    await assert.rejects(service.backup(), /SYNTHETIC_CAPTURE_FAILURE/);
    assert.ok(fs.readdirSync(path.join(service.root, 'backups')).every(name => name.startsWith('.staging-')));
    const call = await client(service);
    assert.equal((await call('/v1/messages', input('after-failure'))).status, 200);
  } finally { await service.close(); }
});

test('已挂接但无快照协议的后端不能把仅聊天库备份报告为完整', async t => {
  const box = sandbox(t), service = await startService({ dataRoot: path.join(box.root, 'service'), backend: { async reply() { return 'synthetic'; } } });
  try { await assert.rejects(service.backup(), /BACKEND_CHECKPOINT_UNSUPPORTED/); assert.deepEqual(fs.readdirSync(path.join(service.root, 'backups')), []); }
  finally { await service.close(); }
});

test('文件清单顺序和JSON属性顺序变化不影响相同快照恢复，重复路径仍须拒绝', async t => {
  const box = sandbox(t), service = await startService({ dataRoot: path.join(box.root, 'service'), backend: { kind: 'isolated-sdk', async checkpoint(destination, captureChat) { checkpointFixture(destination); await captureChat(); } } });
  try {
    const bundle = await service.backup(), directory = path.join(service.root, 'backups', bundle.id), file = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file));
    manifest.files = manifest.files.reverse().map(({ path, bytes, sha256 }) => ({ sha256, bytes, path })); fs.writeFileSync(file, JSON.stringify(manifest));
    assert.equal(verifyRuntimeBackup(directory).id, bundle.id);
    assert.equal(restoreRuntimeBackup(directory, path.join(box.root, 'restored')).messages, 0);
    manifest.files.push(manifest.files[0]); fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => verifyRuntimeBackup(directory), /BACKUP_VERIFICATION_FAILED/);
  } finally { await service.close(); }
});

test('备份清单穿越、附加文件、链接和缺失账本均在发布恢复目录前被拒绝', async t => {
  const box = sandbox(t), service = await startService({ dataRoot: path.join(box.root, 'service'), backend: { kind: 'isolated-sdk', async checkpoint(destination, captureChat) { checkpointFixture(destination); await captureChat(); } } });
  try {
    const bundle = await service.backup(), directory = path.join(service.root, 'backups', bundle.id);
    const manifestFile = path.join(directory, 'manifest.json'), original = fs.readFileSync(manifestFile, 'utf8');
    const modified = JSON.parse(original); modified.files[0].path = '../../outside'; fs.writeFileSync(manifestFile, JSON.stringify(modified));
    const target = path.join(box.root, 'rejected');
    assert.throws(() => restoreRuntimeBackup(directory, target), /BACKUP_VERIFICATION_FAILED/); assert.equal(fs.existsSync(target), false);
    fs.writeFileSync(manifestFile, original);
    fs.writeFileSync(path.join(directory, 'payload', 'extra'), 'unlisted');
    assert.throws(() => restoreRuntimeBackup(directory, target), /BACKUP_VERIFICATION_FAILED/); fs.unlinkSync(path.join(directory, 'payload', 'extra'));
    const link = path.join(directory, 'payload', 'linked'); fs.symlinkSync(box.root, link, 'junction');
    assert.throws(() => restoreRuntimeBackup(directory, target), /BACKUP_LINK_REFUSED/); fs.unlinkSync(link);
    fs.unlinkSync(path.join(directory, 'payload/dsh/requests.sqlite'));
    assert.throws(() => restoreRuntimeBackup(directory, target), /BACKUP_VERIFICATION_FAILED/); assert.equal(fs.existsSync(target), false);
  } finally { await service.close(); }
});

test('仅有原生完成证据的未知请求可补存一次，无法证明的请求保持未知', async t => {
  const box = sandbox(t); let lookup = 0, calls = 0;
  const service = await startService({ dataRoot: path.join(box.root, 'service'), backend: { async reply() { calls++; return 'must not run'; }, async lookupResult(request) { lookup++; return request.client_id === 'proven' ? 'durable synthetic reply' : null; } } });
  try {
    const proven = service.store.submit(input('proven')); service.store.claim(); service.store.unknown(proven.id);
    const unknown = service.store.submit(input('unknown')); service.store.recoverRestoredWork();
    await Promise.all([service.tick(), service.tick()]);
    assert.equal(service.store.message(proven.id).state, 'completed');
    await service.tick(); await service.tick();
    assert.equal(service.store.message(unknown.id).state, 'unknown'); assert.equal(calls, 0); assert.equal(lookup, 3);
    assert.equal(service.store.history().filter(row => row.parent === proven.id).length, 1);
    assert.throws(() => service.store.complete(proven.id, 'duplicate', proven.revision), /RUN_NOT_ACTIVE/);
  } finally { await service.close(); }
});

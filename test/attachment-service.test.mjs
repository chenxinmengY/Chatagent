import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startService } from '../apps/service/server.mjs';
import { restoreRuntimeBackup, verifyRuntimeBackup, inventory } from '../packages/migration/runtime-backup.mjs';
import { sandbox } from './helpers.mjs';

const digest = content => createHash('sha256').update(content).digest('hex');
const metadata = (content, name = '合成文件.txt') => ({ id: randomUUID(), name, bytes: content.length, sha256: digest(content) });
async function client(service) {
  const boot = await (await fetch(service.url + '/v1/bootstrap')).json();
  const call = (route, body, options = {}) => fetch(service.url + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Chatagent-Token': boot.token, 'Content-Type': 'application/json', ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
  return { boot, call,
    chunk: (id, offset, content) => call(`/v1/attachments/${id}/content?offset=${offset}`, undefined, { method: 'PUT', body: content,
      headers: { 'X-Chatagent-Token': boot.token, 'Content-Type': 'application/octet-stream' } }),
    message: (ids, id = randomUUID(), text = '') => ({ deviceId: 'synthetic-files', clientMessageId: id, text, queuedAt: Date.now(), expectedMode: boot.mode, expectedModeRevision: boot.modeRevision, attachmentIds: ids }) };
}
async function upload(c, bytes, name) {
  const record = metadata(bytes, name); assert.equal((await c.call('/v1/attachments', record)).status, 200);
  if (bytes.length) assert.equal((await c.chunk(record.id, 0, bytes)).status, 200);
  assert.equal((await c.call(`/v1/attachments/${record.id}/complete`, {})).status, 200); return record;
}

test('HTTP附件上传分片可查重续传，消息引用原子落盘，纯文字后端不能忽略文件执行', async t => {
  const box = sandbox(t); let calls = 0;
  const service = await startService({ dataRoot: path.join(box.root, 'service'), backend: { async reply() { calls++; return 'must not run'; } } });
  try {
    const c = await client(service), bytes = Buffer.from('synthetic-attachment-only'), file = metadata(bytes);
    assert.equal((await fetch(service.url + '/v1/attachments/' + file.id)).status, 401);
    assert.equal((await c.call('/v1/attachments', file)).status, 200);
    assert.equal((await c.call('/v1/attachments', file)).status, 200); assert.equal(service.attachments.count(), 1);
    assert.equal((await c.call('/v1/attachments', { ...file, name: 'changed' })).status, 409);
    assert.equal((await c.call('/v1/messages', c.message([file.id]))).status, 409);
    assert.equal((await c.chunk(file.id, 0, bytes.subarray(0, 6))).status, 200);
    assert.equal((await (await c.chunk(file.id, 0, bytes.subarray(0, 6))).json()).offset, 6);
    assert.equal((await (await c.call(`/v1/attachments/${file.id}`)).json()).offset, 6);
    assert.equal((await c.chunk(file.id, 6, bytes.subarray(6))).status, 200);
    assert.equal((await c.call(`/v1/attachments/${file.id}/complete`, {})).status, 200);
    const body = c.message([file.id]), accepted = await (await c.call('/v1/messages', body)).json();
    assert.equal(accepted.attachments[0].sha256, file.sha256);
    assert.equal((await (await c.call('/v1/messages', body)).json()).id, accepted.id);
    assert.equal((await c.call('/v1/messages', { ...body, attachmentIds: [] })).status, 400);
    const other = await upload(c, bytes, '另一份.txt');
    assert.equal((await c.call('/v1/messages', { ...body, attachmentIds: [other.id] })).status, 409);
    assert.equal((await c.call('/v1/messages', c.message([], 'after-file', 'later text'))).status, 200);
    await service.tick(); assert.equal(calls, 0); assert.equal(service.store.message(accepted.id).state, 'queued');
    const synced = await (await c.call('/v1/sync?after=0')).json(); assert.equal(synced.messages[0].attachments[0].id, file.id);
    const downloaded = await c.call(`/v1/attachments/${file.id}/content`);
    assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
    assert.match(downloaded.headers.get('content-disposition'), /^attachment;/);
    assert.equal(digest(Buffer.from(await downloaded.arrayBuffer())), file.sha256);
    assert.equal(JSON.stringify(accepted).includes(service.root), false);
  } finally { await service.close(); }
});

test('带文件的档案快照可恢复消息引用、已完成文件和半途上传，原件保持不变', async t => {
  const box = sandbox(t), service = await startService({ dataRoot: path.join(box.root, 'service') });
  let restored;
  try {
    const c = await client(service), bytes = Buffer.from('synthetic-file-backup');
    const file = await upload(c, bytes), body = c.message([file.id]);
    const message = await (await c.call('/v1/messages', body)).json();
    const partial = metadata(bytes, 'unfinished.bin'); await c.call('/v1/attachments', partial); await c.chunk(partial.id, 0, bytes.subarray(0, 3));
    const bundle = await service.backup(); assert.equal(bundle.version, 2);
    assert.deepEqual(bundle.coverage, ['chatagent.local-chat.sqlite', 'chatagent.attachments']);
    const directory = path.join(service.root, 'backups', bundle.id), before = inventory(directory);
    assert.equal(verifyRuntimeBackup(directory).id, bundle.id);
    const recovery = restoreRuntimeBackup(directory, path.join(box.root, 'restored'));
    assert.equal(recovery.dshRoot, null); assert.deepEqual(inventory(directory), before);
    restored = await startService({ dataRoot: recovery.chatRoot }); const rc = await client(restored);
    const row = await (await rc.call(`/v1/messages/lookup?deviceId=${body.deviceId}&clientMessageId=${body.clientMessageId}`)).json();
    assert.equal(row.id, message.id); assert.equal(row.state, 'unknown'); assert.equal(row.attachments[0].id, file.id);
    assert.equal(digest(Buffer.from(await (await rc.call(`/v1/attachments/${file.id}/content`)).arrayBuffer())), file.sha256);
    assert.equal((await (await rc.call(`/v1/attachments/${partial.id}`)).json()).offset, 3);
    assert.equal((await rc.chunk(partial.id, 3, bytes.subarray(3))).status, 200);
    assert.equal((await rc.call(`/v1/attachments/${partial.id}/complete`, {})).status, 200);
    assert.deepEqual(inventory(directory), before);
    assert.equal(service.attachments.get(partial.id).offset, 3);
    // 无论攻击者是否更新外层文件哈希，消息引用都必须匹配真实附件元数据。
    const copied = path.join(directory, 'payload/chat/chat.sqlite'), db = new DatabaseSync(copied);
    try { db.prepare('UPDATE messages SET attachments=? WHERE id=?').run(JSON.stringify([{ ...row.attachments[0], sha256: '0'.repeat(64) }]), row.id); } finally { db.close(); }
    const manifestPath = path.join(directory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.files = inventory(path.join(directory, 'payload')); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => restoreRuntimeBackup(directory, path.join(box.root, 'rejected')), /ATTACHMENT_REFERENCE_INVALID/);
    assert.equal(fs.existsSync(path.join(box.root, 'rejected')), false);
  } finally { await restored?.close(); await service.close(); }
});

test('附件损坏不能下载或发布备份，备份失败后文字写入恢复', async t => {
  const box = sandbox(t), service = await startService({ dataRoot: path.join(box.root, 'service') });
  try {
    const c = await client(service), file = await upload(c, Buffer.from('synthetic-intact'));
    fs.writeFileSync(service.attachments.verify(file.id).file, 'corrupt');
    const response = await c.call(`/v1/attachments/${file.id}/content`); assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'ATTACHMENT_OBJECT_DAMAGED');
    await assert.rejects(service.backup(), /ATTACHMENT_OBJECT_DAMAGED/);
    assert.ok(fs.readdirSync(path.join(service.root, 'backups')).every(name => name.startsWith('.staging-')));
    assert.equal((await c.call('/v1/messages', c.message([], 'after-backup-failure', 'text'))).status, 200);
  } finally { await service.close(); }
});

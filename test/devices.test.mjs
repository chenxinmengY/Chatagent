import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { DeviceStore, PAIRING_LIFETIME_MS } from '../packages/devices/store.mjs';
import { startService } from '../apps/service/server.mjs';
import { restoreLocalBackup } from '../packages/migration/local-restore.mjs';
import { restoreRuntimeBackup } from '../packages/migration/runtime-backup.mjs';
import { sandbox } from './helpers.mjs';

const secret = () => randomBytes(32).toString('hex');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const request = (base, route, body, headers = {}) => fetch(base + route, {
  method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
async function clients(service) {
  const boot = await (await fetch(service.url + '/v1/bootstrap')).json();
  const admin = (route, body) => request(service.url, route, body, { 'X-Chatagent-Token': boot.token });
  const invitation = await (await admin('/v1/pairing/invitations', {})).json();
  const deviceToken = secret();
  const claimBody = { credential: invitation.credential, deviceToken, name: '合成手机' };
  const pairing = await request(service.deviceUrl, '/v1/pairing/claim', claimBody);
  assert.equal(pairing.status, 200);
  const identity = await pairing.json();
  const device = (route, body) => request(service.deviceUrl, route, body, { Authorization: 'Bearer ' + deviceToken });
  return { boot, admin, device, identity, deviceToken, claimBody };
}

test('配对一次性、响应丢失幂等、凭据只存哈希，撤销不可通过原邀请复活', t => {
  const box = sandbox(t), file = path.join(box.root, 'devices.sqlite'), store = new DeviceStore(file);
  try {
    const invitation = store.invite(), deviceToken = secret();
    const body = { credential: invitation.credential, deviceToken, name: '  合成手机  ' };
    const first = store.claim(body);
    assert.deepEqual(store.claim(body), first);
    assert.equal(store.list().length, 1);
    assert.deepEqual(store.authenticate(deviceToken), first);
    assert.throws(() => store.claim({ ...body, deviceToken: secret() }), /PAIRING_UNAVAILABLE/);
    const persisted = JSON.stringify([store.db.prepare('SELECT * FROM devices').all(), store.db.prepare('SELECT * FROM pairing').all()]);
    assert.equal(persisted.includes(deviceToken), false); assert.equal(persisted.includes(invitation.credential), false);
    assert.equal(JSON.stringify(store.list()).includes('token'), false);
    store.revoke(first.deviceId); store.revoke(first.deviceId);
    assert.throws(() => store.authenticate(deviceToken), /DEVICE_AUTH_REQUIRED/);
    assert.throws(() => store.claim(body), /PAIRING_UNAVAILABLE/);
    const next = store.invite();
    assert.throws(() => store.claim({ ...body, credential: next.credential }), /DEVICE_TOKEN_REUSED/);
  } finally { store.close(); }
});

test('邀请过期、换新和取消均使旧邀请失效；重启只保留已登记设备', t => {
  const box = sandbox(t), file = path.join(box.root, 'devices.sqlite'); let now = 1000;
  let store = new DeviceStore(file, { now: () => now });
  const claim = credential => ({ credential, deviceToken: secret(), name: '合成设备' });
  try {
    const expired = store.invite(); now += PAIRING_LIFETIME_MS;
    assert.throws(() => store.claim(claim(expired.credential)), /PAIRING_UNAVAILABLE/);
    const old = store.invite(), current = store.invite();
    assert.throws(() => store.claim(claim(old.credential)), /PAIRING_UNAVAILABLE/);
    store.cancelInvitation(); assert.throws(() => store.claim(claim(current.credential)), /PAIRING_UNAVAILABLE/);
    const body = claim(store.invite().credential), accepted = store.claim(body), pending = store.invite();
    store.close(); store = new DeviceStore(file, { now: () => now });
    assert.deepEqual(store.authenticate(body.deviceToken), accepted);
    assert.throws(() => store.claim(claim(pending.credential)), /PAIRING_UNAVAILABLE/);
    assert.throws(() => store.claim({ ...body, name: 'bad\nname' }), /INVALID_PAIRING/);
    assert.throws(() => store.claim({ ...body, deviceToken: body.credential }), /INVALID_PAIRING/);
  } finally { store.close(); }
});

test('设备入口不泄漏本机管理令牌、拒绝管理与跨站请求，提交身份不可冒用', async t => {
  const box = sandbox(t), service = await startService({ dataRoot: path.join(box.root, 'service'), devicePort: 0 });
  try {
    assert.notEqual(service.deviceUrl, service.url);
    assert.equal((await fetch(service.deviceUrl + '/v1/bootstrap')).status, 401);
    const c = await clients(service);
    const boot = await (await c.device('/v1/bootstrap')).json();
    assert.equal(boot.deviceId, c.identity.deviceId); assert.equal(boot.token, undefined);
    for (const [route, body] of [['/', undefined], ['/v1/devices', undefined], ['/v1/backups', {}], ['/v1/pairing/invitations', {}], ['/v1/devices/' + c.identity.deviceId + '/revoke', {}]]) {
      assert.equal((await c.device(route, body)).status, 403, route);
    }
    assert.equal((await request(service.deviceUrl, '/v1/messages', undefined, { 'X-Chatagent-Token': c.boot.token })).status, 401);
    assert.equal((await request(service.url, '/v1/devices', undefined, { Authorization: 'Bearer ' + c.deviceToken })).status, 401);
    for (const headers of [{ Origin: service.deviceUrl }, { Origin: 'https://example.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await request(service.deviceUrl, '/v1/bootstrap', undefined, { Authorization: 'Bearer ' + c.deviceToken, ...headers })).status, 403, JSON.stringify(headers));
    }
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = http.get(service.deviceUrl + '/v1/bootstrap', { headers: { Host: 'example.invalid', Authorization: 'Bearer ' + c.deviceToken } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    const body = { clientMessageId: 'same-id', text: '合成设备消息', queuedAt: Date.now(), expectedMode: boot.mode, expectedModeRevision: boot.modeRevision };
    assert.equal((await c.device('/v1/messages', { ...body, deviceId: 'impersonation' })).status, 403);
    const first = await (await c.device('/v1/messages', body)).json();
    assert.equal(first.device, c.identity.deviceId);
    assert.equal((await (await c.device('/v1/messages', body)).json()).id, first.id);
    assert.equal((await (await c.device('/v1/messages/lookup?clientMessageId=same-id')).json()).id, first.id);
    assert.equal((await c.device('/v1/messages/lookup?deviceId=impersonation&clientMessageId=same-id')).status, 403);
    assert.equal((await (await c.device('/v1/sync?after=0')).json()).messages.length, 1);
    assert.equal((await request(service.deviceUrl, '/v1/pairing/claim', c.claimBody)).status, 200);
    await c.admin('/v1/devices/' + c.identity.deviceId + '/revoke', {});
    assert.equal((await c.device('/v1/messages')).status, 401);
    assert.equal((await request(service.deviceUrl, '/v1/pairing/claim', c.claimBody)).status, 403);
  } finally { await service.close(); }
});

test('两个已配对设备同消息ID互不冲突，重启保留身份与撤销状态', async t => {
  const box = sandbox(t), dataRoot = path.join(box.root, 'service');
  let service = await startService({ dataRoot, devicePort: 0 });
  try {
    const one = await clients(service), two = await clients(service);
    const body = { clientMessageId: 'same-id', text: '合成消息', queuedAt: Date.now(), expectedMode: one.boot.mode, expectedModeRevision: one.boot.modeRevision };
    const first = await (await one.device('/v1/messages', body)).json(), second = await (await two.device('/v1/messages', body)).json();
    assert.notEqual(first.id, second.id);
    await one.admin('/v1/devices/' + one.identity.deviceId + '/revoke', {});
    await service.close(); service = await startService({ dataRoot, devicePort: 0 });
    assert.equal((await request(service.deviceUrl, '/v1/bootstrap', undefined, { Authorization: 'Bearer ' + one.deviceToken })).status, 401);
    const resumed = await request(service.deviceUrl, '/v1/messages', body, { Authorization: 'Bearer ' + two.deviceToken });
    assert.equal(resumed.status, 200); assert.equal((await resumed.json()).id, second.id);
  } finally { await service.close(); }
});

test('设备在请求体传输期间被撤销，JSON提交和附件写入均被拒绝', async t => {
  const box = sandbox(t), service = await startService({ dataRoot: path.join(box.root, 'service'), devicePort: 0 });
  try {
    for (const binary of [false, true]) {
      const c = await clients(service), bytes = Buffer.from('synthetic-upload'), fileId = randomUUID();
      if (binary) assert.equal((await c.device('/v1/attachments', { id: fileId, name: 'file.txt', bytes: bytes.length, sha256: hash(bytes) })).status, 200);
      const route = binary ? `/v1/attachments/${fileId}/content?offset=0` : '/v1/messages';
      const payload = binary ? bytes : Buffer.from(JSON.stringify({ clientMessageId: 'revoked-pending', text: 'must not save', queuedAt: Date.now(), expectedMode: c.boot.mode, expectedModeRevision: c.boot.modeRevision }));
      let response;
      const responseDone = new Promise((resolve, reject) => {
        response = http.request(service.deviceUrl + route, { method: binary ? 'PUT' : 'POST', headers: { Authorization: 'Bearer ' + c.deviceToken, 'Content-Type': binary ? 'application/octet-stream' : 'application/json', 'Content-Length': payload.length } }, res => {
          const parts = []; res.on('data', part => parts.push(part)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts)) }));
        });
        response.on('error', reject);
      });
      const socketReady = once(response, 'socket');
      response.write(payload.subarray(0, 1));
      await socketReady;
      // 一次本机往返后再撤销；请求保持未结束，不依赖大文件耗时。
      await c.device('/v1/bootstrap');
      await c.admin('/v1/devices/' + c.identity.deviceId + '/revoke', {});
      response.end(payload.subarray(1));
      const result = await responseDone;
      assert.equal(result.status, 401); assert.equal(result.body.error, 'DEVICE_AUTH_REQUIRED');
      if (binary) assert.equal(service.attachments.get(fileId).offset, 0);
      else assert.equal(service.store.lookup(c.identity.deviceId, 'revoked-pending'), null);
    }
  } finally { await service.close(); }
});

test('聊天及附件档案恢复不恢复设备授权，旧凭据不能访问新档案', async t => {
  const box = sandbox(t), service = await startService({ dataRoot: path.join(box.root, 'service'), devicePort: 0 });
  const restored = [];
  try {
    const c = await clients(service);
    for (const withAttachment of [false, true]) {
      if (withAttachment) {
        const bytes = Buffer.from('synthetic-backup-file'), id = randomUUID();
        service.attachments.create({ id, name: 'file.txt', bytes: bytes.length, sha256: hash(bytes) }); service.attachments.write(id, 0, bytes); service.attachments.complete(id);
      }
      const manifest = await service.backup(), source = path.join(service.root, 'backups', manifest.id), destination = path.join(box.root, 'restored-' + withAttachment);
      const target = withAttachment ? restoreRuntimeBackup(source, destination).chatRoot : (restoreLocalBackup(source, destination), destination);
      assert.equal(fs.existsSync(path.join(target, 'devices.sqlite')), false);
      const copy = await startService({ dataRoot: target, devicePort: 0 }); restored.push(copy);
      assert.equal((await request(copy.deviceUrl, '/v1/bootstrap', undefined, { Authorization: 'Bearer ' + c.deviceToken })).status, 401);
      assert.equal((await c.device('/v1/bootstrap')).status, 200);
    }
  } finally { for (const copy of restored) await copy.close(); await service.close(); }
});

test('设备入口默认关闭；端口冲突释放本机监听和运行锁', async t => {
  const box = sandbox(t), normal = await startService({ dataRoot: path.join(box.root, 'normal') });
  try {
    assert.equal(normal.deviceUrl, null);
    const boot = await (await fetch(normal.url + '/v1/bootstrap')).json();
    const denied = await request(normal.url, '/v1/pairing/invitations', {}, { 'X-Chatagent-Token': boot.token });
    assert.equal((await denied.json()).error, 'DEVICE_GATEWAY_DISABLED');
    const dataRoot = path.join(box.root, 'conflict');
    await assert.rejects(startService({ dataRoot, devicePort: Number(new URL(normal.url).port) }), { code: 'EADDRINUSE' });
    const retry = await startService({ dataRoot, devicePort: 0 }); await retry.close();
  } finally { await normal.close(); }
});

test('设备附件上传续传、下载校验、积压确认和模式切换均沿用聊天规则', async t => {
  const box = sandbox(t), service = await startService({ dataRoot: path.join(box.root, 'service'), devicePort: 0 });
  try {
    const c = await clients(service), bytes = Buffer.from('synthetic paired device attachment'), id = randomUUID();
    const metadata = { id, name: '合成文件.txt', bytes: bytes.length, sha256: hash(bytes) };
    assert.equal((await c.device('/v1/attachments', metadata)).status, 200);
    const chunk = (offset, body) => fetch(service.deviceUrl + `/v1/attachments/${id}/content?offset=${offset}`, { method: 'PUT', headers: { Authorization: 'Bearer ' + c.deviceToken, 'Content-Type': 'application/octet-stream' }, body });
    assert.equal((await chunk(0, bytes.subarray(0, 5))).status, 200);
    assert.equal((await (await c.device(`/v1/attachments/${id}`)).json()).offset, 5);
    assert.equal((await chunk(5, bytes.subarray(5))).status, 200);
    assert.equal((await c.device(`/v1/attachments/${id}/complete`, {})).status, 200);
    const body = { clientMessageId: 'file', text: '', queuedAt: Date.now() - 31 * 60000, expectedMode: c.boot.mode, expectedModeRevision: c.boot.modeRevision, attachmentIds: [id] };
    const accepted = await (await c.device('/v1/messages', body)).json();
    assert.equal(accepted.state, 'awaiting_confirmation'); assert.equal(accepted.attachments[0].sha256, metadata.sha256);
    const confirmed = await (await c.device(`/v1/messages/${accepted.id}/decision`, { revision: accepted.revision, action: 'confirm' })).json();
    assert.equal(confirmed.state, 'queued');
    const download = await c.device(`/v1/attachments/${id}/content`);
    assert.equal(download.status, 200); assert.equal(hash(Buffer.from(await download.arrayBuffer())), metadata.sha256);
    assert.equal((await c.device('/v1/mode', { mode: 'assistant' })).status, 400);
    service.store.setMode('assistant');
    assert.equal((await c.device('/v1/messages', { ...body, clientMessageId: 'old-mode' })).status, 409);
    await c.admin('/v1/devices/' + c.identity.deviceId + '/revoke', {});
    assert.equal((await c.device(`/v1/attachments/${id}/content`)).status, 401);
    assert.equal((await chunk(5, bytes.subarray(5))).status, 401);
  } finally { await service.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { ChatStore } from '../packages/conversation/store.mjs';
import { startService } from '../apps/service/server.mjs';
import { restoreLocalBackup } from '../packages/migration/local-restore.mjs';
import { sandbox } from './helpers.mjs';

const origin = Date.parse('2026-11-02T12:00:00Z');
const input = (id = 'first', at = origin) => ({ deviceId: 'synthetic-device', clientMessageId: id, text: '合成验证消息', queuedAt: at });

test('真实消息库持久化、去重、模式冻结和增量同步', t => {
  const box = sandbox(t); const file = path.join(box.root, 'chat.sqlite'); let store = new ChatStore(file, { now: () => origin });
  try {
    const first = store.submit(input()); assert.equal(store.submit(input()).id, first.id);
    assert.throws(() => store.submit({ ...input(), text: '不同内容' }), /MESSAGE_ID_REUSED/);
    store.setMode('assistant'); const next = store.submit(input('second')); assert.equal(first.mode, 'social'); assert.equal(next.mode, 'assistant');
    const initial = store.sync(null); assert.equal(initial.reset, true); assert.equal(initial.messages.length, 2);
    const running = store.claim(); assert.equal(running.id, first.id);
    assert.equal(store.claim(), null);
    assert.throws(() => store.decide(first.id, first.revision, 'cancel'), /MESSAGE_STATE_CHANGED/);
    const reply = store.complete(first.id, '合成后端回复');
    const delta = store.sync(initial.epoch, initial.cursor); assert.equal(delta.reset, false); assert.ok(delta.messages.some(x => x.id === reply.id));
    assert.equal(store.claim().id, next.id);
    const epoch = store.epoch; store.close(); store = new ChatStore(file, { now: () => origin }); store.recoverInterrupted();
    assert.equal(store.message(next.id).state, 'unknown'); assert.equal(store.claim(), null);
    assert.equal(store.submit(input()).id, first.id); assert.equal(store.sync(epoch, delta.cursor).reset, false);
    store.resetEpochAfterRestore(); assert.equal(store.sync(epoch, delta.cursor).reset, true);
    assert.equal(store.history().filter(x => x.role === 'assistant').length, 1);
  } finally { store.close(); }
});

test('手机时钟略快不会误判积压，保留原始时间去重且积压仍需确认', t => {
  const box = sandbox(t); let now = origin;
  const store = new ChatStore(path.join(box.root, 'chat.sqlite'), { now: () => now });
  try {
    const message = input('fast-phone', origin + 14000), first = store.submit(message);
    store.expire(); assert.equal(store.message(first.id).state, 'queued');
    assert.equal(store.submit(message).id, first.id);
    assert.equal(store.message(first.id).queued_at, origin + 14000);
    assert.throws(() => store.submit({ ...message, queuedAt: origin }), /MESSAGE_ID_REUSED/);
    assert.equal(store.claim().id, first.id); store.complete(first.id, 'clock-skew fixture');
    const stale = store.submit(input('stale-fast-phone', now + 14000));
    now += 30 * 60000 + 1; store.expire();
    assert.equal(store.message(stale.id).state, 'awaiting_confirmation');
    store.decide(stale.id, store.message(stale.id).revision, 'confirm');
    assert.equal(store.claim().id, stale.id); store.complete(stale.id, 'confirmed fixture');
    const backward = store.submit(input('server-clock-backward', now + 14000));
    now -= 1; assert.equal(store.claim(), null);
    assert.equal(store.message(backward.id).state, 'awaiting_confirmation');
    assert.throws(() => store.submit(input('too-far-ahead', now + 60001)), /INVALID_MESSAGE/);
  } finally { store.close(); }
});

test('积压确认及取消用版本校验，用户确认后同ID继续', t => {
  const box = sandbox(t); let now = origin;
  const store = new ChatStore(path.join(box.root, 'chat.sqlite'), { now: () => now });
  try {
    const row = store.submit(input()); now += 30 * 60000 + 1;
    assert.equal(store.claim(), null); const expired = store.message(row.id); assert.equal(expired.state, 'awaiting_confirmation');
    assert.throws(() => store.decide(row.id, row.revision, 'confirm'), /MESSAGE_STATE_CHANGED/);
    const confirmed = store.decide(row.id, expired.revision, 'confirm'); assert.equal(confirmed.confirmed_at, now);
    assert.equal(store.claim().id, row.id);
    assert.throws(() => store.decide(row.id, confirmed.revision, 'cancel'), /MESSAGE_STATE_CHANGED/);
    store.complete(row.id, 'synthetic');
    const pending = store.submit(input('cancel', now)); store.decide(pending.id, pending.revision, 'cancel'); assert.equal(store.claim(), null);
  } finally { store.close(); }
});

test('HTTP端到端拒绝跨站与无令牌访问，备份可独立读取', async t => {
  const box = sandbox(t); const dataRoot = path.join(box.root, 'local'); const service = await startService({ dataRoot, now: () => origin });
  try {
    const boot = await (await fetch(service.url + '/v1/bootstrap')).json();
    const call = async (route, body, extra = {}) => fetch(service.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Chatagent-Token': boot.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(route === '/v1/messages' && !Array.isArray(body) ? { expectedMode: boot.mode, expectedModeRevision: boot.modeRevision, ...body } : body) }) });
    assert.equal((await fetch(service.url + '/v1/messages')).status, 401);
    assert.equal((await call('/v1/messages', undefined, { Origin: 'https://example.invalid' })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(service.url + '/v1/bootstrap', { headers: { Host: 'untrusted.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await call('/v1/messages', [])).status, 400);
    assert.equal((await call('/v1/messages', { ...input(), text: 'x'.repeat(300000) })).status, 413);
    const first = await (await call('/v1/messages', input())).json(); assert.equal(first.state, 'queued');
    assert.equal((await (await call('/v1/messages', input())).json()).id, first.id);
    const manifest = await (await call('/v1/backups', {})).json();
    assert.deepEqual(manifest.coverage, ['chatagent.local-chat.sqlite']); assert.equal(manifest.messages, 1);
    const file = path.join(dataRoot, 'backups', manifest.id, 'chat.sqlite');
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), manifest.sha256);
    const restored = new DatabaseSync(file, { readOnly: true });
    try { assert.equal(restored.prepare('SELECT text FROM messages').get().text, input().text); } finally { restored.close(); }
    assert.equal((await (await call('/v1/messages')).json()).length, 1);
    const target = path.join(box.root, 'restored');
    const recovery = restoreLocalBackup(path.dirname(file), target); assert.equal(recovery.messages, 1); assert.notEqual(recovery.epoch, boot.epoch);
    const restoredService = await startService({ dataRoot: target, now: () => origin });
    try { assert.equal(restoredService.store.lookup(input().deviceId, input().clientMessageId).id, first.id); }
    finally { await restoredService.close(); }
    assert.throws(() => restoreLocalBackup(path.dirname(file), target), /EEXIST/);
    assert.equal(service.store.message(first.id).state, 'queued');
    await assert.rejects(startService({ dataRoot }), /SERVICE_ALREADY_RUNNING/);
  } finally { await service.close(); }
});

test('注入合成后端只有一次调用，后台出错标未知而非自动重试', async t => {
  const box = sandbox(t); let calls = 0;
  const service = await startService({ dataRoot: path.join(box.root, 'local'), now: () => origin,
    backend: { async reply() { calls++; if (calls === 2) throw Error('synthetic unknown'); return '仅用于测试的回复'; } } });
  try {
    const first = service.store.submit(input()); service.store.submit(input());
    await Promise.all([service.tick(), service.tick()]); await service.tick(); assert.equal(calls, 1);
    assert.equal(service.store.message(first.id).state, 'completed');
    const second = service.store.submit(input('second')); await service.tick(); await service.tick();
    assert.equal(calls, 2); assert.equal(service.store.message(second.id).state, 'unknown');
  } finally { await service.close(); }
});

test('服务拒绝已有未知数据目录及来源数据库', async t => {
  const box = sandbox(t); fs.mkdirSync(path.join(box.root, 'production-like')); fs.writeFileSync(path.join(box.root, 'production-like', 'keep'), 'original');
  await assert.rejects(startService({ dataRoot: path.join(box.root, 'production-like') }), /FOREIGN_DATA_ROOT_REFUSED/);
  const original = box.database('original.sqlite'); original.exec('CREATE TABLE precious(text TEXT)');
  assert.throws(() => new ChatStore(path.join(box.root, 'original.sqlite')), /FOREIGN_DATABASE_REFUSED/);
  assert.equal(original.prepare('PRAGMA application_id').get().application_id, 0);
});

test('同步分页不跳过事件，历史也可向前分页', t => {
  const box = sandbox(t), store = new ChatStore(path.join(box.root, 'chat.sqlite'), { now: () => origin });
  try {
    for (let i = 0; i < 230; i++) store.submit(input('m' + i));
    const batch1 = store.sync(store.epoch, 0); assert.equal(batch1.messages.length, 200); assert.equal(batch1.hasMore, true);
    const batch2 = store.sync(store.epoch, batch1.cursor); assert.equal(batch2.messages.length, 30); assert.equal(batch2.hasMore, false);
    assert.equal(new Set([...batch1.messages, ...batch2.messages].map(x => x.id)).size, 230);
    const newest = store.history(); const older = store.history(newest[0].seq); assert.equal(newest.length, 100); assert.equal(older.length, 100);
    assert.ok(older.at(-1).seq < newest[0].seq);
  } finally { store.close(); }
});

test('恢复旧快照隔离其中所有未结束工作，不能重做备份后已完成的请求', async t => {
  const box = sandbox(t);
  const source = await startService({ dataRoot: path.join(box.root, 'source'), now: () => origin });
  let restored;
  try {
    const first = source.store.submit(input('after-backup'));
    const second = source.store.submit(input('confirmed'));
    source.store.decide(second.id, second.revision, 'confirm');
    const stale = source.store.submit(input('stale', origin - 31 * 60000));
    const boot = await (await fetch(source.url + '/v1/bootstrap')).json();
    const manifest = await (await fetch(source.url + '/v1/backups', { method: 'POST', headers: { 'X-Chatagent-Token': boot.token, 'Content-Type': 'application/json' }, body: '{}' })).json();
    assert.equal(source.store.claim().id, first.id);
    source.store.complete(first.id, '备份之后才生成的回复');
    const target = path.join(box.root, 'restored');
    restoreLocalBackup(path.join(source.root, 'backups', manifest.id), target);
    let calls = 0;
    restored = await startService({ dataRoot: target, now: () => origin, backend: { async reply() { calls++; return '不应该执行'; } } });
    await restored.tick();
    assert.equal(calls, 0, '旧备份没有记录后续执行结果，不能自动重跑');
    for (const row of [first, second, stale]) assert.equal(restored.store.message(row.id).state, 'unknown');
    assert.equal(source.store.message(first.id).state, 'completed');
    assert.equal(restored.store.history().filter(row => row.role === 'assistant').length, 0);
  } finally { if (restored) await restored.close(); await source.close(); }
});

test('首次同步保留两百条以外仍会阻塞会话的待核对消息', t => {
  const box = sandbox(t), store = new ChatStore(path.join(box.root, 'chat.sqlite'), { now: () => origin });
  try {
    const blocker = store.submit(input('blocker'));
    store.claim(); store.unknown(blocker.id);
    for (let i = 0; i < 210; i++) {
      const row = store.submit(input('cancelled-' + i));
      store.decide(row.id, row.revision, 'cancel');
    }
    const reset = store.sync(null);
    assert.ok(reset.messages.some(row => row.id === blocker.id && row.state === 'unknown'));
    assert.equal(new Set(reset.messages.map(row => row.id)).size, reset.messages.length);
  } finally { store.close(); }
});

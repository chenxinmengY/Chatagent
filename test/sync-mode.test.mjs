import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ChatStore } from '../packages/conversation/store.mjs';
import { startService } from '../apps/service/server.mjs';
import { sandbox } from './helpers.mjs';

const origin = Date.parse('2026-11-02T13:00:00Z');
const input = (id, time = origin) => ({ deviceId: 'mode-sync-test', clientMessageId: id, text: '合成消息 ' + id, queuedAt: time });

test('模式改变持续同步，旧客户端预期不能悄悄升级为助手模式', async t => {
  const box = sandbox(t), service = await startService({ dataRoot: path.join(box.root, 'mode'), now: () => origin });
  try {
    const boot = await (await fetch(service.url + '/v1/bootstrap')).json();
    const call = async (route, body) => fetch(service.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Chatagent-Token': boot.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(boot.mode, 'social'); assert.equal(boot.modeRevision, 0);
    assert.equal((await call('/v1/messages', input('legacy-without-mode'))).status, 428);
    const accepted = await (await call('/v1/messages', { ...input('first'), expectedMode: 'social', expectedModeRevision: 0 })).json();
    assert.equal((await call('/v1/mode', { mode: 'assistant' })).status,400);
    // Legacy stored revisions still protect pending messages during migration.
    service.store.setMode('assistant');
    const sync = await (await call(`/v1/sync?epoch=${boot.epoch}&after=1`)).json();
    assert.equal(sync.mode, 'assistant'); assert.equal(sync.modeRevision, 1);
    const rejected = await call('/v1/messages', { ...input('stale-mode'), expectedMode: 'social', expectedModeRevision: 0 });
    assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error, 'MODE_CHANGED');
    assert.equal(service.store.lookup(input('stale-mode').deviceId, 'stale-mode'), null);
    const retry = await (await call('/v1/messages', { ...input('first'), expectedMode: 'social', expectedModeRevision: 0 })).json();
    assert.equal(retry.id, accepted.id); assert.equal(retry.mode, 'social');
    assert.equal((await (await call('/v1/messages', input('first'))).json()).id, accepted.id);
    await call('/v1/mode', { mode: 'social' });
    assert.equal((await call('/v1/messages', { ...input('aba'), expectedMode: 'social', expectedModeRevision: 0 })).status, 409);
    const current = await (await call('/v1/messages', { ...input('current'), expectedMode: 'social', expectedModeRevision: 2 })).json();
    assert.equal(current.state, 'queued');
    const cache = await (await call(`/v1/cache?epoch=${boot.epoch}&before=999&since=0`)).json();
    assert.equal(cache.messages.length, 2);
    assert.equal((await call('/v1/cache?epoch=old&before=999&since=0')).status, 409);
  } finally { await service.close(); }
});

test('近30天资料超过200条时可完整分页，旧待核对记录不改变历史边界', t => {
  const box = sandbox(t); let now = origin - 40 * 86400000;
  const store = new ChatStore(path.join(box.root, 'cache.sqlite'), { now: () => now });
  try {
    const blocker = store.submit(input('old-blocker', now)); store.claim(); store.unknown(blocker.id);
    const old = store.submit(input('old-history', now)); store.decide(old.id, old.revision, 'cancel');
    now = origin;
    for (let i = 0; i < 450; i++) { const row = store.submit(input('recent-' + i)); store.decide(row.id, row.revision, 'cancel'); }
    const initial = store.sync(null);
    assert.equal(initial.historyBefore, 253); assert.ok(initial.messages.some(row => row.id === blocker.id));
    const all = new Map(initial.messages.filter(row => row.created_at >= initial.cacheSince).map(row => [row.id, row]));
    const page1 = store.cachePage(initial.epoch, initial.historyBefore, initial.cacheSince);
    assert.equal(page1.messages.length, 200); assert.equal(page1.hasMore, true);
    // 持久化nextBefore之后中断，恢复只需沿用此游标，不能把旧pending的seq=1作为边界。
    const page2 = store.cachePage(initial.epoch, page1.nextBefore, initial.cacheSince);
    assert.equal(page2.messages.length, 50); assert.equal(page2.hasMore, false);
    for (const row of [...page1.messages, ...page2.messages]) all.set(row.id, row);
    assert.equal(all.size, 450); assert.ok(!all.has(old.id));
    assert.ok(store.history(initial.historyBefore).some(row => row.client_id === 'recent-249'));
    assert.throws(() => store.cachePage('stale-epoch', initial.historyBefore, initial.cacheSince), /ARCHIVE_CHANGED/);
    assert.throws(() => store.cachePage(initial.epoch, 0, initial.cacheSince), /INVALID_CURSOR/);
  } finally { store.close(); }
});

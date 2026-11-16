import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ChatStore } from '../packages/conversation/store.mjs';
import { startService } from '../apps/service/server.mjs';
import { DEFAULT_POLICY } from '../packages/conversation/preferences.mjs';
import { sandbox } from './helpers.mjs';

const origin = Date.parse('2026-11-06T01:00:00Z');
const input = (id, at = origin) => ({ deviceId: 'synthetic-phone', clientMessageId: id, text: id, queuedAt: at });

test('旧未知和待确认消息保留原样，重启后新消息仍可处理且不重放旧请求', t => {
  const box = sandbox(t), file = path.join(box.root, 'chat.sqlite');
  let store = new ChatStore(file, { now: () => origin });
  try {
    const old = store.submit(input('old-failure')); store.claim(); store.unknown(old.id);
    const stale = store.submit(input('old-unsent', origin - 31 * 60000));
    const before = [old, stale].map(row => store.message(row.id));
    store.close(); store = new ChatStore(file, { now: () => origin }); store.recoverInterrupted();
    const fresh = store.submit(input('new-message'));
    const run = store.claim({ policy: { ...DEFAULT_POLICY, mergeMs: 0 } });
    assert.equal(run?.id, fresh.id);
    assert.deepEqual(run.memberIds, [fresh.id]); assert.equal(run.text, 'new-message');
    store.complete(run.id, 'Synthetic new reply');
    assert.deepEqual([old, stale].map(row => store.message(row.id)), before);
    assert.equal(store.submit(input('old-failure')).state, 'unknown');
    assert.equal(store.claim(), null);
    assert.deepEqual(store.history().filter(row => row.role === 'assistant').map(row => row.parent), [fresh.id]);
  } finally { store.close(); }
});

test('新请求运行时确认较早的积压消息也不会并行执行', t => {
  const box = sandbox(t), store = new ChatStore(path.join(box.root, 'chat.sqlite'), { now: () => origin });
  try {
    const stale = store.submit(input('old-unsent', origin - 31 * 60000));
    const fresh = store.submit(input('new-message'));
    assert.equal(store.claim()?.id, fresh.id);
    store.decide(stale.id, stale.revision, 'confirm');
    assert.equal(store.claim(), null);
    store.complete(fresh.id, 'Synthetic new reply');
    assert.equal(store.claim()?.id, stale.id);
  } finally { store.close(); }
});

test('服务遇到后端失败后继续回复新消息，旧请求仅只读核对', async t => {
  const box = sandbox(t), calls = [], lookups = [];
  const service = await startService({ dataRoot: path.join(box.root, 'chat'), now: () => origin,
    backend: {
      async reply(request) { calls.push(request.id); if (calls.length === 1) throw Error('synthetic transport failure'); return 'Synthetic fresh reply'; },
      async lookupResult(request) { lookups.push(request.id); return null; }
    } });
  try {
    const old = service.store.submit(input('old-failure')); await service.tick();
    assert.equal(service.store.message(old.id).state, 'unknown');
    const original = service.store.message(old.id);
    const stale = service.store.submit(input('old-unsent', origin - 31 * 60000));
    const fresh = service.store.submit(input('new-message'));
    await Promise.all([service.tick(), service.tick()]); await service.tick();
    assert.deepEqual(calls, [old.id, fresh.id]);
    assert.ok(lookups.length > 0 && lookups.every(id => id === old.id));
    assert.deepEqual(service.store.message(old.id), original);
    assert.equal(service.store.message(stale.id).state, 'awaiting_confirmation');
    assert.equal(service.store.message(fresh.id).state, 'completed');
    assert.equal(service.store.history().filter(row => row.parent === fresh.id).length, 1);
  } finally { await service.close(); }
});

test('较早未知请求无结果或核对失败时，后续已完成语音也能轮到核对且仅补存一次', async t => {
  const box = sandbox(t), lookups = [], calls = [];
  const service = await startService({ dataRoot: path.join(box.root, 'chat'), now: () => origin,
    backend: {
      supportsAttachments: true,
      async reply(request) { calls.push(request.id); throw Error('must not replay'); },
      async lookupResult(request) {
        lookups.push(request.id);
        if (request.client_id === 'old-0') throw Error('synthetic lookup failure');
        return request.client_id === 'completed-voice' ? 'Synthetic saved voice reply' : null;
      }
    } });
  try {
    const unresolved = [];
    for (let i = 0; i < 3; i++) { const row = service.store.submit(input('old-' + i)); service.store.claim(); service.store.unknown(row.id); unresolved.push(service.store.message(row.id)); }
    const voice = service.store.submit({ ...input('completed-voice'), text: '', attachments: [{ id: '11111111-1111-4111-8111-111111111111', name: 'synthetic.wav', bytes: 44, sha256: 'a'.repeat(64), mediaType: 'audio/wav' }] });
    service.store.claim({ allowAttachments: true }); service.store.unknown(voice.id);
    for (let i = 0; i < 4; i++) await service.tick();
    assert.equal(service.store.message(voice.id).state, 'completed');
    assert.deepEqual(lookups.slice(0, 4), [...unresolved.map(row => row.id), voice.id]);
    for (let i = 0; i < 4; i++) await service.tick();
    assert.deepEqual(unresolved.map(row => service.store.message(row.id)), unresolved);
    assert.equal(service.store.history().filter(row => row.parent === voice.id).length, 1);
    assert.deepEqual(calls, []); assert.equal(lookups.filter(id => id === voice.id).length, 1);
  } finally { await service.close(); }
});

test('无法读取的旧附件不阻止后续未知请求核对', async t => {
  const box = sandbox(t), lookups = [];
  const service = await startService({ dataRoot: path.join(box.root, 'chat'), now: () => origin,
    backend: { async reply() { throw Error('must not replay'); }, async lookupResult(request) { lookups.push(request.id); return 'Synthetic saved text reply'; } } });
  try {
    const attachment = service.store.submit({ ...input('unsupported-old'), attachments: [{ id: '11111111-1111-4111-8111-111111111111', name: 'synthetic.wav', bytes: 44, sha256: 'b'.repeat(64), mediaType: 'audio/wav' }] });
    service.store.claim({ allowAttachments: true }); service.store.unknown(attachment.id);
    const text = service.store.submit(input('later-text')); service.store.claim(); service.store.unknown(text.id);
    await service.tick(); await service.tick();
    assert.equal(service.store.message(attachment.id).state, 'unknown'); assert.equal(service.store.message(text.id).state, 'completed'); assert.deepEqual(lookups, [text.id]);
  } finally { await service.close(); }
});

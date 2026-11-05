import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { ChatStore } from '../packages/conversation/store.mjs';
import { ModelConnections, createModelRouter, windowsSecrets, normalizeEndpoint, REHEARSAL_TEXT } from '../packages/dsh-adapter/model-connections.mjs';
import { startService } from '../apps/service/server.mjs';
import { sandbox } from './helpers.mjs';
import { nativeMessages, verifyNativeAdapter } from '../packages/dsh-adapter/antigravity.mjs';

const secrets = { protect: s => 'test-cipher:' + Buffer.from(s).toString('base64'), unprotect: s => Buffer.from(s.slice(12), 'base64').toString() };
const profile = (id = 'a') => ({ id, name: '测试 ' + id, protocol: 'chat-completions', baseUrl: 'https://model.invalid/v1', model: 'test-' + id, auth: 'key', apiKey: 'fake-key', maxTokens: 100, timeoutSeconds: 5 });
const setup = (t, options = {}) => {
  let store; t.after(() => store?.close());
  const box = sandbox(t); store = new ChatStore(path.join(box.root, 'chat.sqlite'));
  return { box, store, models: new ModelConnections(store, { secrets, ...options }) };
};
function save(models, profiles = [profile()], mode = 'rehearsal', selectedId = profiles[0]?.id ?? null) {
  return models.save({ revision: models.read().revision, profiles, mode, selectedId });
}
const response = content => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));

test('native multi-step turns use rotated credentials and preserve concurrent account replacement', async t => {
  const initial = { access: 'fake-old', refresh: 'fake-refresh-old', projectId: 'fake-project', expires: 0 };
  const rotated = { ...initial, access: 'fake-new', refresh: 'fake-refresh-new', expires: Date.now() + 3600000 };
  const replacement = { ...rotated, access: 'fake-other-account', refresh: 'fake-other-refresh', projectId: 'fake-other-project' };
  const received = []; let refresh = rotated;
  const { models } = setup(t, { allowNetwork: true, nativeRunner: async ({ credential, onCredential }) => {
    received.push(credential); if (refresh) onCredential(refresh); return [];
  } });
  const native = { ...profile(), apiKey: '', protocol: 'antigravity', auth: 'oauth', baseUrl: 'https://cloudcode-pa.googleapis.com', model: 'gemini-3.8-flash', oauthCredentials: initial };
  save(models, [native], 'real');
  const turn = models.snapshot(), draft = models.read();
  await models.nativeChunks(turn, {});
  // A previously opened form must preserve the newly encrypted credential.
  models.save(draft); refresh = null;
  await models.nativeChunks(turn, {});
  assert.deepEqual(received, [initial, rotated]);
  assert.deepEqual(JSON.parse(secrets.unprotect(models.snapshot().profile.secret)), rotated);
  const staleTurn = models.snapshot();
  const value = models.read(); models.save({ ...value, profiles: [{ ...value.profiles[0], oauthCredentials: replacement }] });
  refresh = { ...rotated, access: 'fake-last', refresh: 'fake-refresh-last' };
  await models.nativeChunks(staleTurn, {});
  assert.deepEqual(JSON.parse(secrets.unprotect(models.snapshot().profile.secret)), replacement);
  assert.equal(models.read().profiles[0].hasKey, true);
  assert.ok(!JSON.stringify(models.read()).includes('fake-other-refresh'));
});

test('model settings redact secrets, persist selection, reject stale writes and protect changed endpoints', t => {
  const { store, models } = setup(t); const first = save(models);
  assert.equal(first.mode, 'rehearsal'); assert.equal(first.profiles[0].hasKey, true);
  assert.ok(!JSON.stringify(first).includes('fake-key')); assert.ok(!JSON.stringify(first).includes('test-cipher:'));
  assert.ok(!store.db.prepare('SELECT value FROM settings WHERE key=?').get('model-connections-v1').value.includes('fake-key'));
  assert.throws(() => models.save({ ...first, revision: 0 }), /MODEL_CONFIG_CHANGED/);
  const later = models.save(first); assert.equal(later.profiles[0].hasKey, true);
  assert.throws(() => models.save({ ...later, profiles: [{ ...later.profiles[0], baseUrl: 'https://different.invalid/v1' }] }), /MODEL_ENDPOINT_KEY_REQUIRED/);
  const cleared = models.save({ ...later, profiles: [{ ...later.profiles[0], clearKey: true }] });
  assert.equal(cleared.profiles[0].hasKey, false);
  assert.equal(new ModelConnections(store, { secrets }).read().selectedId, 'a');
});

test('rehearsal lock blocks activation, probes and saved real-mode restoration without any fetch', async t => {
  let calls = 0; const { models, store } = setup(t, { fetchImpl: async () => { calls++; throw Error(); } });
  const value = save(models);
  assert.throws(() => models.save({ ...value, mode: 'real' }), /MODEL_REHEARSAL_LOCKED/);
  await assert.rejects(models.probe({ id: 'a', revision: value.revision }), /MODEL_REHEARSAL_LOCKED/);
  const enabled = new ModelConnections(store, { allowNetwork: true, secrets }); enabled.save({ ...value, mode: 'real' });
  assert.equal(models.read().mode, 'rehearsal'); assert.equal(models.snapshot().mode, 'rehearsal'); assert.equal(calls, 0);
});

test('model endpoint and profile validation refuses unsafe URLs, incomplete real selections and unknown protocols', t => {
  const { models } = setup(t, { allowNetwork: true });
  for (const url of ['file:///test', 'http://example.com/v1', 'https://name:password@example.com', 'https://example.com?key=secret', 'https://example.com/#x']) assert.throws(() => normalizeEndpoint(url), /MODEL_ENDPOINT_INVALID/);
  assert.throws(() => normalizeEndpoint('https://example.com/v1/chat/completions'), /MODEL_BASE_URL_REQUIRED/);
  assert.equal(normalizeEndpoint('http://127.0.0.1:39000/v1/'), 'http://127.0.0.1:39000/v1');
  assert.throws(() => save(models, [], 'real'), /MODEL_NOT_READY/);
  assert.throws(() => save(models, [{ ...profile(), apiKey: '' }], 'real'), /MODEL_NOT_READY/);
  assert.throws(() => save(models, [{ ...profile(), protocol: 'unknown' }]), /MODEL_CONFIG_INVALID/);
  assert.throws(() => save(models, [profile(), profile()]), /MODEL_CONFIG_INVALID/);
  assert.throws(() => save(models, [{ ...profile(), apiKey: 'bad\nkey' }]), /MODEL_KEY_INVALID/);
});

test('in-flight route snapshot stays on original model and key; later calls switch without mutating history', async t => {
  const calls = []; let release;
  const { models, store } = setup(t, { allowNetwork: true, fetchImpl: async (url, options) => {
    calls.push({ url, key: options.headers.Authorization, body: JSON.parse(options.body) });
    if (calls.length === 1) await new Promise(r => release = r);
    return response('ok');
  } });
  save(models, [profile('a'), { ...profile('b'), apiKey: 'second-key' }], 'real');
  const original = models.snapshot(), pending = models.completion(original, [{ role: 'user', content: 'test' }]);
  const next = models.read(); next.selectedId = 'b'; models.save(next); release(); await pending;
  await models.completion(models.snapshot(), [{ role: 'user', content: 'next' }]);
  assert.deepEqual(calls.map(c => c.body.model), ['test-a', 'test-b']);
  assert.deepEqual(calls.map(c => c.key), ['Bearer fake-key', 'Bearer second-key']);
  assert.equal(store.history().length, 0); assert.equal(original.profile.model, 'test-a');
});

test('connection probe uses only fixed prompt and explicit model, never changes active mode or chat', async t => {
  const calls = []; const { models, store } = setup(t, { allowNetwork: true, fetchImpl: async (url, opts) => { calls.push({ url, ...opts }); return response('OK'); } });
  const saved = save(models); const result = await models.probe({ id: 'a', revision: saved.revision });
  assert.equal(result.ok, true); assert.equal(models.read().mode, 'rehearsal'); assert.equal(store.history().length, 0);
  const payload = JSON.parse(calls[0].body); assert.deepEqual(payload.messages, [{ role: 'user', content: 'Reply with OK.' }]); assert.equal(payload.max_tokens, 16);
  assert.equal(calls[0].redirect, 'error'); assert.equal(calls.length, 1);
  await assert.rejects(models.probe({ id: 'a', revision: 0 }), /MODEL_CONFIG_CHANGED/); assert.equal(calls.length, 1);
});

test('connection failures are sanitized and never retried', async t => {
  for (const [answer, expected] of [[() => new Response('secret-body', { status: 401 }), 'MODEL_AUTH_FAILED'], [() => new Response('secret-body', { status: 429 }), 'MODEL_RATE_LIMITED'], [() => new Response('secret-body', { status: 500 }), 'MODEL_HTTP_FAILED'], [() => new Response('not-json'), 'MODEL_RESPONSE_INVALID'], [() => response(''), 'MODEL_RESPONSE_EMPTY'], [() => { throw Error('fake-key raw network error'); }, 'MODEL_CONNECTION_FAILED']]) {
    let calls = 0; const { models } = setup(t, { allowNetwork: true, fetchImpl: async () => { calls++; return answer(); } });
    const saved = save(models); await assert.rejects(models.probe({ id: 'a', revision: saved.revision }), error => error.message === expected && !error.message.includes('fake-key')); assert.equal(calls, 1);
  }
});

test('actual local HTTP protocol roundtrip, redirect protection and timeout abort', async t => {
  const requests = []; let hanging = false, redirected = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/redirect/chat/completions') { res.writeHead(307, { Location: '/stolen' }); res.end(); return; }
    if (req.url === '/stolen') redirected++;
    let text = ''; for await (const c of req) text += c;
    requests.push(JSON.parse(text)); if (hanging) return;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'local HTTP OK' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { models } = setup(t, { allowNetwork: true });
  const p = { ...profile(), baseUrl: `http://127.0.0.1:${server.address().port}/v1`, auth: 'none' }; const saved = save(models, [p]);
  assert.equal((await models.probe({ id: p.id, revision: saved.revision })).ok, true);
  const v = save(models, [{ ...p, baseUrl: `http://127.0.0.1:${server.address().port}/redirect` }]);
  await assert.rejects(models.probe({ id: p.id, revision: v.revision }), /MODEL_CONNECTION_FAILED/); assert.equal(redirected, 0);
  save(models, [p], 'real'); hanging = true;
  await assert.rejects(models.completion(models.snapshot(), [{ role: 'user', content: 'timeout' }], [], AbortSignal.timeout(50)), /MODEL_TIMEOUT/);
  assert.equal(requests.length, 2);
});

test('router binds all steps of one turn and translates tool calls without exposing keys', async t => {
  let received; const { models } = setup(t, { allowNetwork: true, fetchImpl: async (_, options) => {
    received = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } }] } }] }));
  } });
  save(models, [profile()], 'real'); const router = createModelRouter(); router.attach(models); const adapter = router.adapterFactory({ LlmAdapter: class {} });
  const chunks = await router.run(router.snapshot(), async () => Array.fromAsync(adapter.stream({ messages: [{ role: 'system', content: [{ type: 'text', text: 'persona' }] }, { role: 'user', content: [{ type: 'text', text: 'test' }] }], tools: [{ name: 'lookup', parameters: { type: 'object' } }] })));
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls'); assert.equal(chunks[2].block.name, 'lookup'); assert.equal(received.tools[0].function.parameters.type, 'object');
  save(models, models.read().profiles); const rehearsal = await router.run(router.snapshot(), async () => Array.fromAsync(adapter.stream({})));
  assert.equal(rehearsal[1].text, REHEARSAL_TEXT);
  await assert.rejects(Array.fromAsync(adapter.stream({})), /MODEL_TURN_BINDING_REQUIRED/);
});

test('model endpoints require local admin token and refuse authenticated phone devices', async t => {
  let service; t.after(() => service?.close());
  const box = sandbox(t); service = await startService({ dataRoot: path.join(box.root, 'service'), devicePort: 0, modelOptions: { secrets } });
  const boot = await (await fetch(service.url + '/v1/bootstrap')).json(), headers = { 'X-Chatagent-Token': boot.token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(service.url + '/v1/models')).status, 401);
  const v = await (await fetch(service.url + '/v1/models', { headers })).json();
  const saved = await (await fetch(service.url + '/v1/models', { headers, method: 'POST', body: JSON.stringify({ ...v, profiles: [profile()], selectedId: 'a' }) })).json();
  assert.equal(saved.profiles[0].hasKey, true); assert.equal(saved.mode, 'rehearsal');
  assert.equal((await fetch(service.url + '/v1/models/test', { headers, method: 'POST', body: JSON.stringify({ id: 'a', revision: saved.revision }) })).status, 409);
  const invite = await (await fetch(service.url + '/v1/pairing/invitations', { headers, method: 'POST', body: '{}' })).json();
  const deviceToken = randomBytes(32).toString('hex');
  await fetch(service.deviceUrl + '/v1/pairing/claim', { headers: { 'Content-Type': 'application/json' }, method: 'POST', body: JSON.stringify({ credential: invite.credential, deviceToken, name: 'test' }) });
  for (const route of ['/v1/models', '/v1/models/test']) assert.equal((await fetch(service.deviceUrl + route, { headers: { Authorization: 'Bearer ' + deviceToken } })).status, 403);
  assert.equal((await fetch(service.url + '/models')).status, 200);
});

test('Windows current-user secret protection roundtrips without plaintext ciphertext', { skip: process.platform !== 'win32' }, () => {
  const secret = 'isolated-verification-' + randomBytes(16).toString('hex'); const encrypted = windowsSecrets.protect(secret);
  assert.ok(!encrypted.includes(secret)); assert.equal(windowsSecrets.unprotect(encrypted), secret);
  assert.throws(() => windowsSecrets.unprotect('invalid'), /MODEL_CREDENTIAL_STORE_UNAVAILABLE/);
});

test('native message conversion preserves signed tool replay and result identity without changing history', () => {
  const replayState = { kind: 'antigravity', version: 1, provider: 'antigravity', model: 'gemini-3.8-flash', blocks: [{ type: 'tool-call', thoughtSignature: 'synthetic-signature' }] };
  const messages = [{ role: 'assistant', source: { kind: 'model', provider: 'chatagent-synthetic', model: 'synthetic-text', replayState }, content: [{ type: 'tool-call', id: 'one', name: 'lookup', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'one', isError: true, content: [{ type: 'text', text: 'synthetic error' }] },
    { role: 'assistant', source: { kind: 'model', model: 'other-model' }, content: [{ type: 'text', text: 'old reply' }] }];
  const old = structuredClone(messages), converted = nativeMessages(messages);
  assert.equal(converted[0].source.model, 'gemini-3.8-flash'); assert.equal(converted[0].source.replayState.blocks[0].thoughtSignature, 'synthetic-signature');
  assert.equal(converted[1].content[0].toolCallId, 'one'); assert.equal(converted[1].content[0].isError, true); assert.deepEqual(converted[1].content[0].content, messages[1].content);
  assert.equal(converted[2], messages[2]); assert.deepEqual(messages, old);
});

test('native proxy configuration accepts only explicit local HTTP proxies', t => {
  const box = sandbox(t), modulePath = path.join(box.root, 'adapter.js'); fs.writeFileSync(modulePath, 'synthetic adapter only');
  const base = { modulePath, sdkRoot: box.root, files: [{ name: 'adapter.js', sha256: createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex') }] };
  assert.doesNotThrow(() => verifyNativeAdapter({ ...base, proxyEnvironment: { HTTP_PROXY: 'http://127.0.0.1:12345', HTTPS_PROXY: 'http://localhost:12345' } }));
  assert.doesNotThrow(() => verifyNativeAdapter({ ...base, endpointPolicy: 'dsh-default' }));
  assert.throws(() => verifyNativeAdapter({ ...base, endpointPolicy: 'arbitrary' }), /MODEL_NATIVE_ENDPOINT_INVALID/);
  for (const proxyEnvironment of [{ HTTPS_PROXY: 'http://external.invalid:12345' }, { HTTP_PROXY: 'http://name:secret@localhost:12345' }, { HTTP_PROXY: 'socks5://localhost:12345' }, { NO_PROXY: '*' }]) assert.throws(() => verifyNativeAdapter({ ...base, proxyEnvironment }), /MODEL_PROXY_INVALID/);
});

test('native Antigravity configuration stays rehearsal without OAuth, rejects key substitution and secret carryover', async t => {
  const { models, store } = setup(t);
  const native = { ...profile(), protocol: 'antigravity', auth: 'oauth', baseUrl: 'https://cloudcode-pa.googleapis.com', model: 'gemini-3.8-flash' }; delete native.apiKey;
  const value = save(models, [native]); assert.equal(value.profiles[0].hasKey, false); assert.equal(models.snapshot().mode, 'rehearsal');
  assert.throws(() => save(models, [{ ...native, apiKey: 'plain-key' }]), /MODEL_OAUTH_REQUIRED/);
  assert.throws(() => save(models, [{ ...native, baseUrl: 'https://other.invalid' }]), /MODEL_NATIVE_ENDPOINT_INVALID/);
  await assert.rejects(models.probe({ id: 'a', revision: value.revision }), /MODEL_REHEARSAL_LOCKED/);
  const enabled = new ModelConnections(store, { allowNetwork: true, secrets });
  assert.throws(() => enabled.save({ ...value, mode: 'real' }), /MODEL_NOT_READY/);
  const oauth = { access: 'fake-access', refresh: 'fake-refresh', projectId: 'fake-project', expires: Date.now() + 3600000 };
  const saved = enabled.save({ ...value, profiles: [{ ...native, oauthCredentials: oauth }] });
  assert.equal(saved.profiles[0].hasKey, true); assert.ok(!JSON.stringify(saved).includes('fake-access'));
  const asKey = enabled.save({ ...saved, profiles: [{ ...profile(), apiKey: '' }] }); assert.equal(asKey.profiles[0].hasKey, false);
});

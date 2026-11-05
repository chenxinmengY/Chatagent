import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fault } from '../conversation/store.mjs';
import { ANTIGRAVITY_ENDPOINT, validateOAuth, runAntigravity } from './antigravity.mjs';

const KEY = 'model-connections-v1';
const empty = () => ({ revision: 0, mode: 'rehearsal', selectedId: null, profiles: [] });
const fail = code => fault(code, 400);
const safeText = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);

// Current-user DPAPI: credentials are never placed in command arguments or environment.
function dpapi(value, decrypt) {
  if (process.platform !== 'win32') throw fail('MODEL_CREDENTIAL_STORE_UNAVAILABLE');
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: decrypt ? value : Buffer.from(value, 'utf8').toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 65536
  });
  if (result.status !== 0 || !/^[A-Za-z0-9+/=]+$/.test(result.stdout ?? '')) throw fail('MODEL_CREDENTIAL_STORE_UNAVAILABLE');
  return decrypt ? Buffer.from(result.stdout, 'base64').toString('utf8') : result.stdout;
}
export const windowsSecrets = { protect: value => dpapi(value, false), unprotect: value => dpapi(value, true) };

export function normalizeEndpoint(value) {
  if (!safeText(value, 2048)) throw fail('MODEL_ENDPOINT_INVALID');
  let url; try { url = new URL(value.trim()); } catch { throw fail('MODEL_ENDPOINT_INVALID'); }
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) ||
      url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw fail('MODEL_ENDPOINT_INVALID');
  if (/\/(chat\/completions|responses|messages)\/?$/.test(url.pathname)) throw fail('MODEL_BASE_URL_REQUIRED');
  return url.href.replace(/\/+$/, '');
}
export class ModelConnections {
  constructor(store, { allowNetwork = false, secrets = windowsSecrets, fetchImpl = fetch, antigravity, nativeRunner = runAntigravity } = {}) {
    this.store = store; this.allowNetwork = allowNetwork; this.secrets = secrets; this.fetch = fetchImpl; this.probing = false;
    this.antigravity = antigravity;
    this.nativeRunner = nativeRunner;
    store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(KEY, JSON.stringify(empty()));
  }
  raw() { return JSON.parse(this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(KEY).value); }
  read() {
    const value = this.raw();
    return { ...value, mode: this.allowNetwork ? value.mode : 'rehearsal', networkAllowed: this.allowNetwork, nativeEndpointPolicy: this.antigravity?.endpointPolicy ?? 'single',
      profiles: value.profiles.map(({ secret, ...p }) => ({ ...p, hasKey: Boolean(secret) })) };
  }
  save(value) {
    const old = this.raw();
    if (value.revision !== old.revision) throw fault('MODEL_CONFIG_CHANGED', 409);
    if (!['rehearsal', 'real'].includes(value.mode) || !Array.isArray(value.profiles) || value.profiles.length > 20) throw fail('MODEL_CONFIG_INVALID');
    if (value.mode === 'real' && !this.allowNetwork) throw fault('MODEL_REHEARSAL_LOCKED', 409);
    const profiles = value.profiles.map(p => {
      if (!p || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id ?? '') || !safeText(p.name, 80) || !safeText(p.model, 200) || !['chat-completions','antigravity'].includes(p.protocol) ||
          !(p.protocol === 'antigravity' ? p.auth === 'oauth' : ['key', 'none'].includes(p.auth)) || !Number.isSafeInteger(p.maxTokens) || p.maxTokens < 1 || p.maxTokens > 131072 ||
          !Number.isSafeInteger(p.timeoutSeconds) || p.timeoutSeconds < 5 || p.timeoutSeconds > 90) throw fail('MODEL_CONFIG_INVALID');
      const baseUrl = normalizeEndpoint(p.baseUrl), previous = old.profiles.find(x => x.id === p.id);
      if (p.protocol === 'antigravity' && baseUrl !== ANTIGRAVITY_ENDPOINT) throw fail('MODEL_NATIVE_ENDPOINT_INVALID');
      let secret = previous?.secret ?? null;
      if (previous && previous.protocol !== p.protocol) secret = null;
      if (p.apiKey !== undefined && typeof p.apiKey !== 'string' || p.clearKey !== undefined && typeof p.clearKey !== 'boolean') throw fail('MODEL_KEY_INVALID');
      if (p.apiKey && (!safeText(p.apiKey, 8192) || p.apiKey !== p.apiKey.trim())) throw fail('MODEL_KEY_INVALID');
      if (previous?.baseUrl !== baseUrl && secret && !p.apiKey && !p.clearKey && p.auth !== 'none') throw fail('MODEL_ENDPOINT_KEY_REQUIRED');
      if (p.clearKey || p.auth === 'none') secret = null;
      if (p.apiKey && p.auth === 'key') secret = this.secrets.protect(p.apiKey);
      if (p.protocol === 'antigravity' && p.apiKey) throw fail('MODEL_OAUTH_REQUIRED');
      if (p.oauthCredentials !== undefined) {
        if (p.protocol !== 'antigravity') throw fail('MODEL_OAUTH_INVALID');
        secret = this.secrets.protect(JSON.stringify(validateOAuth(p.oauthCredentials)));
      }
      return { id: p.id, name: p.name.trim(), protocol: p.protocol, baseUrl, model: p.model.trim(), auth: p.auth, maxTokens: p.maxTokens, timeoutSeconds: p.timeoutSeconds, secret };
    });
    if (new Set(profiles.map(p => p.id)).size !== profiles.length || new Set(profiles.map(p => p.name)).size !== profiles.length ||
        value.selectedId !== null && !profiles.some(p => p.id === value.selectedId)) throw fail('MODEL_CONFIG_INVALID');
    const selected = profiles.find(p => p.id === value.selectedId);
    if (value.mode === 'real' && (!selected || selected.auth !== 'none' && !selected.secret)) throw fail('MODEL_NOT_READY');
    const next = { revision: old.revision + 1, mode: value.mode, selectedId: value.selectedId, profiles };
    this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(next), KEY);
    return this.read();
  }
  snapshot() {
    const value = this.raw();
    if (!this.allowNetwork || value.mode === 'rehearsal') return { mode: 'rehearsal', revision: value.revision };
    const profile = value.profiles.find(p => p.id === value.selectedId);
    if (!profile || profile.auth !== 'none' && !profile.secret) throw fail('MODEL_NOT_READY');
    return { mode: 'real', revision: value.revision, profile: { ...profile } };
  }
  async completion(snapshot, messages, tools = [], signal) {
    if (!this.allowNetwork || snapshot.mode !== 'real') throw fault('MODEL_REHEARSAL_LOCKED', 409);
    const p = snapshot.profile;
    if (p.protocol === 'antigravity') throw fail('MODEL_NATIVE_PROTOCOL_REQUIRED');
    const key = p.auth === 'key' ? this.secrets.unprotect(p.secret) : null;
    const timeout = AbortSignal.timeout(p.timeoutSeconds * 1000);
    try {
      const response = await this.fetch(p.baseUrl + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify({ model: p.model, messages, stream: false, max_tokens: p.maxTokens, ...(tools.length ? { tools } : {}) })
      });
      if (!response.ok) { await response.body?.cancel(); throw fail(response.status === 401 || response.status === 403 ? 'MODEL_AUTH_FAILED' : response.status === 429 ? 'MODEL_RATE_LIMITED' : 'MODEL_HTTP_FAILED'); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw fail('MODEL_RESPONSE_INVALID'); chunks.push(chunk); }
      let data; try { data = JSON.parse(Buffer.concat(chunks)); } catch { throw fail('MODEL_RESPONSE_INVALID'); }
      const choice = data?.choices?.[0], message = choice?.message;
      if (!message || message.role !== 'assistant' || !['stop', 'tool_calls'].includes(choice.finish_reason) ||
          message.content != null && typeof message.content !== 'string' ||
          message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw fail('MODEL_RESPONSE_INVALID');
      if (!message.content?.trim() && !message.tool_calls?.length) throw fail('MODEL_RESPONSE_EMPTY');
      for (const call of message.tool_calls ?? []) {
        if (call.type !== 'function' || !safeText(call.id, 200) || !safeText(call.function?.name, 200) || typeof call.function.arguments !== 'string') throw fail('MODEL_RESPONSE_INVALID');
        try { JSON.parse(call.function.arguments); } catch { throw fail('MODEL_RESPONSE_INVALID'); }
      }
      return { message, usage: data.usage };
    } catch (error) {
      if (error.status) throw error;
      throw fail(timeout.aborted || signal?.aborted ? 'MODEL_TIMEOUT' : 'MODEL_CONNECTION_FAILED');
    }
  }
  async nativeChunks(snapshot, options) {
    if (!this.allowNetwork || snapshot.mode !== 'real') throw fault('MODEL_REHEARSAL_LOCKED', 409);
    const p = snapshot.profile; if (!p.secret) throw fail('MODEL_OAUTH_REQUIRED');
    const credential = validateOAuth(JSON.parse(this.secrets.unprotect(p.secret)));
    return this.nativeRunner({ configuration: this.antigravity, profile: p, credential, options, signal: options.signal,
      home: path.join(path.dirname(this.store.file), 'native-isolation'),
      onCredential: next => {
        const saved = this.raw(), current = saved.profiles.find(item => item.id === p.id);
        const encrypted = this.secrets.protect(JSON.stringify(next));
        if (current?.secret === p.secret && current.protocol === 'antigravity') {
          current.secret = encrypted;
          this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(saved), KEY);
        }
        // Tool steps share this turn's profile. Carry its refreshed credential
        // forward without adopting or overwriting a concurrently replaced account.
        p.secret = encrypted;
      } });
  }
  async probe({ revision, id }) {
    if (!this.allowNetwork) throw fault('MODEL_REHEARSAL_LOCKED', 409);
    if (this.probing) throw fault('MODEL_TEST_BUSY', 409);
    const value = this.raw();
    if (revision !== value.revision) throw fault('MODEL_CONFIG_CHANGED', 409);
    const profile = value.profiles.find(p => p.id === id);
    if (!profile || profile.auth !== 'none' && !profile.secret) throw fail('MODEL_NOT_READY');
    this.probing = true;
    try {
      if (profile.protocol === 'antigravity') await this.nativeChunks({ mode: 'real', profile: { ...profile, maxTokens: 1024 } }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }] });
      else await this.completion({ mode: 'real', profile: { ...profile, maxTokens: 16 } }, [{ role: 'user', content: 'Reply with OK.' }]);
      return { ok: true, id, revision, model: profile.model, scope: 'fixed-test-prompt' };
    } finally { this.probing = false; }
  }
}

export const REHEARSAL_TEXT = '【本地演练响应】真实人格、记忆和插件已加载。此入口尚未连接外部模型，不代表小鲸鱼的真实回复；可以到“搬家档案”查看导入资料。';
export function createModelRouter() {
  const scope = new AsyncLocalStorage(); let connections;
  return {
    attach(value) { connections = value; },
    snapshot: () => connections?.snapshot() ?? { mode: 'rehearsal', revision: 0 },
    mode: () => connections?.read().mode ?? 'rehearsal',
    run: (snapshot, action) => scope.run(snapshot, action),
    async generateText({ prompt, maxTokens = 256, signal }) {
      const selected = scope.getStore() ?? connections?.snapshot();
      if (!selected || selected.mode !== 'real') throw fail('MODEL_REHEARSAL_LOCKED');
      const snapshot = { ...selected, profile: { ...selected.profile, maxTokens } };
      if (snapshot.profile.protocol === 'antigravity') {
        const chunks = await connections.nativeChunks(snapshot, { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], signal });
        return chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
      }
      return (await connections.completion(snapshot, [{ role: 'user', content: prompt }], [], signal)).message.content;
    },
    adapterFactory: ({ LlmAdapter }) => new class extends LlmAdapter {
      async *stream(options) {
        const selected = scope.getStore();
        if (!selected) throw fail('MODEL_TURN_BINDING_REQUIRED');
        if (selected.mode === 'real' && selected.profile.protocol === 'antigravity') {
          for (const chunk of await connections.nativeChunks(selected, options)) yield chunk;
          return;
        }
        let message = { content: REHEARSAL_TEXT }, usage;
        if (selected.mode === 'real') {
          const messages = options.messages.map(m => {
            if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role) || m.content.some(b => !['text', 'reasoning', 'tool-call'].includes(b.type))) throw fail('MODEL_CONTENT_UNSUPPORTED');
            const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('');
            const calls = m.content.filter(b => b.type === 'tool-call').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }));
            return { role: m.role === 'developer' ? 'system' : m.role, content: text || null, ...(m.role === 'tool' ? { tool_call_id: m.toolCallId } : {}), ...(calls.length ? { tool_calls: calls } : {}) };
          });
          const result = await connections.completion(selected, messages, (options.tools ?? []).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), options.signal);
          message = result.message; usage = result.usage;
        }
        let index = 0;
        if (message.content) {
          yield { type: 'block-start', index, blockType: 'text' }; yield { type: 'text-delta', index, text: message.content };
          yield { type: 'block-end', index, block: { type: 'text', text: message.content } }; index++;
        }
        for (const call of message.tool_calls ?? []) {
          yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index, id: call.id, name: call.function.name, argumentsDelta: call.function.arguments };
          yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments } }; index++;
        }
        if (usage && [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) yield { type: 'usage', usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } };
        yield { type: 'finish', reason: { kind: message.tool_calls?.length ? 'tool-calls' : 'stop' } };
      }
    }()
  };
}

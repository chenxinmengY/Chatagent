import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fault } from '../conversation/store.mjs';

export const ANTIGRAVITY_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_FALLBACK_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
export function validateOAuth(value) {
  if (!value || typeof value !== 'object' || !['access', 'refresh', 'projectId'].every(k => typeof value[k] === 'string' && value[k].length > 0 && value[k].length < 16384 && !/[\x00-\x20]/.test(value[k])) || !Number.isSafeInteger(value.expires) || value.expires < 0) throw fault('MODEL_OAUTH_INVALID', 400);
  return { access: value.access, refresh: value.refresh, projectId: value.projectId, expires: value.expires };
}
export function verifyNativeAdapter(configuration) {
  if (!configuration || !path.isAbsolute(configuration.modulePath ?? '') || !path.isAbsolute(configuration.sdkRoot ?? '') || !Array.isArray(configuration.files) || !configuration.files.length) throw fault('MODEL_NATIVE_ADAPTER_MISSING', 409);
  const directory = path.dirname(configuration.modulePath);
  for (const item of configuration.files) {
    if (!/^[\w-]+\.js$/.test(item.name) || !/^[a-f0-9]{64}$/.test(item.sha256) || createHash('sha256').update(fs.readFileSync(path.join(directory, item.name))).digest('hex') !== item.sha256) throw fault('MODEL_NATIVE_ADAPTER_CHANGED', 409);
  }
  if (!configuration.files.some(f => path.join(directory, f.name) === configuration.modulePath)) throw fault('MODEL_NATIVE_ADAPTER_CHANGED', 409);
  if (configuration.endpointPolicy !== undefined && !['single', 'dsh-default'].includes(configuration.endpointPolicy)) throw fault('MODEL_NATIVE_ENDPOINT_INVALID', 400);
  for (const [name, value] of Object.entries(configuration.proxyEnvironment ?? {})) {
    let url; try { url = new URL(value); } catch { throw fault('MODEL_PROXY_INVALID', 400); }
    if (!['HTTP_PROXY', 'HTTPS_PROXY'].includes(name) || !['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw fault('MODEL_PROXY_INVALID', 400);
  }
}
// The SDK records our stable routing model as the source. The native adapter
// needs the original model identity to recognize its signed replay blocks.
export function nativeMessages(messages) {
  return messages.map(message => {
    // Installed plugin versions use nested tool-result blocks; this SDK uses
    // a tool-role message with the call ID and result content on the message.
    if (message.role === 'tool') return message.content.some(block => block.type === 'tool-result') ? message : { ...message, content: [{ type: 'tool-result', toolCallId: message.toolCallId, content: message.content, isError: message.isError }] };
    const source = message.source, state = source?.replayState;
    if (source?.kind !== 'model' || state?.kind !== 'antigravity' || state.version !== 1 || state.provider !== 'antigravity' || typeof state.model !== 'string' || !Array.isArray(state.blocks)) return message;
    return { ...message, source: { ...source, provider: state.provider, model: state.model } };
  });
}
function nativeFailureCode(diagnostics) {
  const response = diagnostics.findLast(item => item.event === 'response' && item.status >= 400);
  if (response?.status === 429) return 'MODEL_RATE_LIMITED';
  if (response && ([401, 403].includes(response.status) || response.stage === 'oauth-refresh' && response.status === 400)) return 'MODEL_AUTH_FAILED';
  return response ? 'MODEL_HTTP_FAILED' : 'MODEL_NATIVE_FAILED';
}
export async function runAntigravity({ configuration, profile, credential, options, home, signal, onCredential, mockBase }) {
  verifyNativeAdapter(configuration); validateOAuth(credential);
  if (profile.baseUrl !== ANTIGRAVITY_ENDPOINT) throw fault('MODEL_NATIVE_ENDPOINT_INVALID', 400);
  if (mockBase && !/^http:\/\/(127\.0\.0\.1:\d+|chatagent-native-proxy\.invalid)$/.test(mockBase)) throw Error('MOCK_ENDPOINT_INVALID');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTIGRAVITY_|NOAGY_|DSH_HOME$|DSH_AGENTS_HOME$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|NODE_USE_ENV_PROXY$)/i.test(k)));
  Object.assign(env, configuration.proxyEnvironment, { DSH_HOME: home, DSH_AGENTS_HOME: path.join(home, 'agents') });
  if (configuration.endpointPolicy !== 'dsh-default') env.ANTIGRAVITY_BASE_URL = profile.baseUrl;
  const worker = new Worker(new URL('./antigravity-worker.mjs', import.meta.url), { env, stdout: true, stderr: true,
    workerData: { modulePath: configuration.modulePath, sdkRoot: configuration.sdkRoot, endpointPolicy: configuration.endpointPolicy, profile, credential, options: { messages: nativeMessages(options.messages), tools: options.tools ?? [], reasoningEffort: options.reasoningEffort }, mockBase } });
  // Do not forward third-party debug output; no production logger or plugin timers are installed.
  worker.stdout.resume(); worker.stderr.resume();
  const chunks = [], diagnostics = []; let timer;
  try {
    return await new Promise((resolve, reject) => {
      const abort = () => finish(fault('MODEL_TIMEOUT', 408));
      signal?.addEventListener('abort', abort, { once: true });
      const finish = (error, value) => {
        signal?.removeEventListener('abort', abort);
        if (error) reject(Object.assign(error, { diagnostics: [...diagnostics] }));
        else { Object.defineProperty(value, 'diagnostics', { value: [...diagnostics] }); resolve(value); }
      };
      timer = setTimeout(() => finish(fault('MODEL_TIMEOUT', 408)), profile.timeoutSeconds * 1000);
      if (signal?.aborted) return finish(fault('MODEL_TIMEOUT', 408));
      worker.on('message', message => {
        try {
          if (message.type === 'chunk') chunks.push(message.value);
          else if (message.type === 'network' && diagnostics.length < 32) diagnostics.push(message.value);
          else if (message.type === 'credential') onCredential?.(validateOAuth(message.value));
          else if (message.type === 'done') finish(null, chunks);
          else if (message.type === 'failed') {
            const code = nativeFailureCode(diagnostics);
            finish(fault(mockBase && code === 'MODEL_NATIVE_FAILED' ? code + ': ' + message.testError : code, 502));
          }
        } catch { finish(fault('MODEL_NATIVE_FAILED', 502)); }
      });
      worker.on('error', error => finish(fault(mockBase ? 'MODEL_NATIVE_FAILED: ' + String(error.message).replaceAll(credential.access, '[access]').replaceAll(credential.refresh, '[refresh]') : 'MODEL_NATIVE_FAILED', 502)));
      worker.on('exit', () => finish(fault('MODEL_NATIVE_FAILED', 502)));
    });
  } finally { clearTimeout(timer); await worker.terminate(); }
}

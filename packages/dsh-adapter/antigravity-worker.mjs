// A separate JS isolate hosts the installed adapter, never its plugin apply() or account files.
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import path from 'node:path';

const { modulePath, sdkRoot, endpointPolicy, profile, credential, options, mockBase } = workerData;
const fallbackEndpoint = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const sdkParent = pathToFileURL(path.join(sdkRoot, '..', '..', 'package.json')).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, specifier.startsWith('@deepseek-ai/') || specifier === 'undici' ? { ...context, parentURL: sdkParent } : context);
} });
let generations = 0, bytes = 0, complete = false, firstModel, lastGenerationStatus;
const submittedEndpoints = new Set();
const { installProxyFromEnvironment } = await import('@deepseek-ai/dsh-http-proxy');
await installProxyFromEnvironment({ get: name => process.env[name] === undefined ? undefined : { value: process.env[name] } }, () => {});
const { fetch: realFetch } = await import('undici');
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const generation = url.pathname === '/v1internal:streamGenerateContent';
  const discovery = url.pathname === '/v1internal:fetchAvailableModels';
  const refresh = url.href === 'https://oauth2.googleapis.com/token';
  const allowedEndpoint = url.origin === profile.baseUrl || endpointPolicy === 'dsh-default' && url.origin === fallbackEndpoint;
  if (!(allowedEndpoint && (generation || discovery) || refresh)) throw Error('NATIVE_ENDPOINT_REFUSED');
  const stage = generation ? 'generation' : refresh ? 'oauth-refresh' : 'model-catalog';
  const event = value => parentPort.postMessage({ type: 'network', value: { stage, endpoint: url.origin === fallbackEndpoint ? 'fallback' : refresh ? 'oauth' : 'primary', ...value } });
  if (generation) {
    const model = JSON.parse(init.body).model;
    if (generations && !(endpointPolicy === 'dsh-default' && generations === 1 && [403,404,429].includes(lastGenerationStatus) && !submittedEndpoints.has(url.origin) && firstModel === model)) {
      event({ event: 'retry-blocked' }); throw Error('NATIVE_REPLAY_REFUSED');
    }
    firstModel ??= model; generations++; submittedEndpoints.add(url.origin); lastGenerationStatus = undefined;
    event({ event: 'selected-model', model: /^[a-zA-Z0-9._-]{1,160}$/.test(model) ? model : 'unrecognized' });
  }
  const target = mockBase ? mockBase + url.pathname + url.search : url.href;
  event({ event: 'started' });
  let response;
  try { response = await realFetch(target, { ...init, redirect: 'error', ...(mockBase ? { headers: { ...init.headers, 'X-Chatagent-Mock-Endpoint': url.origin === fallbackEndpoint ? 'fallback' : 'primary' } } : {}) }); }
  catch (error) {
    const code = error.cause?.code ?? error.code;
    event({ event: 'transport-failed', code: ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','UND_ERR_CONNECT_TIMEOUT','ABORT_ERR','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code) ? code : 'NETWORK_ERROR' });
    throw error;
  }
  event({ event: 'response', status: response.status });
  if (generation) lastGenerationStatus = response.status;
  if (!generation || !response.ok) return response;
  let buffer = '', received = 0; const decoder = new TextDecoder();
  const line = value => {
    if (!value.startsWith('data:')) return;
    const raw = value.slice(5).trim(); if (!raw || raw === '[DONE]') return;
    const parsed = JSON.parse(raw), data = parsed.response ?? parsed;
    for (const candidate of data.candidates ?? []) if (['STOP','MAX_TOKENS','SAFETY','RECITATION','OTHER','MALFORMED_FUNCTION_CALL','UNEXPECTED_TOOL_CALL'].includes(candidate.finishReason)) event({ event: 'finish', reason: candidate.finishReason });
    if (data.candidates?.some(c => c.finishReason === 'STOP')) complete = true;
  };
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      received += chunk.length; if (received > 2 * 1024 * 1024) throw Error('NATIVE_RESPONSE_TOO_LARGE');
      buffer += decoder.decode(chunk, { stream: true });
      let end; while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end).trimEnd()); buffer = buffer.slice(end + 1); }
      controller.enqueue(chunk);
    }, flush() { buffer += decoder.decode(); if (buffer.trim()) line(buffer.trimEnd()); }
  }));
  return new Response(body, { status: response.status, headers: response.headers });
};
try {
  const { AntigravityPoolAdapter } = await import(pathToFileURL(modulePath).href);
  let current = { ...credential, id: 'chatagent-isolated-account' };
  const pool = { init: async () => {}, getCandidateAccounts: async () => [current],
    addOrUpdateAccount: async value => { current = { ...value }; parentPort.postMessage({ type: 'credential', value: { access: current.access, refresh: current.refresh, expires: current.expires, projectId: current.projectId } }); },
    clearCooldownUntil: async () => {}, markCooldown: async () => {} };
  const settings = { read: async () => ({ enabledModelIds: [profile.model], catalogModels: [{ id: profile.model, name: profile.model, inputModalities: ['text'], contextWindow: 1048576, maxTokens: profile.maxTokens, reasoningEfforts: ['low', 'medium', 'high'] }] }) };
  const adapter = new AntigravityPoolAdapter(pool, settings);
  for await (const chunk of adapter.stream({ ...options, provider: 'antigravity', model: profile.model, maxTokens: profile.maxTokens })) {
    bytes += Buffer.byteLength(JSON.stringify(chunk)); if (bytes > 2 * 1024 * 1024) throw Error('NATIVE_RESPONSE_TOO_LARGE');
    parentPort.postMessage({ type: 'chunk', value: chunk });
  }
  if (!complete) throw Error('NATIVE_COMPLETION_UNPROVEN');
  parentPort.postMessage({ type: 'done' });
} catch (error) {
  // Upstream errors may contain account/project identifiers. Keep them out of the public API.
  parentPort.postMessage({ type: 'failed', ...(mockBase ? { testError: String(error.message).replaceAll(credential.access, '[access]').replaceAll(credential.refresh, '[refresh]') } : {}) });
}

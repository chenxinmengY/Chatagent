import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { verifyTtsInstallation, createIsolatedTtsProvider } from '../packages/companion-capabilities/isolated-tts.mjs';
import { fileSha } from '../packages/companion-capabilities/vendor/singing/common.mjs';

function fixture(t) {
  const parent = path.resolve(process.platform === 'win32' ? path.parse(process.cwd()).root + 'ChatagentRuntime/tests' : '.verification-tmp'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'tts-install-'));
  for (const name of ['engine', 'models', 'refs']) fs.mkdirSync(path.join(root, name));
  for (const file of ['engine/audiocpp_server.exe', 'models/voice.gguf', 'refs/voice.wav']) fs.writeFileSync(path.join(root, file), 'synthetic-not-executable');
  const config = { host: '127.0.0.1', port: 37825, backend: 'cpu', threads: 2, lazy_load: true, log_request_body: false, models: [{ id: 'test', mode: 'offline', path: path.join(root, 'models/voice.gguf'), default_voice_preset: { voice_ref: path.join(root, 'refs/voice.wav') } }] };
  const seal = () => { fs.writeFileSync(path.join(root, 'server.json'), JSON.stringify(config)); const files = ['engine/audiocpp_server.exe', 'models/voice.gguf', 'refs/voice.wav', 'server.json'].map(file => ({ file, bytes: fs.statSync(path.join(root, file)).size, sha256: fileSha(path.join(root, file)) })); fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ format: 'chatagent-isolated-tts-v1', completed: true, model: 'test', files })); }; seal();
  t.after(() => { const actual = fs.realpathSync(root); if (path.dirname(actual).toLowerCase() !== fs.realpathSync(parent).toLowerCase() || !path.basename(actual).startsWith('tts-install-')) throw Error('CLEANUP_REFUSED'); fs.rmSync(actual, { recursive: true }); });
  return { root, config, seal };
}
test('独立TTS要求完整文件校验、CPU配置与专用端口', async t => {
  const { root, config, seal } = fixture(t); assert.equal((await verifyTtsInstallation(root)).config.backend, 'cpu');
  config.port = 8099; seal(); await assert.rejects(verifyTtsInstallation(root), /ISOLATION_CONFIGURATION/);
  config.port = 37825; config.backend = 'vulkan'; seal(); await assert.rejects(verifyTtsInstallation(root), /ISOLATION_CONFIGURATION/);
});

test('独立TTS允许已实测的HIP四线程，仍拒绝越界路径、未知后端和未验证的线程配置', async t => {
  const { root, config, seal } = fixture(t);
  config.backend = 'hip'; config.threads = 4; seal(); assert.equal((await verifyTtsInstallation(root)).config.backend, 'hip');
  config.threads = 0; seal(); await assert.rejects(verifyTtsInstallation(root), /ISOLATION_CONFIGURATION/);
  config.threads = 4; config.models[0].default_voice_preset.voice_ref = path.resolve(root, '../production.wav'); seal(); await assert.rejects(verifyTtsInstallation(root), /ISOLATION_CONFIGURATION/);
});
test('独立TTS拒绝损坏模型与越界资源，不启动任何二进制', async t => {
  const { root, config, seal } = fixture(t), file = path.join(root, 'models/voice.gguf');
  const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes); await assert.rejects(verifyTtsInstallation(root), /INSTALLATION_CHANGED/);
  config.models[0].path = path.resolve(root, '../production-model.gguf'); seal(); await assert.rejects(verifyTtsInstallation(root), /ISOLATION_CONFIGURATION/);
});

test('冷启动模型哈希校验让出事件循环，回执轮询不被大模型文件阻塞，并支持取消', async t => {
  const { root, seal } = fixture(t); fs.truncateSync(path.join(root, 'models/voice.gguf'), 32 * 1024 * 1024); seal();
  let heartbeats = 0; const timer = setInterval(() => heartbeats++, 1);
  try { await verifyTtsInstallation(root); } finally { clearInterval(timer); }
  assert.ok(heartbeats > 0, 'HTTP receipt handling must remain responsive during checksum verification');
  const controller = new AbortController(); controller.abort(); await assert.rejects(verifyTtsInstallation(root, controller.signal), { name: 'AbortError' });
});
test('TTS生成拒绝覆写已有文件或无效请求，关闭后不能启动', async t => {
  const { root } = fixture(t), provider = createIsolatedTtsProvider({ root });
  const directory = path.join(root, 'outputs'); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'same.wav'), 'keep');
  await assert.rejects(provider.synthesize({ text: 'test', directory, id: 'same' }), /OUTPUT_EXISTS/); assert.equal(fs.readFileSync(path.join(directory, 'same.wav'), 'utf8'), 'keep');
  await assert.rejects(provider.synthesize({ text: 'test', directory, id: '../escape' }), /REQUEST_INVALID/); await provider.close();
  await assert.rejects(provider.synthesize({ text: 'test', directory, id: 'new' }), /PROVIDER_CLOSED/);
});

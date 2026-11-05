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
test('独立TTS要求完整文件校验、CPU配置与专用端口', t => {
  const { root, config, seal } = fixture(t); assert.equal(verifyTtsInstallation(root).config.backend, 'cpu');
  config.port = 8099; seal(); assert.throws(() => verifyTtsInstallation(root), /ISOLATION_CONFIGURATION/);
  config.port = 37825; config.backend = 'hip'; seal(); assert.throws(() => verifyTtsInstallation(root), /ISOLATION_CONFIGURATION/);
});
test('独立TTS拒绝损坏模型与越界资源，不启动任何二进制', t => {
  const { root, config, seal } = fixture(t); fs.appendFileSync(path.join(root, 'models/voice.gguf'), 'changed'); assert.throws(() => verifyTtsInstallation(root), /INSTALLATION_CHANGED/);
  config.models[0].path = path.resolve(root, '../production-model.gguf'); seal(); assert.throws(() => verifyTtsInstallation(root), /ISOLATION_CONFIGURATION/);
});
test('TTS生成拒绝覆写已有文件或无效请求，关闭后不能启动', async t => {
  const { root } = fixture(t), provider = createIsolatedTtsProvider({ root });
  const directory = path.join(root, 'outputs'); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'same.wav'), 'keep');
  await assert.rejects(provider.synthesize({ text: 'test', directory, id: 'same' }), /OUTPUT_EXISTS/); assert.equal(fs.readFileSync(path.join(directory, 'same.wav'), 'utf8'), 'keep');
  await assert.rejects(provider.synthesize({ text: 'test', directory, id: '../escape' }), /REQUEST_INVALID/); await provider.close();
  await assert.rejects(provider.synthesize({ text: 'test', directory, id: 'new' }), /PROVIDER_CLOSED/);
});

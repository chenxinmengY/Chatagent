import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileSha } from './vendor/singing/common.mjs';
import { assertPlain } from '../migration/standby-capture.mjs';
import { verifyAudio } from './media.mjs';

export function verifyTtsInstallation(root) {
  if (!path.isAbsolute(root)) throw Error('TTS_ROOT_MUST_BE_ABSOLUTE'); root = path.resolve(root); assertPlain(root);
  if (process.platform === 'win32' && /[^\x20-\x7e]/.test(root)) throw Error('TTS_NATIVE_ASCII_ROOT_REQUIRED');
  const read = name => { assertPlain(path.join(root, name)); return JSON.parse(fs.readFileSync(path.join(root, name))); };
  const manifest = read('manifest.json');
  if (manifest.format !== 'chatagent-isolated-tts-v1' || manifest.completed !== true || !Array.isArray(manifest.files)) throw Error('TTS_INSTALLATION_INCOMPLETE');
  const names = new Set();
  for (const item of manifest.files) {
    if (typeof item.file !== 'string' || !/^[\w./-]+$/.test(item.file) || item.file.split('/').some(x => !x || x === '.' || x === '..') || names.has(item.file)) throw Error('TTS_INSTALLATION_PATH');
    names.add(item.file); const file = path.join(root, item.file); assertPlain(file);
    if (fs.statSync(file).size !== item.bytes || fileSha(file) !== item.sha256) throw Error('TTS_INSTALLATION_CHANGED');
  }
  for (const required of ['server.json', 'engine/audiocpp_server.exe', 'models/voice.gguf', 'refs/voice.wav']) if (!names.has(required)) throw Error('TTS_INSTALLATION_INCOMPLETE');
  const config = read('server.json');
  if (config.host !== '127.0.0.1' || config.port !== 37825 || config.backend !== 'cpu' || config.threads !== 2 || config.lazy_load !== true || config.log_request_body !== false || config.models?.length !== 1 || config.models[0].path !== path.join(root, 'models/voice.gguf') || config.models[0].default_voice_preset?.voice_ref !== path.join(root, 'refs/voice.wav') || config.models[0].id !== manifest.model || config.models[0].mode !== 'offline') throw Error('TTS_ISOLATION_CONFIGURATION');
  return { root, manifest, config };
}

async function requireFreePort(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', () => reject(Error('TTS_PORT_ALREADY_OWNED'))); probe.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
  await new Promise(resolve => probe.close(resolve));
}
function ownsListener(pid, port) {
  if (process.platform !== 'win32') throw Error('TTS_PLATFORM_NOT_VERIFIED');
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort ${port} -ErrorAction Stop).OwningProcess`], { windowsHide: true, timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (text !== String(pid)) throw Error('TTS_LISTENER_IDENTITY_CHANGED');
}

// Lazy, owned local CPU server. It never discovers or reuses the production
// server, and receives only the explicit text passed to this provider.
export function createIsolatedTtsProvider({ root, startupMs = 30000, requestMs = 180000 }) {
  let child, childEnded, starting, pending = false, closed = false, verified;
  const terminate = async () => {
    const owned = child, ended = childEnded; child = null; childEnded = null;
    if (owned?.pid && owned.exitCode === null && owned.signalCode === null) owned.kill();
    await ended;
  };
  async function start(signal) {
    if (closed) throw Error('TTS_PROVIDER_CLOSED');
    if (child && child.exitCode === null && child.signalCode === null) { ownsListener(child.pid, verified.config.port); return; }
    if (starting) return starting;
    starting = (async () => {
      verified = verifyTtsInstallation(root); signal?.throwIfAborted(); await requireFreePort(verified.config.port);
      const logs = path.join(verified.root, 'logs'); fs.mkdirSync(logs, { recursive: true }); assertPlain(logs);
      const outFile = path.join(logs, 'stdout.log'), errFile = path.join(logs, 'stderr.log'); assertPlain(outFile); assertPlain(errFile);
      const stdout = fs.openSync(outFile, 'a'), stderr = fs.openSync(errFile, 'a');
      try { child = spawn(path.join(verified.root, 'engine/audiocpp_server.exe'), ['--config', path.join(verified.root, 'server.json'), '--no-ui', '--max-loaded-models', '1', '--idle-unload-ms', '60000', '--min-free-memory-mb', '1024'], { cwd: verified.root, windowsHide: true, stdio: ['ignore', stdout, stderr] }); }
      finally { fs.closeSync(stdout); fs.closeSync(stderr); }
      childEnded = new Promise(resolve => child.once('close', resolve));
      let launchError; child.on('error', () => { launchError = Error('TTS_PROCESS_START_FAILED'); });
      const deadline = Date.now() + startupMs;
      try {
        while (Date.now() < deadline) {
          signal?.throwIfAborted(); if (launchError || child.exitCode !== null) throw launchError ?? Error('TTS_PROCESS_EXITED');
          try {
            const response = await fetch(`http://127.0.0.1:${verified.config.port}/health`, { redirect: 'error', signal: AbortSignal.timeout(500) });
            if (response.ok) { ownsListener(child.pid, verified.config.port); return; }
          } catch (e) { if (e.message === 'TTS_LISTENER_IDENTITY_CHANGED') throw e; }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw Error('TTS_START_TIMEOUT');
      } catch (e) { await terminate(); throw e; }
    })().finally(() => { starting = null; }); return starting;
  }
  const synthesize = async ({ text, directory, id, signal }) => {
    if (pending) throw Error('TTS_PROVIDER_BUSY');
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || !/^[\w-]{1,100}$/.test(id) || !path.isAbsolute(directory)) throw Error('TTS_REQUEST_INVALID');
    assertPlain(directory); if (!fs.statSync(directory).isDirectory()) throw Error('TTS_OUTPUT_DIRECTORY');
    const file = path.join(directory, id + '.wav'); assertPlain(file); if (fs.existsSync(file)) throw Error('TTS_OUTPUT_EXISTS');
    pending = true;
    const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(requestMs)]);
    try {
      await start(abort); ownsListener(child.pid, verified.config.port); abort.throwIfAborted();
      const response = await fetch(`http://127.0.0.1:${verified.config.port}/v1/audio/speech`, { method: 'POST', redirect: 'error', signal: abort, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: verified.manifest.model, input: text }) });
      if (!response.ok) throw Error('TTS_HTTP_' + response.status);
      const chunks = []; let size = 0;
      for await (const block of response.body) { size += block.length; if (size > 64 * 1024 * 1024) throw Error('TTS_RESPONSE_TOO_LARGE'); chunks.push(block); }
      abort.throwIfAborted(); const bytes = Buffer.concat(chunks);
      if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Error('TTS_WAV_REQUIRED');
      fs.writeFileSync(file, bytes, { flag: 'wx' }); const sha256 = fileSha(file);
      const checked = await verifyAudio(file, { expectedHash: sha256, maxSeconds: 600, signal: abort });
      return { file, sha256, seconds: checked.seconds, provenance: 'isolated-local-cosyvoice3-cpu', losslessTransport: true };
    } catch (e) { await terminate(); throw e; } finally { pending = false; }
  };
  synthesize.kind = 'isolated-local-cosyvoice3-cpu';
  return { synthesize, status: () => ({ connected: !!child && child.exitCode === null, busy: pending, cpuOnly: true }), async close() { closed = true; await starting?.catch(() => {}); await terminate(); } };
}

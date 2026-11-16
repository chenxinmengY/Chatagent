import fs from 'node:fs';
import path from 'node:path';
import { assertPlain } from '../packages/migration/standby-capture.mjs';
import { fileSha } from '../packages/companion-capabilities/vendor/singing/common.mjs';

const [source, destination] = process.argv.slice(2);
if (!source || !destination || ![source, destination].every(path.isAbsolute)) throw Error('USAGE: prepare-isolated-tts <absolute-audio-cpp-root> <new-absolute-root>');
const from = path.resolve(source), root = path.resolve(destination);
if (process.platform === 'win32' && /[^\x20-\x7e]/.test(root)) throw Error('TTS_NATIVE_ASCII_ROOT_REQUIRED');
for (const p of [from, root]) assertPlain(p);
const relative = path.relative(from, root);
if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) || fs.existsSync(root)) throw Error('TTS_DESTINATION_REFUSED');
const sourceConfig = JSON.parse(fs.readFileSync(path.join(from, 'server.json'))), model = sourceConfig.models.find(m => m.id === 'cosyvoice3-feiyu');
if (!model || model.family !== 'cosyvoice3' || model.task !== 'clon' || model.mode !== 'offline') throw Error('TTS_SOURCE_CONFIGURATION_CHANGED');
fs.mkdirSync(root, { recursive: true });
const manifest = { format: 'chatagent-isolated-tts-v1', completed: false, model: model.id, files: [] };
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
function copy(input, target) {
  assertPlain(input); const st = fs.lstatSync(input);
  if (st.isDirectory()) { fs.mkdirSync(target); for (const name of fs.readdirSync(input).sort()) copy(path.join(input, name), path.join(target, name)); return; }
  if (!st.isFile()) throw Error('TTS_SOURCE_TYPE_REFUSED');
  const before = fileSha(input), source = fs.openSync(input, 'r'), output = fs.openSync(target, 'wx'), buffer = Buffer.alloc(256 * 1024);
  try {
    let count; while ((count = fs.readSync(source, buffer, 0, buffer.length, null))) { let written = 0; while (written < count) { const n = fs.writeSync(output, buffer, written, count - written); if (!n) throw Error('TTS_COPY_WRITE_FAILED'); written += n; } }
    fs.fsyncSync(output);
  } finally { fs.closeSync(source); fs.closeSync(output); }
  if (fileSha(target) !== before || fileSha(input) !== before) throw Error('TTS_SOURCE_CHANGED');
  manifest.files.push({ file: path.relative(root, target).replaceAll('\\', '/'), bytes: st.size, sha256: before });
}
copy(path.join(from, 'bin64'), path.join(root, 'engine'));
fs.mkdirSync(path.join(root, 'models')); fs.mkdirSync(path.join(root, 'refs'));
copy(model.path, path.join(root, 'models/voice.gguf')); copy(model.default_voice_preset.voice_ref, path.join(root, 'refs/voice.wav'));
const config = { host: '127.0.0.1', port: 37825, backend: 'cpu', threads: 2, lazy_load: true, log_request_body: false,
  models: [{ ...model, path: path.join(root, 'models/voice.gguf'), default_voice_preset: { ...model.default_voice_preset, voice_ref: path.join(root, 'refs/voice.wav') } }] };
const file = path.join(root, 'server.json'); fs.writeFileSync(file, JSON.stringify(config, null, 2), { flag: 'wx' });
manifest.files.push({ file: 'server.json', bytes: fs.statSync(file).size, sha256: fileSha(file) }); manifest.completed = true;
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ root, files: manifest.files.length, bytes: manifest.files.reduce((n, f) => n + f.bytes, 0), backend: config.backend, port: config.port }));

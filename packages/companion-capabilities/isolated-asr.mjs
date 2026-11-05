import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileSha } from './vendor/singing/common.mjs';
import { assertPlain } from '../migration/standby-capture.mjs';

function run(command, args, { input, signal, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { windowsHide: true, timeout, signal, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { let result; try { result = JSON.parse(stdout); } catch {} reject(Error(/^ASR_[A-Z_]+$/.test(result?.error) ? result.error : 'ASR_PROCESS_FAILED')); }
      else resolve(stdout);
    });
    child.stdin.on('error', () => {}); child.stdin.end(input ?? '');
  });
}
export function verifyAsrInstallation(root) {
  if (!path.isAbsolute(root)) throw Error('ASR_ABSOLUTE_ROOT_REQUIRED');
  assertPlain(root); const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))), names = new Set();
  if (manifest.format !== 'chatagent-isolated-asr-v1' || manifest.completed !== true || !Array.isArray(manifest.files)) throw Error('ASR_INSTALLATION_INCOMPLETE');
  for (const item of manifest.files) {
    if (typeof item.file !== 'string' || item.file.split('/').some(x => !x || x === '.' || x === '..') || path.isAbsolute(item.file) || item.file.includes('\\') || names.has(item.file)) throw Error('ASR_INSTALLATION_PATH');
    names.add(item.file); const file = path.join(root, item.file); assertPlain(file);
    if (fs.statSync(file).size !== item.bytes || fileSha(file) !== item.sha256) throw Error('ASR_INSTALLATION_CHANGED');
  }
  for (const name of ['env/Scripts/python.exe', 'model/model.int8.onnx', 'model/tokens.txt', 'worker.py', 'ffmpeg.exe']) if (!names.has(name)) throw Error('ASR_INSTALLATION_INCOMPLETE');
  return manifest;
}
export function createIsolatedAsrProvider({ root }) {
  let verified = false, pending = false;
  return async ({ file, directory, signal, offsetSeconds = 0, segmentSeconds = 123 }) => {
    if (pending) throw Error('ASR_BUSY');
    pending = true;
    try {
      if (!verified) { verifyAsrInstallation(root); verified = true; }
      assertPlain(file); assertPlain(directory);
      if(!Number.isFinite(offsetSeconds)||offsetSeconds<0||offsetSeconds>1800||!Number.isFinite(segmentSeconds)||segmentSeconds<=0||segmentSeconds>123)throw Error('ASR_SEGMENT_INVALID');
      const wav = path.join(directory, 'input.wav'); if (fs.existsSync(wav)) throw Error('ASR_OUTPUT_EXISTS');
      // Bound decoded samples even for containers with malicious duration metadata.
      await run(path.join(root, 'ffmpeg.exe'), ['-nostdin', '-v', 'error', '-xerror', '-ss', String(offsetSeconds), '-i', file, '-t', String(segmentSeconds), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-n', wav], { signal, timeout: 30000 });
      const stdout = await run(path.join(root, 'env/Scripts/python.exe'), ['-I', '-B', path.join(root, 'worker.py')], { input: JSON.stringify({ root, wav }), signal });
      const result = JSON.parse(stdout);
      if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 16000 || result.kind !== 'local-sensevoice-transcription') throw Error('ASR_RESULT_INVALID');
      return result;
    } finally { pending = false; }
  };
}

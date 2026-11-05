import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlain } from '../migration/standby-capture.mjs';
import { fileSha, checkedSegments, sha } from './vendor/singing/common.mjs';
import { createWorkerClient } from './vendor/singing/worker-client.mjs';
import { createSingingSource } from './vendor/singing/source.mjs';
import { ownedFile } from './media.mjs';
import { verifyInstallationFiles } from './installation-integrity.mjs';

const design = 'singing-design-20261031', accel = 'singing-repair-20261031/acceleration';
const vendor = fileURLToPath(new URL('./vendor/singing/', import.meta.url));
export function verifySingingInstallation(root) {
  if (!path.isAbsolute(root) || /[^\x20-\x7e]/.test(root)) throw Error('SINGING_ASCII_ROOT_REQUIRED');
  root = path.resolve(root); assertPlain(root);
  const manifest = JSON.parse(fs.readFileSync(ownedFile(root, path.join(root, 'manifest.json'))));
  if (manifest.format !== 'chatagent-isolated-singing-v1' || manifest.completed !== true || !Array.isArray(manifest.files)) throw Error('SINGING_INSTALLATION_INCOMPLETE');
  const seen = verifyInstallationFiles(root, manifest.files);
  const read = relative => { if (!seen.has(relative)) throw Error('SINGING_INSTALLATION_INCOMPLETE'); return JSON.parse(fs.readFileSync(path.join(root, relative))); };
  const cpu = read(design + '/rvc/runtime.cpu.json'), synth = read(accel + '/rvc-synth-dml/profile.json'), hybrid = read(accel + '/rvc-synth-dml/hybrid-profile.json');
  const expectedPython = path.join(root, design, 'rvc/env/Scripts/python.exe');
  if (cpu.python !== expectedPython || cpu.repo !== path.join(root, design, 'rvc/source/Applio') || cpu.backend !== 'cpu' || cpu.precision !== 'float32' || synth.python !== path.join(root, accel, 'dml-env/Scripts/python.exe') || synth.cpu_profile_sha256 !== fileSha(path.join(root, design, 'rvc/runtime.cpu.json')) || hybrid.cpu_profile_sha256 !== synth.cpu_profile_sha256 || hybrid.synth_profile_sha256 !== fileSha(path.join(root, accel, 'rvc-synth-dml/profile.json')) || hybrid.synthesis_backend !== 'dml') throw Error('SINGING_ISOLATION_CONFIGURATION');
  for (const relative of ['singing-delivery-20261101/runtime/worker.py', 'python312/python.exe', design + '/rvc/env/Scripts/python.exe', accel + '/rvc-worker/owned_process.py']) if (!seen.has(relative)) throw Error('SINGING_INSTALLATION_INCOMPLETE');
  return { root, manifest, python: expectedPython, launcherPython: path.join(root, 'python312/python.exe'), ownershipModule: path.join(root, accel, 'rvc-worker'), entry: path.join(root, 'singing-delivery-20261101/runtime/worker.py') };
}

// Import only the completed artifacts of this exact owned worker run. Do not
// let a worker's absolute output paths expand the capability host's file scope.
export function importSingingResult({ runtimeDirectory, outputRoot, id, mode, result }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || ['.', '..'].includes(id)) throw Error('SINGING_JOB_ID');
  const jobRoot = path.join(runtimeDirectory, 'jobs', id), master = ownedFile(jobRoot, result?.master?.path);
  if (!/^[a-f0-9]{64}$/.test(result.master.sha256 ?? '') || fileSha(master) !== result.master.sha256 || fs.statSync(master).size > 256 * 1024 * 1024) throw Error('SINGING_MASTER_CHANGED');
  let segments;
  if (mode === 'clip') {
    ownedFile(jobRoot, result.segmentsManifest); segments = checkedSegments(result.segmentsManifest);
    if (segments.manifestSha256 !== result.segmentsManifestSha256) throw Error('SINGING_SEGMENTS_CHANGED');
  } else if (mode !== 'whole') throw Error('SINGING_MODE_INVALID');
  assertPlain(outputRoot); fs.mkdirSync(outputRoot, { recursive: true });
  const folder = path.join(outputRoot, id); assertPlain(folder); fs.mkdirSync(folder);
  const copy = (source, name, expected) => {
    const target = path.join(folder, name), bytes = fs.readFileSync(source);
    if (sha(bytes) !== expected) throw Error('SINGING_RESULT_CHANGED');
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    if (fileSha(target) !== expected || fileSha(source) !== expected) throw Error('SINGING_RESULT_CHANGED'); return target;
  };
  const imported = { master: { ...result.master, path: copy(master, 'master.wav', result.master.sha256) } };
  if (segments) {
    for (const part of segments.parts) copy(part.file, path.basename(part.file), part.sha256);
    imported.segmentsManifest = copy(result.segmentsManifest, 'segments.json', result.segmentsManifestSha256);
    imported.segmentsManifestSha256 = result.segmentsManifestSha256; checkedSegments(imported.segmentsManifest);
  }
  return imported;
}

export function createIsolatedSingingWorker({ root, outputRoot, startupMs = 120000 }) {
  if (!path.isAbsolute(root) || !path.isAbsolute(outputRoot)) throw Error('SINGING_ABSOLUTE_ROOT_REQUIRED');
  let client, starting, closed = false;
  async function start(signal) {
    if (closed) throw Error('SINGING_PROVIDER_CLOSED'); signal?.throwIfAborted();
    if (client?.ready) return;
    if (starting) return starting;
    starting = (async () => {
      const installation = verifySingingInstallation(root); signal?.throwIfAborted();
      if (installation.manifest.finalized !== true) throw Error('SINGING_INSTALLATION_NOT_FINALIZED');
      if (client) throw Error('SINGING_WORKER_NOT_READY');
      client = createWorkerClient({ ...installation, directory: path.join(root, 'client-state'), shutdownGraceMs: 5000 });
      const deadline = Date.now() + startupMs;
      try {
        while (!client.ready) {
          signal?.throwIfAborted(); if (closed) throw Error('SINGING_PROVIDER_CLOSED');
          if (client.state === 'unavailable') throw Error('SINGING_WORKER_UNAVAILABLE');
          if (Date.now() >= deadline) throw Error('SINGING_START_TIMEOUT');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!client.runtimeDirectory) throw Error('SINGING_RUNTIME_IDENTITY_INVALID');
      } catch (e) { await client.close(); throw e; }
    })().finally(() => { starting = null; }); return starting;
  }
  return {
    get ready() { return !closed && (!client || client.ready); }, get state() { return closed ? 'unavailable' : client?.state ?? 'idle'; },
    get ownershipReport() { return client?.ownershipReport; }, get runtimeDirectory() { return client?.runtimeDirectory; }, start,
    async run(args) { ownedFile(outputRoot, args.inputPath); await start(args.signal); const result = await client.run(args); args.signal?.throwIfAborted(); return importSingingResult({ runtimeDirectory: client.runtimeDirectory, outputRoot, id: args.id, mode: args.mode ?? 'clip', result }); },
    cancel(id) { client?.cancel(id); },
    async close() { closed = true; await client?.close(); await starting?.catch(() => {}); }
  };
}

export function createIsolatedSingingSource({ root, capabilityRoot, python }) {
  const installation = verifySingingInstallation(root);
  if (installation.manifest.finalized !== true || path.resolve(python) !== path.join(installation.root, 'bili-env/Scripts/python.exe')) throw Error('SINGING_SOURCE_PYTHON_NOT_ISOLATED');
  ownedFile(root, python);
  for (const file of [python, path.join(root, 'python312/python.exe'), path.join(root, accel, 'rvc-worker/owned_process.py')]) { if (!path.isAbsolute(file)) throw Error('SINGING_ABSOLUTE_ROOT_REQUIRED'); assertPlain(file); }
  const downloader = path.join(vendor, 'anonymous-audio-download.py');
  return createSingingSource({ directory: path.join(capabilityRoot, 'singing-source'), inputsDirectory: path.join(capabilityRoot, 'singing-inputs'), python,
    launcherPython: path.join(root, 'python312/python.exe'), ownershipModule: path.join(root, accel, 'rvc-worker'), ownedProcessDir: path.join(root, accel, 'rvc-worker'), downloader, downloaderSha256: fileSha(downloader) });
}

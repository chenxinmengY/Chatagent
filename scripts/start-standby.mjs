import fs from 'node:fs';
import path from 'node:path';
import { createCompanion } from '../packages/dsh-adapter/companion.mjs';
import { createIsolatedDshRuntime } from '../packages/dsh-adapter/isolated-runtime.mjs';
import { startService } from '../apps/service/server.mjs';
import { verifyStandbyCapture } from '../packages/migration/standby-capture.mjs';
import { createIsolatedTtsProvider } from '../packages/companion-capabilities/isolated-tts.mjs';
import { readDeviceTlsOptions } from '../packages/devices/tls-config.mjs';
import { createModelRouter } from '../packages/dsh-adapter/model-connections.mjs';
import { createIsolatedAsrProvider } from '../packages/companion-capabilities/isolated-asr.mjs';
import { createIsolatedSingingSource, createIsolatedSingingWorker } from '../packages/companion-capabilities/isolated-singing.mjs';
import { fileSha } from '../packages/companion-capabilities/vendor/singing/common.mjs';

const configFile = path.resolve(process.argv[2] ?? (fs.existsSync('data/standby-v0210-launch.private.json') ? 'data/standby-v0210-launch.private.json' : 'data/standby-launch.private.json'));
const config = JSON.parse(fs.readFileSync(configFile));
if (![config.dataRoot, config.captureRoot, config.sdkRoot].every(value => typeof value === 'string' && path.isAbsolute(value)) || !['local-rehearsal', 'configured-model'].includes(config.mode)) throw Error('STANDBY_LAUNCH_CONFIG_INVALID');
// Optional, explicitly configured device TLS listener; never issues a certificate.
const deviceOptions = config.device ? readDeviceTlsOptions(config.device) : {};
const captured = JSON.parse(fs.readFileSync(path.join(config.captureRoot, '.standby-capture.json')));
if (captured.format !== 'chatagent-standby-v1' || captured.completed !== true) throw Error('STANDBY_CAPTURE_INCOMPLETE');
verifyStandbyCapture(config.captureRoot);
// Existing launch files remain network-locked. No production preset or credentials are discovered.
const modelRouter = createModelRouter();
const runtime = await createIsolatedDshRuntime({ sdkRoot: config.sdkRoot, dataRoot: path.join(config.dataRoot, 'dsh'), adapterFactory: modelRouter.adapterFactory, modelRouter, turnTimeoutMs: 120000,
  speechRecognizer: config.asrRoot ? createIsolatedAsrProvider({ root: config.asrRoot }) : undefined,
  companionFactory: ({ root }) => {
    const tts = config.ttsRoot ? createIsolatedTtsProvider({ root: config.ttsRoot }) : null;
    const capabilityRoot=path.join(root,'workspaces/companion/state/chatagent-capabilities');
    let singing={};
    if(config.mode==='configured-model'&&config.singingRoot){
      let source;
      const singingSource=()=>source??=createIsolatedSingingSource({root:config.singingRoot,capabilityRoot,python:path.join(config.singingRoot,'bili-env/Scripts/python.exe')});
      singing={singingWorker:createIsolatedSingingWorker({root:config.singingRoot,outputRoot:capabilityRoot}),
        singingSource:{resolve:(...args)=>singingSource().resolve(...args),prepare:(...args)=>singingSource().prepare(...args)},recipeDigest:fileSha(path.join(config.singingRoot,'manifest.json'))};
    }
    return createCompanion({ root: path.join(root, 'workspaces/companion'), sourceWorkspace: path.join(config.captureRoot, 'workspace'), capabilityArchive: config.capabilityArchive, generateText: modelRouter.generateText,
      capabilityProviders: { ...singing, ...(tts ? { voiceSynthesize: tts.synthesize, close: () => tts.close(),
        ...(config.mode === 'configured-model' ? { voiceIntent: ({ instruction, context, signal }) => modelRouter.generateText({ prompt: instruction + '\n' + JSON.stringify(context), maxTokens: 128, signal }) } : {}) } : {}) } });
  } });
let service;
try { service = await startService({ dataRoot: path.join(config.dataRoot, 'chat'), port: config.port ?? 37822, backend: runtime,
  modelOptions: { allowNetwork: config.mode === 'configured-model', antigravity: config.nativeAdapters?.antigravity },
  preferencesSeed: config.preferencesSeed ? JSON.parse(fs.readFileSync(config.preferencesSeed, 'utf8')) : undefined, ...deviceOptions }); }
catch (error) { await runtime.close(); throw error; }
console.log(JSON.stringify({ url: service.url, mode: config.mode, snapshot: captured.id, externalModelAllowed: config.mode === 'configured-model' }));
let closing;
const close = () => closing ??= (async () => { await service.close(); await runtime.close(); })();
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());

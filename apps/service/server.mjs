import {SessionTools} from '../../packages/conversation/session-tools.mjs';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import fs from 'node:fs';
import { PortableArchive, hash } from '../../packages/migration/portable.mjs';
import { timelinePage } from '../../packages/conversation/timeline.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { ChatStore, fault } from '../../packages/conversation/store.mjs';
import { captureRuntimeBackup } from '../../packages/migration/runtime-backup.mjs';
import { AttachmentStore, MAX_ATTACHMENT_BYTES, MAX_CHUNK_BYTES } from '../../packages/storage/attachments.mjs';
import { verifyLocalDatabase } from '../../packages/migration/local-restore.mjs';
import { DeviceStore } from '../../packages/devices/store.mjs';
import { BackupCoordinator } from '../../packages/migration/backup-coordinator.mjs';
import { ownerRecord, ownerDefinitelyGone } from '../../packages/storage/process-owner.mjs';
import { Preferences } from '../../packages/conversation/preferences.mjs';
import { Profiles } from '../../packages/conversation/profiles.mjs';
import { ModelConnections } from '../../packages/dsh-adapter/model-connections.mjs';
import { createProactiveScheduler } from '../../packages/conversation/proactive.mjs';

const publicRoot = fileURLToPath(new URL('../web/', import.meta.url));
// Fetch/browser clients reject these ports even when the OS assigns one to 0.
const fetchUnsafePorts=new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);

function ownRoot(root) {
  root = path.resolve(root);
  let existing = root;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (fs.realpathSync(existing).toLowerCase() !== existing.toLowerCase()) throw fault('DATA_ROOT_LINK_REFUSED');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  if (fs.realpathSync(root).toLowerCase() !== root.toLowerCase()) throw fault('DATA_ROOT_LINK_REFUSED');
  const marker = path.join(root, '.chatagent-local.json');
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(root).length) throw fault('FOREIGN_DATA_ROOT_REFUSED');
    fs.writeFileSync(marker, JSON.stringify({ format: 'chatagent-local-v1', id: randomUUID() }), { flag: 'wx' });
  }
  if (fs.lstatSync(marker).isSymbolicLink() || JSON.parse(fs.readFileSync(marker, 'utf8')).format !== 'chatagent-local-v1') throw fault('FOREIGN_DATA_ROOT_REFUSED');
  return root;
}

function acquireLock(root) {
  const file = path.join(root, 'service.lock'), token = randomUUID();
  const guard = path.join(root, 'service-lock-guard');
  try { fs.mkdirSync(guard); } catch { throw fault('SERVICE_LOCK_CHECK_IN_PROGRESS'); }
  try {
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink()) throw fault('LOCK_LINK_REFUSED');
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw fault('INVALID_SERVICE_LOCK');
    if (!ownerDefinitelyGone(previous, file)) throw fault('SERVICE_ALREADY_RUNNING');
    fs.renameSync(file, path.join(root, 'stale-lock-' + randomUUID() + '.json'));
  }
  fs.writeFileSync(file, JSON.stringify(ownerRecord(token)), { flag: 'wx' });
  } finally { fs.rmdirSync(guard); }
  return () => { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); };
}

export async function startService({ dataRoot, port = 0, devicePort, deviceTls, deviceHost = '127.0.0.1', deviceHostname = deviceHost, automaticBackups = false, backupIdleMs = 5 * 60000, backend = null, preferencesSeed, modelOptions, now = Date.now, allowChatSpaces=true } = {}) {
  const tailAddress = /^100\.(\d+)\.(\d+)\.(\d+)$/.exec(deviceHost);
  const isTailAddress = isIP(deviceHost) === 4 && tailAddress && Number(tailAddress[1]) >= 64 && Number(tailAddress[1]) <= 127;
  if (deviceHost !== '127.0.0.1' && (!deviceTls || !isTailAddress)) throw fault('PRIVATE_TLS_LISTENER_REQUIRED');
  if (!/^[a-zA-Z0-9.-]+$/.test(deviceHostname) || deviceHostname.length > 253 || deviceHostname.includes('..') ||
      devicePort === undefined && (deviceTls || deviceHost !== '127.0.0.1')) throw fault('INVALID_DEVICE_LISTENER');
  if (typeof automaticBackups !== 'boolean' || !Number.isSafeInteger(backupIdleMs) || backupIdleMs < 0) throw fault('INVALID_BACKUP_OPTIONS');
  const root = ownRoot(dataRoot), release = acquireLock(root);
  let store, attachments, devices;
  try { store = new ChatStore(path.join(root, 'chat.sqlite'), { now }); attachments = new AttachmentStore(path.join(root, 'attachments')); devices = new DeviceStore(path.join(root, 'devices.sqlite'), { now }); store.recoverInterrupted(); }
  catch (error) { devices?.close(); attachments?.close(); store?.close(); release(); throw error; }
  const portable = new PortableArchive(store);
  if(store.mode()!=='social')store.setMode('social');
  let preferences, models, profiles;
  try { profiles = new Profiles(store); preferences = new Preferences(store, preferencesSeed); models = new ModelConnections(store, modelOptions); backend?.attachModels?.(models); }
  catch (error) { devices.close(); attachments.close(); store.close(); release(); throw error; }
  const sessionTools=new SessionTools(store);
  const activeSession=()=>backend?.status?.().modeBindings?.find(b=>b.mode==='social')?.session_id;
  store.db.exec('CREATE TABLE IF NOT EXISTS chat_spaces(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  const children=new Map();
  const spaceRows=()=>store.db.prepare('SELECT body FROM chat_spaces ORDER BY rowid').all().map(r=>JSON.parse(r.body));
  async function openSpace(id){
    if(!allowChatSpaces||!spaceRows().some(r=>r.id===id))throw fault('CHAT_NOT_FOUND',404);
    if(!children.has(id)){const job=(async()=>{const childBackend=await backend.openChat(id);try{return {...await startService({dataRoot:path.join(root,'conversations',id),backend:childBackend,now,allowChatSpaces:false}),backend:childBackend};}catch(e){await childBackend.close?.();throw e;}})();children.set(id,job);job.catch(()=>children.delete(id));}
    return children.get(id);
  }
  function spaceSummary(id,db){const value=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='preferences'").get().value),mode=value.modes.social,persona=value.personas.find(p=>p.id===mode.personaId),last=db.prepare("SELECT text,created_at FROM messages ORDER BY seq DESC LIMIT 1").get();return {id,name:mode.name,personaId:persona?.id??null,personaName:persona?.name??'未指定人格',policy:value.policy,messageCount:db.prepare('SELECT COUNT(*) n FROM messages').get().n,lastMessage:last?.text?.slice(0,100)??'',lastAt:last?.created_at??null};}
  function listSpaces(){return [spaceSummary('default',store.db),...spaceRows().map(row=>{const db=new DatabaseSync(path.join(root,'conversations',row.id,'chat.sqlite'),{readOnly:true});try{return spaceSummary(row.id,db);}finally{db.close();}})];}
  async function createSpace(value){
    if(!allowChatSpaces||!backend?.openChat)throw fault('MULTI_CHAT_NOT_CONNECTED',409);
    if(!/^[a-f0-9-]{36}$/.test(value.id??'')||typeof value.name!=='string'||!value.name.trim()||value.name.length>80)throw fault('INVALID_CHAT',400);
    const existing=spaceRows().find(r=>r.id===value.id);if(existing){if(existing.name!==value.name.trim()||existing.personaId!==value.personaId)throw fault('CHAT_ID_REUSED',409);await openSpace(value.id);return {id:value.id};}
    if(spaceRows().length>=100)throw fault('CHAT_LIMIT',400);
    const library=preferences.read(),persona=library.personas.find(p=>p.id===value.personaId);if(!persona)throw fault('INVALID_PERSONA',400);
    const folder=ownRoot(path.join(root,'conversations',value.id)),dbStore=new ChatStore(path.join(folder,'chat.sqlite'),{now});
    try{new Preferences(dbStore,{personas:library.personas,categories:library.categories,activePersonaId:persona.id,modes:{social:{name:value.name.trim()}}});const profile=new Profiles(dbStore);profile.save('agent',{...profile.read('agent'),nickname:value.name.trim().slice(0,40)});}finally{dbStore.close();}
    store.db.prepare('INSERT INTO chat_spaces VALUES(?,?)').run(value.id,JSON.stringify({id:value.id,name:value.name.trim(),personaId:value.personaId,createdAt:now()}));
    await openSpace(value.id);return {id:value.id};
  }
  const describe = row => ({ id: row.id, name: row.name, bytes: row.bytes, sha256: row.sha256, mediaType: row.media_type, ...(row.state === 'ready' && row.media_type.startsWith('audio/') ? { durationMs: attachments.audioDuration(row.id) } : {}) });
  // Presentation metadata is projected onto wire responses; original message rows stay byte-for-byte intact.
  const audioDetails = value => {
    if (Array.isArray(value)) return value.map(audioDetails);
    if (value && Array.isArray(value.attachments) && value.role) return { ...value, attachments: value.attachments.map(file => file.mediaType?.startsWith('audio/') ? { ...file, durationMs: attachments.audioDuration(file.id) } : file) };
    if (value && Array.isArray(value.messages)) return { ...value, messages: audioDetails(value.messages) };
    return value;
  };
  const token = randomBytes(32).toString('hex');
  let active = null, closed = false, backupJob = null, maintenance = false, closeJob, lastActivity = now(), lastContextCheck = 0;
  try { backend?.attachDelivery?.({ store, attachments }); }
  catch (error) { devices.close(); attachments.close(); store.close(); release(); throw error; }
  const proactive=createProactiveScheduler({store,backend,preferences,now});
  async function tick() {
    if (closed || active || maintenance) return;
    store.expire();
    if (store.flushReplyParts()) lastActivity = now();
    if (!backend) return;
    active = (async () => {
      try { await backend.flushDeliveries?.(); } catch { /* The DSH outbox retains unacknowledged deliveries. */ }
      if (typeof backend.lookupResult === 'function') {
        const unknown = store.hydrate(store.db.prepare("SELECT * FROM messages WHERE role='user' AND state='unknown' ORDER BY seq LIMIT 1").get());
        if (unknown && (!unknown.attachments.length || backend.supportsAttachments === true)) {
          try {
            const text = await backend.lookupResult(store.workRequest(unknown));
            if (text !== null) { store.complete(unknown.id, text, unknown.revision); lastActivity = now(); }
          } catch { /* 无法证明完成，继续保留unknown，禁止重跑。 */ }
        }
      }
      if (maintenance || closed) return;
      const head = store.db.prepare("SELECT mode FROM messages WHERE mode='social' AND role='user' AND state IN ('queued','awaiting_confirmation','running','unknown') ORDER BY seq LIMIT 1").get();
      const request = store.claim({ allowAttachments: backend.supportsAttachments === true, policy: {...preferences.forMode('social'),...(backend?.kind==='dsh-bridge'&&activeSession()?{allowedTools:sessionTools.read(activeSession()).allowedTools,disabledTools:[]}:{})}, mode:'social' });
      if (!request) {
        if(!head&&!store.db.prepare("SELECT 1 FROM reply_parts WHERE state='queued' LIMIT 1").get())await proactive.tick();
        if (!head && !store.db.prepare("SELECT 1 FROM reply_parts WHERE state='queued' LIMIT 1").get() && now() - lastContextCheck >= 30000 && now() - lastActivity >= preferences.read().policy.contextIdleSeconds * 1000) {
          lastContextCheck = now(); await backend.maintainContext?.(preferences.read());
        }
        return;
      }
      let reply;
      try { reply = await backend.reply(request); store.complete(request.id, reply); lastActivity = now(); }
      catch { store.unknown(request.id); }
      // Post-reply media failure must never turn a saved text reply into an
      // unknown model turn. Recovery reads text only, never replays media jobs.
      if (reply !== undefined && store.message(request.id).state === 'completed') {
        try { await backend.afterReply?.(request, reply); } catch { /* Capability ledger retains its own outcome. */ }
      }
    })();
    try { await active; } finally { active = null; }
  }
  let coordinator;
  try { coordinator = new BackupCoordinator({ file: path.join(root, 'backup-jobs.json'), capture: localBackup, enabled: automaticBackups, now,
    isIdle: () => !closed && !active && !maintenance && now() - lastActivity >= backupIdleMs }); }
  catch (error) { devices.close(); attachments.close(); store.close(); release(); throw error; }
  async function localBackup() {
    if (closed) throw fault('SERVICE_CLOSED', 503);
    if (backupJob) return backupJob;
    maintenance = true;
    backupJob = (async () => {
      if (active) await active;
      const directory = path.join(root, 'backups');
      if (!fs.existsSync(directory)) fs.mkdirSync(directory);
      if (fs.lstatSync(directory).isSymbolicLink()) throw fault('BACKUP_LINK_REFUSED');
      const id = randomUUID(), stage = path.join(directory, '.staging-' + id), destination = path.join(directory, id);
      if (backend && !backend.externalRuntime || attachments.count()) return captureRuntimeBackup({ store, runtime: backend?.externalRuntime ? null : backend, attachments: attachments.count() ? attachments : null, destination, now });
      fs.mkdirSync(stage);
      const file = path.join(stage, 'chat.sqlite');
      await backup(store.db, file);
      const probe = new DatabaseSync(file, { readOnly: true });
      let count;
      try {
        if (probe.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw fault('BACKUP_CHECK_FAILED');
        count = probe.prepare('SELECT COUNT(*) n FROM messages').get().n;
      } finally { probe.close(); }
      if (verifyLocalDatabase(file, count).length) throw fault('BACKUP_ATTACHMENTS_MISSING');
      const manifest = { version: 1, id, createdAt: now(), coverage: ['chatagent.local-chat.sqlite'], status: 'complete',
        messages: count, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), productionMigration: false };
      fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
      fs.renameSync(stage, destination); return manifest;
    })();
    try { return await backupJob; } finally { backupJob = null; maintenance = false; }
  }
  const bootstrap = () => ({ chatName:preferences.read().modes.social.name, epoch: store.epoch, mode: store.mode(), modeRevision: store.modeRevision(), modelMode: backend?.externalRuntime ? 'dsh-managed' : backend ? models.read().mode : 'not-connected', backend: backend?.kind==='dsh-bridge' ? 'dsh-bridge' : backend ? 'test-injected' : 'not-connected', attachmentLimit: MAX_ATTACHMENT_BYTES, chunkLimit: MAX_CHUNK_BYTES, mediaModel: backend?.supportsAttachments === true });
  const handler = deviceOnly => async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
    const send = (status, value, type = 'application/json; charset=utf-8') => { const content=type.startsWith('application/json') ? JSON.stringify(audioDetails(value)) : value; res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(content); };
    try {
      const host = `${deviceOnly ? deviceHostname : '127.0.0.1'}:${(deviceOnly ? deviceServer : server).address().port}`, origin = `${deviceOnly && deviceTls ? 'https' : 'http'}://${host}`;
      const standardTlsHost = deviceOnly && deviceTls && deviceServer.address().port === 443 && req.headers.host === deviceHostname;
      if (req.headers.host !== host && !standardTlsHost || (req.headers.origin && (deviceOnly || req.headers.origin !== origin)) || req.headers['sec-fetch-site'] === 'cross-site') throw fault('ORIGIN_REFUSED', 403);
      const url = new URL(req.url, origin), route = url.pathname;
      const scopedRoute=/^\/v1\/chats\/([a-f0-9-]{36})\/(v1\/.*)$/.exec(route);
      const assets = { '/overview': ['overview.html', 'text/html; charset=utf-8'], '/overview.js': ['overview.js', 'text/javascript; charset=utf-8'], '/shell.js': ['shell.js', 'text/javascript; charset=utf-8'], '/desktop.css': ['desktop.css', 'text/css; charset=utf-8'], '/whale.svg': ['whale.svg', 'image/svg+xml'], '/archive': ['archive.html', 'text/html; charset=utf-8'], '/archive.js': ['archive.js', 'text/javascript; charset=utf-8'], '/': ['index.html', 'text/html; charset=utf-8'], '/devices': ['devices.html', 'text/html; charset=utf-8'], '/devices.js': ['devices.js', 'text/javascript; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/manage': ['manage.html', 'text/html; charset=utf-8'], '/manage.js': ['manage.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/outbox.js': ['outbox.js', 'text/javascript; charset=utf-8'], '/message-presentation.js': ['message-presentation.js', 'text/javascript; charset=utf-8'], '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'] };
      for(const name of ['customize.html','customize.js','customize.css'])assets[name==='customize.html'?'/customize':'/'+name]=[name,name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'];
      assets['/appearance-values.js']=['../../packages/conversation/appearance.mjs','text/javascript; charset=utf-8'];
      assets['/appearance.js']=['appearance.js','text/javascript; charset=utf-8'];
      const settingsViews={appearance:'customize.html',data:'customize.html',workspace:'customize.html',reply:'manage.html',personas:'manage.html',sessions:'manage.html',profiles:'profiles.html',models:'models.html',devices:'devices.html'};
      const settingsSection=url.searchParams.get('section')??'appearance';
      assets['/settings']=[Object.hasOwn(settingsViews,settingsSection)?settingsViews[settingsSection]:'customize.html','text/html; charset=utf-8'];
      assets['/chats']=['chats.html','text/html; charset=utf-8'];
      assets['/plugins']=[url.searchParams.get('section')==='records'?'archive.html':url.searchParams.get('plugin')==='course-query'?'course.html':['fish-notebook','media-browser'].includes(url.searchParams.get('plugin'))?'plugin-detail.html':'plugins.html','text/html; charset=utf-8'];
      for(const file of ['bubble-arrival.js','course.js','chat-settings.js','tool-catalog.js','chat-settings.css','plugin-detail.js','plugin-detail.css','plugin-records.js','chat-scope.js','chats.js','chats.css'])assets['/'+file]=[file,file.endsWith('.json')?'application/json':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'];
      assets['/plugins.js']=['plugins.js','text/javascript; charset=utf-8'];
      assets['/capability-cards.js']=['capability-cards.js','text/javascript; charset=utf-8'];
      assets['/manage.css'] = ['manage.css', 'text/css; charset=utf-8'];
      assets['/models'] = ['models.html', 'text/html; charset=utf-8'];
      assets['/models.js'] = ['models.js', 'text/javascript; charset=utf-8'];
      assets['/regions.json']=['regions.json','application/json; charset=utf-8'];
      assets['/region-picker.js']=['region-picker.js','text/javascript; charset=utf-8'];
      for(const name of ['profiles.html','profiles.js','profiles.css','profile-chat.js'])assets[name==='profiles.html'?'/profiles':'/'+name]=[name,name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'];
      if(route==='/settings'&&['sessions','reply'].includes(url.searchParams.get('section'))||route==='/manage'&&url.searchParams.get('tab')==='sessions')assets[route]=['chats.html','text/html; charset=utf-8'];
      if (!deviceOnly && req.method === 'GET' && assets[route]) { const [name, type] = assets[route], bytes=fs.readFileSync(path.join(publicRoot, name)); return send(200, type.startsWith('application/json')?JSON.parse(bytes):bytes, type); }
      if (!deviceOnly && req.method === 'GET' && route === '/v1/bootstrap') return send(200, { ...bootstrap(), token, backupScope: backend?.externalRuntime ? 'chat-and-attachments' : backend?.kind === 'isolated-sdk' ? 'chat-and-isolated-dsh' : backend ? 'unsupported-backend' : 'local-chat', localOnly: true, deviceGatewayEnabled: Boolean(deviceServer), deviceRemoteEnabled: Boolean(deviceServer && deviceHost !== '127.0.0.1'), deviceUrl: deviceServer ? `${deviceTls ? 'https' : 'http'}://${deviceHostname}:${deviceServer.address().port}` : null });
      const pairingClaim = deviceOnly && req.method === 'POST' && route === '/v1/pairing/claim';
      const authenticate = () => devices.authenticate(/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1]);
      let device;
      if (deviceOnly) { if (!pairingClaim) device = authenticate(); }
      else if (req.headers['x-chatagent-token'] !== token) throw fault('AUTH_REQUIRED', 401);
      // 独立入口不给出管理员token、网页或管理接口；新增接口默认不可从设备入口访问。
      const deviceRoute=scopedRoute?'/'+scopedRoute[2]:route;
      const allowedDeviceRoute = req.method === 'GET' && ['/v1/chats','/v1/bootstrap', '/v1/messages', '/v1/messages/lookup', '/v1/sync', '/v1/cache', '/v1/profiles', '/v1/timeline'].includes(deviceRoute) ||
        req.method === 'POST' && deviceRoute === '/v1/profiles/self' ||
        req.method === 'POST' && ['/v1/pairing/claim', '/v1/messages', '/v1/mode', '/v1/attachments'].includes(deviceRoute) ||
        req.method === 'POST' && /^\/v1\/messages\/[a-f0-9-]+\/decision$/.test(deviceRoute) ||
        req.method === 'GET' && /^\/v1\/attachments\/[a-f0-9-]{36}(?:\/content)?$/.test(deviceRoute) ||
        req.method === 'PUT' && /^\/v1\/attachments\/[a-f0-9-]{36}\/content$/.test(deviceRoute) ||
        req.method === 'POST' && /^\/v1\/attachments\/[a-f0-9-]{36}\/complete$/.test(deviceRoute) ||
        ['GET','POST'].includes(req.method) && /^\/v1\/attachments\/[a-f0-9-]{36}\/transcription$/.test(deviceRoute);
      if (deviceOnly && !allowedDeviceRoute) throw fault('DEVICE_SCOPE_REFUSED', 403);
      if(req.method==='GET'&&route==='/v1/chats'){const chats=listSpaces();return send(200,{chats:deviceOnly?chats.map(({policy,...r})=>r):chats,canCreate:!deviceOnly&&!!backend?.openChat});}
      if(scopedRoute){
        if(maintenance)throw fault('BACKUP_IN_PROGRESS',503);
        const inner='/'+scopedRoute[2];if(!/^\/v1\/(?:bootstrap|messages|sync|cache|profiles|timeline|mode|attachments|preferences|chat-settings|conversation-status|reply-parts|dsh|plugins|backups|companion)(?:\/|$)/.test(inner))throw fault('CHAT_ROUTE_REFUSED',403);
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_CHUNK_BYTES+32768)throw fault('BODY_TOO_LARGE',413);chunks.push(chunk);}let bytes=Buffer.concat(chunks);
        if(deviceOnly){device=authenticate();if(inner==='/v1/messages'&&req.method==='POST'){let value;try{value=JSON.parse(bytes);}catch{throw fault('INVALID_JSON',400);}if(value.deviceId!==undefined&&value.deviceId!==device.deviceId)throw fault('DEVICE_ID_MISMATCH',403);value.deviceId=device.deviceId;bytes=Buffer.from(JSON.stringify(value));}if(inner==='/v1/messages/lookup'){if(url.searchParams.has('deviceId')&&url.searchParams.get('deviceId')!==device.deviceId)throw fault('DEVICE_ID_MISMATCH',403);url.searchParams.set('deviceId',device.deviceId);}}
        const child=await openSpace(scopedRoute[1]),response=await fetch(child.url+inner+url.search,{method:req.method,headers:{'X-Chatagent-Token':child.adminToken,...req.headers['content-type']?{'Content-Type':req.headers['content-type']} :{}},...['GET','HEAD'].includes(req.method)?{}:{body:bytes},signal:AbortSignal.timeout(20000)});
        const type=response.headers.get('content-type')??'application/octet-stream';
        if(type.includes('application/json')){const value=await response.json();if(inner==='/v1/bootstrap'){delete value.token;if(!deviceOnly)value.token=token;else Object.assign(value,device);}return send(response.status,value,type);}
        for(const key of ['Content-Disposition','X-Content-SHA256'])if(response.headers.has(key))headers[key]=response.headers.get(key);return send(response.status,Buffer.from(await response.arrayBuffer()),type);
      }
      const transcription = /^\/v1\/attachments\/([a-f0-9-]{36})\/transcription$/.exec(route);
      if (transcription && ['GET','POST'].includes(req.method)) {
        if (!backend?.attachmentTranscription || !backend?.transcribeAttachment) throw fault('ASR_NOT_CONNECTED',409);
        const file = attachments.verify(transcription[1]);
        if (!file.media_type.startsWith('audio/')) throw fault('ASR_UNSUPPORTED_ATTACHMENT',400);
        if (req.method === 'POST') { if (maintenance) throw fault('BACKUP_IN_PROGRESS',503); return send(200, await backend.transcribeAttachment(file.id)); }
        return send(200, await backend.attachmentTranscription(file.id));
      }
      if (!deviceOnly && req.method === 'GET' && route === '/v1/companion') return send(200, backend?.companionStatus?.() ?? { kind: 'not-connected' });
      if(!deviceOnly&&req.method==='GET'&&route==='/v1/plugins')return send(200,await backend?.pluginStatus?.()??[]);
      if(!deviceOnly&&req.method==='GET'&&route==='/v1/plugins/course-query/timetable'){if(!backend?.pluginDetail)throw fault('PLUGIN_NOT_CONNECTED',409);return send(200,await backend.pluginDetail('course-query'));}
      const diyRoute=/^\/v1\/plugins\/(fish-notebook|media-browser|course-query)\/(settings|run|stop|preview|apply)$/.exec(route);
      if (!deviceOnly && req.method === 'GET' && route === '/v1/dsh') return send(200, await backend?.bridgeStatus?.() ?? {connected:false});
      if (!deviceOnly && req.method === 'POST' && route === '/v1/companion/cancel') { await backend?.cancelCapabilities?.(); return send(200, { cancellationRequested: true }); }
      if (!deviceOnly && req.method === 'GET' && route === '/v1/companion/archive') {
        if (!backend?.companionArchive) throw fault('COMPANION_NOT_CONNECTED', 409);
        const offset = Number(url.searchParams.get('offset') ?? '0');
        if (!Number.isSafeInteger(offset) || offset < 0 || !['history', 'memories', 'diaries', 'bili', 'bili-legacy'].includes(url.searchParams.get('kind'))) throw fault('ARCHIVE_QUERY_INVALID', 400);
        return send(200, backend.companionArchive(url.searchParams.get('kind'), offset));
      }
      if (deviceOnly && req.method === 'GET' && route === '/v1/bootstrap') return send(200, { ...bootstrap(), ...device, localOnly: deviceHost === '127.0.0.1' });
      const attachmentRoute = /^\/v1\/attachments\/([a-f0-9-]{36})(?:\/(content|complete))?$/.exec(route);
      if (attachmentRoute && req.method === 'PUT' && attachmentRoute[2] === 'content') {
        if (maintenance) throw fault('BACKUP_IN_PROGRESS', 503);
        if (req.headers['content-type'] !== 'application/octet-stream') throw fault('BINARY_REQUIRED', 415);
        if (!url.searchParams.has('offset') || !/^\d+$/.test(url.searchParams.get('offset'))) throw fault('INVALID_ATTACHMENT_CHUNK', 400);
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > MAX_CHUNK_BYTES) throw fault('BODY_TOO_LARGE', 413); chunks.push(chunk); }
        if (deviceOnly) authenticate();
        lastActivity = now();
        if (maintenance || closed) throw fault('BACKUP_IN_PROGRESS', 503);
        const row = attachments.write(attachmentRoute[1], Number(url.searchParams.get('offset')), Buffer.concat(chunks));
        return send(200, { ...describe(row), offset: row.offset, state: row.state });
      }
      if (attachmentRoute && req.method === 'GET') {
        if (attachmentRoute[2] === 'content') {
          const row = attachments.verify(attachmentRoute[1]);
          const content = fs.readFileSync(row.file);
          if (content.length !== row.bytes || createHash('sha256').update(content).digest('hex') !== row.sha256) throw fault('ATTACHMENT_OBJECT_DAMAGED');
          headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(row.name);
          headers['Content-Length'] = row.bytes; headers['X-Content-SHA256'] = row.sha256;
          return send(200, content, 'application/octet-stream');
        }
        if (!attachmentRoute[2]) { const row = attachments.get(attachmentRoute[1]); return send(200, { ...describe(row), offset: row.offset, state: row.state }); }
      }
      let body = {};
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw fault('JSON_REQUIRED', 415);
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > (route.startsWith('/v1/plugins/course-query/')?8192:(route.startsWith('/v1/import/')||route.startsWith('/v1/memory/import/'))?32768:/^\/v1\/profiles\/(self|agent)$/.test(route)?512:256) * 1024) throw fault('BODY_TOO_LARGE', 413); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault('INVALID_JSON', 400); }
        if (!body || Array.isArray(body) || typeof body !== 'object') throw fault('INVALID_JSON', 400);
      }
      if (closed) throw fault('SERVICE_CLOSED', 503);
      if (pairingClaim) return send(200, devices.claim(body));
      if (deviceOnly) device = authenticate(); // 读请求体期间可能已被电脑撤销。
      if (req.method === 'POST') lastActivity = now();
      if(!deviceOnly&&req.method==='POST'&&route==='/v1/chats'){if(maintenance)throw fault('BACKUP_IN_PROGRESS',503);return send(200,await createSpace(body));}
      if(!deviceOnly&&req.method==='POST'&&diyRoute){if(maintenance)throw fault('BACKUP_IN_PROGRESS',503);if(!backend?.pluginAction)throw fault('PLUGIN_NOT_CONNECTED',409);try{return send(200,await backend.pluginAction(diyRoute[1],diyRoute[2],body));}catch(e){if(/^PLUGIN_[A-Z_]+$/.test(e.message))throw fault(e.message,409);throw e;}}
      if(req.method==='GET' && route==='/v1/timeline')return send(200,timelinePage(store,portable,backend?.historyRecords?.()??[],url.searchParams));
      if(!deviceOnly && req.method==='GET' && route==='/v1/workspace')return send(200,{chatRoot:root,...backend?.workspaceInfo?.()});
      if(!deviceOnly && req.method==='GET' && route==='/v1/memory')return send(200,backend?.memorySettings?.()??{engine:null,memories:[],deleted:[],traces:[]});
      if(!deviceOnly && req.method==='POST' && route==='/v1/memory') { if(maintenance)throw fault('BACKUP_IN_PROGRESS',503);if(!backend?.saveMemorySettings)throw fault('COMPANION_NOT_CONNECTED');return send(200,await backend.saveMemorySettings(body)); }
      if(!deviceOnly && req.method==='POST' && ['/v1/memory/import/preview','/v1/memory/import/apply'].includes(route)){if(maintenance)throw fault('BACKUP_IN_PROGRESS',503);if(!backend?.importMemory)throw fault('COMPANION_NOT_CONNECTED');return send(200,await backend.importMemory({...body,apply:route.endsWith('/apply')}));}
      if(!deviceOnly && req.method==='GET' && route==='/v1/import/records')return send(200,portable.records());
      if(!deviceOnly && req.method==='POST' && route==='/v1/import/preview'){const {report,records}=portable.preview(body.package);return send(200,{...report,preview:hash([report,records])});}
      if(!deviceOnly && req.method==='POST' && route==='/v1/import/apply'){if(maintenance)throw fault('BACKUP_IN_PROGRESS',503);return send(200,portable.apply(body.package,body.preview));}
      if(!deviceOnly && req.method==='GET' && route==='/v1/export') {
        store.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('portable_origin',?)").run('chatagent-'+store.epoch);
        const sourceId=store.db.prepare("SELECT value FROM settings WHERE key='portable_origin'").get().value,scope='local';
        const records=store.db.prepare('SELECT * FROM messages ORDER BY seq').all().map(r=>({sourceId,scope,id:r.id,kind:'message',text:r.text,role:r.role,at:r.created_at,mode:r.mode,attachments:store.hydrate(r).attachments,metadata:{state:r.state}}));
        records.push(...(backend?.historyRecords?.()??[]));
        const mem=backend?.memorySettings?.();
        for(const [name,items] of [['active',mem?.memories??[]],['deleted',mem?.deleted??[]]])for(const r of items)records.push({sourceId,scope,id:name+'-'+r.id,kind:'memory',text:String(r.text??''),at:Number.isFinite(Date.parse(r.at))?Date.parse(r.at):null,metadata:{state:name,engine:'dsh-fish-memory',engineVersion:'1.5.0',native:r}});
        for(const p of preferences.read().personas)records.push({sourceId,scope,id:p.id,kind:'persona',text:p.text,at:null,metadata:{name:p.name}});
        if(backend?.companionArchive){for(let offset=0;;offset+=50){const page=backend.companionArchive('diaries',offset);for(const r of page.entries)records.push({sourceId,scope,id:String(r.id),kind:'diary',text:r.text,at:null,metadata:{date:r.date}});if(page.entries.length<50)break;}}
        const result=portable.export(records);res.setHeader('Content-Disposition','attachment; filename="chatagent-portable.json"');return send(200,result);
      }
      if(req.method==='GET' && route==='/v1/profiles')return send(200,profiles.list(url.searchParams.get('after')));
      const profileRoute=/^\/v1\/profiles\/(self|agent)$/.exec(route);
      if(req.method==='POST' && profileRoute){if(maintenance)throw fault('BACKUP_IN_PROGRESS',503);return send(200,profiles.save(profileRoute[1],body));}
      if (!deviceOnly && req.method === 'GET' && route === '/v1/models') return send(200, backend?.externalRuntime ? {managedBy:'dsh'} : models.read());
      if (!deviceOnly && req.method === 'POST' && route === '/v1/models') {
        if (maintenance) throw fault('BACKUP_IN_PROGRESS', 503);
        if (backend?.externalRuntime) throw fault('MODEL_MANAGED_BY_DSH',409);
        return send(200, models.save(body));
      }
      if (!deviceOnly && req.method === 'POST' && route === '/v1/models/test') {
        if (maintenance) throw fault('BACKUP_IN_PROGRESS', 503);
        if (backend?.externalRuntime) throw fault('MODEL_MANAGED_BY_DSH',409);
        return send(200, await models.probe(body));
      }
      if(!deviceOnly&&route==='/v1/chat-settings'&&['GET','POST'].includes(req.method)){
        const sessionId=activeSession();if(!sessionId)throw fault('SESSION_NOT_CONNECTED',409);
        if(req.method==='POST'){if(maintenance)throw fault('BACKUP_IN_PROGRESS',503);if(body.sessionId!==sessionId)throw fault('SESSION_CHANGED',409);return send(200,body.preferences?store.transaction(()=>({...sessionTools.save(body,false),preferences:preferences.save(body.preferences,false)})):sessionTools.save(body));}
        return send(200,{...sessionTools.read(sessionId),name:preferences.read().modes.social.name,preferences:preferences.read(),tools:(await backend?.bridgeStatus?.())?.tools??[]});
      }
      if (!deviceOnly && req.method === 'GET' && route === '/v1/preferences') return send(200, preferences.read());
      if (!deviceOnly && req.method === 'POST' && route === '/v1/preferences') {
        if (maintenance) throw fault('BACKUP_IN_PROGRESS', 503);
        return send(200, preferences.save(body));
      }
      if (!deviceOnly && req.method === 'GET' && route === '/v1/conversation-status') return send(200, {
        currentMode: store.mode(), runtime: backend?.status?.() ?? null, context: backend?.contextStatus?.() ?? { state: 'not-connected' },
        messages: store.db.prepare('SELECT mode,role,state,COUNT(*) count FROM messages GROUP BY mode,role,state').all(),
        pendingParts: store.db.prepare("SELECT COUNT(*) n FROM reply_parts WHERE state='queued'").get().n,
        files: store.history().flatMap(m => m.attachments.map(f => ({ ...f, mode: m.mode, messageId: m.id })))
      });
      if (!deviceOnly && req.method === 'POST' && route === '/v1/reply-parts/stop') {
        if (maintenance) throw fault('BACKUP_IN_PROGRESS', 503);
        return send(200, { cancelled: store.stopReplyParts() });
      }
      if (!deviceOnly && req.method === 'GET' && route === '/v1/devices') return send(200, { devices: devices.list(), gatewayEnabled: Boolean(deviceServer) });
      if (!deviceOnly && req.method === 'POST' && route === '/v1/pairing/invitations') {
        if (!deviceServer) throw fault('DEVICE_GATEWAY_DISABLED', 409);
        return send(200, devices.invite());
      }
      if (!deviceOnly && req.method === 'POST' && route === '/v1/pairing/cancel') { devices.cancelInvitation(); return send(200, { cancelled: true }); }
      const revokeDevice = /^\/v1\/devices\/([a-f0-9-]{36})\/revoke$/.exec(route);
      if (!deviceOnly && req.method === 'POST' && revokeDevice) return send(200, devices.revoke(revokeDevice[1]));
      if (req.method === 'POST' && route === '/v1/attachments') {
        if (maintenance) throw fault('BACKUP_IN_PROGRESS', 503);
        const row = attachments.create(body); return send(200, { ...describe(row), offset: row.offset, state: row.state });
      }
      if (req.method === 'POST' && attachmentRoute?.[2] === 'complete') {
        if (maintenance) throw fault('BACKUP_IN_PROGRESS', 503);
        const row = attachments.complete(attachmentRoute[1]); return send(200, { ...describe(row), offset: row.offset, state: row.state });
      }
      if (req.method === 'POST' && route === '/v1/messages') {
        if (maintenance) throw fault('BACKUP_IN_PROGRESS', 503);
        if (deviceOnly) {
          if (body.deviceId !== undefined && body.deviceId !== device.deviceId) throw fault('DEVICE_ID_MISMATCH', 403);
          body.deviceId = device.deviceId;
        }
        const known = typeof body.deviceId === 'string' && typeof body.clientMessageId === 'string' && store.lookup(body.deviceId, body.clientMessageId);
        if (!known && (body.expectedMode === undefined || body.expectedModeRevision === undefined)) throw fault('MODE_EXPECTATION_REQUIRED', 428);
        const ids = body.attachmentIds ?? [];
        if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length || Object.hasOwn(body, 'attachments')) throw fault('INVALID_ATTACHMENTS', 400);
        const submitted = store.submit({ ...body, attachments: ids.map(id => describe(attachments.verify(id))) });
        if (!known && submitted.state === 'queued' && !ids.length && body.text.trim() === '停止分段') {
          store.stopSplittingCommand(submitted.id);
        }
        return send(200, store.message(submitted.id));
      }
      if (req.method === 'GET' && route === '/v1/messages/lookup') {
        if (deviceOnly && url.searchParams.has('deviceId') && url.searchParams.get('deviceId') !== device.deviceId) throw fault('DEVICE_ID_MISMATCH', 403);
        return send(200, store.lookup(deviceOnly ? device.deviceId : url.searchParams.get('deviceId') ?? '', url.searchParams.get('clientMessageId') ?? ''));
      }
      if (req.method === 'GET' && route === '/v1/messages') return send(200, store.history(url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined));
      const decision = /^\/v1\/messages\/([a-f0-9-]+)\/decision$/.exec(route);
      if (req.method === 'POST' && decision) {
        if (maintenance) throw fault('BACKUP_IN_PROGRESS', 503);
        return send(200, store.decide(decision[1], body.revision, body.action));
      }
      if (req.method === 'GET' && route === '/v1/sync') return send(200, store.sync(url.searchParams.get('epoch'), Number(url.searchParams.get('after') ?? 0)));
      if (req.method === 'GET' && route === '/v1/cache') return send(200, store.cachePage(url.searchParams.get('epoch'), Number(url.searchParams.get('before')), Number(url.searchParams.get('since'))));
      if (req.method === 'POST' && route === '/v1/mode') {
        if (maintenance) throw fault('BACKUP_IN_PROGRESS', 503);
        if(body.mode!=='social')throw fault('CHAT_ONLY',400);
        return send(200, { mode: store.setMode(body.mode), modeRevision: store.modeRevision() });
      }
      if (req.method === 'GET' && route === '/v1/backups/status') return send(200, coordinator.status());
      if (req.method === 'POST' && route === '/v1/backups') return send(200, await coordinator.request());
      if (req.method === 'POST' && route === '/v1/backups/pin') { coordinator.pin(body.id, body.pinned); return send(200, coordinator.status()); }
      throw fault('NOT_FOUND', 404);
    } catch (error) {
      if (/^(INVALID_ATTACHMENT|ATTACHMENT_)/.test(error.message) && /^[A-Z_]+$/.test(error.message)) return send(error.message === 'ATTACHMENT_NOT_FOUND' ? 404 : 409, { error: error.message });
      send(error.status ?? 500, { error: error.status ? error.message : 'INTERNAL_ERROR' });
    }
  };
  const server = http.createServer(handler(false));
  let deviceServer;
  try { deviceServer = devicePort === undefined ? null : deviceTls ? https.createServer({ key: deviceTls.key, cert: deviceTls.cert, minVersion: 'TLSv1.2' }, handler(true)) : http.createServer(handler(true)); }
  catch (error) { devices.close(); attachments.close(); store.close(); release(); throw error; }
  server.requestTimeout = 15000;
  if (deviceServer) deviceServer.requestTimeout = 15000;
  const listen = async(listener,value,host='127.0.0.1')=>{for(let attempt=0;attempt<16;attempt++){await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(value,host,()=>{listener.removeListener('error',reject);resolve();});});if(value!==0||!fetchUnsafePorts.has(listener.address().port))return;await new Promise(resolve=>listener.close(resolve));}throw fault('HTTP_COMPATIBLE_PORT_UNAVAILABLE');};
  const stopListener = async listener => { if (listener?.listening) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); } };
  try { await listen(server, port); if (deviceServer) await listen(deviceServer, devicePort, deviceHost); }
  catch (error) { await stopListener(deviceServer); await stopListener(server); devices.close(); attachments.close(); store.close(); release(); throw error; }
  const timer = setInterval(() => { void tick().catch(() => {}); void coordinator.tick().catch(() => {}); }, 1000); timer.unref();
  if(allowChatSpaces&&backend?.openChat)for(const row of spaceRows())void openSpace(row.id).catch(()=>{});
  return { adminToken:token,url: `http://127.0.0.1:${server.address().port}`, deviceUrl: deviceServer ? `${deviceTls ? 'https' : 'http'}://${deviceHostname}:${deviceServer.address().port}` : null, root, store, attachments, tick, backup: () => coordinator.request(), backupStatus: () => coordinator.status(),
    close() {
      closed = true; clearInterval(timer);
      return closeJob ??= (async () => { await stopListener(deviceServer); await stopListener(server);
        if (active) await active; if (coordinator.job) await coordinator.job.catch(() => {}); if (backupJob) await backupJob.catch(() => {});await Promise.allSettled([...children.values()].map(async job=>{const child=await job;await child.close();await child.backend.close?.();})); devices.close(); attachments.close(); store.close(); release(); })();
    } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? fileURLToPath(new URL('../../data/local/', import.meta.url));
  const service = await startService({ dataRoot: root, port: Number(process.env.CHATAGENT_PORT ?? 37821), devicePort: process.env.CHATAGENT_DEVICE_PORT === undefined ? undefined : Number(process.env.CHATAGENT_DEVICE_PORT) });
  console.log(`Chatagent 本地服务：${service.url}\nDSH 尚未连接；不会向微信或模型发送消息。`);
  if (service.deviceUrl) console.log(`设备协议验证入口（仅本机）：${service.deviceUrl}`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await service.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
